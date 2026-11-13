/**
 * store/agents.ts — the roster and the org's configuration, as rows (§9).
 *
 * Two tables hold what `config.yaml` declares and what the commands set while the org runs:
 *
 *   agents    who exists and who steers whom, the org's `/etc/passwd`: the identity, the
 *             mind session, `principals`, and the backlog floor (`since`), a fact of the
 *             agent written once. These are the columns SQL joins: the roster views
 *             (`principals`, `aliases`), the ingest classifier (a sender whose address
 *             matches an agent's `phone`/`email` is that member speaking), and the law
 *             standing on those views (§6).
 *   config    `(scope, key, value)`, the value JSON, a row per leaf. The scopes are the
 *             file's sections: `system`, `shared`, `shared.agents`, `agents.<name>`,
 *             `processors`, `edge`, `connections.<service>`. A row present is a key set;
 *             no row is a key inherited; `null` is a value ("every tool", "never
 *             sleeps"). A scope that holds no key of its own stands by one row under the
 *             empty key: a connection declared with every knob at its default.
 *
 * An agent's setting resolves `agents.<name>` → `shared.agents` → the catalog's constant
 * when it is read (`config.ts`), so a change to `shared.agents` reaches every agent that
 * does not set the key itself. `mind` is a setting like the rest: `runs` on a row read
 * back is that resolution, made by the engine.
 *
 * The tables are primary. `putAgents` upserts and never deletes; `dropAgent` is the one
 * removal, total and in one transaction: the references to an agent are foreign keys that
 * cascade (`memberships`, `connections`, `credentials`, `rules`), its `config` scope, its
 * docs where they are rows and its turn leases go with it, and a trigger refuses while
 * another agent's `principals` names it. `events`, `usage` and `egress` are history: their
 * `agent_id` stamps stay.
 *
 * `manifest` is what the org has taken from releases (§9): the schema's version, the
 * release it last booted, and per system doc the hash of the release text it last took.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Json } from "../types.ts";

export interface AgentRow {
  agentId: string;
  mind: string; // its mind session's conversation — `mind@<agent>` (§4)
  name?: string; // the roster's word for them — `<principal name>`, the marks (§5)
  email?: string; // the account's declared handles — the classifier's column scan
  phone?: string;
  /** Who steers: a list of roster usernames (`[]` ⇒ nobody), or `"*"` ⇒ anyone writing in
   *  its steering room. Absent ⇒ derived from ownership (§4). */
  principals?: string[] | "*";
  /** The backlog floor, an instant (§5): written once, when the row was made. */
  since?: string;
  /** False ⇒ no session runs (`mind` false, its own or the org's): a person alone, or an
   *  agent paused. Read back resolved; never written. */
  runs?: boolean;
}

/** One leaf of the configuration. */
export interface ConfigRow {
  scope: string;
  key: string;
  value: Json;
}

/** The scope an agent's own settings live in. */
export const agentScope = (agentId: string): string => `agents.${agentId}`;

/** A row as it is put: with it, keys to set in the agent's own scope, and keys to delete
 *  from it so they inherit again. */
export type AgentPut = AgentRow & { settings?: Record<string, Json>; unset?: string[] };

export interface Registry {
  /** Upsert each row, never deleting another: a row given without `since` keeps the floor
   *  it has. Its `settings` and `unset` land in the agent's own scope, in the same
   *  transaction. */
  putAgents(rows: AgentPut[]): Promise<void>;
  /** Remove an agent, whole: its row, what references it, its scope, its docs and its
   *  leases. Refused, naming them, while another agent's `principals` names it. */
  dropAgent(agentId: string): Promise<void>;
  /** The roster as it stands (ordered by agent id). */
  agents(): Promise<AgentRow[]>;
  /** The configuration's rows: one scope's, or every scope's. */
  config(scope?: string): Promise<ConfigRow[]>;
  /** Set each leaf, replacing the value it had. */
  setConfig(rows: ConfigRow[]): Promise<void>;
  /** Delete leaves so they inherit again: the keys named, or the whole scope. */
  unsetConfig(scope: string, keys?: string[]): Promise<void>;
  /** When each agent last paid for a model call, by agent id. */
  lastTurns(): Promise<Record<string, string>>;
  /** What the org has taken from releases, by key. */
  manifest(): Promise<Record<string, string>>;
  /** Record entries of the manifest; `null` deletes one. */
  setManifest(entries: Record<string, string | null>): Promise<void>;
}

/** The roster and what references it. `agents` comes first: the others name it. */
export const AGENTS_DDL = `CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  mind       TEXT NOT NULL,
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  principals TEXT,
  since      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS manifest (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;`;

/** The `RESTRICT` a key cannot spell: a principal lives in a JSON array. An agent naming
 *  itself waits on no one, and `"*"` names no one. */
export const AGENTS_TRIGGER = `CREATE TRIGGER IF NOT EXISTS agents_steering
BEFORE DELETE ON agents
WHEN EXISTS (
  SELECT 1 FROM agents a, json_each(a.principals) p
  WHERE json_type(a.principals) = 'array' AND a.agent_id <> OLD.agent_id
    AND p.value = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'the agent is a principal of another');
END;`;

/** `runs`, resolved by the engine: the agent's own `mind`, else the org's, else it runs. */
export const RUNS_SQL = `coalesce(
  (SELECT value FROM config WHERE scope = 'agents.' || a.agent_id AND key = 'mind'),
  (SELECT value FROM config WHERE scope = 'shared.agents' AND key = 'mind'),
  'true') <> 'false'`;

