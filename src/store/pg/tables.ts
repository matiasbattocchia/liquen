/**
 * store/pg/tables.ts — the store's ports beside the log, on Postgres (§4, §9, §10).
 *
 * Each is the SQLite adapter's statements in Postgres's words — `jsonb` operators for
 * `json_extract`, `ON CONFLICT` targets for `INSERT OR REPLACE` — answering through the
 * same row mappers. The claims (a lease's steal, a timer's claim) stay one conditional
 * UPDATE each: under READ COMMITTED the second writer waits on the row, re-reads its
 * predicate against the first writer's commit, and touches nothing.
 */

import type { LeaseRows } from "../lock.ts";
import { agentOf, type AgentRow, type Registry } from "../agents.ts";
import type { PermissionBehavior } from "../../types.ts";
import type { RememberedRule, Standing } from "../rules.ts";
import {
  type AliasColumns,
  aliasRowOf,
  connectionOf,
  type Connections,
  ENROLLMENT_ORDER,
  type EnrollmentColumns,
  enrollmentOf,
  type MembershipRow,
} from "../connections.ts";
import { routedSession } from "../../session.ts";
import {
  CLAIM_LEASE_MS,
  nextFire,
  type Raw,
  timerOf,
  type TimerRow,
  type Timers,
} from "../timers.ts";
import { type Gates, owedOf, type RulingRow } from "../gates.ts";
import { RETRY_BACKOFF_MS, type Sweeper } from "../sweep.ts";
import { newId } from "../id.ts";
import type { Event, PermissionRequestEvent } from "../../types.ts";
import { count, type Db, rows } from "./sql.ts";

export function pgLeases(db: Db): LeaseRows {
  return {
    take: async (name, t) =>
      await count(
        db,
        `INSERT INTO locks (name, born, seen) VALUES ($1::text, $2::bigint, $2::bigint)
         ON CONFLICT (name) DO NOTHING`,
        [name, t],
      ) > 0,
    steal: async (name, t, cutoff) =>
      await count(
        db,
        `UPDATE locks SET born = $2::bigint, seen = $2::bigint, cancel = 0
         WHERE name = $1::text AND seen <= $3::bigint`,
        [name, t, cutoff],
      ) > 0,
    beat: async (name, born, t) => {
      const [row] = await rows<{ cancel: number }>(
        db,
        `UPDATE locks SET seen = $3::bigint WHERE name = $1::text AND born = $2::bigint
         RETURNING cancel`,
        [name, born, t],
      );
      return row === undefined ? undefined : { cancel: row.cancel === 1 };
    },
    free: async (name, born) => {
      await count(db, RELEASE, [name, born]);
    },
    live: async (name, cutoff) =>
      (await rows(db, "SELECT 1 FROM locks WHERE name = $1::text AND seen > $2::bigint", [
        name,
        cutoff,
      ])).length > 0,
    marked: async (name, born) =>
      (await rows<{ cancel: number }>(
        db,
        "SELECT cancel FROM locks WHERE name = $1::text AND born = $2::bigint",
        [name, born],
      ))[0]?.cancel === 1,
  };
}

/** The release a turn's last publish runs in its own transaction (§2). */
export const RELEASE = "DELETE FROM locks WHERE name = $1::text AND born = $2::bigint";

export function pgRegistry(db: Db): Registry {
  const all = `SELECT agent_id, mind, provider, model, effort, name, email, phone, principals,
                 runs, settings
               FROM agents ORDER BY agent_id`;
  return {
    async syncAgents(list: AgentRow[]): Promise<void> {
      const now = new Date().toISOString();
      const keep = new Set(list.map((r) => r.agentId));
      for (const r of list) {
        await count(
          db,
          `INSERT INTO agents (agent_id, mind, provider, model, effort, name, email, phone,
             principals, runs, settings, created_at, updated_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
             $8::text, $9::jsonb, $10::integer, $11::jsonb, $12::text, $12::text)
           ON CONFLICT (agent_id) DO UPDATE SET
             mind = excluded.mind, provider = excluded.provider, model = excluded.model,
             effort = excluded.effort, name = excluded.name, email = excluded.email,
             phone = excluded.phone, principals = excluded.principals, runs = excluded.runs,
             settings = excluded.settings, updated_at = excluded.updated_at`,
          [
            r.agentId,
            r.mind,
            r.provider ?? null,
            r.model ?? null,
            r.effort ?? null,
            r.name ?? null,
            r.email ?? null,
            r.phone ?? null,
            r.principals ? JSON.stringify(r.principals) : null,
            r.runs === false ? 0 : 1,
            r.settings ? JSON.stringify(r.settings) : null,
            now,
          ],
        );
      }
      for (const row of await rows<{ agent_id: string }>(db, all)) {
        if (!keep.has(row.agent_id)) {
          await count(db, "DELETE FROM agents WHERE agent_id = $1::text", [row.agent_id]);
        }
      }
    },
    async agents(): Promise<AgentRow[]> {
      return (await rows<Record<string, string | number | null>>(db, all)).map(agentOf);
    },
  };
}

