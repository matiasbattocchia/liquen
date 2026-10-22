/**
 * proxy/proxy.ts — the credential-injecting egress proxy (DESIGN §9).
 *
 * The wire half of the MITM the vault design is built on. A tool in user space is handed
 * three env vars (issued, never inherited — bash.ts clears the pocket first):
 *
 *   HTTPS_PROXY=http://127.0.0.1:<port>   send every HTTPS request here as a CONNECT tunnel
 *   SSL_CERT_FILE=<ca.pem>                trust ONLY the liquen CA (so this proxy can terminate)
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
 * A tunnel is decrypted where it arrives: the proxy answers the CONNECT, runs TLS
 * server-side on the tunnel's own socket with the dialed host's leaf, and hands the
 * decrypted stream to an HTTP server that listens on nothing. The dialed authority is
 * `host`, or `host:port` off 443, and the port rides through to the origin.
 *
 * Every dial is judged first (guard.ts): the name is resolved once, an address in the
 * refused set (loopback, link-local, metadata, this machine's own) is dropped, and the
 * address that survived is the one dialed. A refusal is answered with its reason, as the
 * status line's phrase and the body, and audited like any other request.
 *
 * A bubble reaches the proxy over a unix socket of its agent's own (`sockets`), so every
 * connection over it is known to be that agent's: the audit names it even for a tunnel
 * bridged blind, and a handle naming another agent's grant is refused there.
 *
 * The proxy speaks IDENTITY to its client. `fetch` negotiates compression with the origin
 * and hands back a DECODED body, but the headers it exposes still describe the encoded
 * entity — `content-encoding: gzip` over bytes that are no longer gzip, `content-length`
 * counting the compressed ones. Copying those onto the decoded body truncates every reader
 * at the compressed length: a 170 KB discovery document arriving as 23 KB of
 * valid-prefix JSON, which is how this was found. So the request's own `accept-encoding`
 * is dropped on the way out (let `fetch` ask for what it can decode) and both headers are
 * dropped on the way back — the hop is loopback, where a compressed body buys nothing.
 *
 * One policy rule attaches at the plaintext seam: the grant's HOST BINDING. A credential
 * row that declares `extra.hosts` spends only toward those origins — the swap refuses any
 * other dial (grants.ts hostAllowed), so a handle can't be aimed at an echo endpoint to
 * read the real token back. Method/path policy would attach at the same seam; none yet.
 */

import http from "node:http";
import tls from "node:tls";
import { Duplex, Readable } from "node:stream";
// the runtime's web streams are node's; only their declarations differ
import type { ReadableStream as WebStream, WritableStream as WebSink } from "node:stream/web";
import type { GrantBroker } from "./grants.ts";
import type { CA, Leaf } from "./ca.ts";
import { addressGuard, type Guard, Refused } from "./guard.ts";
import { findRoot, orgFlag } from "../config.ts";
import { entry } from "../entry.ts";

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
  /** Which dialed authorities the proxy TERMINATES: the hosts a fronted grant binds, where
   *  a placeholder can ride and the swap has to see plaintext. Every other tunnel is
   *  bridged blind to the origin — the client sees the origin's own certificate, so a tool
   *  verifying against its own bundle (pip, requests, npm) reaches the world untouched.
   *  Absent ⇒ every authority terminates. */
  terminates?: (authority: string) => boolean;
  /** What a dial may reach (guard.ts); absent ⇒ the built-in refused set alone. */
  guard?: Guard;
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
 * core. `caller` is the agent whose socket the request came over, when it came over one:
 * a handle naming another agent's grant is refused.
 */
