/**
 * proxy/proxy.ts — the credential-injecting egress proxy (DESIGN §8).
 *
 * The wire half of the MITM the vault design is built on. A tool in user space is handed
 * three env vars (issued, never inherited — bash.ts clears the pocket first):
 *
 *   HTTPS_PROXY=http://127.0.0.1:<port>   send every HTTPS request here as a CONNECT tunnel
 *   SSL_CERT_FILE=<ca.pem>                trust ONLY the mu CA (so this proxy can terminate)
 *   GOOGLE_WORKSPACE_CLI_TOKEN=mu-grant-… a PLACEHOLDER — the real token never enters here
 *
 * The proxy terminates the tunnel's TLS with a leaf it mints for the dialed host (ca.ts),
 * reads the plaintext request, and — where it carries a `mu-grant-…` bearer — swaps in the
 * real access token the broker fetches from the vault (grants.ts). Then it re-originates to
 * the true host over real TLS and streams the answer back. User space never holds a valid
 * credential; the credential meets the request only here, at the last hop before Google.
 *
 * TLS-server-on-a-hijacked-conn isn't a stable Deno primitive, so CONNECT is bridged: per
 * host we stand up a loopback `Deno.serve` with that host's leaf (giving us Request/Response
 * directly), and pipe the tunnel's bytes into it. A handful of backends over a process life.
 *
 * No method/host/path policy yet (deliberate): the swap and the audit line are the whole
 * job. The plaintext request is where policy WOULD attach — that seam exists, unused.
 */

import type { GrantBroker } from "./grants.ts";
import type { CA } from "./ca.ts";

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
const HANDLE_RE = /^Bearer (mu-grant-\S+)$/;

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
  host: string;
  path: string;
  status: number;
  agentId?: string;
  swapped: boolean; // did a placeholder get a real credential
}

/**
 * Serve one decrypted request for `host`: swap a placeholder bearer for the real token,
 * re-originate, and audit. Pure over its deps (no TLS) — the proxy's testable core.
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
  const auth = req.headers.get("authorization");
  const m = auth?.match(HANDLE_RE);
  if (m) {
    const handle = m[1];
    agentId = deps.broker.resolve(handle)?.agentId;
    const real = await deps.broker.accessTokenFor(handle);
    if (!real) {
      // a placeholder we can't honor never leaves the box as-is (it would 401 upstream and
      // leak the handle) — fail it here
      audit({ method: req.method, host, path: url.pathname, status: 401, agentId, swapped: false });
      return new Response("mu proxy: no credential for this grant\n", { status: 401 });
    }
    headers.set("authorization", `Bearer ${real}`);
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
  // per-host decrypting backend: a loopback TLS `Deno.serve` with that host's leaf
  const backends = new Map<string, Promise<number>>();
  const servers: { shutdown(): Promise<void> }[] = [];

  const backendFor = (host: string): Promise<number> => {
    let p = backends.get(host);
    if (!p) {
      p = (async () => {
        const leaf = await deps.ca.leafFor(host);
        const srv = Deno.serve(
          { hostname, port: 0, cert: leaf.cert, key: leaf.key, onListen: () => {} },
          (req) => proxyRequest(host, req, deps),
        );
        servers.push(srv);
        return srv.addr.port;
      })();
      backends.set(host, p);
      p.catch(() => backends.delete(host));
    }
    return p;
  };

  const listener = Deno.listen({ hostname, port: opts.port ?? 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const serve = async () => {
    for await (const conn of listener) handleConn(conn).catch(() => {});
  };
  const handleConn = async (conn: Deno.Conn): Promise<void> => {
    const host = await readConnect(conn);
    if (!host) {
      // not a CONNECT: this proxy only tunnels HTTPS
      await conn.write(new TextEncoder().encode("HTTP/1.1 405 Method Not Allowed\r\n\r\n"))
        .catch(() => {});
      conn.close();
      return;
    }
    const backendPort = await backendFor(host);
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    const up = await Deno.connect({ hostname, port: backendPort });
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

/** Read the CONNECT line off a fresh tunnel conn → the target host (no port). null if the
 *  first bytes aren't a CONNECT. */
async function readConnect(conn: Deno.Conn): Promise<string | null> {
  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  if (!n) return null;
  const head = new TextDecoder().decode(buf.subarray(0, n));
  const m = head.match(/^CONNECT (\S+?)(?::(\d+))? /);
  return m ? m[1] : null;
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
 * Env: MU_DIR · PORT. */
if (import.meta.main) {
  const { openCredentials } = await import("../store/credentials.ts");
  const { createGrantBroker } = await import("./grants.ts");
  const { openCA } = await import("./ca.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
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
  const ca = await openCA(dir);
  const proxy = startProxy({ ca, broker }, { port: Number(Deno.env.get("PORT") ?? 0) });
  const grant = await creds.get(key);
  const handle = broker.issue(key, grant?.agentId);
  console.error(`[proxy] on :${proxy.port} — fronting ${key}\n`);
  console.error(`export HTTPS_PROXY=http://127.0.0.1:${proxy.port}`);
  console.error(`export SSL_CERT_FILE=${proxy.caPath}`);
  console.error(`export GOOGLE_WORKSPACE_CLI_TOKEN=${handle}`);
}
