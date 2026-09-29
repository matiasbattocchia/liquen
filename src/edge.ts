/**
 * edge.ts — the org's one door (DESIGN §9): the address grammar every service is handed,
 * and the process that stands behind it.
 *
 * A service needs the org's address for two things — where it pushes (a webhook, Graph's
 * notifications, an Events API request URL) and where a sign-in comes back (an OAuth
 * redirect URI) — and every one of those hangs off ONE base by path:
 *
 *   <base>/<service>/ingest             what the service pushes to
 *   <base>/<service>/oauth/callback     where its sign-in returns
 *
 * The base is `edge.publicUrl` for a dialer on the internet, and this machine's edge,
 * `http://localhost:<edge.port>`, for one on this host — a browser here, the whatsmeow
 * bridge, `gh webhook forward`. `publicUrl` is all the org asks of whatever puts it on
 * the internet: publish `edge.port` at that https address. A named tunnel, a host's own
 * reverse proxy, a cloud's function router — each does exactly that, so the harness knows
 * none of them by name.
 *
 * Behind the port the connectors listen on Unix sockets under the org's own folder,
 * `data/run/<service>.sock` for an ingest and `data/run/<service>-oauth.sock` for a
 * sign-in door (`socketOf`): the location is the whole address, so a connector declares
 * nothing to be reachable, and two orgs on one machine never meet. The edge forwards each
 * path to the socket the grammar names — an ingest is a server rooted at `/`, so it is
 * handed the path UNDER `/<service>/ingest`; a door matches by suffix, so it is handed
 * the path as it came. Nothing answering on the socket is a 502 that names it — a service
 * whose process is down, or a door nobody is holding open — and a path outside the
 * grammar is a 404. `liquen start` runs the edge as one more child, always, and
 * `edge.tunnel` beside it when the org runs its own tunnel.
 */

import { findRoot, type OrgConfig, orgFlag, readConfig, SERVICE_NAME } from "./config.ts";
import { entry } from "./entry.ts";

/** This machine's edge, as a dialer on this host reaches it. */
export function localBase(port: number): string {
  return `http://localhost:${port}`;
}

/** Where a service pushes: `<base>/<service>/ingest`. The base is the one the dialer can
 *  reach — `edge.publicUrl` from the internet, `localBase` from this host. */
export function ingestAddress(base: string, service: string): string {
  return `${base}/${service}/ingest`;
}

/** Where a service's sign-in returns, the `redirect_uri` registered and sent: under
 *  `publicUrl` when the org has one — a member signs in from anywhere — else on this
 *  machine's edge, whose browser Google and Entra permit in plain http. One grammar
 *  either way. */
export function callbackAddress(
  edge: Pick<OrgConfig["edge"], "publicUrl" | "port">,
  service: string,
): string {
  return `${edge.publicUrl ?? localBase(edge.port)}/${service}/oauth/callback`;
}

/** The two legs a service may serve. */
export type Leg = "ingest" | "oauth";

/** The socket a service's leg is served on, under the org's own folder. */
export function socketOf(root: string, service: string, leg: Leg): string {
  return `${root}/data/run/${service}${leg === "oauth" ? "-oauth" : ""}.sock`;
}

/** A path under the grammar: the service, the leg, and the path the leg is handed. */
export function routeOf(pathname: string): { service: string; leg: Leg; rest: string } | null {
  const m = /^\/([^/]+)\/(ingest|oauth)(\/.*)?$/.exec(pathname);
  if (!m || !SERVICE_NAME.test(m[1])) return null;
  const [, service, leg, tail = ""] = m;
  return leg === "ingest"
    ? { service, leg: "ingest", rest: tail || "/" }
    : { service, leg: "oauth", rest: pathname };
}

/** The forwarder over the org's sockets. */
export function createEdge(root: string): (req: Request) => Promise<Response> {
  const clients = new Map<string, Deno.HttpClient>();
  const clientFor = (path: string): Deno.HttpClient => {
    let c = clients.get(path);
    if (!c) {
      c = Deno.createHttpClient({ proxy: { transport: "unix", path } });
      clients.set(path, c);
    }
    return c;
  };
  return async (req) => {
    const url = new URL(req.url);
    const at = routeOf(url.pathname);
    if (!at) return text(404, "no such door");
    const sock = socketOf(root, at.service, at.leg);
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    // the body is read whole: a delivery is a document, and a stream would tie the
    // answer's fate to a connection the service never sees
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetch(`http://localhost${at.rest}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        client: clientFor(sock),
      });
    } catch {
      // the path under the org, not the machine's: this answer reaches the internet
      const where = sock.slice(root.length + 1);
      return text(502, `${at.service}'s ${at.leg} is not listening (${where})`);
    }
    // the leg's answer as it gave it, a sign-in's redirect included; the framing headers
    // are the connection's own and are rewritten by the one that serves this response
    const out = new Headers(res.headers);
    for (const h of ["content-length", "content-encoding", "transfer-encoding", "connection"]) {
      out.delete(h);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
}

/** Whether `address` answers as the service — the whole path checked from where the
 *  dialer stands, without knowing what carries it: an ingest names itself to a GET at its
 *  root (`serveIngest`), so a tunnel that is down, aimed at another port or in front of
 *  another org each answer with something else. Null when it does; else what it said. */
export async function reached(address: string, service: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(address, { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const said = (await res.text()).trim();
  if (res.ok && said === service) return null;
  return `HTTP ${res.status}${said ? ` "${said.slice(0, 80)}"` : ""}`;
}
const REACH_TIMEOUT_MS = 10_000;

/** The line a door prints about the address it just handed a service. */
export async function reachLine(address: string, service: string): Promise<string> {
  const fault = await reached(address, service);
  return fault === null
    ? `✓ ${address} answers as ${service}`
    : `✗ ${address} does not answer as ${service} (${fault}) — is the tunnel up, and does ` +
      `it publish edge.port? The service cannot deliver until it does`;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

if (import.meta.main) {
  await entry(async () => {
    const root = findRoot(orgFlag());
    const { edge } = await readConfig(root);
    try {
      // "::" is every interface of BOTH families: `localhost` is ::1 as much as
      // 127.0.0.1, and a dialer that resolves it to ::1 first (Go's pure resolver does,
      // some of the time) would be refused by an IPv4-only listener and lose the batch
      Deno.serve({
        hostname: "::",
        port: edge.port,
        onListen: ({ port }) =>
          console.error(
            `${edge.publicUrl ?? localBase(port)} ← :${port} → ${root}/data/run/*.sock`,
          ),
      }, createEdge(root));
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) {
        throw new Error(`port ${edge.port} in use — another org running? set edge.port`);
      }
      throw err;
    }
  });
}
