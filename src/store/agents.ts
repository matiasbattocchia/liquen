/**
 * store/agents.ts — the agent registry (§9): the rows agents ARE.
 *
 * An agent is a row — identity + its mind session; docs, workspace, memory may all be empty
 * and the agent still fully exists. But rows are terrible DX to author, so agents are
 * created "the framework way": the catalog's `agents` section declares the roster — each
 * entry carries its settings (`provider`, `model`, `effort`) and the handles a human knows
 * (`email`, `phone`) — and at boot main COMPILES the declaration: config → this table →
 * home folders. The table exists because policy and the ingest classifier need rows (RLS
 * derives from the registry on Postgres, and the scoped-log policy derives from it here,
 * §6; a sender whose address matches an agent's `phone`/`email` is that agent's
 * principal), not because rows are how humans make agents.
 *
 * Mirror semantics: sync upserts every given agent and DELETES the rest — the table is a
 * projection of what runs, never an archive (events keep their own `agent_id` stamps).
 */

import type { DatabaseSync } from "node:sqlite";

export interface AgentRow {
  agentId: string;
  mind: string; // its mind session's conversation — `mind@<agent>` (§4)
  provider?: string; // model provider (the transport seam's future knob)
  model?: string;
  effort?: string;
  email?: string; // the principal's declared handles — the classifier's column scan
  phone?: string;
}

export interface Registry {
  /** Mirror the table to `rows`: upsert each, delete every row not named. */
  syncAgents(rows: AgentRow[]): void;
  /** The registry as it stands (ordered by agent id). */
  agents(): AgentRow[];
}

export const AGENTS_DDL = `CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  mind       TEXT NOT NULL,
  provider   TEXT,
  model      TEXT,
  effort     TEXT,
  email      TEXT,
  phone      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

/** Bind the registry to an open DB (same pattern as `createLocker` — composed by openLog). */
export function createRegistry(db: DatabaseSync): Registry {
  const put = db.prepare(
    `INSERT INTO agents (agent_id, mind, provider, model, effort, email, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       mind = excluded.mind, provider = excluded.provider, model = excluded.model,
       effort = excluded.effort, email = excluded.email, phone = excluded.phone,
       updated_at = excluded.updated_at`,
  );
  const all = db.prepare(
    "SELECT agent_id, mind, provider, model, effort, email, phone FROM agents ORDER BY agent_id",
  );
  const del = db.prepare("DELETE FROM agents WHERE agent_id = ?");

  return {
    syncAgents(rows: AgentRow[]): void {
      const now = new Date().toISOString();
      const keep = new Set(rows.map((r) => r.agentId));
      for (const r of rows) {
        put.run(
          r.agentId,
          r.mind,
          r.provider ?? null,
          r.model ?? null,
          r.effort ?? null,
          r.email ?? null,
          r.phone ?? null,
          now,
          now,
        );
      }
      for (const row of all.all() as { agent_id: string }[]) {
        if (!keep.has(row.agent_id)) del.run(row.agent_id);
      }
    },

    agents(): AgentRow[] {
      return (all.all() as Record<string, string | null>[]).map((r) => ({
        agentId: r.agent_id!,
        mind: r.mind!,
        ...(r.provider ? { provider: r.provider } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.effort ? { effort: r.effort } : {}),
        ...(r.email ? { email: r.email } : {}),
        ...(r.phone ? { phone: r.phone } : {}),
      }));
    },
  };
}
