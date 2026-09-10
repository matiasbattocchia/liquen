/**
 * connect/slack/connect.ts — `liquen connect slack`: the PASTE door (DESIGN §4).
 *
 * The dashboard's "Install to Workspace" button IS an OAuth flow with Slack hosting the
 * redirect — so a dev can self-serve a user token (xoxp) with zero public surface: the
 * CLI prints the app-manifest prefill link, the dev creates + installs the app and pastes
 * the token back. The paste is the grant, and THE GRANT WRITES THE MAP — the same two
 * writes as the OAuth handler (connect/slack/oauth.ts), from a different door:
 *
 *   auth.test(xoxp) → team + user (the paste never identifies the workspace; Slack does)
 *     → connections: the GRANT, OWNED — address `<team>:<user>` (a user grant is its own
 *                    connection, §4), `agent_id` = the principal (owned ⇒ private, §6),
 *                    `credential_key` → the vault row below
 *     → vault:       key `slack:<team>:<principal>` — the `token` field of the blob
 *
 * Four doors, one map (google's twins):
 *
 *   user    the paste above — the principal's own leg (xoxp), owned ⇒ private (§6)
 *   bot     the org's shared identity: xoxb → vault `slack:<team>:org`, org-credentialed
 *           anchor
 *   socket  the app-level token (xapp) → vault `slack:socket:<app id>`. Not a grant: it
 *           names no identity and grants no reach, it says HOW events arrive. App-scoped
 *           where a grant is workspace-scoped, so it keys by the app id the token carries
 *   app     the OAuth client (id + secret) → vault `slack:app:<client_id>` — what the
 *           OAuth handler signs a member in with
 *
 * Arg (user door): the principal (default: the OS username). Env: none.
 *
 * The manifest it prints is `src/seed/slack-manifest.json` — the app's SHAPE (name, events,
 * redirect, socket mode) — with the consent lists filled from `connections.slack`
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
import { declared } from "../declare.ts";
import { missingScopes } from "./config.ts";
import { entry } from "../../entry.ts";

/** auth.test's answer, plus what the token may DO: the granted scopes ride the response
 *  header (`x-oauth-scopes`), never the body — for a pasted token it is the only account
 *  Slack gives of its reach. */
export type AuthTest = AuthTestResponse & { scopes?: string[] };

export interface SlackConnectDeps {
  /** The registry name the pasted grant belongs to (v0: principal name = agent name). */
  principal: string;
  creds: Pick<Credentials, "put">;
  /** The machinery's write side (§4) — the same seam the oauth callback uses. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** auth.test — injectable for tests; default POSTs with the pasted token. */
  authTest?: (token: string) => Promise<AuthTest>;
  /** The scopes this leg is supposed to carry (`connections.slack.userScopes`): what the
   *  installed app granted is compared against it, and the difference is the caller's to
   *  report. Absent ⇒ nothing to compare, and the grant claims nothing about its reach. */
  asked?: string[];
  /** conversations.open on the granting user's own id → the self-DM channel (the
   *  mind-alias binding, §4). Injectable; undefined result ⇒ no binding recorded. */
  openSelfIm?: (token: string, user: string) => Promise<string | undefined>;
  now?: () => string;
}

/** Finish a pasted user-token grant: verify with Slack, write the map, notify the log.
 *  Throws (writing nothing) when Slack rejects the token. */
export async function connectSlackUser(
  token: string,
  deps: SlackConnectDeps,
): Promise<{ team: string; user: string; missing: string[] }> {
  const authTest = deps.authTest ?? defaultAuthTest;
  const now = deps.now ?? (() => new Date().toISOString());

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
    ...(who.url ? { extra: { url: who.url } } : {}),
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
  return { team, user, missing };
}

/* ── the app door: `liquen connect slack app` — the OAuth client into the vault ──────────── */

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

/** The OAuth handler's app: the only one, or the one `clientId` names. */
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

/* ── the bot door: `liquen connect slack bot` — the org's shared identity ────────────────── */