export async function proxyRequest(
  host: string,
  req: Request,
  deps: ProxyDeps,
  caller?: string,
): Promise<Response> {
  const originFetch = deps.originFetch ?? fetch;
  const audit = deps.audit ?? defaultAudit;
  const url = new URL(req.url);
  const target = `https://${host}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    // `fetch` decodes what IT asked for; a client's own negotiation would let an encoding
    // through that the body no longer carries (see the header note above)
    if (HOP_BY_HOP.has(key) || key === "accept-encoding") continue;
    headers.set(k, v);
  }

  let swapped = false;
  let agentId = caller;
  // every handle in the request, resolved once — a token per distinct handle, refused as
  // a whole if any can't be honored toward THIS host
  const real = new Map<string, string>();
  for (const [, v] of headers) {
    for (const { 0: handle } of v.matchAll(HANDLE_RE)) {
      if (real.has(handle)) continue;
      const owner = deps.broker.resolve(handle)?.agentId;
      if (caller !== undefined && owner !== undefined && owner !== caller) {
        audit({ method: req.method, host, path: url.pathname, status: 403, agentId, swapped });
        return new Response(`liquen proxy: this grant is ${owner}'s, not ${caller}'s\n`, {
          status: 403,
        });
      }
      agentId ??= owner;
      // the path judged is the one re-originated: `target` is built from it
      const token = await deps.broker.accessTokenFor(handle, host, url.pathname);
      if (!token) {
        // a placeholder we can't honor never leaves the box as-is (it would 401 upstream
        // and leak the handle) — fail it here; same answer when the grant's host or path
        // binding refuses the request
        audit({
          method: req.method,
          host,
          path: url.pathname,
          status: 401,
          agentId,
          swapped: false,
        });
        return new Response(
          "liquen proxy: no credential for this grant, or grant not valid for this host or path\n",
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

  // strip hop-by-hop off the way back too, and the two headers that describe an encoding
  // the body no longer carries; keep the body streaming and let the runtime frame it
  const out = new Headers();
  for (const [k, v] of res.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === "content-encoding" || key === "content-length") continue;
    out.append(k, v); // a header the origin sent twice (`set-cookie`) is sent twice
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export interface Proxy {
  /** The loopback port `HTTPS_PROXY` points at. */
  port: number;
  /** The CA cert path `SSL_CERT_FILE` points at. */
  caPath: string;
  shutdown(): Promise<void>;
}

/** A unix socket the proxy accepts on for one agent: every connection over it is that
 *  agent's, so the agent is known before a byte is read (exec/bubble.ts). */
export interface AgentSocket {
  path: string;
  agentId: string;
}

/** A tunnel the proxy decrypts, as the HTTP server meets its requests. */
interface Tunnel {
  authority: string;
  caller?: string;
}

/** Start the proxy on loopback. `port: 0` picks an ephemeral one (read `.port` back).
 *  `sockets` are unix sockets it also accepts on, the same protocol, one per agent. */
export function startProxy(
  deps: ProxyDeps,
  opts: { port?: number; hostname?: string; sockets?: AgentSocket[] } = {},
): Proxy {
  const hostname = opts.hostname ?? "127.0.0.1";
  const guard = deps.guard ?? addressGuard();
  const audit = deps.audit ?? defaultAudit;
  const open = new Set<Deno.Conn>();
  // the decrypted side: an HTTP server no socket listens for, handed each tunnel it serves
  const tunnels = new WeakMap<object, Tunnel>();
  const server = http.createServer((req, res) => {
    const tunnel = tunnels.get(req.socket);
    if (tunnel) void serveDecrypted(tunnel, req, res, deps);
    else res.writeHead(421).end();
  });
  // A server that is not listening is closing, to the runtime: it destroys a connection
  // the moment its answer is out instead of keeping it alive for the client's next
  // request, which a client reusing it meets as a dead connection. This one listens for
  // nothing and serves until shutdown, so it says so for exactly that long.
  let serving = true;
  Object.defineProperty(server, "listening", { get: () => serving });

  const listener = Deno.listen({ hostname, port: opts.port ?? 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const listeners: [Deno.Listener, string?][] = [[listener]];
  for (const { path, agentId } of opts.sockets ?? []) {
    try {
      Deno.removeSync(path); // a socket a stopped harness left behind
    } catch { /* none */ }
    listeners.push([Deno.listen({ transport: "unix", path }), agentId]);
  }

  const serve = () =>
    Promise.all(listeners.map(async ([l, caller]) => {
      for await (const conn of l) {
        open.add(conn);
        handleConn(conn, caller).catch(() => {}).finally(() => open.delete(conn));
      }
    }));
  // a conn we can't tunnel gets an ANSWER that says why, and a close — never a silent hang
  const deny = async (conn: Deno.Conn, status: number, reason: string): Promise<void> => {
    const phrase = reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
    const body = `liquen proxy: ${phrase}\n`;
    await conn.write(
      new TextEncoder().encode(
        `HTTP/1.1 ${status} ${phrase}\r\ncontent-type: text/plain\r\n` +
          `content-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      ),
    ).catch(() => {});
    try {
      conn.close();
    } catch { /* already closed */ }
  };
  const handleConn = async (conn: Deno.Conn, caller?: string): Promise<void> => {
    const head = await readConnect(conn);
    if (!head) return deny(conn, 405, "this proxy only tunnels: send CONNECT host:port");
    const said = (status: number) =>
      audit({
        method: "CONNECT",
        host: head.authority,
        path: "",
        status,
        swapped: false,
        agentId: caller,
      });
    const origin = originOf(head.authority);
    let address: string;
    try {
      address = await guard.pick(origin.hostname);
    } catch (err) {
      const refused = err instanceof Refused;
      said(refused ? 403 : 502);
      return deny(conn, refused ? 403 : 502, err instanceof Error ? err.message : String(err));
    }
    if (deps.terminates?.(head.authority) ?? true) {
      let leaf: Leaf;
      try {
        leaf = await deps.ca.leafFor(origin.hostname);
      } catch {
        said(502);
        return deny(conn, 502, `no certificate can stand for ${origin.hostname}`);
      }
      await answer(conn);
      return terminate(conn, head.early, leaf, { authority: head.authority, caller });
    }
    let up: Deno.Conn;
    try {
      up = await Deno.connect({ hostname: address, port: origin.port });
    } catch {
      said(502);
      return deny(conn, 502, `${head.authority} did not answer`);
    }
    said(200);
    await answer(conn);
    try {
      // bytes an optimistic client sent past the CONNECT head are the tunnel's first bytes
      for (let off = 0; off < head.early.length;) off += await up.write(head.early.subarray(off));
    } catch { /* a broken tunnel surfaces in the pipes below */ }
    await Promise.all([
      conn.readable.pipeTo(up.writable).catch(() => {}),
      up.readable.pipeTo(conn.writable).catch(() => {}),
    ]);
  };
  // TLS server-side on the tunnel's own socket, the decrypted stream handed to the server:
  // no decrypted byte crosses a socket another process could open
  const terminate = (conn: Deno.Conn, early: Uint8Array, leaf: Leaf, tunnel: Tunnel) => {
    const readable = early.length ? prefixed(early, conn.readable) : conn.readable;
    const raw = Duplex.fromWeb({
      readable: readable as unknown as WebStream,
      writable: conn.writable as unknown as WebSink,
    });
    const decrypted = new tls.TLSSocket(raw, { isServer: true, cert: leaf.cert, key: leaf.key });
    tunnels.set(decrypted, tunnel);
    return new Promise<void>((resolve) => {
      decrypted.on("error", () => decrypted.destroy());
      decrypted.on("close", () => resolve());
      server.emit("connection", decrypted);
    });
  };

  const running = serve();

  return {
    port,
    caPath: deps.ca.caPath,
    async shutdown(): Promise<void> {
      serving = false;
      for (const [l] of listeners) {
        try {
          l.close();
        } catch { /* already closed */ }
      }
      await running.catch(() => {});
      for (const conn of open) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      server.close();
    },
  };
}

