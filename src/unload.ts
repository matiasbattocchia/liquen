/**
 * unload.ts — the turn that writes down what a span taught (DESIGN §5 "Unload").
 *
 * A checkpoint keeps the gist of what it folds away; a doc keeps the fact. So before the
 * facts a span holds leave the window, the harness raises a notice for the agent the way a
 * wake raises one: an `alarm` with no note, whose `extra.unload` names the span, rendered
 * `<system kind="unload" since="…">`. The turn it opens reads the window, writes into its
 * docs what `70-memory` says to keep, and ends silent. The notice is a stored event and
 * the writes are ordinary calls, so both stand in the window whether a checkpoint follows
 * or not, and the instruction is in the prefix from the start: nothing about the turn is
 * a tail of its own.
 *
 * The cursor is the last event the latest answered notice covered: a notice whose turn
 * failed or was cut moves nothing, and the span stays owed. Past the cursor, a span is
 * owed when it holds a line someone else wrote (the agent's own words answer lines; they
 * teach nothing a line did not) and one of three holds: the checkpoint about to run would
 * fold such a line away, the span outweighs `unloadAt`, or such a line has waited past the
 * day's `unloadDaily`. An unload runs between turns, as a checkpoint does, and only while
 * no news waits: its turn's closing consumes what the window held, so a line it reads
 * would otherwise go unanswered.
 */

import type { AlarmEvent, Draft, Event, EventId, Session } from "./types.ts";
import {
  applySummary,
  closingBoundary,
  estTokens,
  mediaTokens,
  ownVoice,
  silenced,
  unloadOf,
} from "./render.ts";
import { LOCAL_CONNECTION } from "./session.ts";
import { DEFAULT_TIMEZONE, DEFAULT_UNLOAD_AT, DEFAULT_UNLOAD_DAILY } from "./config.ts";

/** The knobs an unload reads; unset ⇒ the catalog's, and `unloadDaily: null` ⇒ no daily
 *  one. */
export interface UnloadWake {
  timezone?: string;
  unloadAt?: number;
  unloadDaily?: string | null;
}

/** The span an unload covers: the first line it asks to be written down, and the last event
 *  it reads through, which becomes the cursor once its turn closes. */
export interface UnloadSpan {
  since: EventId;
  through: EventId;
}

/** The last event the latest answered notice covered. A notice past the last closing is
 *  one whose turn never closed: it moves nothing. Undefined ⇒ no answered notice in the
 *  window, so every row after the checkpoint's floor is owed. */
export function unloadCursor(events: Event[], session: Session): EventId | undefined {
  const boundary = closingBoundary(events, session);
  for (let i = boundary - 1; i >= 0; i--) {
    const span = unloadOf(events[i]);
    if (span) return span.through;
  }
}

/** A row that teaches: a line someone other than the agent wrote, worth reading. */
function teaches(e: Event, session: Session): boolean {
  return e.type === "message" && !ownVoice(e, session) && !silenced(e);
}

/** The span past the cursor and the lines in it that teach, the latest checkpoint applied. */
function pastCursor(events: Event[], session: Session): { past: Event[]; taught: Event[] } {
  const view = applySummary(events);
  const cursor = unloadCursor(view, session);
  const past = view.filter((e) =>
    e.type !== "summary" && unloadOf(e) === undefined && (cursor === undefined || e.id > cursor)
  );
  return { past, taught: past.filter((e) => teaches(e, session)) };
}

/** Is an unload owed now? `folding` is what the checkpoint about to run would cover (null ⇒
 *  none would run): an unload goes first when it folds a line no unload read. The caller
 *  decides whether the moment is free, since that is attention's question. */
export function unloadOwed(
  events: Event[],
  session: Session,
  wake: UnloadWake,
  now: number,
  folding: Event[] | null,
): boolean {
  const { past, taught } = pastCursor(events, session);
  if (taught.length === 0) return false;
  if (folding && taught.some((e) => folding.includes(e))) return true;
  const weight = estTokens(past) + mediaTokens(past, session);
  if (weight > (wake.unloadAt ?? DEFAULT_UNLOAD_AT)) return true;
  const daily = wake.unloadDaily === undefined ? DEFAULT_UNLOAD_DAILY : wake.unloadDaily;
  if (daily === null) return false;
  const slot = lastSlot(now, daily, wake.timezone ?? DEFAULT_TIMEZONE);
  return taught.some((e) => Date.parse(e.ts) < slot);
}

/** Would the checkpoint `folding` covers take a line no unload read? Then it waits for one. */
export function foldsUnread(events: Event[], session: Session, folding: Event[]): boolean {
  return pastCursor(events, session).taught.some((e) => folding.includes(e));
}

/** The latest moment at or before `now` whose org-clock time is `hhmm`. */
function lastSlot(now: number, hhmm: string, zone: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  const at = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone);
  let slot = at.with({ hour, minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  if (Temporal.ZonedDateTime.compare(slot, at) > 0) slot = slot.subtract({ days: 1 });
  return slot.epochMilliseconds;
}

/** The span the next unload covers: from the first line past the cursor that teaches, to
 *  the newest event in the window. Null ⇒ nothing to write down. */
export function unloadSpan(events: Event[], session: Session): UnloadSpan | null {
  const { taught } = pastCursor(events, session);
  if (taught.length === 0) return null;
  const since = taught.reduce((m, e) => e.id < m ? e.id : m, taught[0].id);
  const through = events.reduce((m, e) => e.id > m ? e.id : m, events[0].id);
  return { since, through };
}

/** The notice that opens an unload turn: harness-authored, so it wakes like any alarm, and
 *  lands in the session's own room. */
export function unloadNotice(session: Session, span: UnloadSpan): Draft<AlarmEvent> {
  return {
    ts: new Date().toISOString(),
    type: "alarm", // harness-authored: no `agent`, so the relational rule wakes on it (§2)
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: session.conversation },
    },
    extra: { unload: { since: span.since, through: span.through } },
    parts: [{ type: "text", kind: "alarm", text: "" }],
  };
}
