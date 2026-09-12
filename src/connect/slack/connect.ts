/**
 * connect/slack/connect.ts — `liquen connect slack`: the two dev-side Slack doors (§4).
 *
 *   app   one sitting in front of the Slack console. Prints the manifest prefill link (Slack
 *         builds the app from it; app creation and app-level tokens have no public API, so
 *         the link is the automation ceiling), then takes what that console shows, each
 *         paste skippable: the OAuth client (id + secret) → vault `slack:app:<client_id>`,
 *         its signing secret (HTTP ingest only), the app-level token (xapp) → vault
 *         `slack:socket:<app id>` — the Socket Mode carrier, app-scoped, so it keys by the
 *         app id the token carries — and the public redirect URI the user door serves.
 *         With `--bot` and `--user` it also takes the tokens "Install to Workspace" just
 *         issued: xoxb → vault `slack:<team>:org`, the org's shared identity; xoxp → the
 *         dev's own leg, landed exactly as the user door lands one. Which carrier ingest
 *         opens is read off the vault, never chosen here: an xapp row is the socket, a
 *         signing secret is HTTP.
 *   user  a member's own leg through the OAuth handler (connect/slack/oauth.ts), served for
 *         exactly one sign-in: hand out /start, and the callback lands the grant. Ownership
 *         is decided HERE, at mint time — the agent arg rides `?agent=` — and Slack's
 *         verified `authed_user.id` is what the terminal reports against it. Slack registers
 *         https redirect URLs only, no loopback exception, so this door works only through
 *         the app row's public URI; a dev on their own machine pastes at `app --user`.
 *
 * Either way THE GRANT WRITES THE MAP, and it is one function (`landSlackUser`) whichever
 * door the token came through:
 *
 *   → connections: the workspace stub (the anchor every event carries; registering it opens
 *                  the log) and the GRANT, OWNED — address `<team>:<user>` (a user grant is
 *                  its own connection, §4), `agent_id` = the principal (owned ⇒ private,
 *                  §6), `credential_key` → the vault row below, the self-DM as the
 *                  mind-alias binding
 *   → vault:       key `slack:<team>:<principal>` — the `token` field of the blob
 *   → the log:     the grant note, an event (the only legal way to tell the harness)
 *
 * A paste never identifies its workspace; `auth.test` does, and a rejected token writes
 * nothing. The manifest printed is `src/seed/slack-manifest.json` — the app's SHAPE (name,
 * events, socket mode) — with the consent lists filled from `connections.slack`
 * (`withScopes`), so what the app may do is a knob and lives in one place.
 */

import { helpFlag } from "../help.ts";
import type { AuthTestResponse } from "@slack/web-api";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { requireIngest } from "../declare.ts";
import { type DoorAddress, doorAddress, oneShot, openBrowser } from "../door.ts";
import { missingScopes, SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

/** auth.test's answer, plus what the token may DO: the granted scopes ride the response
 *  header (`x-oauth-scopes`), never the body — for a pasted token it is the only account
 *  Slack gives of its reach. */
export type AuthTest = AuthTestResponse & { scopes?: string[] };

/** What landing a user grant needs, whichever door it came through. */
export interface SlackGrantDeps {
  /** The registry name the grant belongs to (v0: principal name = agent name). */
  principal: string;
  creds: Pick<Credentials, "put">;
  /** The machinery's write side (§4). */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** conversations.open on the granting user's own id → the self-DM channel (the
   *  mind-alias binding, §4). Injectable; undefined result ⇒ no binding recorded. */
  openSelfIm?: (token: string, user: string) => Promise<string | undefined>;
  now?: () => string;
}

export interface SlackConnectDeps extends SlackGrantDeps {
  /** auth.test — injectable for tests; default POSTs with the pasted token. */
  authTest?: (token: string) => Promise<AuthTest>;
  /** The scopes this leg is supposed to carry (`connections.slack.userScopes`): what the
   *  installed app granted is compared against it, and the difference is the caller's to
   *  report. Absent ⇒ nothing to compare, and the grant claims nothing about its reach. */
  asked?: string[];
}

/** A user token Slack has already vouched for, and what it fell short of. */
export interface SlackUserGrant {
  token: string;
  team: string;
  user: string;
  url?: string; // the workspace's, when auth.test said
  missing: string[];
}

