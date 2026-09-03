/**
 * store/credentials.ts — the vault (DESIGN §4, §9): a key:value store for everything
 * secret, in log.db (one substrate, its own accessor — the vault never rides the `Log`
 * object, so a policy-scoped log carries no credential capability into the agent plane).
 *
 *   • credentials — `(key, value, agent_id?, extra)`: `key` is the connector's own
 *     convention (slack: `slack:<team>:<owner>` for a user grant, `slack:<team>:org` for
 *     the bot; a tool: whatever its config's `credential_key` names); `value` is the
 *     service-shaped secret blob (`{token, app_token}`, `{client_id, client_secret}`,
 *     `{api_key}`); `agent_id` is the owner, absent = the org's — the same convention as
 *     connections, whose `credential_key` column points here. `put` MERGES `value`/
 *     `extra` fields: each door writes the field it holds (a pasted xoxp, a socket xapp)
 *     and never clobbers a sibling's; removal is a deliberate SQL act.
 *   • oauth_states — one-time CSRF nonces for authorize flows: minted at `/start`,
 *     consumed exactly once at the callback, expired after a TTL (`born`, epoch ms —
 *     the lease-arithmetic exception, like `locks.born`).
 *
 * Broker-side by construction: connectors read rows; agents never can (the exec plane
 * has no port here). On Postgres the same table wears RLS deny-all (§9).
 */

import { DatabaseSync } from "node:sqlite";

export interface CredentialRow {
  key: string;
  value: Record<string, string>; // the secret blob
  agentId?: string; // the owner; absent = the org's (§4)
  extra?: Record<string, unknown>; // non-secret sidecar (scopes, urls…)
}

export interface Credentials {
  /** Merge the row's `value`/`extra` fields into the stored blob (see header). */
  put(row: CredentialRow): Promise<void>;
  get(key: string): Promise<CredentialRow | null>;
  /** Rows whose key starts with `prefix` (a literal, not a pattern) — key order. */
  list(prefix: string): Promise<CredentialRow[]>;
  /** Mint a one-time state for an OAuth flow; `extra` rides along (org, hints). */
  mintState(service: string, extra?: Record<string, unknown>): Promise<string>;
  /** Consume a state exactly once: returns its extra, or null (unknown/used/expired). */
  consumeState(service: string, state: string): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
}

const STATE_TTL_MS = 10 * 60 * 1000; // OAuth codes live ~10min; states match

/** Open the vault on the org's log.db (its own connection — WAL serves both). */
/** `now` is the clock the OAuth-state TTL is measured against (§9): a test ages a state
 *  by moving it rather than waiting ten minutes. */
export async function openCredentials(
  dir: string,
  opts: { now?: () => number } = {},
): Promise<Credentials> {
  const now = opts.now ?? Date.now;
  await Deno.mkdir(`${dir}/log`, { recursive: true });
  const db = new DatabaseSync(`${dir}/log/log.db`);
  db.exec(
    `PRAGMA busy_timeout=5000;
     PRAGMA journal_mode=WAL;
     CREATE TABLE IF NOT EXISTS credentials (
       key        TEXT PRIMARY KEY,
       value      TEXT NOT NULL,
       agent_id   TEXT,
       extra      TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS oauth_states (
       state   TEXT PRIMARY KEY,
       service TEXT NOT NULL,
       extra   TEXT,
       born    INTEGER NOT NULL,
       used    INTEGER NOT NULL DEFAULT 0
     );`,
  );
  const putC = db.prepare(
    `INSERT INTO credentials (key, value, agent_id, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, agent_id = COALESCE(excluded.agent_id, agent_id),
       extra = excluded.extra, updated_at = excluded.updated_at`,
  );
  const getC = db.prepare("SELECT * FROM credentials WHERE key = ?");
  const listC = db.prepare(
    "SELECT * FROM credentials WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
  );
  const putS = db.prepare(
    "INSERT INTO oauth_states (state, service, extra, born) VALUES (?, ?, ?, ?)",
  );
  const takeS = db.prepare(
    `UPDATE oauth_states SET used = 1
     WHERE state = ? AND service = ? AND used = 0 AND born > ?
     RETURNING extra`,
  );

  type RawRow = { key: string; value: string; agent_id: string | null; extra: string | null };
  const rowOf = (r: RawRow): CredentialRow => ({
    key: r.key,
    value: JSON.parse(r.value) as Record<string, string>,
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.extra ? { extra: JSON.parse(r.extra) as Record<string, unknown> } : {}),
  });
  const read = (key: string): CredentialRow | null => {
    const r = getC.get(key) as RawRow | undefined;
    return r ? rowOf(r) : null;
  };

  return {
    put(row: CredentialRow): Promise<void> {
      const prior = read(row.key);
      const value = { ...prior?.value, ...row.value };
      const extra = prior?.extra || row.extra ? { ...prior?.extra, ...row.extra } : undefined;
      putC.run(
        row.key,
        JSON.stringify(value),
        row.agentId ?? null,
        extra ? JSON.stringify(extra) : null,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      return Promise.resolve();
    },

    get(key: string): Promise<CredentialRow | null> {
      return Promise.resolve(read(key));
    },

    list(prefix: string): Promise<CredentialRow[]> {
      const pattern = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
      return Promise.resolve((listC.all(pattern) as RawRow[]).map(rowOf));
    },

    mintState(service, extra): Promise<string> {
      const state = crypto.randomUUID();
      putS.run(state, service, extra ? JSON.stringify(extra) : null, now());
      return Promise.resolve(state);
    },

    consumeState(service, state): Promise<Record<string, unknown> | null> {
      const r = takeS.get(state, service, now() - STATE_TTL_MS) as
        | { extra: string | null }
        | undefined;
      if (r === undefined) return Promise.resolve(null);
      return Promise.resolve(r.extra ? JSON.parse(r.extra) as Record<string, unknown> : {});
    },

    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
}
