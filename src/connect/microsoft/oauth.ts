/**
 * connect/microsoft/oauth.ts — the Entra OAuth surface of the connection (DESIGN §4, §9).
 *
 * Google's twin (connect/google/oauth.ts): two routes, one portable handler
 * (`(Request) => Response`, deps injected), served by a door for the length of one sign-in.
 *
 *   GET /start     mint a one-time `state` → 302 to the tenant's authorize endpoint. The
 *                  link is minted PER MEMBER: `?agent=<name>` rides into the state, and
 *                  the callback binds the grant to that member. No `agent` ⇒ an
 *                  ownerless grant: the org's shared account (§6). `?scopes=` overrides
 *                  the default ask; Entra records consent per permission, so a later ask
 *                  for Mail adds to what the member already granted.
 *   GET /callback  verify state (one-time, TTL) → exchange the code → read the member's
 *                  verified identity from the `id_token` (Entra signed it and handed it
 *                  over TLS — decoded, not re-verified) → write the map:
 *                    connections: `(microsoft, <upn>)`, `agent_id` from the state,
 *                                 `credential_key` → the vault row below
 *                    vault:       `microsoft:<upn>` — `refresh_token` (the grant) +
 *                                 `access_token`; scopes/oid/tid/expiry in `extra`
 *                  → publish the grant event → a plain "you can close this window" page.
 *
 * The address is the `preferred_username` claim — the account's UPN, an email-shaped name
 * a member recognizes; `oid` (the account) and `tid` (its tenant) ride as sidecars. The
 * refresh token arrives because `offline_access` is asked; Entra ROTATES it on every
 * refresh, so the broker stores the answer's back (proxy/grants.ts). The refresh token
 * never leaves the vault: consumers ask the broker for short-lived access tokens (§9).
 *
 * The endpoints are the tenant's: `login.microsoftonline.com/<tenant>/oauth2/v2.0/…`, where
 * `<tenant>` is the app row's — a directory id, a domain, or `organizations` for an app
 * registered multi-tenant. Both routes are SYNCHRONOUS request/response (a 302, a page),
 * so whatever fronts them must carry a redirect.
 */

import { DEFAULT_SCOPES, GRANT_ENV, GRANT_HOSTS } from "./config.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { timedFetch } from "../http.ts";

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string; // must exactly match a redirect URI registered on the app
  scopes?: string[]; // the default ask when /start names none
}

/** The token endpoint's answer — the fields this door reads (the wire carries more). */
export interface MicrosoftTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  scope?: string; // space-separated, the Graph permissions actually GRANTED
  id_token?: string; // JWT carrying the verified identity
  error?: string;
  error_description?: string;
}

export interface MicrosoftOAuthDeps {
  config: MicrosoftOAuthConfig;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** The machinery's write side (§4): a grant is what CREATES the connection anchor. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** The code exchange — injectable for tests; default POSTs the tenant's token endpoint. */
  exchange?: (code: string, config: MicrosoftOAuthConfig) => Promise<MicrosoftTokens>;
  /** Called once the grant is written, before the page returns: a door that has a
   *  terminal in front of it (the account verb) reports the shortfall there and then. */
  onGrant?: (grant: { upn: string; agent?: string; missing: string[] }) => void;
  now?: () => string;
}

export type OAuthHandler = (req: Request) => Promise<Response>;

