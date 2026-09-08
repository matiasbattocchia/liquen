/**
 * store/sweep.ts — the harness-led retry: a send that never left is offered again.
 *
 * A dispatcher posts what the log offers and stamps what the wire answered; it holds no
 * retry of its own. The retry is a STATE MOVE on the row: the sweep turns a transiently
 * `failed` row back to `queued`, and the update stream (`subscribe({updates})`) hands it
 * to the dispatcher like any other offer — the dispatcher never learns it is a retry, and
 * a connector that lives in another process gets it the same way. The whole policy is one
 * WHERE clause over columns and lifecycle keys, so the same statement runs wherever the
 * log lives.
 *
 * Eligible: the dispatcher's own rows (`message`, ours, no `external_id` — a failure the
 * wire reported AFTER naming the artifact is not the harness's to retry), `failed` with a
 * transient class (`error_code` absent · 429 · 5xx), whose `failed_at` is older than the
 * rung their re-offer count has reached. The ladder's end is the ceiling: a row that has
 * been re-offered once per rung stays `failed`, and the agent reads it off the window.
 *
 * An offer nobody was there to take stands in the row: a dispatcher that opens later
 * reads its service's `queued` rows before it listens, so the sweep never repeats itself.
 *
 * The ladder is weather, not a knob: the same for every deployment. It spans the recovery
 * a wedged socket needs after a resume (a quarter hour) and ends a day out, by which time
 * a laptop that was shut has been opened.
 */

import type { DatabaseSync } from "node:sqlite";

/** The wait before re-offer number N+1, by N re-offers so far. Length = the ceiling. */
export const RETRY_BACKOFF_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  14_400_000,
  86_400_000,
] as const;

export interface Sweeper {
  /** One pass at `now` (UTC ISO): re-offer what has waited its rung out. Returns how many. */
  sweep(now: string): number;
}

/** The dispatcher's own rows (`isOutbound`, minus the state it reads off the lifecycle). */
const OURS = "type = 'message' AND agent_id IS NOT NULL AND external_id IS NULL";

export function createSweeper(db: DatabaseSync): Sweeper {
  const rung = RETRY_BACKOFF_MS
    .map((_, i) => `WHEN ${i} THEN ?${i + 2}`)
    .join(" ");
  const requeue = db.prepare(
    `UPDATE events SET
       status = json_patch(status, json_object(
         'state', 'queued',
         'queued_at', ?1,
         'attempts', coalesce(json_extract(status, '$.attempts'), 0) + 1)),
       updated_at = ?1
     WHERE ${OURS}
       AND json_extract(status, '$.state') = 'failed'
       AND (json_extract(status, '$.error_code') IS NULL
            OR json_extract(status, '$.error_code') = 429
            OR json_extract(status, '$.error_code') >= 500)
       AND json_extract(status, '$.failed_at') <=
           CASE coalesce(json_extract(status, '$.attempts'), 0) ${rung} END`,
  );
  return {
    sweep(now) {
      const at = new Date(now).getTime();
      const cutoffs = RETRY_BACKOFF_MS.map((ms) => new Date(at - ms).toISOString());
      return Number(requeue.run(now, ...cutoffs).changes);
    },
  };
}