export function pgStanding(db: Db): Standing {
  return {
    async remember(rule: RememberedRule): Promise<void> {
      await count(
        db,
        `INSERT INTO rules (agent_id, tool, connection, conversation, action, updated_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)
         ON CONFLICT (agent_id, tool, connection, conversation) DO UPDATE SET
           action = excluded.action, updated_at = excluded.updated_at`,
        [
          rule.agentId,
          rule.tool,
          rule.connection ?? "",
          rule.conversation ?? "",
          rule.action,
          new Date().toISOString(),
        ],
      );
    },
    async remembered(agentId: string): Promise<RememberedRule[]> {
      return (await rows<{
        tool: string;
        connection: string;
        conversation: string;
        action: PermissionBehavior;
      }>(
        db,
        `SELECT tool, connection, conversation, action FROM rules WHERE agent_id = $1::text
         ORDER BY (conversation <> '') DESC, (connection <> '') DESC, updated_at DESC, seq DESC`,
        [agentId],
      )).map((r) => ({
        agentId,
        tool: r.tool,
        action: r.action,
        ...(r.connection !== "" ? { connection: r.connection } : {}),
        ...(r.conversation !== "" ? { conversation: r.conversation } : {}),
      }));
    },
  };
}

export function pgConnections(db: Db): Connections {
  // a row that names no session enrolls the ROUTED one — the wire writers never decide
  const sessionOf = (r: MembershipRow) =>
    r.sessionId ?? routedSession({ service: r.service, connection_address: r.connection });
  const member = (agentScoped: boolean) =>
    `SELECT 1 FROM memberships
     WHERE service = $1::text AND connection_address = $2::text
       AND conversation_address = $3::text AND agent_id = $4::text
       ${agentScoped ? "" : "AND session_id = $6::text"}
       AND (deleted_at IS NULL OR $5::text <= deleted_at)`;
  return {
    async upsertConnections(list) {
      const now = new Date().toISOString();
      for (const r of list) {
        await count(
          db,
          `INSERT INTO connections
             (service, address, agent_id, credential_key, extra, created_at, updated_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $6::text)
           ON CONFLICT (service, address) DO UPDATE SET
             agent_id = coalesce(excluded.agent_id, connections.agent_id),
             credential_key = coalesce(excluded.credential_key, connections.credential_key),
             extra = CASE WHEN excluded.extra IS NULL THEN connections.extra
                          ELSE json_patch(coalesce(connections.extra, '{}'), excluded.extra) END,
             updated_at = excluded.updated_at,
             deleted_at = NULL`,
          [
            r.service,
            r.address,
            r.agentId ?? null,
            r.credentialKey ?? null,
            r.extra ? JSON.stringify(r.extra) : null,
            now,
          ],
        );
      }
    },
    async deleteConnections(keys) {
      const now = new Date().toISOString();
      for (const k of keys) {
        await count(
          db,
          `UPDATE connections SET deleted_at = $1::text, updated_at = $1::text
           WHERE service = $2::text AND address = $3::text`,
          [now, k.service, k.address],
        );
      }
    },
    async connection(service, address) {
      const [r] = await rows<Parameters<typeof connectionOf>[0]>(
        db,
        `SELECT service, address, agent_id, credential_key, extra FROM connections
         WHERE service = $1::text AND address = $2::text`,
        [service, address],
      );
      return r ? connectionOf(r) : null;
    },
    async connections() {
      return (await rows<Parameters<typeof connectionOf>[0]>(
        db,
        `SELECT service, address, agent_id, credential_key, extra FROM connections
         WHERE deleted_at IS NULL ORDER BY service, address`,
      )).map(connectionOf);
    },
    async aliases() {
      return (await rows<AliasColumns>(
        db,
        `SELECT service, connection, conversation, agent_id, principal, live FROM aliases
         ORDER BY service, connection, conversation, agent_id, principal`,
      )).map(aliasRowOf);
    },
    async upsertMemberships(list) {
      const now = new Date().toISOString();
      for (const r of list) {
        await count(
          db,
          `INSERT INTO memberships (service, connection_address, conversation_address,
             agent_id, session_id, created_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)
           ON CONFLICT (service, connection_address, conversation_address, agent_id, session_id)
           DO UPDATE SET deleted_at = NULL`,
          [r.service, r.connection, r.conversation, r.agentId, sessionOf(r), now],
        );
      }
    },
    async deleteMemberships(list) {
      const now = new Date().toISOString();
      for (const r of list) {
        await count(
          db,
          `UPDATE memberships SET deleted_at = $1::text
           WHERE service = $2::text AND connection_address = $3::text
             AND conversation_address = $4::text AND agent_id = $5::text
             AND session_id = $6::text AND deleted_at IS NULL`,
          [now, r.service, r.connection, r.conversation, r.agentId, sessionOf(r)],
        );
      }
    },
    async isMember(service, connection, conversation, agentId, sessionId, ts) {
      return (await rows(db, member(false), [
        service,
        connection,
        conversation,
        agentId,
        ts ?? null,
        sessionId,
      ])).length > 0;
    },
    async isAgentMember(service, connection, conversation, agentId, ts) {
      return (await rows(db, member(true), [
        service,
        connection,
        conversation,
        agentId,
        ts ?? null,
      ])).length > 0;
    },
    async enrolled() {
      return (await rows<{ agent_id: string; session_id: string }>(
        db,
        `SELECT DISTINCT agent_id, session_id FROM memberships WHERE deleted_at IS NULL
         ORDER BY agent_id, session_id`,
      )).map((r) => ({ agentId: r.agent_id, sessionId: r.session_id }));
    },
    async memberships() {
      return (await rows<EnrollmentColumns>(db, `SELECT * FROM memberships ${ENROLLMENT_ORDER}`))
        .map(enrollmentOf);
    },
  };
}

