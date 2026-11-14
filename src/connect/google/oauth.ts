/**
 * connect/google/oauth.ts — the Google OAuth surface of the connection (DESIGN §4, §9).
 *
 * Two routes, one portable handler (`(Request) => Response`, deps injected — the same
 * shape as connect/slack/oauth.ts):
 *
 *   GET /start     `?ticket=` names an open sign-in (connect/signin.ts): mint a one-time
 *                  `state` pointing at it → 302 to Google's consent screen, asking the
 *                  ticket's scopes. Consent is INCREMENTAL (`include_granted_scopes`): a
 *                  later ask for Drive merges into the same grant. A reconnect's link
 *                  preselects its account (`login_hint`).
 *   GET /callback  verify state (one-time, TTL) → exchange the code → read the member's
 *                  verified identity from the `id_token` (Google signed it and handed it
 *                  over TLS — decoded, not re-verified) → the ticket judges the account
 *                  and names whom it binds to → write the map:
 *                    connections: `(google, <email>)`, `agent_id` from the ticket,
 *                                 `credential_key` → the vault row below
 *                    vault:       `google:<email>` — `refresh_token` (the grant) +
 *                                 `access_token`; scopes/sub/expiry in `extra`
 *                  → publish the grant event (the only legal way to tell the harness
 *                  anything) → a plain "you can close this window" page.
 *
 * `access_type=offline` + `prompt=consent` is what makes the refresh token arrive on
 * every pass through the door — and the vault's merge keeps a sibling field a re-consent
 * doesn't carry. The refresh token never leaves the vault: consumers ask the broker for
 * short-lived access tokens (the credential stays broker-side, §9).
 *
 * Main serves these routes while a Google ticket is open. The app is the ticket's
 * (`config`), and its redirect URI is sent verbatim, so the browser Google redirects
 * reaches the door the link started at. Both routes are SYNCHRONOUS request/response (a
 * 302, a page), so whatever fronts them must carry a redirect.
 */

import { GRANT_ENV, GRANT_HOSTS } from "./config.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials, TicketRow } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { timedFetch } from "../http.ts";
import { linked } from "../health.ts";
import type { Gate } from "../signin.ts";
import { askedOf, callbackTicket, page, startTicket } from "../door.ts";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // must exactly match a registered redirect URI
}

/** The token endpoint's answer — the fields this door reads (the wire carries more). */
export interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  scope?: string; // space-separated, the scopes actually GRANTED
  id_token?: string; // JWT carrying the verified identity (email, sub)
  error?: string;
  error_description?: string;
}

export interface GoogleOAuthDeps {
  /** The app a ticket signs in through, and the redirect it registered. */
  config: (ticket: TicketRow) => Promise<GoogleOAuthConfig>;
  /** The sign-in the ticket is (connect/signin.ts): judged, then told. */
  gate: Gate;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** The machinery's write side (§4): a grant is what CREATES the connection anchor. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** The code exchange — injectable for tests; default POSTs the token endpoint. */
  exchange?: (code: string, config: GoogleOAuthConfig) => Promise<GoogleTokens>;
  now?: () => string;
}

