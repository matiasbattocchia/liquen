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
 * transient class (`error_code` absent · 429 · 5xx — a code that is not a number is no
 * class, and stands), whose `failed_at` is older than the
 * rung their re-offer count has reached. The ladder's end is the ceiling: a row that has
 * been re-offered once per rung stays `failed`, and the agent reads it off the window.
 *
 * An offer nobody was there to take stands in the row: a dispatcher that opens later
 * reads its service's `queued` rows before it listens, so the sweep never repeats itself.
 *
 * The ladder is weather, not a knob: the same for every deployment. It spans the recovery
 * a wedged socket needs after a resume (a quarter hour) and ends half a day out, by which
 * time a laptop that was shut overnight has been opened.
 *
 * What the agent is told of its sends is claimed here too, each tale once: a send not out
 * `STALLED_AFTER_MS` after it was made (`stalled`), one that failed for good
 * (`undelivered`), and one told either way, or withdrawn, that went out after all
 * (`corrected`). A withdrawn send (`withdraw`) is never offered again.
 */

import type { DatabaseSync } from "node:sqlite";
import type { EventId } from "../types.ts";

/** The wait before re-offer number N+1, by N re-offers so far. Length = the ceiling. */
export const RETRY_BACKOFF_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  14_400_000,
  43_200_000,
] as const;

/** How long a send may stay undelivered before its session is told it is still trying:
 *  past the blips the first rungs absorb, and soon enough to change course. */
export const STALLED_AFTER_MS = 15 * 60_000;

export interface Sweeper {
  /** One pass at `now` (UTC ISO): re-offer what has waited its rung out. Returns how many. */
  sweep(now: string): Promise<number>;
  /** Claim the agent's own sends that failed for good and nobody has told it of: stamp
   *  `reported_at` = `now` on each and answer their ids, oldest first. For good is a
   *  failure the ladder will not offer again: a permanent class, a transient one past the
   *  ceiling, or one the wire reported after naming the artifact. A send is the model's
   *  (`payload.turn_id`): a mirror's copy or a presence line fails without a turn to tell.
   *  A claim is one conditional UPDATE, so two clocks never claim one row. */
  undelivered(now: string): Promise<EventId[]>;
  /** Claim the agent's own sends still not out `STALLED_AFTER_MS` after they were made,
   *  queued or failed and not yet told of: stamp `stalled_at` and answer their ids. A send
   *  told undelivered, or withdrawn, has had its word. */
  stalled(now: string): Promise<EventId[]>;
  /** Claim the agent's own sends it was told were stalled or undelivered, or that it
   *  withdrew, which went out after all: stamp `corrected_at` and answer their ids. */
  corrected(now: string): Promise<EventId[]>;
  /** Withdraw a send of the agent's that has not gone out: `state: withdrawn`, stamped
   *  `withdrawn_at`. Only a row still queued or failed is withdrawn; true when it was. A
   *  withdrawn row is never offered again, whatever a post already in flight stamps. */
  withdraw(id: EventId, now: string): Promise<boolean>;
}

/** The dispatcher's own rows (`isOutbound`, minus the state it reads off the lifecycle).
 *  Presence is excluded by the one thing that makes it presence: `extra.delta` says the row
 *  is only true while the turn runs, and a `[thinking...]` re-offered an hour later would
 *  be a lie the ladder told. Ephemera fails once, quietly — that is its correct ending. */
const OURS =
  "type = 'message' AND agent_id IS NOT NULL AND external_id IS NULL AND json_extract(extra, '$.delta') IS NOT 1";

/** The class the ladder offers again: no class (the request never reached the service),
 *  429, or 5xx. */
const TRANSIENT = `(json_extract(status, '$.error_code') IS NULL
  OR (json_type(status, '$.error_code') IN ('integer', 'real')
      AND (json_extract(status, '$.error_code') = 429
           OR json_extract(status, '$.error_code') >= 500)))`;

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
       AND json_extract(status, '$.withdrawn_at') IS NULL
       AND ${TRANSIENT}
       AND json_extract(status, '$.failed_at') <=
           CASE coalesce(json_extract(status, '$.attempts'), 0) ${rung} END`,
  );
  // no `updated_at`: the claim is the harness's bookkeeping, not a lifecycle move to offer
  const claim = db.prepare(
    `UPDATE events SET status = json_patch(status, json_object('reported_at', ?1))
     WHERE type = 'message' AND agent_id IS NOT NULL
       AND json_extract(payload, '$.turn_id') IS NOT NULL
       AND json_extract(extra, '$.delta') IS NOT 1
       AND json_extract(status, '$.state') = 'failed'
       AND json_extract(status, '$.reported_at') IS NULL
       AND json_extract(status, '$.withdrawn_at') IS NULL
       AND (external_id IS NOT NULL OR NOT ${TRANSIENT}
            OR coalesce(json_extract(status, '$.attempts'), 0) >= ${RETRY_BACKOFF_MS.length})
     RETURNING id`,
  );
  const stall = db.prepare(
    `UPDATE events SET status = json_patch(status, json_object('stalled_at', ?1))
     WHERE ${OURS}
       AND json_extract(payload, '$.turn_id') IS NOT NULL
       AND json_extract(status, '$.state') IN ('queued', 'failed')
       AND json_extract(status, '$.stalled_at') IS NULL
       AND json_extract(status, '$.reported_at') IS NULL
       AND json_extract(status, '$.withdrawn_at') IS NULL
       AND created_at <= ?2
     RETURNING id`,
  );
  const correct = db.prepare(
    `UPDATE events SET status = json_patch(status, json_object('corrected_at', ?1))
     WHERE type = 'message' AND agent_id IS NOT NULL
       AND json_extract(payload, '$.turn_id') IS NOT NULL
       AND json_extract(extra, '$.delta') IS NOT 1
       AND json_extract(status, '$.state') IN ('dispatched', 'delivered', 'read')
       AND json_extract(status, '$.corrected_at') IS NULL
       AND (json_extract(status, '$.stalled_at') IS NOT NULL
            OR json_extract(status, '$.reported_at') IS NOT NULL
            OR json_extract(status, '$.withdrawn_at') IS NOT NULL)
     RETURNING id`,
  );
  // a lifecycle move: `updated_at` rides along, so the window and the dispatcher see it
  const unoffer = db.prepare(
    `UPDATE events SET
       status = json_patch(status, json_object('state', 'withdrawn', 'withdrawn_at', ?2)),
       updated_at = ?2
     WHERE id = ?1 AND ${OURS}
       AND json_extract(status, '$.state') IN ('queued', 'failed')
     RETURNING id`,
  );
  const ids = (rows: unknown[]) =>
    Promise.resolve((rows as { id: string }[]).map((r) => r.id).sort());
  return {
    sweep(now) {
      const at = new Date(now).getTime();
      const cutoffs = RETRY_BACKOFF_MS.map((ms) => new Date(at - ms).toISOString());
      return Promise.resolve(Number(requeue.run(now, ...cutoffs).changes));
    },
    undelivered: (now) => ids(claim.all(now)),
    stalled(now) {
      const before = new Date(new Date(now).getTime() - STALLED_AFTER_MS).toISOString();
      return ids(stall.all(now, before));
    },
    corrected: (now) => ids(correct.all(now)),
    withdraw: (id, now) => Promise.resolve(unoffer.all(id, now).length > 0),
  };
}