/** Land a verified user grant: write the map, vault the token, notify the log. The one
 *  write both doors make — a paste after `auth.test`, the OAuth callback after the code
 *  exchange — so a member's leg looks the same however it arrived. */
export async function landSlackUser(grant: SlackUserGrant, deps: SlackGrantDeps): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { token, team, user, missing } = grant;
  // two rows (§4): the WORKSPACE — the anchor every event carries; registering it is
  // what OPENS the log (the publish gate) — and the OWNED grant `<team>:<user>`, the
  // identity/credential edge the classifier and dispatch resolve through
  const leg = `${team}:${user}`;
  const credentialKey = `slack:${team}:${deps.principal}`;
  // the mind-alias binding (§4): the self-DM (notes-to-self) IS the mind on this surface —
  // resolved here, once, with the grant in hand; recorded on the grant row where the
  // ownership edge already names the principal. Unresolvable ⇒ the grant still lands,
  // just without the alias (the note below says which).
  const selfIm = await (deps.openSelfIm ?? defaultOpenSelfIm)(token, user).catch(() => undefined);
  deps.store.upsertConnections([
    { service: "slack", address: team },
    {
      service: "slack",
      address: leg,
      agentId: deps.principal,
      credentialKey,
      ...(selfIm ? { extra: { self_conversation: selfIm } } : {}),
    },
  ]);
  // the grant note below is the principal's to see — on a personal-only workspace the
  // anchor row is a stub (§6), so membership is what carries it into their view
  deps.store.upsertMemberships([
    { service: "slack", connection: team, conversation: "connect", agentId: deps.principal },
  ]);
  await deps.creds.put({
    key: credentialKey,
    value: { token },
    agentId: deps.principal,
    ...(grant.url ? { extra: { url: grant.url } } : {}),
  });

  // cross the frontier the only legal way: an event (§4)
  const note: Draft<MessageEvent> = {
    ts: now(),
    type: "message",
    envelope: {
      service: "slack",
      connection_address: team, // the workspace just registered — the gate admits it (§4)
      conversation: { address: "connect" },
      sender: { address: "slack-connect" },
    },
    parts: [{
      type: "text",
      kind: "text",
      text: `Slack connected on workspace ${team}: ${deps.principal} (slack user ${user})` +
        (selfIm
          ? ` — mind-alias bound to self-DM ${selfIm}`
          : " — self-DM unresolved, no mind-alias") +
        (missing.length ? ` — NOT granted: ${missing.join(" ")}` : ""),
    }],
  };
  await deps.publish(note);
}

/** Finish a pasted user-token grant: verify with Slack, then land it. Throws (writing
 *  nothing) when Slack rejects the token. */
export async function connectSlackUser(
  token: string,
  deps: SlackConnectDeps,
): Promise<{ team: string; user: string; missing: string[] }> {
  const authTest = deps.authTest ?? defaultAuthTest;

  // shape guard BEFORE auth.test: a bot token also passes auth.test (returning the BOT's
  // user id), and storing it as the principal's user leg would bind the bot's handle to
  // a human — the dashboard shows both tokens side by side, so this paste-slip is easy
  if (!token.startsWith("xoxp-")) {
    const got = token.startsWith("xoxb-")
      ? 'the BOT token (xoxb) — on OAuth & Permissions, copy the "User OAuth Token" instead'
      : token.startsWith("xapp-")
      ? "an app-level token (xapp) — that's the socket carrier, not an identity"
      : "not a Slack user token";
    throw new Error(`expected a user token (xoxp-…), got ${got}`);
  }

  const who = await authTest(token);
  if (!who.ok || !who.team_id || !who.user_id) {
    throw new Error(`auth.test: ${who.error ?? "no team/user in response"}`);
  }
  const { team_id: team, user_id: user } = who;
  const missing = missingScopes(deps.asked ?? [], who.scopes);
  await landSlackUser({ token, team, user, url: who.url, missing }, deps);
  return { team, user, missing };
}

/* ── the OAuth client into the vault ─────────────────────────────────────────────────────── */

export const APP_PREFIX = "slack:app:";

export interface SlackApp {
  clientId: string;
  clientSecret: string;
  signingSecret?: string; // verifies HTTP-mode deliveries; socket mode needs none
  redirectUri?: string; // the public callback registered on the client — where a served sign-in lands
}