/** The door's two routes, `/start` and the callback, as one handler. */
export type OAuthHandler = (req: Request) => Promise<Response>;

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createGoogleOAuth(deps: GoogleOAuthDeps): OAuthHandler {
  const exchange = deps.exchange ?? defaultExchange;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return page(405, "method not allowed");

    if (url.pathname.endsWith("/start")) {
      const t = await startTicket(url, deps.gate);
      if (t instanceof Response) return t;
      const config = await deps.config(t);
      const state = await deps.creds.mintState("google", { ticket: t.ticket });
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", askedOf(t).join(" "));
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      auth.searchParams.set("include_granted_scopes", "true");
      if (typeof t.extra.account === "string") {
        auth.searchParams.set("login_hint", t.extra.account);
      }
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const at = await callbackTicket(url, "google", deps.creds, deps.gate);
      if (at instanceof Response) return at;
      const { ticket: t, code } = at;
      const config = await deps.config(t);
      const tok = await exchange(code, config);
      if (tok.error || !tok.access_token) {
        const why = `the exchange failed: ${tok.error ?? "no token"}`;
        await deps.gate.failed(t.ticket, why);
        return page(502, why);
      }
      const id = claimsOf(tok.id_token);
      if (!id?.email) {
        await deps.gate.failed(t.ticket, "the exchange carried no identity");
        return page(502, "exchange carried no identity");
      }
      const verdict = await deps.gate.judge(t.ticket, { address: id.email, email: id.email });
      if ("refused" in verdict) return page(403, verdict.refused);
      const { agent } = verdict;
      const missing = missingScopes(askedOf(t), tok.scope);

      const credentialKey = `google:${id.email}`;
      await deps.creds.put({
        key: credentialKey,
        value: {
          access_token: tok.access_token,
          // absent on the wire ⇒ absent here, and the vault's merge keeps the stored one
          ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
        },
        ...(agent ? { agentId: agent } : {}),
        extra: {
          scope: tok.scope,
          sub: id.sub,
          // the app that minted the grant — the broker needs it to refresh (§9): only this
          // client_id's secret can spend this refresh_token
          client_id: config.clientId,
          // the proxy declaration (§9): which env var fronts this grant, toward which hosts
          env: GRANT_ENV,
          hosts: GRANT_HOSTS,
          ...(tok.expires_in
            ? { expiry: new Date(Date.now() + tok.expires_in * 1000).toISOString() }
            : {}),
        },
      });
      await deps.store.upsertConnections([{
        service: "google",
        address: id.email,
        ...(agent ? { agentId: agent } : {}),
        credentialKey,
        extra: linked(now()),
      }]);
      if (agent) {
        // the grant note is the principal's to see (§6)
        await deps.store.upsertMemberships([
          { service: "google", connection: id.email, conversation: "oauth", agentId: agent },
        ]);
      }

      // cross the frontier the only legal way: an event (§4). Whatever agent cares reacts.
      const note: Draft<MessageEvent> = {
        ts: now(),
        type: "message",
        envelope: {
          service: "google",
          connection_address: id.email,
          conversation: { address: "oauth" },
          sender: { address: "google-oauth" },
        },
        parts: [{
          type: "text",
          kind: "text",
          text: `Google connected: ${id.email}` + (agent ? ` for ${agent}` : " (org)") +
            (tok.scope ? ` — scopes: ${tok.scope}` : "") +
            (missing.length ? ` — NOT granted: ${missing.join(" ")}` : ""),
        }],
      };
      await deps.publish(note);
      await deps.gate.landed(t.ticket, id.email, missing);
      return page(
        200,
        missing.length
          ? `Connected as ${id.email}, but these permissions were not granted:\n` +
            `  ${missing.join("\n  ")}\n\n` +
            `Approve them on the consent screen and connect again — consent is ` +
            `incremental, so it merges into this grant.`
          : "✓ Connected. You can close this window.",
      );
    }

    return page(404, "not found");
  };
}

/** `email` and `profile` are shorthands Google expands on the way back: the ask says
 *  `email`, the grant says `.../auth/userinfo.email`, and they are one scope. */
const ALIAS: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

/** What the ask did not get, in the ask's own spelling. A member ticks permissions one by
 *  one and the consent screen offers only what the app registered, so `scope` on the wire
 *  is the authority on what the grant can actually do — a subset is a grant that opens the
 *  door and still cannot do the work, and the API says so only at the first 403. */
export function missingScopes(asked: string[], granted?: string): string[] {
  const has = new Set(
    (granted ?? "").split(/\s+/).filter(Boolean).map((s) => ALIAS[s] ?? s),
  );
  return asked.filter((s) => !has.has(ALIAS[s] ?? s));
}

/** The id_token's payload — decoded, not verified: it arrived from Google's own token
 *  endpoint over TLS, so the transport is the trust (a callback can't forge it past the
 *  code exchange). */
export function claimsOf(idToken?: string): { email?: string; sub?: string } | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    ) as { email?: string; sub?: string };
  } catch {
    return null;
  }
}

async function defaultExchange(code: string, c: GoogleOAuthConfig): Promise<GoogleTokens> {
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  return await res.json() as GoogleTokens;
}