export interface SlackBotDeps {
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections">;
  publish: Appender["publish"];
  authTest?: (token: string) => Promise<AuthTest>;
  /** `connections.slack.botScopes` — the same comparison the user door makes. */
  asked?: string[];
  now?: () => string;
}

/** Finish a pasted bot-token grant: verify with Slack, write the same two rows the OAuth
 *  handler writes — the bare workspace stub (membership-only; the anchor of personal-witnessed
 *  deliveries) and the bot's own grant row `<team>:<bot user>` carrying `credential_key`
 *  (no owner ⇒ the org's shared inbox, §6; bot-witnessed deliveries anchor here) — and
 *  vault the blob at `slack:<team>:org`. The identity and nothing else: the socket carrier
 *  is its own door (`liquen connect slack socket`), app-scoped where this is workspace-scoped.
 *  Throws (writing nothing) on a rejected token. */
export async function connectSlackBot(
  token: string,
  deps: SlackBotDeps,
  agent?: string,
): Promise<{ team: string; botUser: string; missing: string[] }> {
  const authTest = deps.authTest ?? defaultAuthTest;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!token.startsWith("xoxb-")) {
    const got = token.startsWith("xoxp-")
      ? "the USER token (xoxp) — that one goes through `liquen connect slack user`"
      : token.startsWith("xapp-")
      ? "an app-level token (xapp) — that's the socket carrier, `liquen connect slack socket`"
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

/* ── the socket door: `liquen connect slack socket` — the app-level token ───────────────── */

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
      ? "the BOT token (xoxb) — that one goes through `liquen connect slack bot`"
      : appToken.startsWith("xoxp-")
      ? "a USER token (xoxp) — that one goes through `liquen connect slack user`"
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
      "no identity yet — `liquen connect slack user` (your own leg) or " +
        "`liquen connect slack bot` (the org's)",
    );
  }
  if (!have.bot) {
    next.push(
      "no org identity — `liquen connect slack bot` (the org's shared inbox; a bot is also " +
        "what an app needs to be installed with bot events)",
    );
  }
  if (!have.appToken) {
    next.push(
      "no socket carrier — Basic Information → App-Level Tokens → Generate Token and " +
        "Scopes (`connections:write`), then `liquen connect slack socket` (without one, " +
        "ingest needs a PUBLIC request URL)",
    );
  }
  if (!have.app) {
    next.push(
      "no OAuth client — `liquen connect slack app` (only the HOSTED door needs it; the " +
        "paste doors do not)",
    );
  }
  return next;
}

/** Fill the manifest's consent lists from the catalog — the seed carries the app's shape
 *  (name, events, redirect, socket mode), the config carries what it may do, so the app a
 *  door creates asks for exactly what the OAuth handler later requests. */
export function withScopes(
  manifest: Record<string, unknown>,
  scopes: { bot: string[]; user: string[] },
): Record<string, unknown> {
  const m = structuredClone(manifest) as { oauth_config?: Record<string, unknown> };
  m.oauth_config = { ...m.oauth_config, scopes: { bot: scopes.bot, user: scopes.user } };
  return m as Record<string, unknown>;
}

/** The USER door mints a USER-ONLY app: no bot user, no bot scopes, no bot events.
 *  The bot is not required for the user leg — and asking for one puts an xoxb next to
 *  the xoxp on the dashboard, the exact paste-slip the shape guard catches. The bot is
 *  its own deliberate door (`liquen connect slack bot`). */
export function userManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const m = structuredClone(manifest) as {
    features?: Record<string, unknown>;
    oauth_config?: { scopes?: Record<string, unknown> };
    settings?: { event_subscriptions?: Record<string, unknown> };
  };
  delete m.features?.bot_user;
  if (m.features && Object.keys(m.features).length === 0) delete m.features;
  delete m.oauth_config?.scopes?.bot;
  delete m.settings?.event_subscriptions?.bot_events;
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