/** A row of `agents` as the registry answers it — `principals` as its JSON text. */
export function agentOf(r: Record<string, string | number | boolean | null>): AgentRow {
  return {
    agentId: r.agent_id as string,
    mind: r.mind as string,
    ...(r.name ? { name: r.name as string } : {}),
    ...(r.email ? { email: r.email as string } : {}),
    ...(r.phone ? { phone: r.phone as string } : {}),
    ...(typeof r.principals === "string"
      ? { principals: JSON.parse(r.principals) as string[] | "*" }
      : {}),
    ...(r.since ? { since: r.since as string } : {}),
    ...(r.runs === 0 || r.runs === false ? { runs: false } : {}),
  };
}

/** Who else names `agentId` among their principals, off the rows as read. */
export function steeredBy(rows: AgentRow[], agentId: string): string[] {
  return rows
    .filter((a) =>
      a.agentId !== agentId && Array.isArray(a.principals) && a.principals.includes(agentId)
    )
    .map((a) => a.agentId);
}

/** The refusal a removal meets while the agent steers another. */
export function steeringRefusal(agentId: string, steered: string[]): Error {
  return new Error(
    `${agentId} is a principal of ${steered.join(", ")} — take it out of their principals first`,
  );
}

/** Bind the registry to an open DB (same pattern as `createLocker` — composed by openLog). */
export function createRegistry(db: DatabaseSync): Registry {
  const put = db.prepare(
    `INSERT INTO agents (agent_id, mind, name, email, phone, principals, since,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       mind = excluded.mind, name = excluded.name, email = excluded.email,
       phone = excluded.phone, principals = excluded.principals,
       since = coalesce(excluded.since, agents.since), updated_at = excluded.updated_at`,
  );
  const all = db.prepare(
    `SELECT a.agent_id, a.mind, a.name, a.email, a.phone, a.principals, a.since,
       ${RUNS_SQL} AS runs
     FROM agents a ORDER BY a.agent_id`,
  );
  const set = db.prepare(
    `INSERT INTO config (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at`,
  );
  const scopeRows = db.prepare("SELECT scope, key, value FROM config WHERE scope = ? ORDER BY key");
  const everyRow = db.prepare("SELECT scope, key, value FROM config ORDER BY scope, key");
  const unsetKey = db.prepare("DELETE FROM config WHERE scope = ? AND key = ?");
  const unsetScope = db.prepare("DELETE FROM config WHERE scope = ?");
  const hasDocs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'docs'");
  const tx = (body: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      body();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const rows = () => (all.all() as Record<string, string | number | null>[]).map(agentOf);
  const write = (list: ConfigRow[], now: string) => {
    for (const r of list) set.run(r.scope, r.key, JSON.stringify(r.value), now);
  };

  return {
    putAgents(list): Promise<void> {
      const now = new Date().toISOString();
      tx(() => {
        for (const r of list) {
          put.run(
            r.agentId,
            r.mind,
            r.name ?? null,
            r.email ?? null,
            r.phone ?? null,
            r.principals !== undefined ? JSON.stringify(r.principals) : null,
            r.since ?? null,
            now,
            now,
          );
          write(
            Object.entries(r.settings ?? {}).map(([key, value]) => ({
              scope: agentScope(r.agentId),
              key,
              value,
            })),
            now,
          );
          for (const key of r.unset ?? []) unsetKey.run(agentScope(r.agentId), key);
        }
      });
      return Promise.resolve();
    },

    dropAgent(agentId: string): Promise<void> {
      tx(() => {
        const steered = steeredBy(rows(), agentId);
        if (steered.length > 0) throw steeringRefusal(agentId, steered);
        db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
        unsetScope.run(agentScope(agentId));
        // its sessions' rooms end in `@<agent>`, and a turn's lease is named for its room
        db.prepare("DELETE FROM locks WHERE name LIKE 'turn-%@' || ?").run(agentId);
        if (hasDocs.get()) {
          db.prepare("DELETE FROM docs WHERE scope = 'agent' AND owner = ?").run(agentId);
        }
      });
      return Promise.resolve();
    },

    agents(): Promise<AgentRow[]> {
      return Promise.resolve(rows());
    },

    config(scope?: string): Promise<ConfigRow[]> {
      const found = (scope === undefined ? everyRow.all() : scopeRows.all(scope)) as {
        scope: string;
        key: string;
        value: string;
      }[];
      return Promise.resolve(found.map((r) => ({ ...r, value: JSON.parse(r.value) as Json })));
    },

    setConfig(list: ConfigRow[]): Promise<void> {
      const now = new Date().toISOString();
      tx(() => write(list, now));
      return Promise.resolve();
    },

    unsetConfig(scope: string, keys?: string[]): Promise<void> {
      tx(() => {
        if (keys === undefined) unsetScope.run(scope);
        else for (const key of keys) unsetKey.run(scope, key);
      });
      return Promise.resolve();
    },

    lastTurns(): Promise<Record<string, string>> {
      const found = db.prepare(
        `SELECT agent_id, max(created_at) AS last FROM usage
         WHERE agent_id IS NOT NULL GROUP BY agent_id`,
      ).all() as { agent_id: string; last: string }[];
      return Promise.resolve(Object.fromEntries(found.map((r) => [r.agent_id, r.last])));
    },

    manifest(): Promise<Record<string, string>> {
      const found = db.prepare("SELECT key, value FROM manifest").all() as {
        key: string;
        value: string;
      }[];
      return Promise.resolve(Object.fromEntries(found.map((r) => [r.key, r.value])));
    },

    setManifest(entries): Promise<void> {
      tx(() => {
        for (const [key, value] of Object.entries(entries)) {
          if (value === null) db.prepare("DELETE FROM manifest WHERE key = ?").run(key);
          else {
            db.prepare(
              `INSERT INTO manifest (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(key, value);
          }
        }
      });
      return Promise.resolve();
    },
  };
}
