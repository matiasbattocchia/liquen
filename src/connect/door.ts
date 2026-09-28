/**
 * connect/door.ts — what a served sign-in has in common across services (§4, §9).
 *
 * An OAuth handler is a pure `(Request) => Response` over two routes, `/start` and
 * `/callback`, and nothing serves it standing: a door mounts it for exactly one sign-in,
 * on the service's oauth socket (`serveLeg`, serve.ts) behind the org's edge, and reports
 * at the terminal it was opened from. The two pieces here are the mount and the
 * addressing; the handler is each service's.
 */

import { serveLeg } from "./serve.ts";

/** A handler wrapped for a one-shot door: the first callback — whichever way it went —
 *  settles `outcome`, so the command reports and exits instead of waiting on a page that
 *  already told the member it failed. */
export function oneShot(
  handler: (req: Request) => Promise<Response>,
): { handler: (req: Request) => Promise<Response>; outcome: Promise<Response> } {
  const done = Promise.withResolvers<Response>();
  return {
    outcome: done.promise,
    handler: async (req) => {
      const res = await handler(req);
      if (new URL(req.url).pathname.endsWith("/callback")) done.resolve(res.clone());
      return res;
    },
  };
}

/** What a door advertises, read off the registered redirect URI. A loopback host is this
 *  machine's edge, so the browser that can reach it is the one here; any other host is
 *  reached by a member anywhere. `/start` is the callback's sibling because the handler
 *  answers both by path suffix. */
export interface DoorAddress {
  callback: string; // sent as `redirect_uri`, byte for byte as registered
  start: string; // the link that begins one sign-in
  loopback: boolean; // the browser that can reach it is the one on this machine
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function doorAddress(redirectUri: string): DoorAddress {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error(`redirect URI is not a URL: ${redirectUri}`);
  }
  // a URI the handler would never answer is a sign-in that 404s after consent, so it is
  // refused at the door that takes it instead
  if (!url.pathname.endsWith("/callback")) {
    throw new Error(`redirect URI must end in /callback: ${redirectUri}`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  const start = new URL(url.href);
  start.pathname = `${url.pathname.slice(0, -"/callback".length)}/start`;
  return { callback: redirectUri, start: start.href, loopback };
}

/** Mount a sign-in handler on the service's oauth socket, where the edge forwards
 *  `/<service>/oauth/…`. */
export function serveDoor(
  root: string,
  service: string,
  handler: (req: Request) => Promise<Response>,
): Promise<Deno.HttpServer<Deno.UnixAddr>> {
  return serveLeg(root, service, "oauth", handler);
}

/** Open a link in this machine's browser, best effort — the link printed is the real door. */
export function openBrowser(url: string): void {
  try {
    new Deno.Command(Deno.build.os === "darwin" ? "open" : "xdg-open", {
      args: [url],
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
  } catch { /* headless is fine */ }
}
