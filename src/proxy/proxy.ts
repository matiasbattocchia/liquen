/**
 * proxy/proxy.ts — the credential-injecting egress proxy (DESIGN §9).
 *
 * The wire half of the MITM the vault design is built on. A tool in user space is handed
 * its env vars (issued, never inherited — bash.ts clears the pocket first):
 *
 *   HTTPS_PROXY=http://<agent>:<nonce>@127.0.0.1:<port>
 *                                         send every HTTPS request here as a CONNECT tunnel
 *   HTTP_PROXY, http_proxy=<the same>     send every plain-HTTP request here, absolute-form
 *   SSL_CERT_FILE=<ca.pem>                trust ONLY the liquen CA (so this proxy can terminate)
 *   <VAR>=sentinel-<VAR>                  a PLACEHOLDER naming its own variable — the real
 *                                         token never enters user space; the var is the
 *                                         credential row's own declaration (`extra.env`)
 *
 * WHO is asking is the connection's: a client sends the URL's credentials as
 * `Proxy-Authorization` on a CONNECT and on each plain request, and the nonce must be the
 * agent's own (`caller`). A connection without one is answered `407` with a Basic
 * challenge (git asks only once challenged), so a process outside the agents' shells
 * reaches neither the grants nor the tunnels. The header is hop-by-hop and never reaches
 * the origin.
 *
 * The proxy terminates the tunnel's TLS with a leaf it mints for the dialed host (ca.ts),
 * reads the plaintext request, and — wherever a header value carries `sentinel-<VAR>` —
 * substitutes the real access token of the grant that agent is fronted under that
 * variable (`grantFor`), which the broker fetches from the vault (grants.ts). Then it
 * re-originates to the true host over real TLS and streams the answer back. User space never
 * holds a valid credential; the credential meets the request only here, at the last hop
 * before the origin.
 *
 * A tunnel is decrypted where it arrives: the proxy answers the CONNECT, runs TLS
 * server-side on the tunnel's own socket with the dialed host's leaf, and hands the
 * decrypted stream to an HTTP server that listens on nothing. The dialed authority is
 * `host`, or `host:port` off 443, and the port rides through to the origin.
 *
 * The proxy fronts credentials and fences nothing: it dials what it is asked, this machine's
 * loopback included, so a token naming a local service (`localhost:8080`) is swapped like
 * any other. A dial that fails is answered with its reason, as the status line's phrase
 * and the body, and audited like any other request.
 *
 * Plain HTTP arrives as requests in absolute form (`GET http://host:port/path`), each
 * served on its own — a client reuses one proxy connection across hosts — through the same
 * swap, toward `http://`; a placeholder rides it only toward a host its grant names with
 * its port (`plain`), so no token crosses a network in the clear by accident. A request that upgrades (a WebSocket, a dev server's reload
 * channel) is bridged to its origin as it came, and the connection is the origin's from
 * then on.
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
 * other dial (grants.ts hostAllowed), so a placeholder can't be aimed at an echo endpoint
 * to read the real token back. Its `extra.paths` binds the path the same way.
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { Duplex, Readable } from "node:stream";
// the runtime's web streams are node's; only their declarations differ
import type { ReadableStream as WebStream, WritableStream as WebSink } from "node:stream/web";
import type { Grant, GrantBroker } from "./grants.ts";
import type { CA, Leaf } from "./ca.ts";
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
  "proxy-connection",
]);
/** What a placeholder opens with; the variable it stands in follows. */
export const SENTINEL = "sentinel-";

/** The placeholder user space holds under `name`. */
export const sentinelOf = (name: string): string => `${SENTINEL}${name}`;

// the placeholder itself is the marker, wherever it rides: `Bearer sentinel-GH_TOKEN`, gh's
// `token sentinel-GH_TOKEN`, an `x-api-key: sentinel-API_KEY` — the swap is a SUBSTITUTION
// over every header value, preserving whatever surrounds it, so a new tool needs no proxy
// change. (A placeholder a tool base64s or signs over can't be substituted — such schemes
// belong broker-side.)
const SENTINEL_RE = /sentinel-([A-Za-z_][A-Za-z0-9_]*)/g;

