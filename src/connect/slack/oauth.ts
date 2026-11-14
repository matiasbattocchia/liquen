/**
 * connect/slack/oauth.ts — the Slack OAuth surface of the connection (DESIGN §4, §9).
 *
 * Two routes, one portable handler (`(Request) => Response`, deps injected — the same
 * shape as connect/google/oauth.ts):
 *
 *   GET /start     `?ticket=` names an open sign-in (connect/signin.ts): mint a one-time
 *                  `state` pointing at it → 302 to Slack's consent screen. A user token is
 *                  always someone's, so the ticket names the agent. Only user scopes are
 *                  asked (`user_scope`): the bot is the org's and comes from the install,
 *                  pasted at `liquen connect slack app --bot`, so a member signing in can
 *                  neither reinstall nor rescope it.
 *   GET /callback  verify state (one-time, TTL) → exchange the code (oauth.v2.access) →
 *                  the ticket judges the Slack-VERIFIED `authed_user.id` (and the
 *                  member's profile email, when the ticket asks for one) → land the user
 *                  token exactly as a paste lands one (`landSlackUser`): the workspace
 *                  stub, the member's OWN grant `<team>:<user>`, the self-DM binding, the
 *                  vault row `slack:<team>:<agent>`, the grant event → a plain "you can
 *                  close this window" page.
 *
 * Main serves these routes while a Slack ticket is open. The redirect URI is the org's
 * public callback, sent verbatim; Slack registers https only, with no loopback exception,
 * so it is always a public address that something terminating TLS forwards here. Both
 * routes are SYNCHRONOUS request/response (a 302, a page), so whatever fronts them must
 * carry a redirect.
 */

import type { OauthV2AccessResponse } from "@slack/web-api";
import { missingScopes } from "./config.ts";
import { landSlackUser, type SlackGrantDeps } from "./connect.ts";
import type { Credentials, TicketRow } from "../../store/credentials.ts";
import { timedFetch } from "../http.ts";
import type { Gate } from "../signin.ts";
import { askedOf, callbackTicket, page, startTicket } from "../door.ts";

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // must exactly match a registered redirect URL
}

/** oauth.v2.access — the OFFICIAL response type (the open-bsp lesson: we assumed shapes
 *  the API never promised; adopting Slack's own types is what surfaces those). */
export type SlackAccess = OauthV2AccessResponse;

export interface SlackOAuthDeps extends Omit<SlackGrantDeps, "principal"> {
  /** The app a ticket signs in through, and the redirect it registered. */
  config: (ticket: TicketRow) => Promise<SlackOAuthConfig>;
  /** The sign-in the ticket is (connect/signin.ts): judged, then told. */
  gate: Gate;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** The code exchange — injectable for tests; default POSTs oauth.v2.access. */
  exchange?: (code: string, config: SlackOAuthConfig) => Promise<SlackAccess>;
  /** The member's profile email, read with their own new token (users.info) —
   *  injectable; asked only when the ticket matches a handle. */
  emailOf?: (token: string, user: string) => Promise<string | undefined>;
}

export type OAuthHandler = (req: Request) => Promise<Response>;

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createSlackOAuth(deps: SlackOAuthDeps): OAuthHandler {
  const exchange = deps.exchange ?? defaultExchange;
  const emailOf = deps.emailOf ?? defaultEmailOf;

  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return page(405, "method not allowed");

    if (url.pathname.endsWith("/start")) {
      const t = await startTicket(url, deps.gate);
      if (t instanceof Response) return t;
      if (!t.agentId) return page(400, "a Slack user token is always someone's");
      const config = await deps.config(t);
      const state = await deps.creds.mintState("slack", { ticket: t.ticket });
      const auth = new URL("https://slack.com/oauth/v2/authorize");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("user_scope", askedOf(t).join(","));
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const at = await callbackTicket(url, "slack", deps.creds, deps.gate);
      if (at instanceof Response) return at;
      const { ticket: t, code } = at;
      const config = await deps.config(t);
      const acc = await exchange(code, config);
      const grant = acc.authed_user;
      if (!acc.ok || !acc.team?.id || !grant?.id || !grant.access_token) {
        const why = `the exchange failed: ${acc.error ?? "no user token in response"}`;
        await deps.gate.failed(t.ticket, why);
        return page(502, why);
      }
      const team = acc.team.id;
      const leg = `${team}:${grant.id}`;
      const email = typeof t.extra.email === "string"
        ? await emailOf(grant.access_token, grant.id).catch(() => undefined)
        : undefined;
      const verdict = await deps.gate.judge(t.ticket, {
        address: leg,
        ...(email ? { email } : {}),
      });
      if ("refused" in verdict) return page(403, verdict.refused);
      if (!verdict.agent) {
        await deps.gate.failed(t.ticket, "a Slack user token is always someone's");
        return page(400, "a Slack user token is always someone's");
      }
      // what the leg came back with, against what /start asked for: a member can grant
      // less than the app requests, and the token then fails at the CALL, not here
      const missing = missingScopes(askedOf(t), grant.scope);
      await landSlackUser(
        { token: grant.access_token, team, user: grant.id, missing },
        { ...deps, principal: verdict.agent },
      );
      await deps.gate.landed(t.ticket, leg, missing);
      return page(
        200,
        missing.length
          ? `Connected on ${team}, but the sign-in did not grant:\n  ${missing.join("\n  ")}\n\n` +
            `Calls needing them answer missing_scope. Approve them and sign in again.`
          : "✓ Connected. You can close this window.",
      );
    }

    return page(404, "not found");
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

async function defaultEmailOf(token: string, user: string): Promise<string | undefined> {
  const res = await timedFetch(`https://slack.com/api/users.info?user=${user}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json() as { ok?: boolean; user?: { profile?: { email?: string } } };
  return body.ok ? body.user?.profile?.email : undefined;
}
