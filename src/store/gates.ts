/**
 * store/gates.ts — the open asks and the unended calls (§9): standing state read off the
 * whole log.
 *
 * A gate is two rows pointing at one `tool_use`: the `permission_request` the harness raised
 * from inside the call, and the `permission_response` that settles it. Open is the ABSENCE
 * of the second row, and absence is a fact about the whole log, never about a window: a card
 * is open until something answers it, however much traffic has flowed past. So the list the
 * anchor shows, the card `cancel` withdraws, the one a surface `/y` lands on and the ruling
 * `act` still owes an outcome to are all read here, the way an armed wake is read off the
 * timers table — by the session, off the store, independent of the turn's window.
 *
 * Two anti-joins, one index. `gates` is the request rows with no response for the same use;
 * `owed` is the responses given by someone other than the model (no `turn_id`) whose use
 * holds its immediate `pending_approval` result and no gated outcome yet. Both are the
 * SQL of the derivations `xi` states over an event list, and the store test holds the two
 * to the same answer.
 *
 * An unended call is the third anti-join on the same index: a call answered `async` whose
 * `final` update never came. While the harness runs, the process holding the work owes
 * that word; one that went down mid-call cannot pay it, and its successor reads what is
 * owed here, at boot, and says the call was lost (late.ts).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  Event,
  PermissionRequestEvent,
  PermissionResponseEvent,
  PermissionVerdict,
  ToolUseEvent,
} from "../types.ts";

/** A ruling that still owes an outcome: the use to run or refuse, and the word on it. */
export interface Owed {
  use: ToolUseEvent;
  verdict: PermissionVerdict;
}

export interface Gates {
  /** Open asks, oldest first — every one when unscoped (the lapse sweep's scan), a
   *  session's own when given the pair (§4): what its anchor lists, what its `cancel` and
   *  its principal's verdict land on. */
  gates(scope?: { agentId: string; sessionId: string }): Promise<PermissionRequestEvent[]>;
  /** A session's rulings whose outcome is still owed (§9): the errand `act` runs on the
   *  model's behalf. One per use, the earliest ruling when several landed. */
  owed(agentId: string, sessionId: string): Promise<Owed[]>;
  /** The calls of tool `name` answered `async` with no `final` update since, oldest first,
   *  org-wide: what a harness that went down mid-call left owed. */
  unended(name: string): Promise<ToolUseEvent[]>;
}

/** The ref join: request, response and result all name their use in `payload.ref_id`. */
export const GATES_DDL = `CREATE INDEX IF NOT EXISTS events_ref
  ON events(type, json_extract(payload, '$.ref_id'));`;

const REF = "json_extract(payload, '$.ref_id')";

/** A use's row beside the parts of a ruling on it, in the ruling's order. */
export type RulingRow = { ruling: string } & Record<string, unknown>;

/** The rulings still owed, one per use — the earliest when several landed. */
export function owedOf(rows: RulingRow[], eventOf: (row: unknown) => Event): Owed[] {
  const out: Owed[] = [];
  const seen = new Set<string>();
  for (const { ruling, ...row } of rows) {
    const use = eventOf(row) as ToolUseEvent;
    if (seen.has(use.id)) continue;
    seen.add(use.id);
    const parts = JSON.parse(ruling) as PermissionResponseEvent["parts"];
    out.push({ use, verdict: parts[0].data });
  }
  return out;
}

export function createGates(db: DatabaseSync, eventOf: (row: unknown) => Event): Gates {
  const open = (scoped: boolean) =>
    `SELECT r.* FROM events r
     WHERE r.type = 'permission_request'
       ${scoped ? "AND r.agent_id = ? AND r.session_id = ?" : ""}
       AND NOT EXISTS (
         SELECT 1 FROM events a
         WHERE a.type = 'permission_response'
           AND json_extract(a.payload, '$.ref_id') = json_extract(r.payload, '$.ref_id'))
     ORDER BY r.id`;
  const all = db.prepare(open(false));
  const mine = db.prepare(open(true));
  // the ruling and its use, side by side: the use's columns under a prefix, the ruling's
  // parts as its own column — one row per (use, ruling), the ruling's order
  const rulings = db.prepare(
    `SELECT u.*, a.parts AS ruling
     FROM events a
     JOIN events u ON u.id = json_extract(a.payload, '$.ref_id')
     WHERE a.type = 'permission_response'
       AND json_extract(a.payload, '$.turn_id') IS NULL
       AND u.type = 'tool_use' AND u.agent_id = ? AND u.session_id = ?
       AND EXISTS (
         SELECT 1 FROM events t WHERE t.type = 'tool_result' AND ${
      REF.replace("payload", "t.payload")
    } = u.id
           AND json_extract(t.payload, '$.gated') IS NOT 1)
       AND NOT EXISTS (
         SELECT 1 FROM events t WHERE t.type = 'tool_result' AND ${
      REF.replace("payload", "t.payload")
    } = u.id
           AND json_extract(t.payload, '$.gated') = 1)
     ORDER BY a.id`,
  );
  const unended = db.prepare(
    `SELECT DISTINCT u.* FROM events t
     JOIN events u ON u.id = ${REF.replace("payload", "t.payload")}
     WHERE t.type = 'tool_result' AND json_extract(t.payload, '$.async') = 1
       AND u.type = 'tool_use' AND json_extract(u.parts, '$[0].data.name') = ?
       AND NOT EXISTS (
         SELECT 1 FROM events f WHERE f.type = 'tool_result' AND ${
      REF.replace("payload", "f.payload")
    } = u.id
           AND json_extract(f.payload, '$.final') = 1)
     ORDER BY u.id`,
  );
  return {
    gates(scope) {
      const rows = scope ? mine.all(scope.agentId, scope.sessionId) : all.all();
      return Promise.resolve(rows.map((r) => eventOf(r) as PermissionRequestEvent));
    },
    owed(agentId, sessionId) {
      return Promise.resolve(owedOf(rulings.all(agentId, sessionId) as RulingRow[], eventOf));
    },
    unended(name) {
      return Promise.resolve(unended.all(name).map((r) => eventOf(r) as ToolUseEvent));
    },
  };
}