/** Store an OAuth client under its own id (the google app door's twin). The vault's
 *  merge lets a re-paste rotate the secret without losing the sidecar. */
export async function connectSlackApp(
  app: SlackApp,
  creds: Pick<Credentials, "put">,
): Promise<string> {
  if (!app.clientId || !app.clientSecret) throw new Error("client_id and client_secret required");
  const key = `${APP_PREFIX}${app.clientId}`;
  await creds.put({
    key,
    value: {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...(app.signingSecret ? { signing_secret: app.signingSecret } : {}),
    },
    ...(app.redirectUri ? { extra: { redirect_uri: app.redirectUri } } : {}),
  });
  return key;
}

/** The user door's address, from the app row's registered redirect URI. Slack takes https
 *  only and grants loopback no exception, so a URI this door could bind and be reached at
 *  directly does not exist: a loopback or plain-http one is refused at paste time, before
 *  a member's sign-in 404s or trips a certificate warning after consent. */
export function slackDoor(redirectUri: string, oauthPort: number): DoorAddress {
  const door = doorAddress(redirectUri, oauthPort);
  if (!redirectUri.startsWith("https://")) {
    throw new Error(`Slack registers https redirect URLs only: ${redirectUri}`);
  }
  if (door.loopback) {
    throw new Error(
      `a loopback host cannot carry Slack's https redirect: ${redirectUri} — put a tunnel or ` +
        `a real host in front of connections.slack.oauthPort and register that`,
    );
  }
  return door;
}