/** The challenge a connection without the agent's credentials is answered with, and why. */
const CHALLENGE = 'Basic realm="liquen"';
const UNNAMED = "this proxy serves an agent's shell, named by its proxy URL";

export interface ProxyDeps {
  ca: CA;
  broker: GrantBroker;
  /** Whether `nonce` is `agentId`'s own: a connection is let in on its
   *  `Proxy-Authorization` alone, and every request on it is made for that agent. */
  caller: (agentId: string, nonce: string) => boolean;
  /** The grant an agent's `sentinel-<name>` stands for: the vault row fronted to that
   *  agent under `name`, or null when the variable is not the agent's. */
  grantFor: (agentId: string, name: string) => Promise<Grant | null>;
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
  /** Which authorities a placeholder may ride PLAIN HTTP to: the ones a fronted grant names
   *  with their port (`localhost:8080`), so a grant declared for `api.crm.io` never sends
   *  its token in the clear. Absent ⇒ none. */
  plain?: (authority: string) => boolean;
}

export interface EgressAudit {
  method: string;
  host: string; // the dialed authority: `host`, or `host:port` off the scheme's port
  path: string;
  status: number;
  agentId: string; // whose connection made it
  swapped: boolean; // did a placeholder get a real credential
}

/**
 * Serve one decrypted request `agentId` made toward the dialed authority: swap each
 * placeholder for the real token of the grant the agent is fronted under its variable,
 * re-originate, and audit. The request's own scheme is the origin's: `https:` off a
 * decrypted tunnel, `http:` off a plain-HTTP request. Pure over its deps (no TLS) — the
 * proxy's testable core.
 */
