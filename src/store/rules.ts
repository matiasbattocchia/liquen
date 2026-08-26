/**
 * store/rules.ts — remembered policies (§9): the standing half of the permission table.
 *
 * Config declares the BASE policy (`agent.rules` in org/agent config.jsonc — the human's
 * writing); this table holds what the principal ruled FROM A SURFACE: `/y conv`,
 * `/n conn`, `/y always` on an approval card land here as rows, upserted by scope — a later
 * verdict on the same scope replaces the action, it never piles up. The gate compiles
 * both, remembered rows first: the principal outranks the base table, and among the
 * remembered the most specific wins (conversation over connection over global), newest
 * breaking ties. Same division of labor as the registry: humans write config, verdicts
 * write rows, the reader merges.
 *
 * Scope columns use '' (not NULL) so the primary key can hold them — in SQLite NULLs
 * never equal each other, and "one row per scope" IS the semantics here.
 */

import type { DatabaseSync } from "node:sqlite";
import type { PermissionBehavior } from "../types.ts";

export interface RememberedRule {
  agentId: string;
  tool: string;
  action: PermissionBehavior;
  connection?: string;
  conversation?: string;
}

export interface Standing {
  /** Upsert one standing verdict — same agent/tool/scope replaces the action. */
  remember(rule: RememberedRule): void;
  /** The agent's remembered rules, most specific first, newest breaking ties. */
  remembered(agentId: string): RememberedRule[];
}

export const RULES_DDL = `CREATE TABLE IF NOT EXISTS rules (
  agent_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  connection   TEXT NOT NULL DEFAULT '',
  conversation TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (agent_id, tool, connection, conversation)
);`;

/** Bind the standing table to an open DB (same pattern as the registry — composed by
 *  openLog, so a verdict's write shares the turn's transaction boundary later). */
export function createStanding(db: DatabaseSync): Standing {
  const put = db.prepare(
    `INSERT INTO rules (agent_id, tool, connection, conversation, action, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, tool, connection, conversation) DO UPDATE SET
       action = excluded.action, updated_at = excluded.updated_at`,
  );
  const all = db.prepare(
    `SELECT tool, connection, conversation, action FROM rules WHERE agent_id = ?
     ORDER BY (conversation != '') DESC, (connection != '') DESC, updated_at DESC, rowid DESC`,
  );
  return {
    remember(rule: RememberedRule): void {
      put.run(
        rule.agentId,
        rule.tool,
        rule.connection ?? "",
        rule.conversation ?? "",
        rule.action,
        new Date().toISOString(),
      );
    },
    remembered(agentId: string): RememberedRule[] {
      return (all.all(agentId) as {
        tool: string;
        connection: string;
        conversation: string;
        action: PermissionBehavior;
      }[]).map((r) => ({
        agentId,
        tool: r.tool,
        action: r.action,
        ...(r.connection !== "" ? { connection: r.connection } : {}),
        ...(r.conversation !== "" ? { conversation: r.conversation } : {}),
      }));
    },
  };
}