const answer = (conn: Deno.Conn) =>
  conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"))
    .catch(() => 0);

/** `first`, then everything `rest` carries. */
function prefixed(first: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let sent = false;
  return new ReadableStream({
    async pull(c) {
      if (!sent) {
        sent = true;
        return c.enqueue(first);
      }
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** One decrypted request, as the HTTP server parsed it, through `proxyRequest` and back. */
async function serveDecrypted(
  tunnel: Tunnel,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProxyDeps,
): Promise<void> {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const framed = req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"] ?? 0) > 0;
  const request = new Request(`https://${tunnel.authority}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    ...(framed ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  });
  let response: Response;
  try {
    response = await proxyRequest(tunnel.authority, request, deps, tunnel.caller);
  } catch {
    response = new Response(`liquen proxy: ${tunnel.authority} did not answer\n`, {
      status: 502,
    });
  }
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of response.headers) if (k !== "set-cookie") out[k] = v;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as unknown as WebStream).pipe(res);
}

/** The origin a dialed authority names: `host`, or `host:port` off 443. */
function originOf(authority: string): { hostname: string; port: number } {
  const m = authority.match(/^(.*?)(?::(\d+))?$/)!;
  return { hostname: m[1], port: m[2] ? Number(m[2]) : 443 };
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

export function defaultAudit(a: EgressAudit): void {
  console.error(
    `[proxy] ${a.agentId ?? "-"} ${a.method} ${a.host}${a.path} → ${a.status}` +
      (a.swapped ? " (swapped)" : ""),
  );
}

/* ── standalone entry: serve the proxy over the org vault ───────────────────────────────
 *
 *   deno task proxy [--dir <org>] [credential_key]   # default: the org's google grant, if exactly one
 *
 * Prints the three env vars a tool needs. Verify by hand:
 *   HTTPS_PROXY=… SSL_CERT_FILE=… GOOGLE_WORKSPACE_CLI_TOKEN=… \
 *     gws calendar events list --params '{"calendarId":"primary"}'
 * Env: none — the port is EPHEMERAL (printed at start; main runs its own in-process). */
if (import.meta.main) {
  await entry(async () => {
    const { openStore } = await import("../store/mod.ts");
    const { createGrantBroker } = await import("./grants.ts");
    const { openCA } = await import("./ca.ts");
    const org = orgFlag();
    const root = findRoot(org);
    const dir = `${root}/data`;
    const store = await openStore(root);
    const creds = await store.vault();

    let key = org.args[0];
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
    const proxy = startProxy({ ca, broker });
    const grant = await creds.get(key);
    // the row's own declaration names the var (main.ts fronts the same way): a grant that
    // declares none is fronted nowhere
    const varName = grant?.extra?.env;
    if (typeof varName !== "string") {
      console.error(`[proxy] ${key} declares no env var (extra.env): nothing to front`);
      Deno.exit(2);
    }
    const handle = broker.issue(key, grant?.agentId);
    console.error(`[proxy] on :${proxy.port} — fronting ${key}\n`);
    console.error(`export HTTPS_PROXY=http://127.0.0.1:${proxy.port}`);
    console.error(`export SSL_CERT_FILE=${proxy.caPath}`);
    console.error(`export ${varName}=${handle}`);
  });
}
