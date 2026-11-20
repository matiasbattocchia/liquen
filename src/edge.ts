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
 * Behind the port the connectors listen on Unix sockets under the org's own folder, a
 * folder per leg: `data/run/ingest/<service>.sock` for an ingest and
 * `data/run/oauth/<service>.sock` for a sign-in door (`socketOf`). The location is the
 * whole address, so a connector declares nothing to be reachable, and two orgs on one
 * machine never meet. The edge forwards each path to the socket the grammar names — an
 * ingest is a server rooted at `/`, so it is handed the path UNDER `/<service>/ingest`; a
 * door matches by suffix, so it is handed the path as it came. Nothing answering on an
 * ingest's socket is a 502 that names it, a service whose process is down; nothing at a
 * door is a 410 that tells the person no sign-in is open, since a door stands only while
 * one is; and a path outside the grammar is a 404. One more head stands beside the
 * grammar: `/pages/…`, the pages agents publish, goes to `data/run/pages.sock`, which
 * main serves, with the path as it came (`pagesSocket`).
 *
 * The edge forwards into the two leg folders and to the pages alone, so no path reaches
 * the org's own sockets beside them in `data/run` — main's, the run's, which answer
 * whoever reaches them. And it forwards only for a connector the org has
 * (`connectorsOf`: the shipped ones and its own under `connectors/`): any other name is a
 * 404, and the edge's log says so the first time it is asked. The folders are kept to
 * that too (`keepLegs`): anything in one that is not a socket named for a connector — a
 * server some other process put there, a link to another socket — is removed as it
 * appears, and the log says what and why.
 *
 * The edge listens on this machine's loopback when everything that dials it is here — the
 * org's own tunnel (`edge.tunnel`), a browser, the bridge — and on every interface when
 * the `publicUrl` is published by something the org does not run, a host's proxy or a
 * platform's router, which may dial from off the machine (`listensOn`). `liquen start`
 * runs the edge as one more child, always, and `edge.tunnel` beside it when the org runs
 * its own tunnel.
 */

import { findRoot, type OrgConfig, orgFlag, SERVICE_NAME } from "./config.ts";
import { readConfig } from "./org.ts";
import { entry } from "./entry.ts";
import { connectorsOf } from "./connect/shipped.ts";

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
const LEGS: Leg[] = ["ingest", "oauth"];

/** The folder a leg's sockets are in, under the org's own: the edge forwards into these
 *  and nowhere else. */
export function legDir(root: string, leg: Leg): string {
  return `${root}/data/run/${leg}`;
}

/** The socket a service's leg is served on. */
export function socketOf(root: string, service: string, leg: Leg): string {
  return `${legDir(root, leg)}/${service}.sock`;
}

/** Where the edge listens (the header): loopback when everything that dials it is on this
 *  machine, both families, since `localhost` is ::1 as much as 127.0.0.1 and a dialer
 *  that resolves it to ::1 first (Go's pure resolver does, some of the time) would be
 *  refused by an IPv4-only listener and lose the batch; and every interface when a
 *  publicUrl is answered by something the org does not run, "::" being every interface
 *  of both families. */
export function listensOn(edge: Pick<OrgConfig["edge"], "publicUrl" | "tunnel">): string[] {
  return edge.publicUrl && !edge.tunnel ? ["::"] : ["127.0.0.1", "::1"];
}

/** The socket main serves the pages on (pages.ts): every path under `/pages/`, handed as
 *  it came. */
export function pagesSocket(root: string): string {
  return `${root}/data/run/pages.sock`;
}

/** Whether a path is a page's: `/pages/<id>` and everything under it. */
export function isPagePath(pathname: string): boolean {
  return pathname.startsWith("/pages/");
}

/** Where a page opens: under `publicUrl` when the org has one, else on this machine's
 *  edge. */