export function pgTimers(db: Db): Timers {
  return {
    async arm(row) {
      const armed: TimerRow = { ...row, id: newId(), armedAt: new Date().toISOString() };
      // a named wake is the operator's handle: arming the name again replaces the row
      // whole, id and all. An unnamed row conflicts with nothing.
      await count(
        db,
        `INSERT INTO timers
           (id, agent_id, session_id, fire_at, cron, note, name, conversation, ref_id, created_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
           $8::text, $9::text, $10::text)
         ON CONFLICT (agent_id, session_id, name) WHERE name IS NOT NULL DO UPDATE SET
           id = excluded.id, fire_at = excluded.fire_at, cron = excluded.cron,
           note = excluded.note, conversation = excluded.conversation,
           ref_id = excluded.ref_id, created_at = excluded.created_at`,
        [
          armed.id,
          armed.agentId,
          armed.sessionId,
          armed.fireAt,
          armed.cron ?? null,
          armed.note,
          armed.name ?? null,
          armed.conversation,
          armed.refId ?? null,
          armed.armedAt!,
        ],
      );
      return armed;
    },
    async due(nowIso) {
      return (await rows<Raw>(
        db,
        "SELECT * FROM timers WHERE fire_at <= $1::text ORDER BY fire_at, id",
        [nowIso],
      )).map(timerOf);
    },
    async claim(id, nowIso) {
      const horizon = new Date(Date.parse(nowIso) + CLAIM_LEASE_MS).toISOString();
      const [raw] = await rows<Raw>(
        db,
        `UPDATE timers SET fire_at = $1::text WHERE id = $2::text AND fire_at <= $3::text
         RETURNING *`,
        [horizon, id, nowIso],
      );
      return raw ? timerOf(raw) : null;
    },
    async settle(id, nowIso, tz) {
      const [raw] = await rows<Raw>(db, "SELECT * FROM timers WHERE id = $1::text", [id]);
      if (raw === undefined) return;
      const row = timerOf(raw);
      // past NOW, not past the stamp it was due at: a long outage collapses to one fire
      if (row.cron) {
        await count(db, "UPDATE timers SET fire_at = $1::text WHERE id = $2::text", [
          nextFire(row.cron, nowIso, tz),
          id,
        ]);
      } else await count(db, "DELETE FROM timers WHERE id = $1::text", [id]);
    },
    async timers(agentId, sessionId) {
      return (await rows<Raw>(
        db,
        `SELECT * FROM timers WHERE agent_id = $1::text AND session_id = $2::text
         ORDER BY fire_at, id`,
        [agentId, sessionId],
      )).map(timerOf);
    },
    async armed() {
      return (await rows<Raw>(db, "SELECT * FROM timers ORDER BY fire_at, id")).map(timerOf);
    },
    async disarm(id, agentId, sessionId) {
      return await count(
        db,
        "DELETE FROM timers WHERE id = $1::text AND agent_id = $2::text AND session_id = $3::text",
        [id, agentId, sessionId],
      ) > 0;
    },
  };
}

