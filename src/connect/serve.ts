/**
 * serve.ts — a connector's listener: a Unix socket under the org's own folder, where the
 * edge (edge.ts) forwards the service's path. The location is the whole address, so a
 * connector declares nothing to be reachable, and two orgs on one machine never meet.
 *
 * Every ingest NAMES ITSELF to a `GET /`: the service's name, plain. The services only
 * ever POST, so the answer costs the handler nothing, and it is what lets the org's
 * address be checked from the dialer's side — `<base>/<service>/ingest` fetched and read
 * (`reached`, edge.ts) tells a tunnel that is down, aimed at another port or standing in
 * front of another org apart from one that works, without knowing which tool it is.
 */

import { type Leg, socketOf } from "../edge.ts";

/** Whether something answers on the socket. */
export async function socketUp(path: string): Promise<boolean> {
  try {
    (await Deno.connect({ transport: "unix", path })).close();
    return true;
  } catch {
    return false;
  }
}

/** Whether this org's ingest for `service` is up.
 *
 *  The mirror of `serveIngest`, for the doors that need it: a pairing hands a service the
 *  org's address, and the service dials it from that second on — the whatsmeow bridge
 *  posts the linked phone's history within seconds, and nothing retries it. So the door
 *  asks first, and refuses when the answer is no. A CONNECT, not a bind: the ingest is
 *  the thing that binds, and what the door needs to know is that someone is there. */
export function ingestUp(root: string, service: string): Promise<boolean> {
  return socketUp(socketOf(root, service, "ingest"));
}

/** A socket path the kernel will take: `sun_path` holds 108 bytes on Linux and 104 on
 *  macOS, the terminator included. */
const SOCKET_PATH_MAX = 103;

/** Serve `handler` on the socket. A socket somebody answers on is refused — another
 *  process of this org already serves it — and a file nobody answers on is a run that
 *  ended without cleaning up, replaced. */
export async function serveSocket(
  path: string,
  handler: (req: Request) => Response | Promise<Response>,
): Promise<Deno.HttpServer<Deno.UnixAddr>> {
  if (path.length > SOCKET_PATH_MAX) {
    throw new Error(
      `${path} is ${path.length} bytes, and a socket path holds ${SOCKET_PATH_MAX} — ` +
        `the org needs a shorter path`,
    );
  }
  if (await socketUp(path)) {
    throw new Error(`${path} is already served — another process of this org holds it`);
  }
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return Deno.serve({ path, onListen: () => {} }, handler);
}

/** Serve a service's leg at its socket. */
export function serveLeg(
  root: string,
  service: string,
  leg: Leg,
  handler: (req: Request) => Response | Promise<Response>,
): Promise<Deno.HttpServer<Deno.UnixAddr>> {
  return serveSocket(socketOf(root, service, leg), handler);
}

/** Serve an ingest at `data/run/<service>.sock`, naming itself to a `GET /` and handing
 *  everything else to `handler`. */
export function serveIngest(
  root: string,
  service: string,
  handler: (req: Request) => Response | Promise<Response>,
): Promise<Deno.HttpServer<Deno.UnixAddr>> {
  const named = (req: Request) =>
    req.method === "GET" && new URL(req.url).pathname === "/"
      ? new Response(service, { headers: { "content-type": "text/plain" } })
      : handler(req);
  return serveLeg(root, service, "ingest", named);
}
