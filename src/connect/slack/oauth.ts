/**
 * connect/slack/oauth.ts — the Slack OAuth surface of the connection (DESIGN §4, §9).
 *
 * Two routes, one portable handler (`(Request) => Response`, deps injected — the same
 * open-bsp function shape as the github connector's ingest.ts):
 *
 *   GET /start     mint a one-time `state` → 302 to Slack's consent screen. The link is
 *                  stable and shareable: each click gets its own CSRF state, and Slack
 *                  verifies who clicked (§4: the log is the frontier).
 *   GET /callback  verify state (one-time, TTL) → exchange the code (oauth.v2.access) →
 *                  write the granted connections + vault rows: xoxb → the bot pipe (the
 *                  bare `<team>`, ownerless ⇒ the org's shared inbox, §6), xoxp → the
 *                  principal's OWN grant (`<team>:<user>`, owned ⇒ private), binding the
 *                  principal from the Slack-VERIFIED `authed_user.id` (auto-register on
 *                  first connect — the consent flow itself proves identity)
 *                  → publish a notification event to the log (the only legal way to tell
 *                  the harness anything) → a plain "you can close this window" page.
 *
 * Everyone connects through the same flow — installing the app granted the workspace leg
 * only; the admin's personal xoxp comes from this door like every other member's.
 *
 * Nothing serves these routes standing: a door serves them for the length of one sign-in.
 * Both are SYNCHRONOUS request/response (a 302, a page), so whatever fronts them must
 * carry a redirect — an async webhook relay (Hookdeck) cannot.
 */

import type { OauthV2AccessResponse } from "@slack/web-api";
import { DEFAULT_BOT_SCOPES, missingScopes } from "./config.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { timedFetch } from "../http.ts";

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // must (partially) match a registered redirect URL
  scopes?: string[]; // bot scopes requested alongside (kept in sync with the manifest)
  userScopes?: string[]; // the per-principal leg
}

/** oauth.v2.access — the OFFICIAL response type (the open-bsp lesson: we assumed shapes
 *  the API never promised; adopting Slack's own types is what surfaces those). */
export type SlackAccess = OauthV2AccessResponse;

export interface SlackOAuthDeps {
  config: SlackOAuthConfig;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** The machinery's write side (§4): a grant is what CREATES the connection anchor —
   *  the vault holds the secrets, these tables hold the map. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** Resolve a Slack-verified user to a principal id (existing binding or auto-register). */
  bindPrincipal: (slack: { team: string; user: string }) => Promise<string>;
  /** The code exchange — injectable for tests; default POSTs oauth.v2.access. */
  exchange?: (code: string, config: SlackOAuthConfig) => Promise<SlackAccess>;
  now?: () => string;
}

export type OAuthHandler = (req: Request) => Promise<Response>;

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createSlackOAuth(deps: SlackOAuthDeps): OAuthHandler {
  const { config } = deps;
  const exchange = deps.exchange ?? defaultExchange;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return text(405, "method not allowed");

    if (url.pathname.endsWith("/start")) {
      const state = await deps.creds.mintState("slack", {});
      const auth = new URL("https://slack.com/oauth/v2/authorize");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("scope", (config.scopes ?? DEFAULT_BOT_SCOPES).join(","));
      if (config.userScopes?.length) {
        auth.searchParams.set("user_scope", config.userScopes.join(","));
      }
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return text(400, "missing code/state");
      // one-time, TTL'd — a replayed or forged callback dies here (§9 boundary check)
      if ((await deps.creds.consumeState("slack", state)) === null) {
        return text(400, "bad state");
      }
      const acc = await exchange(code, config);
      if (!acc.ok || !acc.team?.id) return text(502, `exchange failed: ${acc.error ?? "?"}`);
      const team = acc.team.id;
      // what each leg came back with, against what /start asked for: an install can grant
      // less than the app requests, and the token then fails at the CALL, not here
      const short = [
        ...missingScopes(acc.access_token ? config.scopes ?? DEFAULT_BOT_SCOPES : [], acc.scope),
        ...missingScopes(
          acc.authed_user?.access_token ? config.userScopes ?? [] : [],
          acc.authed_user?.scope,
        ),
      ];

      // the bare WORKSPACE — the anchor of personal-witnessed deliveries; registering
      // it opens the log (§4, the gate). It stays a STUB (§6): membership-only.
      deps.store.upsertConnections([{ service: "slack", address: team }]);
      if (acc.access_token) { // the org (bot) grant — first install or re-consent: the
        // bot's OWN row `<team>:<bot user>`, ownerless + org-credentialed ⇒ the shared
        // inbox (§6) — bot-witnessed deliveries anchor here
        await deps.creds.put({ key: `slack:${team}:org`, value: { token: acc.access_token } });
        deps.store.upsertConnections([
          {
            service: "slack",
            address: acc.bot_user_id ? `${team}:${acc.bot_user_id}` : team,
            credentialKey: `slack:${team}:org`,
          },
        ]);
      }
      let who = "workspace";
      if (acc.authed_user?.id && acc.authed_user.access_token) { // the principal's grant:
        // their own connection `<team>:<user>`, owned ⇒ private (§6) — N principals on
        // one workspace are N rows, each grant its own ownership edge
        const principal = await deps.bindPrincipal({ team, user: acc.authed_user.id });
        const credentialKey = `slack:${team}:${principal}`;
        await deps.creds.put({
          key: credentialKey,
          value: { token: acc.authed_user.access_token },
          agentId: principal,
          extra: { scope: acc.authed_user.scope },
        });
        deps.store.upsertConnections([
          {
            service: "slack",
            address: `${team}:${acc.authed_user.id}`,
            agentId: principal,
            credentialKey,
          },
        ]);
        // the grant note is the principal's to see even on a stub workspace (§6)
        deps.store.upsertMemberships([
          { service: "slack", connection: team, conversation: "oauth", agentId: principal },
        ]);
        who = principal;
      }

      // cross the frontier the only legal way: an event (§4). Whatever agent cares reacts.
      const note: Draft<MessageEvent> = {
        ts: now(),
        type: "message",
        envelope: {
          service: "slack",
          connection_address: team, // the workspace this grant registered (§4, the gate)
          conversation: { address: "oauth" },
          sender: { address: "slack-oauth" },
        },
        parts: [{
          type: "text",
          kind: "text",
          text: `Slack connected on workspace ${team}: ${who}` +
            (acc.authed_user?.id ? ` (slack user ${acc.authed_user.id})` : "") +
            (short.length ? ` — NOT granted: ${short.join(" ")}` : ""),
        }],
      };
      await deps.publish(note);
      return new Response(
        short.length
          ? `Connected on ${team}, but the install did not grant:\n  ${short.join("\n  ")}\n\n` +
            `Calls needing them answer missing_scope. Add them to the app and install again.`
          : "✓ Connected. You can close this window.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return text(404, "not found");
  };
}

async function defaultExchange(code: string, c: SlackOAuthConfig): Promise<SlackAccess> {
  const res = await timedFetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
    }),
  });
  return await res.json() as SlackAccess;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}
