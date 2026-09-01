/**
 * connect/slack/connect.ts — `mu connect slack`: the PASTE door (DESIGN §4).
 *
 * The dashboard's "Install to Workspace" button IS an OAuth flow with Slack hosting the
 * redirect — so a dev can self-serve a user token (xoxp) with zero public surface: the
 * CLI prints the app-manifest prefill link, the dev creates + installs the app and pastes
 * the token back. The paste is the grant, and THE GRANT WRITES THE MAP — the same two
 * writes as the hosted oauth door (connect/slack/oauth.ts), from a different door:
 *
 *   auth.test(xoxp) → team + user (the paste never identifies the workspace; Slack does)
 *     → connections: the GRANT, OWNED — address `<team>:<user>` (a user grant is its own
 *                    connection, §4), `agent_id` = the principal (owned ⇒ private, §6),
 *                    `credential_key` → the vault row below
 *     → vault:       key `slack:<team>:<principal>` — the `token` field of the blob
 *
 * Three doors, one map (google's twins):
 *
 *   user   the paste above — the principal's own leg (xoxp), owned ⇒ private (§6)
 *   bot    the org's shared identity: xoxb (+ optional xapp, the socket carrier the
 *          ingest picks up) → vault `slack:<team>:org`, org-credentialed anchor
 *   app    the OAuth client (id + secret) → vault `slack:app:<client_id>` — what the
 *          hosted oauth door serves from
 *
 * Arg (user door): the principal (default: the OS username). Env: none.
 *
 * The manifest it prints is `src/seed/slack-manifest.json` — the app's SHAPE (name, events,
 * redirect, socket mode) — with the consent lists filled from `connections.slack`
 * (`withScopes`), so what the app may do is a knob and lives in one place.
 */

import type { AuthTestResponse } from "@slack/web-api";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { findRoot } from "../../config.ts";
import { declared } from "../declare.ts";

export interface SlackConnectDeps {
  /** The registry name the pasted grant belongs to (v0: principal name = agent name). */
  principal: string;
  creds: Pick<Credentials, "put">;
  /** The machinery's write side (§4) — the same seam the oauth callback uses. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** auth.test — injectable for tests; default POSTs with the pasted token. */
  authTest?: (token: string) => Promise<AuthTestResponse>;
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
): Promise<{ team: string; user: string }> {
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
          : " — self-DM unresolved, no mind-alias"),
    }],
  };
  await deps.publish(note);
  return { team, user };
}

/* ── the app door: `mu connect slack app` — the OAuth client into the vault ──────────── */

export const APP_PREFIX = "slack:app:";

