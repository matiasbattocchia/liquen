/**
 * connect/google/oauth.ts — the Google OAuth surface of the connection (DESIGN §4, §9).
 *
 * Two routes, one portable handler (`(Request) => Response`, deps injected — the same
 * shape as connect/slack/oauth.ts):
 *
 *   GET /start     mint a one-time `state` → 302 to Google's consent screen. Unlike the
 *                  Slack door (a shared admin link; Slack verifies who clicked), this
 *                  link is minted PER MEMBER: `?agent=<principal>` rides into the state,
 *                  and the callback binds the grant to that principal. The agent is the
 *                  doorman — it composes the link for ITS principal and delivers it over
 *                  the channel it already holds (§4: the log is the frontier). No
 *                  `agent` ⇒ an ownerless grant: the org's shared account (§6).
 *                  `?scopes=` (space-separated) overrides the default ask — consent is
 *                  INCREMENTAL (`include_granted_scopes`): a later ask for Drive merges
 *                  into the same grant, so the first ask stays as small as calendar.
 *   GET /callback  verify state (one-time, TTL) → exchange the code → read the member's
 *                  verified identity from the `id_token` (Google signed it and handed it
 *                  over TLS — decoded, not re-verified) → write the map:
 *                    connections: `(google, <email>)`, `agent_id` from the state,
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
 * Serving note: both routes are SYNCHRONOUS request/response (a 302, a page) — serve
 * them through a real proxy (cloudflared in dev, an edge function in prod).
 */

import { DEFAULT_SCOPES, GRANT_ENV, GRANT_HOSTS } from "./config.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { findRoot } from "../../config.ts";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // must exactly match a registered redirect URI
  scopes?: string[]; // the default ask when /start names none
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
  config: GoogleOAuthConfig;
  creds: Pick<Credentials, "put" | "mintState" | "consumeState">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** The machinery's write side (§4): a grant is what CREATES the connection anchor. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** The code exchange — injectable for tests; default POSTs the token endpoint. */
  exchange?: (code: string, config: GoogleOAuthConfig) => Promise<GoogleTokens>;
  /** Called once the grant is written, before the page returns: a door that has a
   *  terminal in front of it (the account verb) reports the shortfall there and then. */
  onGrant?: (grant: { email: string; agent?: string; missing: string[] }) => void;
  now?: () => string;
}

/** Identity + calendar: the first product. Drive/Gmail arrive by incremental re-consent
 *  through the same door — never by widening this list ahead of a member's ask. */
export type OAuthHandler = (req: Request) => Promise<Response>;

/** Build the two-route handler. Pure over its deps — serve it anywhere synchronous. */
export function createGoogleOAuth(deps: GoogleOAuthDeps): OAuthHandler {
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
      const state = await deps.creds.mintState("google", {
        ...(agent ? { agent } : {}),
        scopes,
      });
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("redirect_uri", config.redirectUri);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", scopes.join(" "));
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      auth.searchParams.set("include_granted_scopes", "true");
      auth.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: auth.href } });
    }

    if (url.pathname.endsWith("/callback")) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return text(400, "missing code/state");
      // one-time, TTL'd — a replayed or forged callback dies here (§9 boundary check)
      const bound = await deps.creds.consumeState("google", state);
      if (bound === null) return text(400, "bad state");
      const tok = await exchange(code, config);
      if (tok.error || !tok.access_token) {
        return text(502, `exchange failed: ${tok.error ?? "no token"}`);
      }
      const id = claimsOf(tok.id_token);
      if (!id?.email) return text(502, "exchange carried no identity");
      const agent = typeof bound.agent === "string" ? bound.agent : undefined;
      const asked = Array.isArray(bound.scopes)
        ? bound.scopes.filter((s): s is string => typeof s === "string")
        : [];
      const missing = missingScopes(asked, tok.scope);

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
      deps.store.upsertConnections([{
        service: "google",
        address: id.email,
        ...(agent ? { agentId: agent } : {}),
        credentialKey,
      }]);
      if (agent) {
        // the grant note is the principal's to see (§6)
        deps.store.upsertMemberships([
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
      deps.onGrant?.({ email: id.email, ...(agent ? { agent } : {}), missing });
      return new Response(
        missing.length
          ? `Connected as ${id.email}, but these permissions were not granted:\n` +
            `  ${missing.join("\n  ")}\n\n` +
            `Approve them on the consent screen and connect again — consent is ` +
            `incremental, so it merges into this grant.`
          : "✓ Connected. You can close this window.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return text(404, "not found");
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
  const res = await fetch("https://oauth2.googleapis.com/token", {
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

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── local entry: serve /oauth/google/start + /callback over the org stores ────────────
 *
 *   deno task oauth:google [--app <client_id>]   # :8791 — put a SYNCHRONOUS proxy in
 *                                                  front (cloudflared)
 *
 * The app credential (client id/secret) lives in the vault — `google:app:<client_id>`,
 * written by `mu connect google app` — and the vault is the ONLY source: `--app` picks
 * among several. The redirect URI is the app row's `redirect_uri` sidecar (the hosted
 * callback), localhost when absent. The port is connections.google.oauthPort. */
if (import.meta.main) {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { pickGoogleApp } = await import("./connect.ts");
  const { googleConfig } = await import("./config.ts");
  const root = findRoot();
  const dir = `${root}/data`;
  const { oauthPort: port, scopes } = await googleConfig(root);
  const creds = await openCredentials(dir);
  const appFlag = Deno.args.indexOf("--app");
  const appId = appFlag >= 0 ? Deno.args[appFlag + 1] : undefined;
  const app = await pickGoogleApp(creds, appId).catch((e) => {
    console.error(`[oauth] ${e.message}`);
    Deno.exit(2);
  });
  const config: GoogleOAuthConfig = {
    clientId: app.value.client_id,
    clientSecret: app.value.client_secret,
    redirectUri: (app.extra?.redirect_uri as string | undefined) ??
      `http://localhost:${port}/oauth/google/callback`,
    scopes,
  };
  const log = await openLog(`${dir}/log`);
  const handler = createGoogleOAuth({
    config,
    creds,
    publish: log.publish, // no wrapper: keep the overloads (it closes over the db, not `this`)
    store: log, // connections live on the Log (§4) — the grant writes the map
    onGrant: (g) =>
      console.error(
        `[oauth] granted ${g.email}${g.agent ? ` → ${g.agent}` : " (org)"}` +
          (g.missing.length ? ` — WITHOUT ${g.missing.join(" ")}` : ""),
      ),
  });
  console.error(`[oauth] on :${port} — agents mint <public>/oauth/google/start?agent=…`);
  Deno.serve({ port }, handler);
}
