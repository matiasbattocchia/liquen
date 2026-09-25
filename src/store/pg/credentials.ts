/**
 * store/pg/credentials.ts — the vault on Postgres (§4, §9): the SQLite vault's contract,
 * its merge done by the same `json_patch` the log uses.
 *
 * `put` is field-wise: each top-level field of the written blob lands whole — the fields it
 * names are cleared first, then patched in — and the row lock serializes two processes
 * writing different fields of one credential, so both land.
 */

import type { CredentialRow, Credentials } from "../credentials.ts";
import { connect, count, rows } from "./sql.ts";
import { prepare, VAULT_DDL } from "./schema.ts";

const STATE_TTL_MS = 10 * 60 * 1000; // OAuth codes live ~10min; states match

/** Every top-level field of `b` landing whole over `a`'s (a field set to null removed). */
const merge = (a: string, b: string) =>
  `json_patch(json_patch(${a}, (SELECT coalesce(jsonb_object_agg(key, 'null'::jsonb), '{}')
     FROM jsonb_each(${b}))), ${b})`;

/** Open the vault in `schema` of the database at `url`. `now` is the clock the OAuth-state
 *  TTL is measured against (§9). */
export async function openPgCredentials(
  url: string,
  opts: { schema?: string; now?: () => number } = {},
): Promise<Credentials> {
  const schema = opts.schema ?? "public";
  const now = opts.now ?? Date.now;
  const sql = connect(url, schema);
  try {
    await prepare(sql, schema, VAULT_DDL);
  } catch (err) {
    await sql.end();
    throw err;
  }
  const prune = () =>
    count(sql, "DELETE FROM oauth_states WHERE born <= $1::bigint", [now() - STATE_TTL_MS]);
  await prune();

  type RawRow = { key: string; value: string; agent_id: string | null; extra: string | null };
  const rowOf = (r: RawRow): CredentialRow => ({
    key: r.key,
    value: JSON.parse(r.value) as Record<string, string>,
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.extra ? { extra: JSON.parse(r.extra) as Record<string, unknown> } : {}),
  });

  return {
    async put(row: CredentialRow): Promise<void> {
      const at = new Date().toISOString();
      await count(
        sql,
        `INSERT INTO credentials (key, value, agent_id, extra, created_at, updated_at)
         VALUES ($1::text, $2::jsonb, $3::text, $4::jsonb, $5::text, $5::text)
         ON CONFLICT (key) DO UPDATE SET
           value = ${merge("credentials.value", "excluded.value")},
           agent_id = coalesce(excluded.agent_id, credentials.agent_id),
           extra = CASE WHEN excluded.extra IS NULL THEN credentials.extra
                        ELSE ${merge("coalesce(credentials.extra, '{}')", "excluded.extra")} END,
           updated_at = excluded.updated_at`,
        [
          row.key,
          JSON.stringify(row.value),
          row.agentId ?? null,
          row.extra ? JSON.stringify(row.extra) : null,
          at,
        ],
      );
    },

    async get(key: string): Promise<CredentialRow | null> {
      const [r] = await rows<RawRow>(sql, "SELECT * FROM credentials WHERE key = $1::text", [key]);
      return r ? rowOf(r) : null;
    },

    async list(prefix: string): Promise<CredentialRow[]> {
      const pattern = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
      return (await rows<RawRow>(
        sql,
        "SELECT * FROM credentials WHERE key LIKE $1::text ESCAPE '\\' ORDER BY key",
        [pattern],
      )).map(rowOf);
    },

    async mintState(service, extra): Promise<string> {
      await prune();
      const state = crypto.randomUUID();
      await count(
        sql,
        `INSERT INTO oauth_states (state, service, extra, born)
         VALUES ($1::text, $2::text, $3::jsonb, $4::bigint)`,
        [state, service, extra ? JSON.stringify(extra) : null, now()],
      );
      return state;
    },

    async consumeState(service, state): Promise<Record<string, unknown> | null> {
      const [r] = await rows<{ extra: string | null }>(
        sql,
        `UPDATE oauth_states SET used = 1
         WHERE state = $1::text AND service = $2::text AND used = 0 AND born > $3::bigint
         RETURNING extra`,
        [state, service, now() - STATE_TTL_MS],
      );
      if (r === undefined) return null;
      return r.extra ? JSON.parse(r.extra) as Record<string, unknown> : {};
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