export interface SlackApp {
  clientId: string;
  clientSecret: string;
  signingSecret?: string; // verifies HTTP-mode deliveries; socket mode needs none
  redirectUri?: string; // the HOSTED door's callback; absent ⇒ oauth serves localhost
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

/** The hosted door's app choice: the only one, or the one `clientId` names. */
export async function pickSlackApp(
  creds: Pick<Credentials, "get" | "list">,
  clientId?: string,
): Promise<CredentialRow> {
  if (clientId) {
    const row = await creds.get(`${APP_PREFIX}${clientId}`);
    if (!row) throw new Error(`no app ${clientId} — \`mu connect slack app\` first`);
    return row;
  }
  const apps = await creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no slack app in the vault — `mu connect slack app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.value.client_id).join("\n  ");
    throw new Error(`several apps — pick one with --app <client_id>:\n  ${ids}`);
  }
  return apps[0];
}

/* ── the bot door: `mu connect slack bot` — the org's shared identity ────────────────── */

export interface SlackBotDeps {
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections">;
  publish: Appender["publish"];
  authTest?: (token: string) => Promise<AuthTestResponse>;
  now?: () => string;
}

/** Finish a pasted bot-token grant: verify with Slack, write the ORG-credentialed anchor
 *  (`credential_key` on the workspace row, no owner ⇒ the org's shared inbox, §6), vault
 *  the blob at `slack:<team>:org` — `token` (xoxb) plus `app_token` (xapp) when given,
 *  the socket carrier the ingest picks up. Throws (writing nothing) on a rejected token. */
export async function connectSlackBot(
  token: string,
  deps: SlackBotDeps,
  appToken?: string,
): Promise<{ team: string; botUser: string }> {
  const authTest = deps.authTest ?? defaultAuthTest;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!token.startsWith("xoxb-")) {
    const got = token.startsWith("xoxp-")
      ? "the USER token (xoxp) — that one goes through `mu connect slack user`"
      : token.startsWith("xapp-")
      ? "an app-level token (xapp) — that's the socket carrier, pasted SECOND at this door"
      : "not a Slack bot token";
    throw new Error(`expected a bot token (xoxb-…), got ${got}`);
  }
  if (appToken && !appToken.startsWith("xapp-")) {
    throw new Error("the second paste must be an app-level token (xapp-…), or empty");
  }

  const who = await authTest(token);
  if (!who.ok || !who.team_id || !who.user_id) {
    throw new Error(`auth.test: ${who.error ?? "no team/user in response"}`);
  }
  const { team_id: team, user_id: botUser } = who;

  const credentialKey = `slack:${team}:org`;
  // ONE row: the workspace anchor, org-credentialed — that account itself reads as the
  // org (§6), so no ownership edge and no membership; the bot's identity is vault sidecar
  deps.store.upsertConnections([{ service: "slack", address: team, credentialKey }]);
  await deps.creds.put({
    key: credentialKey,
    value: { token, ...(appToken ? { app_token: appToken } : {}) },
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
          (appToken ? " — socket carrier stored" : " — no app-level token, HTTP ingest only"),
      }],
    } satisfies Draft<MessageEvent>,
  );
  return { team, botUser };
}

/** Fill the manifest's consent lists from the catalog — the seed carries the app's shape
 *  (name, events, redirect, socket mode), the config carries what it may do, so the app a
 *  door creates asks for exactly what the oauth door later requests. */
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
 *  its own deliberate door (`mu connect slack bot`). */
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
  const res = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ users: user }),
  });
  const out = await res.json() as { ok: boolean; channel?: { id?: string } };
  return out.ok ? out.channel?.id : undefined;
}

async function defaultAuthTest(token: string): Promise<AuthTestResponse> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return await res.json() as AuthTestResponse;
}

/* ── local entry: the three doors ───────────────────────────────────────────────────────
 *
 *   deno task connect:slack user [principal]   # prefill link → install → paste xoxp
 *   deno task connect:slack bot                # paste xoxb (+ optional xapp carrier)
 *   deno task connect:slack app                # paste client id + secret → the vault
 *
 * A bare invocation (or a bare principal name) is the user door — the common case. */
if (import.meta.main) {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { userInfo } = await import("node:os");
  const { slackConfig } = await import("./config.ts");

  const root = findRoot();
  const dir = `${root}/data`;
  const [first, ...rest] = Deno.args;
  const verb = first === "app" || first === "bot" || first === "user" ? first : "user";

  /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
  const lines = Deno.stdin.isTerminal()
    ? null
    : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
  const ask = (label: string): string | undefined =>
    (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

  if (verb === "app") {
    const creds = await openCredentials(dir);
    try {
      const clientId = ask("Client ID:");
      const clientSecret = ask("Client secret:");
      if (!clientId || !clientSecret) {
        console.error("nothing pasted — nothing written");
        Deno.exit(2);
      }
      const signingSecret = ask("Signing secret (verifies HTTP ingest; empty to skip):");
      const redirectUri = ask("Hosted redirect URI (empty to skip):");
      const key = await connectSlackApp(
        { clientId, clientSecret, signingSecret, redirectUri },
        creds,
      );
      console.error(
        `✓ app stored: ${key}` + (redirectUri ? ` (hosted callback: ${redirectUri})` : ""),
      );
    } finally {
      await creds.close();
    }
    Deno.exit(0);
  }

  if (verb === "bot") {
    console.error("In the app: OAuth & Permissions → the Bot User OAuth Token (xoxb-…).");
    console.error("Socket mode too? Basic Information → App-Level Tokens (xapp-…).\n");
    const token = ask("Paste the bot token (xoxb-…):");
    if (!token) {
      console.error("no token pasted — nothing written");
      Deno.exit(2);
    }
    const appToken = ask("App-level token (xapp-…, empty to skip):");
    const log = await openLog(`${dir}/log`);
    const creds = await openCredentials(dir);
    try {
      const { team, botUser } = await connectSlackBot(token, {
        creds,
        store: log,
        publish: log.publish,
      }, appToken);
      console.error(`\n✓ connected: workspace ${team}, bot user ${botUser} → the org`);
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
  console.error(`Connecting Slack as principal "${principal}".\n`);
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
    const { team, user } = await connectSlackUser(token, {
      principal,
      creds,
      store: log, // connections live on the Log (§4)
      publish: log.publish,
    });
    console.error(`\n✓ connected: workspace ${team}, slack user ${user} → ${principal}`);
    console.error("  (deno task status shows the map)");
    await declared(root, "slack");
  } finally {
    await creds.close();
    await log.close();
  }
}
