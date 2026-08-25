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
 * v0 scope: the user leg for the default principal (paste = local/dev tier; the hosted
 * oauth door remains the org tier — same map, two doors, like ingest's socket vs HTTP).
 * Arg: the principal (default: the OS username). Env: MU_DIR.
 */

import type { AuthTestResponse } from "@slack/web-api";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";

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

/** The DEFAULT door mints a USER-ONLY app: no bot user, no bot scopes, no bot events.
 *  The bot is not required for the user leg — and asking for one puts an xoxb next to
 *  the xoxp on the dashboard, the exact paste-slip the shape guard catches. A bot is a
 *  separate, deliberate act (`--bot`, backlog). */
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

/* ── local entry: print the door, take the paste, finish the grant ──────────────────────
 *
 *   deno task connect:slack      # prefill link → create + install → paste xoxp
 */
if (import.meta.main) {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { userInfo } = await import("node:os");

  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const principal = Deno.args[0] ?? (() => {
    try {
      return userInfo().username;
    } catch {
      return "principal";
    }
  })();

  const manifest = userManifest(JSON.parse(
    await Deno.readTextFile(new URL("../../seed/slack-manifest.json", import.meta.url)),
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

  // TTY: interactive paste; piped stdin: read the line (secret managers, scripts)
  const token = Deno.stdin.isTerminal()
    ? prompt("Paste the user token (xoxp-…):")?.trim()
    : (await new Response(Deno.stdin.readable).text()).trim();
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
  } finally {
    await creds.close();
    await log.close();
  }
}