export function pageAddress(
  edge: Pick<OrgConfig["edge"], "publicUrl" | "port">,
  id: string,
): string {
  return `${edge.publicUrl ?? localBase(edge.port)}/pages/${id}`;
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

/** What a person reads at a sign-in door no sign-in holds open. */
export const SIGN_IN_CLOSED = "No sign-in is open here. If you just signed in, it is done: " +
  "you can close this window. Otherwise, ask for a new link.";

/** What the edge says to its log: a line on stderr, which `liquen start` keeps. */
export type Say = (line: string) => void;
const toLog: Say = (line) => console.error(line);

/** The forwarder over the org's sockets. */
export function createEdge(root: string, say: Say = toLog): (req: Request) => Promise<Response> {
  // the names refused so far, each said once: a path anyone may send is no reason to fill
  // the log, and the count of them is bounded the same way
  const refused = new Set<string>();
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
    const page = isPagePath(url.pathname);
    const at = page ? null : routeOf(url.pathname);
    if (!page && !at) return text(404, "no such door");
    if (at && !connectorsOf(root).has(at.service)) {
      if (!refused.has(at.service)) {
        if (refused.size >= REFUSED_KEPT) refused.clear();
        refused.add(at.service);
        say(`refused /${at.service}/${at.leg}: no connector is named ${at.service}`);
      }
      return text(404, "no such door");
    }
    const sock = at ? socketOf(root, at.service, at.leg) : pagesSocket(root);
    const rest = at ? at.rest : url.pathname;
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    // the body is read whole: a delivery is a document, and a stream would tie the
    // answer's fate to a connection the service never sees
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetch(`http://localhost${rest}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        client: clientFor(sock),
      });
    } catch {
      // a sign-in door stands only while one of its sign-ins is open: a reload of the page
      // that finished one, or a stale link, meets it closed, and the person reads why
      if (at?.leg === "oauth") return text(410, SIGN_IN_CLOSED);
      // the path under the org, not the machine's: this answer reaches the internet
      const where = sock.slice(root.length + 1);
      return text(
        502,
        at
          ? `${at.service}'s ${at.leg} is not listening (${where})`
          : `pages are not served (${where})`,
      );
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
const REFUSED_KEPT = 256;

/** Keep each leg's folder to the org's connectors (the header): what is in it now, and
 *  whatever appears in it after, is left only when it is a socket named for one. Returns
 *  stop. */
export async function keepLegs(root: string, say: Say = toLog): Promise<() => void> {
  // each folder by its real path, the one the watch's events are spelled in
  const dirs: string[] = [];
  for (const leg of LEGS) {
    await Deno.mkdir(legDir(root, leg), { recursive: true });
    dirs.push(await Deno.realPath(legDir(root, leg)));
  }
  const tend = async (path: string) => {
    const at = dirs.indexOf(path.slice(0, path.lastIndexOf("/")));
    if (at < 0) return; // a folder itself, not what is in it
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch {
      return; // gone already: a door that closed, or the removal below
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const service = name.endsWith(".sock") ? name.slice(0, -".sock".length) : null;
    const fault = service === null
      ? "not a connector's socket"
      : !connectorsOf(root).has(service)
      ? `no connector is named ${service}`
      : info.isSymlink
      ? "a link, not a socket"
      : info.isSocket
      ? null
      : "not a socket";
    if (fault === null) return;
    const where = `data/run/${LEGS[at]}/${name}`;
    try {
      await Deno.remove(path, { recursive: true });
      say(`removed ${where}: ${fault}`);
    } catch (err) {
      say(`${where} is ${fault}, and stays: ${err instanceof Error ? err.message : err}`);
    }
  };
  // the watch first, so nothing that appears while the folders are read goes unseen
  const watcher = Deno.watchFs(dirs, { recursive: false });
  for (const dir of dirs) {
    for await (const e of Deno.readDir(dir)) await tend(`${dir}/${e.name}`);
  }
  (async () => {
    for await (const ev of watcher) for (const path of ev.paths) await tend(path);
  })();
  return () => watcher.close();
}

/** Whether `address` answers as the service — the whole path checked from where the
 *  dialer stands, without knowing what carries it: an ingest names itself to a GET at its
 *  root (`serveIngest`), so a tunnel that is down, aimed at another port or in front of
 *  another org each answer with something else. Null when it does; else what it said. */
export async function reached(address: string, service: string): Promise<string | null> {
  // a client of its own, closed after: a pooled connection the network dropped under it,
  // as a suspend does, would otherwise carry every later check into the same timeout
  const client = Deno.createHttpClient({});
  try {
    const res = await fetch(address, { client, signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
    const said = (await res.text()).trim();
    if (res.ok && said === service) return null;
    return `HTTP ${res.status}${said ? ` "${said.slice(0, 80)}"` : ""}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    client.close();
  }
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
    await keepLegs(root);
    const forward = createEdge(root);
    const heard: string[] = [];
    for (const hostname of listensOn(edge)) {
      try {
        Deno.serve({ hostname, port: edge.port, onListen: () => {} }, forward);
        heard.push(`${hostname.includes(":") ? `[${hostname}]` : hostname}:${edge.port}`);
      } catch (err) {
        if (err instanceof Deno.errors.AddrInUse) {
          throw new Error(`port ${edge.port} in use — another org running? set edge.port`);
        }
        // a machine without IPv6 has no ::1, and its `localhost` is 127.0.0.1 alone
        if (hostname === "::1" && err instanceof Deno.errors.AddrNotAvailable) continue;
        throw err;
      }
    }
    console.error(
      `${edge.publicUrl ?? localBase(edge.port)} ← ${heard.join(" · ")} → ` +
        `${root}/data/run/{ingest,oauth}/*.sock`,
    );
  });
}