/** The tenant's v2.0 endpoints. */
export function tokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}
function authorizeEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createMicrosoftOAuth(deps: MicrosoftOAuthDeps): OAuthHandler {
  const { config } = deps;
  const exchange = deps.exchange ?? defaultExchange;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return text(405, "method not allowed");

    if (url.pathname.endsWith("/start")) {
      const agent = url.searchParams.get("agent");
      const scopes = url.searchParams.get("scopes")?.split(/[ ,]+/).filter(Boolean) ??
        config.scopes ?? DEFAULT_SCOPES;
      const state = await deps.creds.mintState("microsoft", {
        ...(agent ? { agent } : {}),
        scopes,
      });
      const auth = new URL(authorizeEndpoint(config.tenant));
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("response_mode", "query");
      auth.searchParams.set("scope", scopes.join(" "));
      // a browser signed in to several accounts picks, rather than the link binding a
      // grant meant for one member to whichever account happened to be first
      auth.searchParams.set("prompt", "select_account");
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        // Entra reports a refused consent on the callback itself, in the query
        const why = url.searchParams.get("error_description") ?? url.searchParams.get("error");
        return text(400, why ?? "missing code/state");
      }
      // one-time, TTL'd — a replayed or forged callback dies here (§9 boundary check)
      const bound = await deps.creds.consumeState("microsoft", state);
      if (bound === null) return text(400, "bad state");
      const tok = await exchange(code, config);
      if (tok.error || !tok.access_token) {
        return text(502, `exchange failed: ${tok.error_description ?? tok.error ?? "no token"}`);
      }
      const id = claimsOf(tok.id_token);
      if (!id?.preferred_username) return text(502, "exchange carried no identity");
      const upn = id.preferred_username;
      const agent = typeof bound.agent === "string" ? bound.agent : undefined;
      const asked = Array.isArray(bound.scopes)
        ? bound.scopes.filter((s): s is string => typeof s === "string")
        : [];
      const missing = missingScopes(asked, tok.scope);

      const credentialKey = `microsoft:${upn}`;
      await deps.creds.put({
        key: credentialKey,
        value: {
          access_token: tok.access_token,
          ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
        },
        ...(agent ? { agentId: agent } : {}),
        extra: {
          scope: tok.scope,
          oid: id.oid,
          tid: id.tid,
          // the app that minted the grant — the broker needs it to refresh (§9): only this
          // client_id's secret, at its tenant, can spend this refresh_token
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
        service: "microsoft",
        address: upn,
        ...(agent ? { agentId: agent } : {}),
        credentialKey,
      }]);
      if (agent) {
        // the grant note is the principal's to see (§6)
        await deps.store.upsertMemberships([
          { service: "microsoft", connection: upn, conversation: "oauth", agentId: agent },
        ]);
      }

      // cross the frontier the only legal way: an event (§4). Whatever agent cares reacts.
      const note: Draft<MessageEvent> = {
        ts: now(),
        type: "message",
        envelope: {
          service: "microsoft",
          connection_address: upn,
          conversation: { address: "oauth" },
          sender: { address: "microsoft-oauth" },
        },
        parts: [{
          type: "text",
          kind: "text",
          text: `Microsoft connected: ${upn}` + (agent ? ` for ${agent}` : " (org)") +
            (tok.scope ? ` — scopes: ${tok.scope}` : "") +
            (missing.length ? ` — NOT granted: ${missing.join(" ")}` : ""),
        }],
      };
      await deps.publish(note);
      deps.onGrant?.({ upn, ...(agent ? { agent } : {}), missing });
      return new Response(
        missing.length
          ? `Connected as ${upn}, but these permissions were not granted:\n` +
            `  ${missing.join("\n  ")}\n\n` +
            `Approve them on the consent screen and connect again — consent adds up, so ` +
            `they merge into this grant.`
          : "✓ Connected. You can close this window.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return text(404, "not found");
  };
}

/** The OpenID scopes: they shape the id_token and never appear in the answer's `scope`,
 *  which lists Graph permissions alone. */
const OPENID = new Set(["openid", "profile", "email", "offline_access"]);
const GRAPH = "https://graph.microsoft.com/";

/** A Graph permission in its one spelling: the wire accepts `Mail.Read` and
 *  `https://graph.microsoft.com/Mail.Read` alike and may answer in either. */
function short(scope: string): string {
  return scope.startsWith(GRAPH) ? scope.slice(GRAPH.length) : scope;
}

/** What the ask did not get, in the ask's own spelling. `scope` on the wire is the
 *  authority on what the grant can actually do — a subset is a grant that opens the door
 *  and still cannot do the work, and the API says so only at the first 403. */
export function missingScopes(asked: string[], granted?: string): string[] {
  const has = new Set((granted ?? "").split(/\s+/).filter(Boolean).map(short));
  return asked.filter((s) => !OPENID.has(s) && !has.has(short(s)));
}

export interface IdClaims {
  preferred_username?: string;
  oid?: string;
  tid?: string;
}

/** The id_token's payload — decoded, not verified: it arrived from the tenant's own token
 *  endpoint over TLS, so the transport is the trust (a callback can't forge it past the
 *  code exchange). */
export function claimsOf(idToken?: string): IdClaims | null {
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
    ) as IdClaims;
  } catch {
    return null;
  }
}

async function defaultExchange(code: string, c: MicrosoftOAuthConfig): Promise<MicrosoftTokens> {
  const res = await timedFetch(tokenEndpoint(c.tenant), {
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
  return await res.json() as MicrosoftTokens;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}
