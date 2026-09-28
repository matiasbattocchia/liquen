/**
 * edge.ts — the org's one public door (DESIGN §9): the address grammar every service is
 * handed, and the process that stands behind it.
 *
 * A service needs the org's address for two things — where it pushes (a webhook, Graph's
 * notifications, an Events API request URL) and where a sign-in comes back (an OAuth
 * redirect URI) — and every one of those hangs off ONE base by path:
 *
 *   <publicUrl>/<service>/ingest             what the service pushes to
 *   <publicUrl>/<service>/oauth/callback     where its sign-in returns
 *
 * `edge.publicUrl` is that base, and it is all the org asks of whatever puts it on the
 * internet: publish `edge.port` at that https address. A quick tunnel, a named tunnel, a
 * host's own reverse proxy, a cloud's function router — each does exactly that, so the
 * harness knows none of them by name. With no `publicUrl` the org is reached on localhost
 * only: an ingest at its own port, a sign-in on the loopback callback (`callbackAddress`).
 *
 * The process: one listener on `edge.port` forwarding each path to the service's own
 * port, read off the catalog once at boot (the connector's `config.ts` spec names
 * `ingestPort` and `oauthPort`; a connector that declares neither has no door here). An
 * ingest is a server rooted at `/`, so it is handed the path UNDER `/<service>/ingest`; a
 * sign-in door matches by suffix, so it is handed the path as it came. Nothing answering
 * on the port is a 502 that names it — a service whose process is down, or a door nobody
 * is holding open — and a path outside the grammar is a 404.
 *
 * `liquen start` runs this as one more child, only under a `publicUrl`, and `edge.tunnel`
 * beside it when the org runs its own tunnel.
 */

import {
  checkPort,
  connectorConfig,
  type ConnectorSpec,
  findRoot,
  orgFlag,
  readConfig,
} from "./config.ts";
import { RUNNING } from "./connect/connect.ts";
import { entry } from "./entry.ts";

/** Where a service pushes: `<publicUrl>/<service>/ingest`, or null when the org has no
 *  public address — a service that must dial the org from the internet has nowhere to. */
export function ingestAddress(publicUrl: string | null, service: string): string | null {
  return publicUrl === null ? null : `${publicUrl}/${service}/ingest`;
}

/** Where a service's sign-in returns, the `redirect_uri` registered and sent: the public
 *  one under `publicUrl`, or the loopback one on the door's own port — this machine's
 *  browser, which Google and Entra permit in plain http. One grammar either way. */
export function callbackAddress(
  publicUrl: string | null,
  service: string,
  oauthPort: number,
): string {
  return `${publicUrl ?? `http://localhost:${oauthPort}`}/${service}/oauth/callback`;
}

/** What one service's door forwards to: its ingest, its sign-in door, either, or (a
 *  connector that pushes nothing and signs nobody in) neither. */
export interface Door {
  ingest?: number;
  oauth?: number;
}

/** A path under the grammar: the service, the leg, and the path the leg is handed. */
export function routeOf(
  pathname: string,
): { service: string; leg: keyof Door; rest: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)\/(ingest|oauth)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const [, service, leg, tail = ""] = m;
  return leg === "ingest"
    ? { service, leg: "ingest", rest: tail || "/" }
    : { service, leg: "oauth", rest: pathname };
}

/** The forwarder over a door table — pure over `fetchApi`, so a test hands it a stub. */
export function createEdge(
  doors: Map<string, Door>,
  fetchApi: typeof fetch = fetch,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const at = routeOf(url.pathname);
    if (!at) return text(404, "no such door");
    const port = doors.get(at.service)?.[at.leg];
    if (port === undefined) return text(404, `${at.service} has no ${at.leg} here`);
    const target = `http://127.0.0.1:${port}${at.rest}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    // the body is read whole: a delivery is a document, and a stream would tie the
    // answer's fate to a connection the service never sees
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetchApi(target, { method: req.method, headers, body, redirect: "manual" });
    } catch {
      return text(502, `${at.service}'s ${at.leg} is not answering on :${port}`);
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

/** The doors the catalog declares: for each connection, the ports its connector's spec
 *  names — `ingestPort` and `oauthPort`, read the way the connector reads them. A port
 *  of 0 is one the OS picks and only the announcement knows, so it is no door here. */
export async function doorsOf(root: string, connections: string[]): Promise<Map<string, Door>> {
  const doors = new Map<string, Door>();
  for (const name of connections) {
    const spec = await specOf(root, name);
    if (!spec) continue;
    const ports = spec.entries.filter((e) => e.check === checkPort).map((e) => e.key);
    const cfg = await connectorConfig<Record<string, number>>(root, spec);
    const door: Door = {};
    if (ports.includes("ingestPort") && cfg.ingestPort !== 0) door.ingest = cfg.ingestPort;
    if (ports.includes("oauthPort") && cfg.oauthPort !== 0) door.oauth = cfg.oauthPort;
    if (door.ingest !== undefined || door.oauth !== undefined) doors.set(name, door);
  }
  return doors;
}

/** A connector's spec: shipped beside this module, or the org's own under `connectors/`
 *  (CONNECTORS.md — a `config.ts` exporting `SPEC`); none for a connector that ships no
 *  config, or an org's whose folder has none. */
async function specOf(root: string, name: string): Promise<ConnectorSpec | null> {
  const url = RUNNING.includes(name)
    ? new URL(`./connect/${name}/config.ts`, import.meta.url).href
    : `${root}/connectors/${name}/config.ts`;
  try {
    const mod = await import(url) as { SPEC?: ConnectorSpec };
    return mod.SPEC ?? null;
  } catch (err) {
    if (err instanceof TypeError || err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Whether `ingestAddress` answers as the service — the whole path checked from the
 *  internet in, without knowing what carries it: an ingest names itself to a GET at its
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
    const { edge, connections } = await readConfig(root);
    if (edge.publicUrl === null) {
      throw new Error("edge.publicUrl is null — there is no public address to stand behind");
    }
    const doors = await doorsOf(root, Object.keys(connections));
    const legs = [...doors].flatMap(([name, d]) => [
      ...(d.ingest !== undefined ? [`/${name}/ingest → :${d.ingest}`] : []),
      ...(d.oauth !== undefined ? [`/${name}/oauth → :${d.oauth}`] : []),
    ]);
    try {
      Deno.serve({
        hostname: "::",
        port: edge.port,
        onListen: ({ port }) =>
          console.error(
            `[edge] ${edge.publicUrl} ← :${port}\n` + legs.map((l) => `[edge]   ${l}`).join("\n"),
          ),
      }, createEdge(doors));
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) {
        throw new Error(`port ${edge.port} in use — another org running? set edge.port`);
      }
      throw err;
    }
  });
}