export function pgGates(db: Db, eventOf: (row: unknown) => Event): Gates {
  const open = (scoped: boolean) =>
    `SELECT r.* FROM events r
     WHERE r.type = 'permission_request'
       ${scoped ? "AND r.agent_id = $1::text AND r.session_id = $2::text" : ""}
       AND NOT EXISTS (
         SELECT 1 FROM events a
         WHERE a.type = 'permission_response'
           AND a.payload ->> 'ref_id' = r.payload ->> 'ref_id')
     ORDER BY r.id`;
  return {
    async gates(scope) {
      const found = scope
        ? await rows(db, open(true), [scope.agentId, scope.sessionId])
        : await rows(db, open(false));
      return found.map((r) => eventOf(r) as PermissionRequestEvent);
    },
    async owed(agentId, sessionId) {
      return owedOf(
        await rows<RulingRow>(
          db,
          `SELECT u.*, a.parts AS ruling
           FROM events a
           JOIN events u ON u.id = a.payload ->> 'ref_id'
           WHERE a.type = 'permission_response'
             AND a.payload ->> 'turn_id' IS NULL
             AND u.type = 'tool_use' AND u.agent_id = $1::text AND u.session_id = $2::text
             AND EXISTS (
               SELECT 1 FROM events t WHERE t.type = 'tool_result'
                 AND t.payload ->> 'ref_id' = u.id AND NOT flag(t.payload, 'deferred'))
             AND NOT EXISTS (
               SELECT 1 FROM events t WHERE t.type = 'tool_result'
                 AND t.payload ->> 'ref_id' = u.id AND flag(t.payload, 'deferred'))
           ORDER BY a.id`,
          [agentId, sessionId],
        ),
        eventOf,
      );
    },
  };
}

/** The sweep (§5), inside the writer's serial section: its stamp is the update stream's
 *  cursor, so it takes its place in line like any other move. */
export function pgSweeper(
  serial: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>,
): Sweeper {
  const rung = RETRY_BACKOFF_MS.map((_, i) => `WHEN ${i} THEN $${i + 2}::text`).join(" ");
  return {
    sweep(now) {
      const at = new Date(now).getTime();
      const cutoffs = RETRY_BACKOFF_MS.map((ms) => new Date(at - ms).toISOString());
      return serial((tx) =>
        count(
          tx,
          `UPDATE events SET
             status = json_patch(status, jsonb_build_object(
               'state', 'queued',
               'queued_at', $1::text,
               'attempts', coalesce((status ->> 'attempts')::integer, 0) + 1)),
             updated_at = $1::text
           WHERE type = 'message' AND agent_id IS NOT NULL AND external_id IS NULL
             AND NOT flag(extra, 'delta')
             AND status ->> 'state' = 'failed'
             AND CASE jsonb_typeof(status -> 'error_code')
                   WHEN 'number' THEN (status ->> 'error_code')::numeric = 429
                                   OR (status ->> 'error_code')::numeric >= 500
                   ELSE coalesce(jsonb_typeof(status -> 'error_code'), 'null') = 'null' END
             AND status ->> 'failed_at' <=
                 CASE coalesce((status ->> 'attempts')::integer, 0) ${rung} END`,
          [now, ...cutoffs],
        )
      );
    },
  };
}