/** The user door's app: the only one, or the one `clientId` names. */
export async function pickSlackApp(
  creds: Pick<Credentials, "get" | "list">,
  clientId?: string,
): Promise<CredentialRow> {
  if (clientId) {
    const row = await creds.get(`${APP_PREFIX}${clientId}`);
    if (!row) throw new Error(`no app ${clientId} — \`liquen connect slack app\` first`);
    return row;
  }
  const apps = await creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no slack app in the vault — `liquen connect slack app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.value.client_id).join("\n  ");
    throw new Error(`several apps — pick one with --app <client_id>:\n  ${ids}`);
  }
  return apps[0];
}

/* ── the bot token: the org's shared identity ───────────────────────────────────────────── */

export interface SlackBotDeps {
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections">;
  publish: Appender["publish"];
  authTest?: (token: string) => Promise<AuthTest>;
  /** `connections.slack.botScopes` — the same comparison the user leg makes. */
  asked?: string[];
  now?: () => string;
}

/** Finish a pasted bot-token grant: verify with Slack, write the bare workspace stub
 *  (membership-only; the anchor of personal-witnessed deliveries) and the bot's own grant
 *  row `<team>:<bot user>` carrying `credential_key` (no owner ⇒ the org's shared inbox,
 *  §6; bot-witnessed deliveries anchor here) — and vault the blob at `slack:<team>:org`.
 *  The identity and nothing else: the socket carrier is app-scoped where this is
 *  workspace-scoped, and lands under its own key. Throws (writing nothing) on a rejected
 *  token. */
export async function connectSlackBot(
  token: string,
  deps: SlackBotDeps,
  agent?: string,
): Promise<{ team: string; botUser: string; missing: string[] }> {
  const authTest = deps.authTest ?? defaultAuthTest;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!token.startsWith("xoxb-")) {
    const got = token.startsWith("xoxp-")
      ? "the USER token (xoxp) — that one is `--user`'s paste"
      : token.startsWith("xapp-")
      ? "an app-level token (xapp) — that's the socket carrier, its own paste"
      : "not a Slack bot token";
    throw new Error(`expected a bot token (xoxb-…), got ${got}`);
  }

  const who = await authTest(token);
  if (!who.ok || !who.team_id || !who.user_id) {
    throw new Error(`auth.test: ${who.error ?? "no team/user in response"}`);
  }
  const { team_id: team, user_id: botUser } = who;
  const missing = missingScopes(deps.asked ?? [], who.scopes);

  const credentialKey = `slack:${team}:org`;
  // the workspace stub opens the log for personal-witnessed deliveries; the bot's own
  // row is where bot-witnessed ones anchor (`<team>:<bot user>`, the ingest's anchor) and
  // the one that carries the credential — that account itself reads as the org (§6), so
  // no ownership edge and no membership on either
  // a bot has no handle a human could declare, so which agent speaks through it is
  // RECORDED on its row (`extra.agent`) the way an opaque id is (§4) — still nobody's:
  // the account is the org's, every member reads it, and the roster steers the agent
  deps.store.upsertConnections([
    { service: "slack", address: team },
    {
      service: "slack",
      address: `${team}:${botUser}`,
      credentialKey,
      ...(agent ? { extra: { agent } } : {}),
    },
  ]);
  await deps.creds.put({
    key: credentialKey,
    value: { token },
    extra: { bot_user: botUser, ...(who.url ? { url: who.url } : {}) },
  });

  await deps.publish(
    {
      ts: now(),
      type: "message",
      envelope: {
        service: "slack",
        connection_address: team,
        conversation: { address: "connect" },
        sender: { address: "slack-connect" },
      },
      parts: [{
        type: "text",
        kind: "text",
        text: `Slack bot connected on workspace ${team} (bot user ${botUser})` +
          (agent ? ` → ${agent}` : "") +
          (missing.length ? ` — NOT granted: ${missing.join(" ")}` : ""),
      }],
    } satisfies Draft<MessageEvent>,
  );
  return { team, botUser, missing };
}

/* ── the app-level token: the socket carrier ────────────────────────────────────────────── */

export const SOCKET_PREFIX = "slack:socket:";

/** The app id an app-level token carries: `xapp-1-<app id>-<issued>-<secret>`. Socket
 *  Mode is APP-scoped — one socket serves every workspace the app is installed in — so
 *  the app id is the carrier's whole identity, and keying by anything else (a team, a
 *  client id) either duplicates the socket or invents a dependency the paste cannot see. */
export function appIdOf(appToken: string): string | null {
  const parts = appToken.split("-");
  return parts.length >= 4 && parts[0] === "xapp" && /^A[A-Z0-9]+$/.test(parts[2])
    ? parts[2]
    : null;
}

export interface SlackSocketDeps {
  creds: Pick<Credentials, "put">;
  /** apps.connections.open — the ONE call an app-level token can make, so it is also the
   *  only proof the token is live. Injectable; default POSTs. */
  probe?: (appToken: string) => Promise<{ ok: boolean; error?: string }>;
}

/** Store a verified app-level token under its app id. No connection, no membership, no
 *  event: a carrier is not a grant — it grants no reach and names no identity, it only
 *  says HOW events arrive. */
export async function connectSlackSocket(
  appToken: string,
  deps: SlackSocketDeps,
): Promise<{ appId: string }> {
  if (!appToken.startsWith("xapp-")) {
    const got = appToken.startsWith("xoxb-")
      ? "the BOT token (xoxb) — that one is `--bot`'s paste"
      : appToken.startsWith("xoxp-")
      ? "a USER token (xoxp) — that one is `--user`'s paste"
      : "not a Slack app-level token";
    throw new Error(`expected an app-level token (xapp-…), got ${got}`);
  }
  const appId = appIdOf(appToken);
  if (!appId) throw new Error(`malformed app-level token — expected xapp-1-<app id>-…`);

  const probe = deps.probe ?? defaultSocketProbe;
  const live = await probe(appToken);
  if (!live.ok) throw new Error(`apps.connections.open: ${live.error ?? "refused"}`);

  await deps.creds.put({ key: `${SOCKET_PREFIX}${appId}`, value: { app_token: appToken } });
  return { appId };
}

async function defaultSocketProbe(appToken: string): Promise<{ ok: boolean; error?: string }> {
  const res = await timedFetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  return await res.json() as { ok: boolean; error?: string };
}

/* ── what the org still owes, read off the vault ─────────────────────────────────────── */

/** The four things a working Slack connection is made of. */
export interface SlackHave {
  app: boolean; // the OAuth client — `slack:app:<client_id>`
  bot: boolean; // the org's identity — `slack:<team>:org`
  appToken: boolean; // the socket carrier, stored beside the bot token
  user: boolean; // at least one principal's own leg — `slack:<team>:<principal>`
}

/** Sort the vault's slack rows into the four. */
export function slackHave(rows: { key: string; value: Record<string, unknown> }[]): SlackHave {
  const have: SlackHave = { app: false, bot: false, appToken: false, user: false };
  for (const r of rows) {
    if (r.key.startsWith(APP_PREFIX)) have.app = true;
    else if (r.key.startsWith(SOCKET_PREFIX)) have.appToken = true;
    else if (r.key.endsWith(":org")) have.bot = true;
    else have.user = true;
  }
  return have;
}

/** What is still owed, in the order a dev would do it — one door finishing is the natural
 *  moment to learn what the next one is, and the pieces are bought at different counters
 *  (a token is pasted, an app-level token is GENERATED, a grant is approved).
 *
 *  Inbound is the sharp one: ingest reads events over one of two carriers — the app-level
 *  token's socket, or an HTTP request URL on the ingest port — and the second needs a
 *  public address. An org with an identity and no `app_token` receives nothing and is
 *  told so here rather than by silence. */
export function slackNext(have: SlackHave): string[] {
  const next: string[] = [];
  if (!have.user && !have.bot) {
    next.push(
      "no identity yet — `liquen connect slack app --user` (your own leg) or " +
        "`liquen connect slack app --bot` (the org's)",
    );
  }
  if (!have.bot) {
    next.push(
      "no org identity — `liquen connect slack app --bot` (the org's shared inbox; a bot is " +
        "also what an app needs to be installed with bot events)",
    );
  }
  if (!have.appToken) {
    next.push(
      "no socket carrier — Basic Information → App-Level Tokens → Generate Token and " +
        "Scopes (`connections:write`), pasted at `liquen connect slack app` (without one, " +
        "ingest needs a PUBLIC request URL)",
    );
  }
  if (!have.app) {
    next.push(
      "no OAuth client — `liquen connect slack app` (only `liquen connect slack user`, " +
        "a member's served sign-in, needs it; a paste does not)",
    );
  }
  return next;
}

/** Fill the manifest's consent lists from the catalog — the seed carries the app's shape
 *  (name, events, socket mode), the config carries what it may do, so the app a door
 *  creates asks for exactly what the user door later requests. */
export function withScopes(
  manifest: Record<string, unknown>,
  scopes: { bot: string[]; user: string[] },
): Record<string, unknown> {
  const m = structuredClone(manifest) as { oauth_config?: Record<string, unknown> };
  m.oauth_config = { ...m.oauth_config, scopes: { bot: scopes.bot, user: scopes.user } };
  return m as Record<string, unknown>;
}

/** The app-creation prefill link: api.slack.com creates the app FROM the manifest —
 *  the ceiling of automation (app creation and app-level tokens have no public API). */
export function manifestUrl(manifest: unknown): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${
    encodeURIComponent(JSON.stringify(manifest))
  }`;
}

