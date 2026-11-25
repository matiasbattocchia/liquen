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
 * owed when the checkpoint about to run would fold away a line someone else wrote (the
 * agent's own words answer lines; they teach nothing a line did not). An unload runs
 * between turns, as a checkpoint does, and only while no news waits, since its turn answers
 * nobody: a line that reaches it while it runs is still owed once it closes (`render.ts`
 * `answeredThrough`), and the next look answers it.
 *
 * The notice also names what to tidy while the docs are open (`tidying`): each memory past
 * its size, and each entry whose end has passed. It is read off the docs when the notice is
 * raised and stored with it, so the line the agent reads never changes under the cache.
 */

import type { AlarmEvent, Draft, Event, EventId, Session } from "./types.ts";
import type { Day } from "./agenda.ts";
import { datedLines, nearestYear } from "./agenda.ts";
import { MONTHS } from "./moment.ts";
import {
  applySummary,
  closingBoundary,
  fill,
  MEMORY_CHARS,
  ownVoice,
  silenced,
  unloadOf,
} from "./render.ts";
import { LOCAL_CONNECTION } from "./session.ts";

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

/** Would the checkpoint `folding` covers take a line no unload read? Then an unload is owed
 *  first. */
export function foldsUnread(events: Event[], session: Session, folding: Event[]): boolean {
  return pastCursor(events, session).taught.some((e) => folding.includes(e));
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
 *  lands in the session's own room. Its text is what `tidying` names, empty when nothing
 *  is owed. */
export function unloadNotice(session: Session, span: UnloadSpan, text = ""): Draft<AlarmEvent> {
  return {
    ts: new Date().toISOString(),
    type: "alarm", // harness-authored: no `agent`, so the relational rule wakes on it (§2)
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: session.conversation },
    },
    extra: { unload: { since: span.since, through: span.through } },
    parts: [{ type: "text", kind: "alarm", text }],
  };
}

/** A memory the notice weighs: the handle the agent opens it by, its size, its body. */
export interface Kept {
  handle: string;
  chars?: number;
  body: string;
}

/** The lapsed entries a notice quotes; past them it counts the rest, doc by doc. */
export const LAPSED_SHOWN = 10;
/** How much of a lapsed entry the notice quotes: its opening words, enough to find it. */
const OPENING = 60;

/** What an unload asks to tidy in the same turn: each memory past its size, as full as its
 *  heading says, and each entry whose end has passed, by its doc and its opening words.
 *  Empty when nothing is owed. */
export function tidying(kept: Kept[], today: Day): string {
  const over = kept
    .filter((k) => k.chars !== undefined && k.chars > MEMORY_CHARS)
    .map((k) => `- ${k.handle}${fill(k)}`);
  const lapsed = kept.flatMap((k) => lapsedIn(k.body, today).map((words) => ({ k, words })));
  const shown = lapsed.slice(0, LAPSED_SHOWN).map(({ k, words }) => `- ${k.handle}: ${words}`);
  const rest = new Map<string, number>();
  for (const { k } of lapsed.slice(LAPSED_SHOWN)) rest.set(k.handle, (rest.get(k.handle) ?? 0) + 1);
  return [
    ...(over.length > 0 ? ["memories over their size:", ...over] : []),
    ...(lapsed.length > 0
      ? [
        "entries past their end:",
        ...shown,
        ...[...rest].map(([handle, n]) => `- ${handle}: ${n} more`),
      ]
      : []),
  ].join("\n");
}

/** The list items of a body whose end has passed, by their opening words: a done one, a
 *  dated one whose last day is over, and one whose grounding range has closed. Fenced code
 *  is an example, never an entry. */
export function lapsedIn(body: string, today: Day): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (item && lapsed(line, item[1], today)) out.push(opening(item[1]));
  }
  return out;
}

/** Whether an entry is over: done, dated to a last day before `today`, or grounded on a
 *  range that ended before it. A line dated to a repeat without an end never is. */
function lapsed(line: string, words: string, today: Day): boolean {
  if (/^\[[xX]\]\s/.test(words)) return true;
  const [dated] = datedLines(line, today);
  const end = dated ? lastOf(dated) : rangeEnd(words, today);
  return end !== undefined && before(end, today);
}

/** A dated line's last day: its own, the `until` of its repeat, or none for an open one. */
function lastOf(l: ReturnType<typeof datedLines>[number]): Day | undefined {
  if (l.step) return l.last;
  if (!l.rule) return l.day;
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(l.rule);
  return until ? { year: +until[1], month: +until[2], day: +until[3] } : undefined;
}

/** A range in a grounding, `(2 Nov–15 Nov, 8be1d0)`: the day it holds from and the day it
 *  ends, each with its month, a year on either when it is not the nearest. */
const RANGE = /\d{1,2} [A-Za-z]{3}(?: \d{4})?\s*[–-]\s*(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?/g;

/** The end an entry's grounding names, the latest of its ranges; none without a range. */
function rangeEnd(words: string, today: Day): Day | undefined {
  const ground = /\(([^()]*)\)\s*$/.exec(words);
  if (!ground) return undefined;
  let end: Day | undefined;
  for (const m of ground[1].matchAll(RANGE)) {
    const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) + 1;
    if (month === 0) continue;
    const year = m[3] ? +m[3] : nearestYear(month, +m[1], today);
    if (year === undefined) continue;
    const day = { year, month, day: +m[1] };
    if (!end || before(end, day)) end = day;
  }
  return end;
}

function before(a: Day, b: Day): boolean {
  return a.year !== b.year
    ? a.year < b.year
    : a.month !== b.month
    ? a.month < b.month
    : a.day < b.day;
}

/** An entry's opening words, cut at a word past half the quote when it runs longer. */
function opening(words: string): string {
  if (words.length <= OPENING) return words;
  const cut = words.slice(0, OPENING);
  const space = cut.lastIndexOf(" ");
  return `${(space > OPENING / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
