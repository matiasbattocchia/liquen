/**
 * store/pg/credentials.ts — the vault on Postgres (§4, §9): the SQLite vault's contract,
 * its merge done by the same `json_patch` the log uses.
 *
 * `put` is field-wise: each top-level field of the written blob lands whole — the fields it
 * names are cleared first, then patched in — and the row lock serializes two processes
 * writing different fields of one credential, so both land.
 */

import type { CredentialRow, Credentials, TicketRow } from "../credentials.ts";
import { connect, count, rows } from "./sql.ts";
import { prepare } from "./schema.ts";

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
    await prepare(sql, schema);
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

  type RawTicket = {
    ticket: string;
    service: string;
    key: string;
    agent_id: string | null;
    extra: string | Record<string, unknown>;
    deadline: string | number;
  };
  const ticketOf = (r: RawTicket): TicketRow => ({
    ticket: r.ticket,
    service: r.service,
    key: r.key,
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    extra: typeof r.extra === "string" ? JSON.parse(r.extra) : r.extra,
    deadline: Number(r.deadline),
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

    async delete(key: string): Promise<boolean> {
      return await count(sql, "DELETE FROM credentials WHERE key = $1::text", [key]) > 0;
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

    async openTicket(row): Promise<{ row: TicketRow; opened: boolean }> {
      await count(sql, "DELETE FROM sign_ins WHERE settled = 1 AND deadline <= $1::bigint", [
        now(),
      ]);
      const ticket = crypto.randomUUID();
      await count(
        sql,
        `INSERT INTO sign_ins (ticket, service, key, agent_id, extra, deadline)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::bigint)
         ON CONFLICT DO NOTHING`,
        [
          ticket,
          row.service,
          row.key,
          row.agentId ?? null,
          JSON.stringify(row.extra),
          row.deadline,
        ],
      );
      const [open] = await rows<RawTicket>(
        sql,
        "SELECT * FROM sign_ins WHERE service = $1::text AND key = $2::text AND settled = 0",
        [row.service, row.key],
      );
      return { row: ticketOf(open), opened: open.ticket === ticket };
    },

    async ticket(id): Promise<TicketRow | null> {
      const [r] = await rows<RawTicket>(
        sql,
        "SELECT * FROM sign_ins WHERE ticket = $1::text AND settled = 0",
        [id],
      );
      return r ? ticketOf(r) : null;
    },

    async tickets(): Promise<TicketRow[]> {
      return (await rows<RawTicket>(
        sql,
        "SELECT * FROM sign_ins WHERE settled = 0 ORDER BY deadline, ticket",
      )).map(ticketOf);
    },

    async noteTicket(id, extra): Promise<void> {
      await count(
        sql,
        `UPDATE sign_ins SET extra = json_patch(extra, $1::jsonb)
         WHERE ticket = $2::text AND settled = 0`,
        [JSON.stringify(extra), id],
      );
    },

    async settleTicket(id): Promise<boolean> {
      return await count(
        sql,
        "UPDATE sign_ins SET settled = 1 WHERE ticket = $1::text AND settled = 0",
        [id],
      ) > 0;
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
