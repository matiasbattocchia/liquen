/**
 * proxy/grants.ts — the credential broker (DESIGN §9): the ONLY code in the proxy that ever
 * touches a secret.
 *
 * User space never holds a real credential — it holds a PLACEHOLDER handle (`mu-grant-…`),
 * an opaque capability (the file-descriptor analogy: readable, printable, meaningful only
 * here). The proxy sees the handle on the wire and asks the broker for the real access
 * token to swap in. The broker:
 *
 *   issue(credentialKey)   mint (or return) the handle standing for a vault grant.
 *   resolve(handle)        handle → the grant it names (credentialKey/agentId) — NO secret.
 *   accessTokenFor(handle) a LIVE access token: the stored one while it's fresh, else a
 *                          refresh against Google (refresh_token + the app secret), with
 *                          the rotated token written back to the vault. The refresh_token
 *                          never leaves this function.
 *
 * The refresh needs the app that minted the grant — its `client_id` is recorded on the
 * grant's `extra`, and the secret lives in `google:app:<client_id>`. Concurrent calls for
 * one grant share a single in-flight refresh (no double-spend of the one-time nothing, but
 * also no redundant round-trips).
 */

import type { Credentials } from "../store/credentials.ts";

export interface Grant {
  credentialKey: string;
  agentId?: string;
}

export interface GrantBroker {
  /** Mint (idempotent per key) the placeholder that stands for a vault grant. */
  issue(credentialKey: string, agentId?: string): string;
  /** The grant a handle names — never a secret. */
  resolve(handle: string): Grant | null;
  /** A live access token for the handle, refreshing when the stored one has expired.
   *  null ⇒ unknown handle, or the refresh failed (the proxy answers 401). */
  accessTokenFor(handle: string): Promise<string | null>;
}

export interface BrokerDeps {
  creds: Pick<Credentials, "get" | "put">;
  /** The token endpoint — injectable for tests; default POSTs oauth2.googleapis.com. */
  refresh?: (body: URLSearchParams) => Promise<TokenResponse>;
  now?: () => number; // epoch ms
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
  error?: string;
  error_description?: string;
}

// refresh a shade early: a token that expires mid-flight would 401 the tool
const SKEW_MS = 60_000;
const HANDLE_PREFIX = "mu-grant-";

export function createGrantBroker(deps: BrokerDeps): GrantBroker {
  const refresh = deps.refresh ?? defaultRefresh;
  const now = deps.now ?? (() => Date.now());
  const byHandle = new Map<string, Grant>();
  const byKey = new Map<string, string>(); // credentialKey → handle (idempotence)
  const inflight = new Map<string, Promise<string | null>>(); // credentialKey → refresh

  const doRefresh = async (key: string): Promise<string | null> => {
    const row = await deps.creds.get(key);
    const refreshToken = row?.value.refresh_token;
    const clientId = typeof row?.extra?.client_id === "string" ? row.extra.client_id : undefined;
    if (!refreshToken || !clientId) return null;
    const app = await deps.creds.get(`google:app:${clientId}`);
    const clientSecret = app?.value.client_secret;
    if (!clientSecret) return null;

    const tok = await refresh(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    );
    if (!tok.access_token) return null;

    await deps.creds.put({
      key,
      value: { access_token: tok.access_token },
      ...(tok.expires_in
        ? { extra: { expiry: new Date(now() + tok.expires_in * 1000).toISOString() } }
        : {}),
    });
    return tok.access_token;
  };

  return {
    issue(credentialKey: string, agentId?: string): string {
      const existing = byKey.get(credentialKey);
      if (existing) return existing;
      const handle = HANDLE_PREFIX + crypto.randomUUID().replaceAll("-", "");
      byHandle.set(handle, { credentialKey, ...(agentId ? { agentId } : {}) });
      byKey.set(credentialKey, handle);
      return handle;
    },

    resolve(handle: string): Grant | null {
      return byHandle.get(handle) ?? null;
    },

    async accessTokenFor(handle: string): Promise<string | null> {
      const grant = byHandle.get(handle);
      if (!grant) return null;
      const key = grant.credentialKey;

      const row = await deps.creds.get(key);
      if (!row) return null;
      const expiry = typeof row.extra?.expiry === "string" ? Date.parse(row.extra.expiry) : NaN;
      if (row.value.access_token && Number.isFinite(expiry) && expiry - now() > SKEW_MS) {
        return row.value.access_token; // still fresh
      }

      // expired (or unknown expiry): refresh — but only once per grant concurrently
      let flight = inflight.get(key);
      if (!flight) {
        flight = doRefresh(key).finally(() => inflight.delete(key));
        inflight.set(key, flight);
      }
      return await flight;
    },
  };
}

async function defaultRefresh(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return await res.json() as TokenResponse;
}
