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
 *   accessTokenFor(handle, host?)
 *                          a LIVE credential: a static `token` as-is (a pasted PAT, a
 *                          slack xoxb — nothing expires), the stored `access_token` while
 *                          it's fresh, else a re-issue against the grant's issuer, with
 *                          the rotated token written back to the vault. `host` enforces
 *                          the grant's binding: the row's `extra.hosts` names the only
 *                          origins the token may be spent toward (hostAllowed).
 *
 * The re-issue needs the app that minted the grant, and the grant's `extra` says which
 * issuer that is: `installation_id` names a GitHub App installation — the broker signs the
 * app's RS256 JWT with the private key in `github:app:<app_id>` and mints an hourly
 * installation token; `client_id` names a Google OAuth app — refresh_token + the secret in
 * `google:app:<client_id>`. The refresh_token and the private key never leave this module.
 * Concurrent calls for one grant share a single in-flight re-issue (no double-spend of the
 * one-time nonce, but also no redundant round-trips).
 */

import { createPrivateKey, createSign } from "node:crypto";
import { encodeBase64Url } from "@std/encoding";
import type { CredentialRow, Credentials } from "../store/credentials.ts";

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
   *  `host` is the dialed authority the token is about to be spent toward: a grant whose
   *  row declares `extra.hosts` is spendable ONLY toward them (exact or `*.` wildcard;
   *  the port doesn't bind) — the swap's one policy rule, declared where the grant lives.
   *  A row declaring none is unbound. Omit `host` for broker-side callers that hold the
   *  token anyway (a dispatcher's spawn env). null ⇒ unknown handle, a host outside the
   *  declaration, or a failed refresh (the proxy answers 401). */
  accessTokenFor(handle: string, host?: string): Promise<string | null>;
}

export interface BrokerDeps {
  creds: Pick<Credentials, "get" | "put">;
  /** Google's token endpoint — injectable for tests; default POSTs oauth2.googleapis.com. */
  refresh?: (body: URLSearchParams) => Promise<TokenResponse>;
  /** GitHub's installation-token endpoint — injectable for tests; default POSTs
   *  api.github.com with the app's JWT. */
  installationToken?: (jwt: string, installationId: string) => Promise<InstallationToken>;
  now?: () => number; // epoch ms
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
  error?: string;
  error_description?: string;
}

export interface InstallationToken {
  token?: string;
  expires_at?: string; // ISO — GitHub mints for an hour
  message?: string; // GitHub's error prose
}

// refresh a shade early: a token that expires mid-flight would 401 the tool
const SKEW_MS = 60_000;
const HANDLE_PREFIX = "mu-grant-";

export function createGrantBroker(deps: BrokerDeps): GrantBroker {
  const refresh = deps.refresh ?? defaultRefresh;
  const installationToken = deps.installationToken ?? defaultInstallationToken;
  const now = deps.now ?? (() => Date.now());
  const byHandle = new Map<string, Grant>();
  const byKey = new Map<string, string>(); // credentialKey → handle (idempotence)
  const inflight = new Map<string, Promise<string | null>>(); // credentialKey → refresh

  // github: the grant names an App installation — sign the app's JWT, mint an hourly token
  const refreshGithub = async (key: string, row: CredentialRow): Promise<string | null> => {
    const appId = String(row.extra?.app_id ?? "");
    const app = appId ? await deps.creds.get(`github:app:${appId}`) : null;
    const pem = app?.value.private_key;
    if (!pem) return null;
    const tok = await installationToken(
      appJwt(appId, pem, now()),
      String(row.extra!.installation_id),
    );
    if (!tok.token) return null;
    await deps.creds.put({
      key,
      value: { access_token: tok.token },
      ...(tok.expires_at ? { extra: { expiry: tok.expires_at } } : {}),
    });
    return tok.token;
  };

  // google: spend the refresh_token with the app's own secret
  const refreshGoogle = async (key: string, row: CredentialRow): Promise<string | null> => {
    const refreshToken = row.value.refresh_token;
    const clientId = typeof row.extra?.client_id === "string" ? row.extra.client_id : undefined;
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

  const doRefresh = async (key: string): Promise<string | null> => {
    const row = await deps.creds.get(key);
    if (!row) return null;
    // the row itself says which issuer re-issues it (see header)
    if (row.extra?.installation_id !== undefined) return refreshGithub(key, row);
    return refreshGoogle(key, row);
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

    async accessTokenFor(handle: string, host?: string): Promise<string | null> {
      const grant = byHandle.get(handle);
      if (!grant) return null;
      const key = grant.credentialKey;

      const row = await deps.creds.get(key);
      if (!row) return null;
      if (host !== undefined && !hostAllowed(row.extra?.hosts, host)) return null;
      if (row.value.token) return row.value.token; // static — nothing expires, nothing refreshes
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

/** The grant's host binding: a row declaring `extra.hosts` spends only toward them.
 *  Entries are exact hostnames or `*.suffix` wildcards; the dialed authority may carry a
 *  port, which doesn't bind. A row declaring none (or a malformed sidecar) is unbound. */
export function hostAllowed(hosts: unknown, authority: string): boolean {
  if (!Array.isArray(hosts)) return true;
  const host = authority.replace(/:\d+$/, "").toLowerCase();
  return hosts.some((h) =>
    typeof h === "string" &&
    (h.startsWith("*.") ? host.endsWith(h.slice(1).toLowerCase()) : host === h.toLowerCase())
  );
}

async function defaultRefresh(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return await res.json() as TokenResponse;
}

async function defaultInstallationToken(
  jwt: string,
  installationId: string,
): Promise<InstallationToken> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
    },
  );
  return await res.json() as InstallationToken;
}

/** The GitHub App's self-signed RS256 JWT: what `POST /app/installations/…/access_tokens`
 *  (and every other JWT-authenticated app endpoint) accepts as `Bearer`. Ten minutes is
 *  GitHub's ceiling; `iat` is backdated a minute because GitHub rejects any clock ahead of
 *  its own. Takes the PEM as GitHub downloads it (PKCS#1) — node:crypto reads both. */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const b64 = (b: string | Uint8Array): string =>
    encodeBase64Url(typeof b === "string" ? new TextEncoder().encode(b) : b);
  const iat = Math.floor(nowMs / 1000) - 60;
  const signing = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    b64(JSON.stringify({ iat, exp: iat + 600, iss: appId }))
  }`;
  const signer = createSign("RSA-SHA256");
  signer.update(signing);
  return `${signing}.${b64(new Uint8Array(signer.sign(createPrivateKey(privateKeyPem))))}`;
}
