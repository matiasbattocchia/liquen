/**
 * proxy/proxy.ts — the credential-injecting egress proxy (DESIGN §9).
 *
 * The wire half of the MITM the vault design is built on. A tool in user space is handed
 * three env vars (issued, never inherited — bash.ts clears the pocket first):
 *
 *   HTTPS_PROXY=http://127.0.0.1:<port>   send every HTTPS request here as a CONNECT tunnel
 *   SSL_CERT_FILE=<ca.pem>                trust ONLY the mu CA (so this proxy can terminate)
 *   <extra.env>=mu-grant-…                a PLACEHOLDER — the real token never enters user
 *                                         space; the var's NAME is the credential row's own
 *                                         declaration (main.ts fronts every row that makes one)
 *
 * The proxy terminates the tunnel's TLS with a leaf it mints for the dialed host (ca.ts),
 * reads the plaintext request, and — wherever a header value carries a `mu-grant-…` handle —
 * substitutes the real access token the broker fetches from the vault (grants.ts). Then it
 * re-originates to the true host over real TLS and streams the answer back. User space never
 * holds a valid credential; the credential meets the request only here, at the last hop
 * before the origin.
 *
 * TLS-server-on-a-hijacked-conn isn't a stable Deno primitive, so CONNECT is bridged: per
 * dialed authority (`host`, or `host:port` off 443 — the port rides through to the origin)
 * we stand up a loopback `Deno.serve` with that host's leaf (giving us Request/Response
 * directly), and pipe the tunnel's bytes into it. A handful of backends over a process life.
 *
 * One policy rule attaches at the plaintext seam: the grant's HOST BINDING. A credential
 * row that declares `extra.hosts` spends only toward those origins — the swap refuses any
 * other dial (grants.ts hostAllowed), so a handle can't be aimed at an echo endpoint to
 * read the real token back. Method/path policy would attach at the same seam; none yet.
 */

import type { GrantBroker } from "./grants.ts";
import type { CA } from "./ca.ts";
import { findRoot } from "../config.ts";

// dropped when re-originating: hop-by-hop headers (RFC 7230 §6.1) + the tunnel's host
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);
// the handle itself is the marker, wherever it rides: `Bearer mu-grant-…`, gh's
// `token mu-grant-…`, an `x-api-key: mu-grant-…` — the swap is a SUBSTITUTION over every
// header value, preserving whatever surrounds the handle, so a new tool needs no proxy
// change. (A handle a tool base64s or signs over can't be substituted — such schemes
// belong broker-side.)
const HANDLE_RE = /mu-grant-[A-Za-z0-9]+/g;

export interface ProxyDeps {
  ca: CA;
  broker: GrantBroker;
  /** The origin call — injectable for tests; default is the runtime `fetch` (real trust). */
  originFetch?: typeof fetch;
  /** An audit sink for every egress request; default logs a line to stderr. NEVER the
   *  token, headers, or body — method · host · path · status · the grant's agent. */
  audit?: (line: EgressAudit) => void;
}

export interface EgressAudit {
  method: string;
  host: string; // the dialed authority: `host`, or `host:port` off 443
  path: string;
  status: number;
  agentId?: string;
  swapped: boolean; // did a placeholder get a real credential
}

/**
 * Serve one decrypted request for the dialed authority: swap a placeholder bearer for the
 * real token, re-originate, and audit. Pure over its deps (no TLS) — the proxy's testable
 * core.
 */
