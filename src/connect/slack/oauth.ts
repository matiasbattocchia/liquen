/**
 * connect/slack/oauth.ts — the Slack OAuth surface of the connection (DESIGN §4, §9).
 *
 * Two routes, one portable handler (`(Request) => Response`, deps injected — the same
 * shape as connect/google/oauth.ts):
 *
 *   GET /start     mint a one-time `state` → 302 to Slack's consent screen. The link is
 *                  minted PER MEMBER, like Google's: `?agent=<name>` rides into the state
 *                  and the callback binds the grant to that member. A user token is
 *                  always someone's, so a link naming nobody is refused. Only user scopes
 *                  are asked (`user_scope`): the bot is the org's and comes from the
 *                  install, pasted at `liquen connect slack app --bot`, so a member signing
 *                  in can neither reinstall nor rescope it.
 *   GET /callback  verify state (one-time, TTL) → exchange the code (oauth.v2.access) →
 *                  land the user token exactly as a paste lands one (`landSlackUser`):
 *                  the workspace stub, the member's OWN grant `<team>:<user>` with the
 *                  Slack-VERIFIED `authed_user.id` as its address, the self-DM binding,
 *                  the vault row `slack:<team>:<agent>`, the grant event
 *                  → a plain "you can close this window" page.
 *
 * The verified id is what lets the terminal say `slack user U… → <agent>` and the dev
 * notice a link that reached the wrong hands; the binding itself is the dev's, decided at
 * mint time, because the roster names people and Slack ids name nobody in it.
 *
 * Nothing serves these routes standing: a door serves them for the length of one sign-in
 * (`liquen connect slack user`). The redirect URI is the app's — `extra.redirect_uri` on
 * the app row — sent verbatim and served at; Slack registers https only, with no loopback
 * exception, so it is always a public address that something terminating TLS forwards to
 * the door. Both routes are SYNCHRONOUS request/response (a 302, a page), so whatever
 * fronts them must carry a redirect.
 */

import type { OauthV2AccessResponse } from "@slack/web-api";
import { DEFAULT_USER_SCOPES, missingScopes } from "./config.ts";
import { landSlackUser, type SlackGrantDeps } from "./connect.ts";
import type { Credentials } from "../../store/credentials.ts";
import { timedFetch } from "../http.ts";

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // must exactly match a registered redirect URL
  userScopes?: string[]; // the default ask when /start names none
}

/** oauth.v2.access — the OFFICIAL response type (the open-bsp lesson: we assumed shapes
 *  the API never promised; adopting Slack's own types is what surfaces those). */
export type SlackAccess = OauthV2AccessResponse;

export interface SlackOAuthDeps extends Omit<SlackGrantDeps, "principal"> {
  config: SlackOAuthConfig;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** The code exchange — injectable for tests; default POSTs oauth.v2.access. */
  exchange?: (code: string, config: SlackOAuthConfig) => Promise<SlackAccess>;
  /** Called once the grant is written, before the page returns: a door that has a
   *  terminal in front of it (the user verb) reports there and then. */
  onGrant?: (grant: { team: string; user: string; agent: string; missing: string[] }) => void;
}

export type OAuthHandler = (req: Request) => Promise<Response>;

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createSlackOAuth(deps: SlackOAuthDeps): OAuthHandler {
  const { config } = deps;
  const exchange = deps.exchange ?? defaultExchange;

  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return text(405, "method not allowed");

    if (url.pathname.endsWith("/start")) {
      const agent = url.searchParams.get("agent");
      if (!agent) return text(400, "this link names nobody — a user token is always someone's");
      const scopes = url.searchParams.get("scopes")?.split(/[ ,]+/).filter(Boolean) ??
        config.userScopes ?? DEFAULT_USER_SCOPES;
      const state = await deps.creds.mintState("slack", { agent, scopes });
      const auth = new URL("https://slack.com/oauth/v2/authorize");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("user_scope", scopes.join(","));
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return text(400, "missing code/state");
      // one-time, TTL'd — a replayed or forged callback dies here (§9 boundary check)
      const bound = await deps.creds.consumeState("slack", state);
      if (bound === null || typeof bound.agent !== "string") return text(400, "bad state");
      const acc = await exchange(code, config);
      const grant = acc.authed_user;
      if (!acc.ok || !acc.team?.id || !grant?.id || !grant.access_token) {
        return text(502, `exchange failed: ${acc.error ?? "no user token in response"}`);
      }
      // what the leg came back with, against what /start asked for: a member can grant
      // less than the app requests, and the token then fails at the CALL, not here
      const asked = Array.isArray(bound.scopes)
        ? bound.scopes.filter((s): s is string => typeof s === "string")
        : [];
      const missing = missingScopes(asked, grant.scope);
      const team = acc.team.id;
      await landSlackUser(
        { token: grant.access_token, team, user: grant.id, missing },
        { ...deps, principal: bound.agent },
      );
      deps.onGrant?.({ team, user: grant.id, agent: bound.agent, missing });
      return new Response(
        missing.length
          ? `Connected on ${team}, but the sign-in did not grant:\n  ${missing.join("\n  ")}\n\n` +
            `Calls needing them answer missing_scope. Approve them and sign in again.`
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