/* ── local entry: the three doors ───────────────────────────────────────────────────────
 *
 *   deno task connect slack user [principal]   # prefill link → install → paste xoxp
 *   deno task connect slack bot [--agent <name>] # paste xoxb; the agent that speaks as it
 *   deno task connect slack app                # paste client id + secret → the vault
 *
 * A bare invocation (or a bare principal name) is the user door — the common case. */
const USAGE = `usage: liquen connect slack app
       liquen connect slack bot [--agent <name>]
       liquen connect slack socket
       liquen connect slack user [agent]

  Put Slack's credentials in the vault, pasted at a prompt or piped one per line;
  knobs: connections.slack.

  app      the OAuth client (id and secret) every other door names
  bot      the bot token (xoxb): the org's shared identity; --agent names the roster
           agent that speaks through it
  socket   the app-level token (xapp): the carrier ingest reads events over
  user     a user token (xoxp): one member's own leg — the default door; [agent]
           defaults to your OS username
  --dir <org>   the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openLog } = await import("../../store/log.ts");
    const { openCredentials } = await import("../../store/credentials.ts");
    const { userInfo } = await import("node:os");
    const { slackConfig } = await import("./config.ts");

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const [first, ...rest] = org.args;
    const verb = first === "app" || first === "bot" || first === "socket" || first === "user"
      ? first
      : "user";

    /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string | undefined =>
      (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

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

    if (verb === "app") {
      const creds = await openCredentials(dir);
      try {
        // the app itself comes FIRST and comes from the manifest: Slack builds it in two
        // clicks from this link, and everything else — the carrier, the bot, a member's
        // leg — is a token that app issues. The OAuth client below is what the OAuth
        // handler signs a member in with, so it is optional here.
        const { botScopes, userScopes } = await slackConfig(root);
        const url = manifestUrl(withScopes(
          JSON.parse(
            await Deno.readTextFile(new URL("../../seed/slack-manifest.json", import.meta.url)),
          ),
          { bot: botScopes, user: userScopes },
        ));
        console.error(`Create the app (Slack builds it from the manifest):\n  ${url}\n`);
        console.error("Then: Install to Workspace (xoxb) · Basic Information → App-Level");
        console.error("Tokens (xapp). `liquen connect slack socket` and `bot` take those.\n");
        try { // best effort — the link above is the real door
          new Deno.Command(Deno.build.os === "darwin" ? "open" : "xdg-open", {
            args: [url],
            stdout: "null",
            stderr: "null",
          }).spawn().unref();
        } catch { /* headless is fine */ }

        const clientId = ask("Client ID (the OAuth client; empty to skip):");
        const clientSecret = clientId ? ask("Client secret:") : undefined;
        if (!clientId || !clientSecret) {
          console.error(clientId ? "no secret pasted — nothing written" : "\nno client stored");
          await owed(creds);
          Deno.exit(clientId ? 2 : 0);
        }
        const signingSecret = ask("Signing secret (verifies HTTP ingest; empty to skip):");
        const redirectUri = ask("Public redirect URI (empty to skip):");
        const key = await connectSlackApp(
          { clientId, clientSecret, signingSecret, redirectUri },
          creds,
        );
        console.error(
          `✓ app stored: ${key}` + (redirectUri ? ` (public callback: ${redirectUri})` : ""),
        );
        await owed(creds);
      } finally {
        await creds.close();
      }
      Deno.exit(0);
    }

    if (verb === "socket") {
      console.error("In the app: Basic Information → App-Level Tokens → Generate Token and");
      console.error("Scopes, with the `connections:write` scope. Slack has no API for this.\n");
      const appToken = ask("Paste the app-level token (xapp-…):");
      if (!appToken) {
        console.error("no token pasted — nothing written");
        Deno.exit(2);
      }
      const creds = await openCredentials(dir);
      try {
        const { appId } = await connectSlackSocket(appToken, { creds });
        console.error(`\n✓ socket carrier stored for app ${appId} — ingest reads events over it`);
        await owed(creds);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        Deno.exit(2);
      } finally {
        await creds.close();
      }
      Deno.exit(0);
    }

    if (verb === "bot") {
      // `--agent <name>`: the roster entry that speaks through this bot (§4) — an org agent
      const at = rest.indexOf("--agent");
      const agent = at < 0 ? undefined : rest[at + 1];
      if (at >= 0 && !agent) {
        console.error("--agent needs the roster name of the agent that speaks through the bot");
        Deno.exit(2);
      }
      if (agent) {
        const { readConfig } = await import("../../config.ts");
        const entry = (await readConfig(root)).agents[agent];
        if (!entry) {
          console.error(
            `no agent "${agent}" in ${root}/config.jsonc — \`liquen agent ${agent}\` adds one`,
          );
          Deno.exit(2);
        }
        if (entry.mind === false) {
          console.error(`"${agent}" is a member with no agent of their own (mind: false)`);
          Deno.exit(2);
        }
      }
      console.error("In the app: OAuth & Permissions → the Bot User OAuth Token (xoxb-…).\n");
      const token = ask("Paste the bot token (xoxb-…):");
      if (!token) {
        console.error("no token pasted — nothing written");
        Deno.exit(2);
      }
      const log = await openLog(`${dir}/log`);
      const creds = await openCredentials(dir);
      try {
        const { botScopes } = await slackConfig(root);
        const { team, botUser, missing } = await connectSlackBot(token, {
          creds,
          store: log,
          publish: log.publish,
          asked: botScopes,
        }, agent);
        console.error(
          `\n✓ connected: workspace ${team}, bot user ${botUser} → ${agent ?? "the org"}`,
        );
        report(missing, "Reinstall the app to the workspace after adding them.");
        await owed(creds);
        console.error("  (deno task status shows the map)");
        await declared(root, "slack");
      } finally {
        await creds.close();
        await log.close();
      }
      Deno.exit(0);
    }

    const principal = (verb === "user" && first === "user" ? rest[0] : first) ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return "principal";
      }
    })();

    const { botScopes, userScopes } = await slackConfig(root);
    const manifest = userManifest(withScopes(
      JSON.parse(
        await Deno.readTextFile(new URL("../../seed/slack-manifest.json", import.meta.url)),
      ),
      { bot: botScopes, user: userScopes },
    ));
    const url = manifestUrl(manifest);
    console.error(`Connecting Slack as agent "${principal}".\n`);
    console.error("1. Create the app (pick your workspace):\n   " + url + "\n");
    console.error('2. In the app: OAuth & Permissions → "Install to Workspace" (approve).');
    console.error('3. Same page, "OAuth Tokens": copy the "User OAuth Token" (xoxp-…) —');
    console.error('   NOT the "Bot User OAuth Token" (xoxb-…). If no user token is shown,');
    console.error('   check "User Token Scopes" has scopes, then "Reinstall to Workspace".\n');
    try { // best effort — the link above is the real door
      new Deno.Command(Deno.build.os === "darwin" ? "open" : "xdg-open", {
        args: [url],
        stdout: "null",
        stderr: "null",
      }).spawn().unref();
    } catch { /* headless is fine */ }

    const token = ask("Paste the user token (xoxp-…):");
    if (!token) {
      console.error("no token pasted — nothing written");
      Deno.exit(2);
    }

    const log = await openLog(`${dir}/log`);
    const creds = await openCredentials(dir);
    try {
      const { team, user, missing } = await connectSlackUser(token, {
        principal,
        creds,
        store: log, // connections live on the Log (§4)
        publish: log.publish,
        asked: userScopes,
      });
      console.error(`\n✓ connected: workspace ${team}, slack user ${user} → ${principal}`);
      report(missing, 'Add them under "User Token Scopes", then "Reinstall to Workspace".');
      await owed(creds);
      console.error("  (deno task status shows the map)");
      await declared(root, "slack");
    } finally {
      await creds.close();
      await log.close();
    }
  });
}