export async function proxyRequest(host: string, req: Request, deps: ProxyDeps): Promise<Response> {
  const originFetch = deps.originFetch ?? fetch;
  const audit = deps.audit ?? defaultAudit;
  const url = new URL(req.url);
  const target = `https://${host}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);

  let swapped = false;
  let agentId: string | undefined;
  // every handle in the request, resolved once — a token per distinct handle, refused as
  // a whole if any can't be honored toward THIS host
  const real = new Map<string, string>();
  for (const [, v] of headers) {
    for (const { 0: handle } of v.matchAll(HANDLE_RE)) {
      if (real.has(handle)) continue;
      agentId ??= deps.broker.resolve(handle)?.agentId;
      const token = await deps.broker.accessTokenFor(handle, host);
      if (!token) {
        // a placeholder we can't honor never leaves the box as-is (it would 401 upstream
        // and leak the handle) — fail it here; same answer when the grant's host binding
        // refuses the dialed origin
        audit({
          method: req.method,
          host,
          path: url.pathname,
          status: 401,
          agentId,
          swapped: false,
        });
        return new Response(
          "mu proxy: no credential for this grant, or grant not valid for this host\n",
          { status: 401 },
        );
      }
      real.set(handle, token);
    }
  }
  if (real.size) {
    for (const [k, v] of [...headers]) {
      headers.set(k, v.replace(HANDLE_RE, (h) => real.get(h) ?? h));
    }
    swapped = true;
  }

  const res = await originFetch(target, {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  });
  audit({ method: req.method, host, path: url.pathname, status: res.status, agentId, swapped });

  // strip hop-by-hop off the way back too; keep the body streaming
  const out = new Headers();
  for (const [k, v] of res.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

export interface Proxy {
  /** The loopback port `HTTPS_PROXY` points at. */
  port: number;
  /** The CA cert path `SSL_CERT_FILE` points at. */
  caPath: string;
  shutdown(): Promise<void>;
}

/** Start the proxy on loopback. `port: 0` picks an ephemeral one (read `.port` back). */
export function startProxy(
  deps: ProxyDeps,
  opts: { port?: number; hostname?: string } = {},
): Proxy {
  const hostname = opts.hostname ?? "127.0.0.1";
  // per-authority decrypting backend: a loopback TLS `Deno.serve` with the host's leaf
  const backends = new Map<string, Promise<number>>();
  const servers: { shutdown(): Promise<void> }[] = [];

  const backendFor = (authority: string): Promise<number> => {
    let p = backends.get(authority);
    if (!p) {
      p = (async () => {
        const leaf = await deps.ca.leafFor(authority.replace(/:\d+$/, ""));
        const srv = Deno.serve(
          { hostname, port: 0, cert: leaf.cert, key: leaf.key, onListen: () => {} },
          (req) => proxyRequest(authority, req, deps),
        );
        servers.push(srv);
        return srv.addr.port;
      })();
      backends.set(authority, p);
      p.catch(() => backends.delete(authority));
    }
    return p;
  };

  const listener = Deno.listen({ hostname, port: opts.port ?? 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const serve = async () => {
    for await (const conn of listener) handleConn(conn).catch(() => {});
  };
  // a conn we can't tunnel gets an ANSWER and a close — never a silent hang
  const deny = async (conn: Deno.Conn, status: string): Promise<void> => {
    await conn.write(new TextEncoder().encode(`HTTP/1.1 ${status}\r\n\r\n`)).catch(() => {});
    try {
      conn.close();
    } catch { /* already closed */ }
  };
  const handleConn = async (conn: Deno.Conn): Promise<void> => {
    const head = await readConnect(conn);
    // not a CONNECT: this proxy only tunnels HTTPS
    if (!head) return deny(conn, "405 Method Not Allowed");
    let up: Deno.Conn;
    try {
      const backendPort = await backendFor(head.authority);
      up = await Deno.connect({ hostname, port: backendPort });
    } catch {
      // a refused host, a failed mint — the tunnel can't be stood up
      return deny(conn, "502 Bad Gateway");
    }
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"))
      .catch(() => {});
    try {
      // bytes an optimistic client sent past the CONNECT head are the tunnel's first bytes
      for (let off = 0; off < head.early.length;) off += await up.write(head.early.subarray(off));
    } catch { /* a broken tunnel surfaces in the pipes below */ }
    await Promise.all([
      conn.readable.pipeTo(up.writable).catch(() => {}),
      up.readable.pipeTo(conn.writable).catch(() => {}),
    ]);
  };

  const running = serve();

  return {
    port,
    caPath: deps.ca.caPath,
    async shutdown(): Promise<void> {
      try {
        listener.close();
      } catch { /* already closed */ }
      await running.catch(() => {});
      await Promise.all(servers.map((s) => s.shutdown().catch(() => {})));
    },
  };
}

/** Read the whole CONNECT head off a fresh tunnel conn (it may arrive in pieces): the
 *  dialed authority (`host`, or `host:port` off 443) plus any bytes past the head — an
 *  optimistic client's first tunnel bytes. null if the bytes aren't a CONNECT. */
async function readConnect(
  conn: Deno.Conn,
): Promise<{ authority: string; early: Uint8Array } | null> {
  const buf = new Uint8Array(4096);
  let n = 0;
  let end = -1;
  while (end < 0) {
    if (n === buf.length) return null; // no head in 4 KiB: nothing this proxy honors
    const read = await conn.read(buf.subarray(n));
    if (read === null) return null;
    n += read;
    end = headEnd(buf, n);
    // bail on non-CONNECT bytes now — never wait on a terminator that will never come
    const line = new TextDecoder().decode(buf.subarray(0, Math.min(n, 8)));
    if (end < 0 && !"CONNECT ".startsWith(line) && !line.startsWith("CONNECT ")) return null;
  }
  const m = new TextDecoder().decode(buf.subarray(0, end)).match(/^CONNECT (\S+?)(?::(\d+))? /);
  if (!m) return null;
  const authority = !m[2] || m[2] === "443" ? m[1] : `${m[1]}:${m[2]}`;
  return { authority, early: buf.slice(end, n) };
}

/** The byte offset just past the head's `\r\n\r\n` terminator, or -1. */
function headEnd(buf: Uint8Array, n: number): number {
  for (let i = 0; i + 4 <= n; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i + 4;
    }
  }
  return -1;
}

function defaultAudit(a: EgressAudit): void {
  console.error(
    `[proxy] ${a.agentId ?? "-"} ${a.method} ${a.host}${a.path} → ${a.status}` +
      (a.swapped ? " (swapped)" : ""),
  );
}

/* ── standalone entry: serve the proxy over the org vault ───────────────────────────────
 *
 *   deno task proxy [credential_key]     # default: the org's google grant, if exactly one
 *
 * Prints the three env vars a tool needs. Verify by hand:
 *   HTTPS_PROXY=… SSL_CERT_FILE=… GOOGLE_WORKSPACE_CLI_TOKEN=… \
 *     gws calendar events list --params '{"calendarId":"primary"}'
 * Env: none — the port is EPHEMERAL (printed at start; main runs its own in-process). */
if (import.meta.main) {
  const { openCredentials } = await import("../store/credentials.ts");
  const { createGrantBroker } = await import("./grants.ts");
  const { openCA } = await import("./ca.ts");
  const root = findRoot();
  const dir = `${root}/data`;
  const creds = await openCredentials(dir);

  let key = Deno.args[0];
  if (!key) {
    const grants = (await creds.list("google:")).filter((r) => !r.key.startsWith("google:app:"));
    if (grants.length !== 1) {
      console.error(
        `[proxy] name a credential key: found ${grants.length} google grants` +
          (grants.length ? `:\n  ${grants.map((g) => g.key).join("\n  ")}` : ""),
      );
      Deno.exit(2);
    }
    key = grants[0].key;
  }

  const broker = createGrantBroker({ creds });
  const ca = await openCA();
  const proxy = startProxy({ ca, broker });
  const grant = await creds.get(key);
  const handle = broker.issue(key, grant?.agentId);
  // the row's own declaration names the var (main.ts fronts the same way)
  const varName = typeof grant?.extra?.env === "string" ? grant.extra.env : "MU_GRANT";
  console.error(`[proxy] on :${proxy.port} — fronting ${key}\n`);
  console.error(`export HTTPS_PROXY=http://127.0.0.1:${proxy.port}`);
  console.error(`export SSL_CERT_FILE=${proxy.caPath}`);
  console.error(`export ${varName}=${handle}`);
}
