/**
 * connect/door.ts — what a served sign-in has in common across services (§4, §9).
 *
 * An OAuth handler is a pure `(Request) => Response` over two routes, `/start` and
 * `/callback`. Main serves a shipped service's on its oauth socket while any of its
 * sign-ins is open (signin.ts): `/start` carries a ticket, the callback's state names it,
 * and the ticket says whom the grant binds. Those shared reads are here, with the page.
 * So is the terminal's side: a CLI door asks main for the sign-in over main's socket
 * (`signInHere`) and says each word main streams back. An org's own door mounts its
 * handler for one sign-in (`oneShot`, `serveDoor`) and reports where it was opened.
 */

import { userInfo } from "node:os";
import { serveLeg, socketUp } from "./serve.ts";
import type { Credentials, TicketRow } from "../store/credentials.ts";
import type { Gate, SignInAsk, Word } from "./signin.ts";
import { mainSocket } from "../roster.ts";

/** A page a person reads in the browser. */
export function page(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** The open ticket a `/start` link carries, or the page that refuses the link. */
export async function startTicket(url: URL, gate: Gate): Promise<TicketRow | Response> {
  const id = url.searchParams.get("ticket");
  const t = id ? await gate.view(id) : null;
  return t ?? page(410, "This sign-in link is over or was never good. Ask for a new one.");
}

/** The ticket a callback's state names, with the code to exchange; or the page that refuses
 *  the callback. A forged or spent state dies here, and a refusal on the wire (consent
 *  declined) ends the sign-in it names. */
export async function callbackTicket(
  url: URL,
  service: string,
  creds: Pick<Credentials, "consumeState">,
  gate: Gate,
): Promise<{ ticket: TicketRow; code: string } | Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const refusal = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (!state) return page(400, refusal ?? "missing code/state");
  // one-time, TTL'd — a replayed or forged callback dies here (§9 boundary check)
  const bound = await creds.consumeState(service, state);
  if (bound === null || typeof bound.ticket !== "string") return page(400, "bad state");
  if (!code) {
    const why = refusal ?? "the service sent no code";
    await gate.failed(bound.ticket, why);
    return page(400, why);
  }
  const ticket = await gate.view(bound.ticket);
  if (!ticket) return page(410, "This sign-in is over. Ask for a new one.");
  return { ticket, code };
}

/** The scopes a ticket asks for. */
export function askedOf(t: TicketRow): string[] {
  const s = t.extra.scopes;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
}

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

/** The user at this terminal — the agent a door signs in when none is named. */
export function terminalUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "principal";
  }
}

/** Hand one sign-in's link to whoever signs in. The person at this terminal — a loopback
 *  callback, or a grant bound to the terminal's own user — gets it opened in this
 *  machine's browser. Anyone else gets a link to send: opened here, the one sign-in would
 *  go to whoever this browser is logged in as, and the grant would land under the name
 *  meant for someone else. `agent` is who the grant binds to; none is the org. */
export function handOut(link: string, loopback: boolean, agent: string | undefined): void {
  if (loopback || agent === terminalUser()) {
    console.error(`Open and approve:\n  ${link}`);
    openBrowser(link);
    return;
  }
  console.error(
    `Send this link to the person signing in:\n  ${link}\n` +
      `It binds the grant to ${agent ? `"${agent}"` : "the org"} and is good for one ` +
      `sign-in, so it goes to exactly one person.`,
  );
}

/** Whether a word ends the sign-in. */
function ends(w: Word): boolean {
  return "landed" in w || "refused" in w || "lapsed" in w;
}

/** How long a CLI door waits for main to come up around it, and how often it looks. */
const MAIN_WAIT_MS = 120_000;
const MAIN_POLL_MS = 1_000;

/** Ask main for a sign-in over its socket, and hear every word it streams back, the
 *  outcome last, which is also what this resolves to. Throws the sentence main refused
 *  the sign-in with. */
export async function askMain(
  root: string,
  ask: SignInAsk,
  hear: (w: Word) => void,
  waitMs: number = MAIN_WAIT_MS,
): Promise<Word> {
  const sock = mainSocket(root);
  if (!(await socketUp(sock))) {
    console.error(
      `main is not running: it holds every sign-in, and \`liquen start\` runs it\n` +
        `  waiting up to ${Math.round(waitMs / 1_000)}s for it…`,
    );
    const deadline = Date.now() + waitMs;
    while (!(await socketUp(sock))) {
      if (Date.now() >= deadline) throw new Error("main is not running: `liquen start` first");
      await new Promise((r) => setTimeout(r, Math.min(MAIN_POLL_MS, waitMs)));
    }
  }
  const client = Deno.createHttpClient({ proxy: { transport: "unix", path: sock } });
  try {
    const res = await fetch("http://localhost/sign-in", {
      method: "POST",
      body: JSON.stringify(ask),
      client,
    });
    if (!res.ok || !res.body) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    let rest = "";
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      rest += chunk;
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        if (!line) continue;
        const word = JSON.parse(line) as Word;
        hear(word);
        if (ends(word)) return word;
      }
    }
    throw new Error("main hung up before the sign-in ended");
  } finally {
    client.close();
  }
}

/** A CLI door's sign-in: asked of main, each word said at this terminal, the outcome as
 *  the exit status. `qr` draws a QR code here. */
export async function signInHere(
  root: string,
  ask: SignInAsk,
  opts: { qr?: (code: string) => void; where?: string; shortfall?: string } = {},
): Promise<number> {
  let outcome: Word;
  let dated = false;
  try {
    outcome = await askMain(root, ask, (w) => {
      if ("link" in w) handOut(w.link, w.loopback, ask.agent);
      else if ("code" in w) console.error(`Code:  ${w.code}\n${w.where}\n`);
      else if ("qr" in w) {
        console.error(opts.where ?? "Scan the code with the phone:\n");
        opts.qr?.(w.qr);
      }
      if (!dated && "until" in w) {
        dated = true;
        console.error(
          `(good until ${new Date(w.until).toLocaleTimeString()}; leaving here leaves it ` +
            "open, and the same command finds it again)\n",
        );
      }
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if ("landed" in outcome) {
    console.error(`\n✓ connected: ${outcome.landed}`);
    if (outcome.missing?.length) {
      console.error(
        `⚠ WITHOUT:\n  ${outcome.missing.join("\n  ")}\n` +
          "The calls that need them are refused. " + (opts.shortfall ? `${opts.shortfall} ` : "") +
          "Approve them on the consent screen and run this again: consent adds up, so they " +
          "merge into this grant.",
      );
    }
    console.error("  (`liquen status` shows the map)");
    return 0;
  }
  console.error(
    "refused" in outcome ? `✗ not connected: ${outcome.refused}` : "✗ not connected: it lapsed",
  );
  return 1;
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