/** The self-DM by `conversations.open` on one's OWN user id — direct (no listing, no
 *  pagination), and it re-opens a closed one. Any refusal ⇒ undefined: the binding is
 *  optional, the grant is not. */
async function defaultOpenSelfIm(token: string, user: string): Promise<string | undefined> {
  const res = await timedFetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ users: user }),
  });
  const out = await res.json() as { ok: boolean; channel?: { id?: string } };
  return out.ok ? out.channel?.id : undefined;
}

async function defaultAuthTest(token: string): Promise<AuthTest> {
  const res = await timedFetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const scopes = res.headers.get("x-oauth-scopes");
  return {
    ...await res.json() as AuthTestResponse,
    ...(scopes ? { scopes: scopes.split(/[,\s]+/).filter(Boolean) } : {}),
  };
}

/* ── local entry: the two doors ─────────────────────────────────────────────────────────
 *
 *   deno task connect slack app [--bot] [--user]           # the console sitting, pasted
 *   deno task connect slack user [agent] [--app <client_id>] [--scopes "…"]
 *
 * The user door serves its callback on connections.slack.oauthPort. */
const USAGE = `usage: liquen connect slack app [--bot] [--user]
       liquen connect slack user [agent] [--app <client_id>] [--scopes "…"]

  Connect Slack from this terminal — the app's pieces pasted into the vault, a member's
  own leg through a served sign-in; knobs: connections.slack.

  app     paste what the app's console shows, each empty to skip: the OAuth client (id
          and secret), its signing secret (HTTP ingest only), the app-level token (xapp,
          the Socket Mode carrier), the public redirect URI the user door serves;
          --bot also takes the bot token (xoxb, the org's shared identity) and the
          roster agent that speaks through it; --user also takes your own user token
          (xoxp) and the agent it belongs to (default: your OS username)
  user    sign a member in through the app's public redirect URI: [agent]'s own leg
          (default: your OS username); --app picks the client when the vault holds
          several; --scopes overrides the catalog's (space- or comma-separated)
  --dir <org>   the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openLog } = await import("../../store/log.ts");
    const { openCredentials } = await import("../../store/credentials.ts");
    const { userInfo } = await import("node:os");
    const { slackConfig } = await import("./config.ts");
    const { readConfig } = await import("../../config.ts");

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const [verb, ...rest] = org.args;
    if (verb !== "app" && verb !== "user") {
      console.error(USAGE);
      Deno.exit(2);
    }

    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--bot" || rest[i] === "--user") flags.set(rest[i].slice(2), "1");
      else if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[++i] ?? "");
      else positional.push(rest[i]);
    }
    const me = (): string => {
      try {
        return userInfo().username;
      } catch {
        return "principal";
      }
    };

    /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string | undefined =>
      (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

    /** A roster agent, or the reason it cannot speak through a bot. */
    const rosterAgent = async (name: string): Promise<void> => {
      const entry = (await readConfig(root)).agents[name];
      if (!entry) {
        console.error(
          `no agent "${name}" in ${root}/config.jsonc — \`liquen agent ${name}\` adds one`,
        );
        Deno.exit(2);
      }
      if (entry.mind === false) {
        console.error(`"${name}" is a member with no agent of their own (mind: false)`);
        Deno.exit(2);
      }
    };

    /** What the org still owes after this door — read off the vault, so finishing one door
     *  is where you learn what the next one is. */
    const owed = async (creds: { list: (p: string) => Promise<CredentialRow[]> }) => {
      const next = slackNext(slackHave(await creds.list("slack:")));
      if (next.length) console.error(`\nstill to do:\n  ${next.join("\n  ")}`);
    };

    /** The grant landed and is stored; what it cannot do is the part worth saying out loud,
     *  because Slack only mentions it again at the call that fails. */
    const report = (missing: string[], remedy: string): void => {
      if (missing.length === 0) return;
      console.error(
        `⚠ this token does NOT carry:\n  ${missing.join("\n  ")}\n` +
          `  Calls needing them answer missing_scope. ${remedy}`,
      );
    };

    const { botScopes, userScopes, oauthPort } = await slackConfig(root);

    if (verb === "app") {
      const pastes = flags.has("bot") || flags.has("user");
      // a grant makes the workspace deliver from that second on, so the door is the moment
      // to know somebody is listening (`requireIngest`); the app's own pieces land no grant
      if (pastes) await requireIngest(root, SPEC);
      const url = manifestUrl(withScopes(
        JSON.parse(
          await Deno.readTextFile(new URL("../../seed/slack-manifest.json", import.meta.url)),
        ),
        { bot: botScopes, user: userScopes },
      ));
      console.error(`Create the app (Slack builds it from the manifest):\n  ${url}\n`);
      console.error("Then paste from Basic Information → App Credentials and App-Level Tokens,");
      console.error("and, after Install to Workspace, from OAuth & Permissions. Empty skips.\n");
      openBrowser(url);

      const creds = await openCredentials(dir);
      const log = pastes ? await openLog(`${dir}/log`) : null;
      try {
        const clientId = ask("Client ID:");
        if (clientId) {
          const clientSecret = ask("Client secret:");
          if (!clientSecret) {
            console.error("a client id without its secret — nothing written for the client");
            Deno.exit(2);
          }
          const signingSecret = ask("Signing secret (HTTP ingest only):");
          const redirectUri = ask("Public redirect URI (the user door's, https):");
          if (redirectUri) {
            try { // a URI the door cannot serve is caught here, not after someone consents
              slackDoor(redirectUri, oauthPort);
            } catch (e) {
              console.error(e instanceof Error ? e.message : String(e));
              Deno.exit(2);
            }
          }
          const key = await connectSlackApp(
            { clientId, clientSecret, signingSecret, redirectUri },
            creds,
          );
          console.error(
            `✓ app stored: ${key}` + (redirectUri ? ` (callback: ${redirectUri})` : ""),
          );
        }

        const appToken = ask("App-level token (xapp-…):");
        if (appToken) {
          const { appId } = await connectSlackSocket(appToken, { creds });
          console.error(`✓ socket carrier stored for app ${appId} — ingest reads events over it`);
        }

        if (flags.has("bot")) {
          const token = ask("Bot token (xoxb-…):");
          if (token) {
            const agent = ask("Agent that speaks through it (empty = the org):");
            if (agent) await rosterAgent(agent);
            const { team, botUser, missing } = await connectSlackBot(token, {
              creds,
              store: log!,
              publish: log!.publish,
              asked: botScopes,
            }, agent);
            console.error(
              `✓ bot connected: workspace ${team}, bot user ${botUser} → ${agent ?? "the org"}`,
            );
            report(missing, "Reinstall the app to the workspace after adding them.");
          }
        }

        if (flags.has("user")) {
          const token = ask("User token (xoxp-…):");
          if (token) {
            const principal = ask(`Agent it belongs to (empty = ${me()}):`) ?? me();
            const { team, user, missing } = await connectSlackUser(token, {
              principal,
              creds,
              store: log!,
              publish: log!.publish,
              asked: userScopes,
            });
            console.error(`✓ connected: workspace ${team}, slack user ${user} → ${principal}`);
            report(missing, 'Add them under "User Token Scopes", then "Reinstall to Workspace".');
          }
        }
        await owed(creds);
        if (pastes) console.error("  (deno task status shows the map)");
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        Deno.exit(2);
      } finally {
        await creds.close();
        await log?.close();
      }
      Deno.exit(0);
    }

    // user: a served sign-in
    await requireIngest(root, SPEC);
    const { createSlackOAuth } = await import("./oauth.ts");
    const agent = positional[0] ?? me();
    const asked = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean) ?? userScopes;
    const creds = await openCredentials(dir);
    try {
      const app = await pickSlackApp(creds, flags.get("app")).catch((e: Error) => {
        console.error(e.message);
        Deno.exit(2);
      });
      const registered = app.extra?.redirect_uri as string | undefined;
      if (!registered) {
        console.error(
          `app ${app.value.client_id} has no public redirect URI, and Slack redirects to https ` +
            `only — no loopback. Put a tunnel or a real host in front of port ${oauthPort}, ` +
            `register its https://…/oauth/slack/callback on the app, and paste it at ` +
            `\`liquen connect slack app\`. Your own leg on this machine needs none: ` +
            `\`liquen connect slack app --user\` pastes it.`,
        );
        Deno.exit(2);
      }
      let door: DoorAddress;
      try {
        door = slackDoor(registered, oauthPort);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        Deno.exit(2);
      }
      const log = await openLog(`${dir}/log`);
      let landed: { user: string; missing: string[] } | undefined;
      const { handler, outcome } = oneShot(createSlackOAuth({
        config: {
          clientId: app.value.client_id,
          clientSecret: app.value.client_secret,
          redirectUri: door.callback,
          userScopes: asked,
        },
        creds,
        publish: log.publish,
        store: log,
        onGrant: (g) => (landed = g),
      }));
      const server = Deno.serve({ port: door.port, onListen: () => {} }, handler);
      const start = new URL(door.start);
      start.searchParams.set("agent", agent);
      console.error(
        `Connecting Slack for "${agent}" via app ${app.value.client_id}.\nAsking for:\n  ${
          asked.join("\n  ")
        }\n`,
      );
      // never opened here: the link binds the grant to a name, and this browser's Slack
      // login would land under it looking perfectly successful
      console.error(
        `Send this link to the person signing in:\n  ${start.href}\n` +
          `It binds the grant to "${agent}" and is good for one sign-in, so it goes to ` +
          `exactly one person. This door waits until they finish, serving ${door.callback} ` +
          `on port ${door.port}.`,
      );
      const res = await outcome;
      await server.shutdown();
      await log.close();
      if (res.status !== 200 || !landed) {
        console.error(`✗ not connected: ${(await res.text()).trim()}`);
        Deno.exit(1);
      }
      console.error(`\n✓ connected: slack user ${landed.user} → ${agent}`);
      report(landed.missing, "Approve them on the consent screen and run this again.");
      await owed(creds);
      console.error("  (deno task status shows the map)");
    } finally {
      await creds.close();
    }
  });
}