export async function proxyRequest(
  host: string,
  req: Request,
  deps: ProxyDeps,
  agentId: string,
): Promise<Response> {
  const originFetch = deps.originFetch ?? fetch;
  const audit = deps.audit ?? defaultAudit;
  const url = new URL(req.url);
  const target = `${url.protocol}//${host}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    // `fetch` decodes what IT asked for; a client's own negotiation would let an encoding
    // through that the body no longer carries (see the header note above)
    if (HOP_BY_HOP.has(key) || key === "accept-encoding") continue;
    headers.set(k, v);
  }

  let swapped = false;
  // every placeholder in the request, resolved once — a token per variable, refused as a
  // whole if any can't be honored for this agent toward THIS host
  const real = new Map<string, string>();
  const carried = [...headers].some(([, v]) => v.search(SENTINEL_RE) !== -1);
  if (carried && url.protocol === "http:" && !(deps.plain?.(host) ?? false)) {
    audit({ method: req.method, host, path: url.pathname, status: 403, agentId, swapped: false });
    return new Response(
      `liquen proxy: a credential rides plain HTTP only toward a host its grant names with ` +
        `its port (${host} is not one)\n`,
      { status: 403 },
    );
  }
  for (const [, v] of headers) {
    for (const { 0: placeholder, 1: name } of v.matchAll(SENTINEL_RE)) {
      if (real.has(placeholder)) continue;
      const grant = await deps.grantFor(agentId, name);
      // the path judged is the one re-originated: `target` is built from it
      const token = grant &&
        await deps.broker.accessTokenFor(
          deps.broker.issue(grant.credentialKey, grant.agentId),
          host,
          url.pathname,
        );
      if (!token) {
        // a placeholder we can't honor never leaves the box as-is (it would 401 upstream
        // and leak the variable's name) — fail it here: a variable the agent is not
        // fronted, a grant with no live credential, or one whose host or path binding
        // refuses the request
        audit({ method: req.method, host, path: url.pathname, status: 401, agentId, swapped });
        return new Response(
          grant
            ? "liquen proxy: no credential for this grant, or grant not valid for this host or path\n"
            : `liquen proxy: ${name} is no grant of ${agentId}'s\n`,
          { status: 401 },
        );
      }
      real.set(placeholder, token);
    }
  }
  if (real.size) {
    for (const [k, v] of [...headers]) {
      headers.set(k, v.replace(SENTINEL_RE, (p) => real.get(p) ?? p));
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
  /** The loopback port `HTTPS_PROXY` and `HTTP_PROXY` point at. */
  port: number;
  /** The CA cert path `SSL_CERT_FILE` points at. */
  caPath: string;
  shutdown(): Promise<void>;
}

/** What the HTTP server meets a connection as: a tunnel the proxy decrypted for one
 *  authority and the agent its CONNECT named, or a client's plain-HTTP requests in
 *  absolute form, each naming its agent itself. */
type Feed = { authority: string; agentId: string } | { plain: true };

/** The agent a `Proxy-Authorization` value names, when the nonce it carries is that
 *  agent's own; null for any other value, or none. */
export function callerOf(
  header: string | null | undefined,
  caller: ProxyDeps["caller"],
): string | null {
  const m = header?.match(/^\s*Basic\s+([A-Za-z0-9+/]+=*)\s*$/i);
  if (!m) return null;
  let said: string;
  try {
    said = atob(m[1]);
  } catch {
    return null;
  }
  const at = said.indexOf(":");
  if (at <= 0) return null;
  const agentId = decodeURIComponent(said.slice(0, at));
  return caller(agentId, said.slice(at + 1)) ? agentId : null;
}

/** Start the proxy on loopback. `port: 0` picks an ephemeral one (read `.port` back). */
export function startProxy(
  deps: ProxyDeps,
  opts: { port?: number; hostname?: string } = {},
): Proxy {
  const hostname = opts.hostname ?? "127.0.0.1";
  const audit = deps.audit ?? defaultAudit;
  const open = new Set<Deno.Conn>();
  // the parsing side: an HTTP server no socket listens for, handed each connection it serves
  const feeds = new WeakMap<object, Feed>();
  const server = http.createServer((req, res) => {
    const feed = feeds.get(req.socket);
    if (!feed) res.writeHead(421).end();
    else if ("authority" in feed) {
      void serve(feed.authority, "https:", req.url ?? "/", req, res, deps, feed.agentId);
    } else void servePlain(req, res, deps);
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, early: Uint8Array) => {
    const feed = feeds.get(socket);
    const agentId = callerOf(req.headers["proxy-authorization"], deps.caller);
    if (!feed || !("plain" in feed)) socket.destroy();
    else if (agentId === null) {
      socket.end(
        `HTTP/1.1 407 ${UNNAMED}\r\nproxy-authenticate: ${CHALLENGE}\r\nconnection: close\r\n\r\n`,
      );
    } else bridgeUpgrade(req, socket, early, audit, agentId);
  });
  // A server that is not listening is closing, to the runtime: it destroys a connection
  // the moment its answer is out instead of keeping it alive for the client's next
  // request, which a client reusing it meets as a dead connection. This one listens for
  // nothing and serves until shutdown, so it says so for exactly that long.
  let serving = true;
  Object.defineProperty(server, "listening", { get: () => serving });

  const listener = Deno.listen({ hostname, port: opts.port ?? 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const accept = async () => {
    for await (const conn of listener) {
      open.add(conn);
      handleConn(conn).catch(() => {}).finally(() => open.delete(conn));
    }
  };
  // a conn we can't serve gets an ANSWER that says why, and a close — never a silent hang
  const deny = async (conn: Deno.Conn, status: number, reason: string): Promise<void> => {
    const phrase = reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
    const body = `liquen proxy: ${phrase}\n`;
    const challenge = status === 407 ? `proxy-authenticate: ${CHALLENGE}\r\n` : "";
    await conn.write(
      new TextEncoder().encode(
        `HTTP/1.1 ${status} ${phrase}\r\ncontent-type: text/plain\r\n${challenge}` +
          `content-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      ),
    ).catch(() => {});
    try {
      conn.close();
    } catch { /* already closed */ }
  };
  const handleConn = async (conn: Deno.Conn): Promise<void> => {
    const head = await readHead(conn);
    if (!head) return deny(conn, 400, "send CONNECT host:port, or a request in absolute form");
    if (head.authority === undefined) return feed(conn, head.early, { plain: true });
    const authority = head.authority;
    const agentId = callerOf(head.auth, deps.caller);
    if (agentId === null) return deny(conn, 407, UNNAMED);
    const said = (status: number) =>
      audit({ method: "CONNECT", host: authority, path: "", status, agentId, swapped: false });
    const origin = originOf(authority);
    if (deps.terminates?.(authority) ?? true) {
      let leaf: Leaf;
      try {
        leaf = await deps.ca.leafFor(origin.hostname);
      } catch {
        said(502);
        return deny(conn, 502, `no certificate can stand for ${origin.hostname}`);
      }
      await answer(conn);
      return feed(conn, head.early, { authority, agentId }, leaf);
    }
    let up: Deno.Conn;
    try {
      up = await Deno.connect(origin);
    } catch {
      said(502);
      return deny(conn, 502, `${authority} did not answer`);
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
  // the connection handed to the server as a node socket, TLS run server-side on it first
  // when it is a tunnel to decrypt: no decrypted byte crosses a socket another process
  // could open
  const feed = (conn: Deno.Conn, early: Uint8Array, as: Feed, leaf?: Leaf) => {
    const readable = early.length ? prefixed(early, conn.readable) : conn.readable;
    const raw = Duplex.fromWeb({
      readable: readable as unknown as WebStream,
      writable: conn.writable as unknown as WebSink,
    });
    // the server calls a net socket's knobs on what it serves; a stream has none to turn
    const socket = leaf
      ? new tls.TLSSocket(raw, { isServer: true, cert: leaf.cert, key: leaf.key })
      : Object.assign(raw, {
        setTimeout: () => raw,
        setNoDelay: () => raw,
        setKeepAlive: () => raw,
      });
    feeds.set(socket, as);
    return new Promise<void>((resolve) => {
      socket.on("error", () => socket.destroy());
      socket.on("close", () => resolve());
      server.emit("connection", socket);
    });
  };

  const running = accept();

  return {
    port,
    caPath: deps.ca.caPath,
    async shutdown(): Promise<void> {
      serving = false;
      try {
        listener.close();
      } catch { /* already closed */ }
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

/** One plain-HTTP request: its absolute-form URL names the origin, and its
 *  `Proxy-Authorization` the agent it is made for. */
function servePlain(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProxyDeps,
): Promise<void> {
  const url = URL.parse(req.url ?? "");
  if (url?.protocol !== "http:") {
    res.writeHead(400, { "content-type": "text/plain" }).end(
      "liquen proxy: a plain-HTTP request names its origin (GET http://host/path); " +
        "HTTPS comes as CONNECT host:port\n",
    );
    return Promise.resolve();
  }
  const agentId = callerOf(req.headers["proxy-authorization"], deps.caller);
  if (agentId === null) {
    res.writeHead(407, { "proxy-authenticate": CHALLENGE, "content-type": "text/plain" })
      .end(`liquen proxy: ${UNNAMED}\n`);
    return Promise.resolve();
  }
  return serve(url.host, "http:", `${url.pathname}${url.search}`, req, res, deps, agentId);
}

/** One request, as the HTTP server parsed it, through `proxyRequest` and back. */
async function serve(
  authority: string,
  scheme: "https:" | "http:",
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ProxyDeps,
  agentId: string,
): Promise<void> {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const framed = req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"] ?? 0) > 0;
  const request = new Request(`${scheme}//${authority}${path}`, {
    method: req.method,
    headers,
    ...(framed ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  });
  let response: Response;
  try {
    response = await proxyRequest(authority, request, deps, agentId);
  } catch {
    response = new Response(`liquen proxy: ${authority} did not answer\n`, { status: 502 });
  }
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of response.headers) if (k !== "set-cookie") out[k] = v;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as unknown as WebStream).pipe(res);
}

/** A plain-HTTP request that upgrades, bridged to its origin: the request as it came, in
 *  origin form, then the bytes both ways. It is audited as the dial, like a blind tunnel. */
function bridgeUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  early: Uint8Array,
  audit: (line: EgressAudit) => void,
  agentId: string,
): void {
  const url = URL.parse(req.url ?? "");
  if (url?.protocol !== "http:") return void socket.destroy();
  const said = (status: number) =>
    audit({
      method: req.method ?? "GET",
      host: url.host,
      path: url.pathname,
      status,
      agentId,
      swapped: false,
    });
  const up = net.connect({
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port || 80),
  });
  up.once("error", () => {
    said(502);
    socket.end(`HTTP/1.1 502 ${url.host} did not answer\r\nconnection: close\r\n\r\n`);
  });
  up.once("connect", () => {
    said(101);
    let head = `${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (/^proxy-/i.test(req.rawHeaders[i])) continue;
      head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(`${head}\r\n`);
    if (early.length) up.write(early);
    up.removeAllListeners("error");
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
    socket.pipe(up);
    up.pipe(socket);
  });
}

/** The origin a dialed authority names: `host`, or `host:port` off 443; an IPv6 literal
 *  without its brackets. */
function originOf(authority: string): { hostname: string; port: number } {
  const m = authority.match(/^(.*?)(?::(\d+))?$/)!;
  return { hostname: m[1].replace(/^\[(.*)\]$/, "$1"), port: m[2] ? Number(m[2]) : 443 };
}

/** Read what opens a fresh conn (it may arrive in pieces). A CONNECT is read whole: the
 *  dialed authority (`host`, or `host:port` off 443), its `Proxy-Authorization`, and any
 *  bytes past the head, an optimistic client's first tunnel bytes. Anything else is a
 *  plain-HTTP request, handed back as the bytes read so far. null if the conn closed, or
 *  sent no head in 4 KiB. */
async function readHead(
  conn: Deno.Conn,
): Promise<{ authority?: string; auth?: string; early: Uint8Array } | null> {
  const buf = new Uint8Array(4096);
  let n = 0;
  while (true) {
    if (n === buf.length) return null;
    const read = await conn.read(buf.subarray(n));
    if (read === null) return null;
    n += read;
    const line = new TextDecoder().decode(buf.subarray(0, Math.min(n, 8)));
    if (!"CONNECT ".startsWith(line) && !line.startsWith("CONNECT ")) {
      return { early: buf.slice(0, n) };
    }
    const end = headEnd(buf, n);
    if (end < 0) continue;
    const text = new TextDecoder().decode(buf.subarray(0, end));
    const m = text.match(/^CONNECT (\S+?)(?::(\d+))? /);
    if (!m) return null;
    const authority = !m[2] || m[2] === "443" ? m[1] : `${m[1]}:${m[2]}`;
    const auth = text.match(/\r\nproxy-authorization:[ \t]*([^\r\n]*)/i)?.[1];
    return { authority, ...(auth !== undefined ? { auth } : {}), early: buf.slice(end, n) };
  }
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
    `[proxy] ${a.agentId} ${a.method} ${a.host}${a.path} → ${a.status}` +
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

    const grant = await creds.get(key);
    // the row's own declaration names the var (main.ts fronts the same way): a grant that
    // declares none is fronted nowhere
    const varName = grant?.extra?.env;
    if (typeof varName !== "string") {
      console.error(`[proxy] ${key} declares no env var (extra.env): nothing to front`);
      Deno.exit(2);
    }
    // this proxy serves one caller, the shell it prints for, by a nonce of its own
    const who = grant?.agentId ?? "org";
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const ca = await openCA(dir);
    const proxy = startProxy({
      ca,
      broker: createGrantBroker({ creds }),
      caller: (agentId, said) => agentId === who && said === nonce,
      grantFor: (_agentId, name) =>
        Promise.resolve(
          name === varName
            ? { credentialKey: key, ...(grant?.agentId ? { agentId: grant.agentId } : {}) }
            : null,
        ),
    });
    const at = `http://${encodeURIComponent(who)}:${nonce}@127.0.0.1:${proxy.port}`;
    console.error(`[proxy] on :${proxy.port} — fronting ${key}\n`);
    console.error(`export HTTPS_PROXY=${at}`);
    console.error(`export HTTP_PROXY=${at}`);
    console.error(`export SSL_CERT_FILE=${proxy.caPath}`);
    console.error(`export ${varName}=${sentinelOf(varName)}`);
  });
}
