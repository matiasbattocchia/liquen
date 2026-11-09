/**
 * compact.ts — the checkpoint layer (DESIGN §5 "Compaction", from pi).
 *
 * The window only grows between checkpoints (render keeps every turn as its requests held
 * it); this is the layer that bounds it: when the
 * window outgrows `compactAt`, one mu call writes a structured checkpoint over the older
 * CLOSED turns — whole ones: a span ends where a turn ends, or at a step's end inside a
 * turn that died, which nothing continues — published as
 * a `summary` event with `covers: [from, to]`. The call is the think's own request — its
 * tools (offered, none called), its system prefix, the window as render lays it out — cut
 * where the span ends and closing on the instruction: the position is the boundary, and
 * the model reads the span in the form it works from. The cut is pinned well before the
 * checkpoint is due, and every think marks it, so the span is a cache read. A call that
 * brings back no record (refused as too long, cut at its cap, or empty) is a try: after
 * one the span goes lean (no thinking, each call clipped), after two it is recorded with
 * no call, as the stretch `search` reads back. Iterative: a later compaction folds the previous summary in (pi's update rule), and
 * `covers` chains from the previous summary's start so survivors get re-covered.
 *
 * A checkpoint runs only BETWEEN turns (§5): a thinking block's signature binds everything
 * its request held before it, and a summary lands at the head of the window, so one written
 * while a turn runs changes the prefix under every thinking block the turn replays. The
 * span is therefore null while a turn is running, whatever the window weighs; `decide`
 * asks for it only once the turn is over (its closing, or the error or cancel that ended it).
 *
 * The call itself comes from nu, as a `StepCall`: nu owns the retry ladder and the stream,
 * so the checkpoint is attempted exactly like a think and streams like one. A checkpoint
 * that cannot be written comes back as an error event, whatever the reason — the window
 * stays uncovered either way, and a turn taken over it would cost more and say less.
 */

import type { Draft, ErrorEvent, Event, Session, SummaryEvent } from "./types.ts";
import {
  applySummary,
  type Archive,
  closingBoundary,
  cutStands,
  deferredInput,
  errorTextOf,
  estTokens,
  mediaTokens,
  ownVoice,
} from "./render.ts";
import type { StepCall, StepInput } from "./mu.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { LOCAL_CONNECTION } from "./session.ts";

import { DEFAULT_COMPACT_AT, DEFAULT_KEEP_RECENT, DEFAULT_MAX_TOKENS } from "./config.ts";

export interface CompactInput {
  /** The turn's interrupt (§2) — a cut checkpoint call is the cut turn's. */
  signal?: AbortSignal;
  /** The prefix the agent's think reads (its instructions, memories, environment): the
   *  checkpoint is written against it, so what the prefix already says is not carried. */
  system?: Anthropic.TextBlockParam[];
  /** The think's tools, offered and never called: the cached prefix is tools, then system,
   *  so only the think's own tools let the checkpoint read the think's cache entry. */
  tools?: Anthropic.Tool[];
  /** The window as the thinks read it, up to the cut and closing on the instruction
   *  (render.ts `Archive`): byte for byte their messages up to the block every think
   *  marked, so the request reads the span from the cache and writes only the instruction. */
  window: (archive: Archive) => Anthropic.MessageParam[];
  events: Event[]; // the window, log order
  session: Session; // whose window it is, and where it speaks (§4)
  model: string;
  effort?: StepInput["effort"];
  /** Lazy source for the checkpoint instruction: the `system/compaction.md`
   *  doc, read from the data root. Called only when a compaction actually runs; it carries
   *  no frontmatter, so it is the harness's to send and never the agent's to read. A null
   *  read is a checkpoint that cannot be written. */
  prompt: () => Promise<string | null>;
  compactAt?: number;
  keepRecent?: number;
  maxTokens?: number; // the agent's output cap, which a checkpoint's never passes (`summaryCap`)
  /** The invocation's turn (nu mints it): the checkpoint call's spend is metered under it,
   *  and the summary carries it — a checkpoint is a model turn like any other. */
  turnId?: string;
}

/** The API refused the request for its size: "prompt is too long: N tokens > M maximum"
 *  (Anthropic's wording, the input alone over the window), "The input token count (N)
 *  exceeds the maximum number of tokens allowed (M)." (Gemini's, the count there or not).
 *  The window's own estimate is chars/4 over the raw events — order-of-magnitude, and
 *  blind to inlined media — so the ceiling that counts is the API's, and this is how it
 *  says so. */
const TOO_LONG = /prompt is too long|input token count (\(\d+\) )?exceeds the maximum/i;

/** An error saying a request was over the model's ceiling, a think's or a checkpoint's. */
export function tooLong(e: Event | undefined): boolean {
  return e?.type === "error" && TOO_LONG.test(errorTextOf(e));
}

/** The last event says the previous request was over the model's ceiling: the window has to
 *  shrink before any think can run, whatever `compactAt` says. */
export function overflowed(events: Event[]): boolean {
  return tooLong(events.at(-1));
}

/** Is the turn over? The trailing chain — everything after the last closing — replays its
 *  thinking on the next request, and a summary inserted under it changes the prefix every
 *  signature was bound to. So a checkpoint waits for the turn to end: a closing (nothing
 *  trails), or the turn is dead — a terminal error as the last event, or the principal's
 *  cancel standing (`cutStands`). A dead turn's chain replays too, but nothing continues
 *  it: the checkpoint may cut inside it, at a step's end (`cutIndex`). */
export function turnOver(events: Event[], session: Session): boolean {
  if (dead(events, session)) return true;
  const boundary = closingBoundary(events, session);
  return !events.slice(boundary + 1).some((e) =>
    (e.type === "thinking" || e.type === "tool_use" || e.type === "tool_result") &&
    ownVoice(e, session)
  );
}

/** Nothing continues the turn the window ends on: a terminal error, or a cut standing. */
function dead(events: Event[], session: Session): boolean {
  return events.at(-1)?.type === "error" || cutStands(events, session);
}

/** Where a cut may fall: after index `i` when no STEP straddles it. A step — the events
 *  sharing the `turn_id` of a tool call: its thinking, its calls, their results, its words
 *  — replays as one API turn, so a cut inside one leaves an orphan the API rejects. A call
 *  still waiting for its result holds its step open to the end. A turn that called nothing
 *  is words alone, and words cut anywhere. */
function cutPoints(events: Event[]): Set<number> {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const steps = new Set(
    events.filter((e) => e.type === "tool_use").map((e) => e.payload.turn_id),
  );
  const answered = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => e.payload.ref_id),
  );
  events.forEach((e, i) => {
    const turn = e.payload?.turn_id;
    if (typeof turn !== "string" || !steps.has(turn)) return;
    if (!first.has(turn)) first.set(turn, i);
    last.set(turn, e.type === "tool_use" && !answered.has(e.id) ? Infinity : i);
  });
  const out = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    let straddled = false;
    for (const [turn, from] of first) {
      if (from <= i && last.get(turn)! > i) {
        straddled = true;
        break;
      }
    }
    if (!straddled) out.add(i);
  }
  return out;
}

/** Where a turn ends: after index `i` when its row is the turn's last — a closing's last
 *  row (a closing step may say more than one message), the error that killed a turn, a
 *  cancel, or a row the cut turn still wrote — and the agent is idle there (`turnOver` on
 *  the window through `i`). World rows and the previous checkpoint end nothing. A span that
 *  ends here holds every turn it touches whole, so the summarizer never reads a closed turn
 *  as one in flight: whatever the turn settled, it settled inside the span. */
function turnEnds(events: Event[], session: Session): (i: number) => boolean {
  const lastOfStep = new Map<string, number>();
  events.forEach((e, i) => {
    const turn = e.payload?.turn_id;
    if (typeof turn === "string") lastOfStep.set(turn, i);
  });
  return (i) => {
    const e = events[i];
    if (e.type === "summary") return false;
    if (e.type !== "error" && e.type !== "control" && !ownVoice(e, session)) return false;
    const turn = e.payload?.turn_id;
    if (typeof turn === "string" && lastOfStep.get(turn)! > i) return false;
    return turnOver(events.slice(0, i + 1), session);
  };
}

/** Where a step ends: after index `i` when its row is the last of one of the session's tool
 *  steps. Inside a dead turn that is a cut too (`cutIndex`): the step is whole on its side
 *  of the cut, and nothing continues the turn past it. */
function stepEnds(events: Event[], session: Session): (i: number) => boolean {
  const steps = new Set(
    events.filter((e) => e.type === "tool_use").map((e) => e.payload.turn_id),
  );
  const lastOfStep = new Map<string, number>();
  events.forEach((e, i) => {
    const turn = e.payload?.turn_id;
    if (typeof turn === "string" && steps.has(turn)) lastOfStep.set(turn, i);
  });
  return (i) => {
    const turn = events[i].payload?.turn_id;
    return typeof turn === "string" && lastOfStep.get(turn) === i &&
      ownVoice(events[i], session);
  };
}

/** The pictures the window inlines weigh with the rows. */
const weightOf = (es: Event[], session: Session) => estTokens(es) + mediaTokens(es, session);

/** Decide the covered span: everything up to the cut (`cutIndex`). Null ⇒ nothing to do:
 *  under the threshold, a turn still running, or nothing coverable yet. */
export function compactionSpan(
  events: Event[],
  session: Session,
  compactAt = DEFAULT_COMPACT_AT,
  keepRecent = DEFAULT_KEEP_RECENT,
): { covered: Event[]; covers: [string, string] } | null {
  // measure and span the VISIBLE window (latest summary applied): the read starts at the
  // floor's covered end, so an older checkpoint the floor folded in can still be in it.
  // Chaining survives: the summary sits first in the visible window, so a new span covers
  // it and `covers[0]` chains from it.
  events = applySummary(events);
  // the ceiling that counts is the API's: a window it refused shrinks whatever it estimates
  if (weightOf(events, session) <= compactAt && !overflowed(events)) return null;
  // never under a running turn (see the header): its replayed thinking is bound to the
  // prefix as it stands
  if (!turnOver(events, session)) return null;
  const cut = cutIndex(events, session, compactAt, keepRecent, true);
  if (cut < 0) return null; // everything is recent, or nothing has ended — nothing coverable yet
  const covered = events.slice(0, cut + 1);
  const chain = covered.find((e): e is SummaryEvent => e.type === "summary");
  const content = covered.filter((e) => e.type !== "summary");
  if (content.length === 0) return null; // the previous checkpoint alone — nothing new
  // the range the checkpoint stands for: from the previous checkpoint's own start (its
  // survivors are re-covered here, so the chain never breaks) to the newest event folded in
  const from = chain ? chain.payload.covers[0] : content[0].id;
  const to = content.reduce((m, e) => e.id > m ? e.id : m, content[0].id);
  return { covered, covers: [from, to] };
}

/** The pinned cut (§5): the last event of the span the next checkpoint will cover, once the
 *  window holds one, whether or not a checkpoint is due. Every think marks it, so the
 *  checkpoint's request reads its span from the cache. Undefined ⇒ no cut pinned yet. */
export function pinnedCut(
  events: Event[],
  session: Session,
  compactAt = DEFAULT_COMPACT_AT,
  keepRecent = DEFAULT_KEEP_RECENT,
): string | undefined {
  const view = applySummary(events);
  const cut = cutIndex(view, session, compactAt, keepRecent, false);
  return cut < 0 ? undefined : view[cut].id;
}

/**
 * Where the cut falls, as an index into the visible window; -1 ⇒ nowhere yet. The cut is
 * PINNED: a turn end past a multiple of `compactAt − keepRecent`, so it stands still while
 * the window grows behind it, and every think from then on marks the same block. A
 * checkpoint due at `compactAt` leaves about `keepRecent` uncovered. `due` is the
 * checkpoint asking: a dead turn's steps are then cuts too, and a window with no pin yet
 * (one turn heavier than the span) cuts where the keep-recent tail allows.
 */
function cutIndex(
  events: Event[],
  session: Session,
  compactAt: number,
  keepRecent: number,
  due: boolean,
): number {
  const weight = (es: Event[]) => weightOf(es, session);
  const boundary = closingBoundary(events, session);
  const deferred = deferredInput(events, session, boundary);
  // walk back from the end keeping ~keepRecent est. tokens uncovered: `kept` = the first
  // kept index
  let keep = 0;
  let kept = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    keep += weight([events[i]]);
    if (keep > keepRecent) break;
    kept = i;
  }
  // where the cut may fall: in the closed region, at a turn's end (`turnEnds`), after any
  // event no step straddles. Never after unanswered input: a world message is INPUT, and a
  // checkpoint is a record, not an answer. Input the closing never consumed sits BEFORE the
  // boundary and is input all the same: `covers` is an id range, so the cut stays below the
  // first such message, or the range would hide it.
  // A live conversation's span is whole turns: the turn the span's weight falls in goes in
  // whole, and the cut is its end. A DEAD turn — an error or a cancel ended it — is over
  // too, and nothing continues it, so when the checkpoint asks, the cut may also fall at
  // the end of any of its steps: it leaves `keepRecent` like any window, and the steps it
  // leaves draw as narration behind the record (render.ts `deadSteps`), their thinking gone
  // with the prefix it was bound to.
  const ended = due && dead(events, session);
  const safe = cutPoints(events);
  const ends = turnEnds(events, session);
  const steps = stepEnds(events, session);
  const cuttable = (c: number) =>
    safe.has(c) && (c <= boundary ? ends(c) : ended && (ends(c) || steps(c)));
  const firstDeferred = events.findIndex((e) => deferred.has(e));
  const limit = firstDeferred === -1 ? events.length : firstDeferred;
  // the pins: the first turn end past each multiple of the span's weight, the summary the
  // window opens on weighing with it. The cut is the latest pin the window's weight has
  // reached: the first until the window outgrows `compactAt` by a whole span, the next
  // after that, so a checkpoint that waited long still leaves about `keepRecent`
  const span = Math.max(1, compactAt - keepRecent);
  const total = weight(events);
  const reach = total <= compactAt ? 1 : Math.floor((total - compactAt) / span) + 1;
  let pin = -1;
  let next = 1;
  let sum = 0;
  for (let c = 0; c < limit && next <= reach; c++) {
    sum += weight([events[c]]);
    if (sum > next * span && cuttable(c)) {
      pin = c;
      next = Math.floor(sum / span) + 1;
    }
  }
  if (pin >= 0 || !due) return pin;
  // no pin: the span's weight lies past every turn end, so the cut is the last one before
  // the keep-recent tail
  const ceiling = Math.min(kept, limit);
  for (let c = ceiling - 1; c >= 0; c--) if (cuttable(c)) return c;
  // the fallback needs content past the budget: a tail that holds every turn stays whole
  const over = events.slice(0, kept).some((e) => e.type !== "summary");
  if (over) { for (let c = ceiling; c < limit; c++) if (cuttable(c)) return c; }
  // a dead turn whose window the tail holds whole — one the API refused under the estimate
  // — is covered whole: no think reads it until it shrinks
  if (ended) { for (let c = limit - 1; c >= 0; c--) if (cuttable(c)) return c; }
  return -1;
}

/** How many checkpoints since the floor made their call and got no record from it (the
 *  error's `attempt`). A failed checkpoint leaves the floor where it was, so the count is
 *  the log's own, and it is the rung the next checkpoint stands on (`buildSummary`). */
export function tries(events: Event[]): number {
  const floor = events.reduce((m, e) => e.type === "summary" && e.id > m ? e.id : m, "");
  return events.filter((e) =>
    e.id > floor && e.type === "error" && e.parts[0]?.data?.attempt === true
  ).length;
}

/** The tries after which a checkpoint is written without a call: the window, then the
 *  window lean (render.ts `Archive.lean`). */
const TRIES = 2;

/** The output cap of a checkpoint call: half of what the span it replaces weighs, so the
 *  record that lands leaves the window well under `compactAt`, and never past the agent's
 *  own cap. Thinking spends from it too; a record cut at it is a try that failed. */
export function summaryCap(
  compactAt = DEFAULT_COMPACT_AT,
  keepRecent = DEFAULT_KEEP_RECENT,
  maxTokens = DEFAULT_MAX_TOKENS,
): number {
  return Math.min(maxTokens, Math.floor((compactAt - keepRecent) / 2));
}

/** The record a span gets when no request could carry it: the previous checkpoint as it
 *  stands, and what the span holds from where it starts. Its tag's `before` closes it, so
 *  `search` reads it back between the two. */
function unread(covered: Event[]): string {
  const previous = covered.find((e): e is SummaryEvent => e.type === "summary");
  const rows = covered.filter((e) => e.type !== "summary");
  const messages = rows.filter((e) => e.type === "message");
  const rooms = new Set(messages.map((e) => e.envelope.conversation.address)).size;
  const calls = rows.filter((e) => e.type === "tool_use").length;
  const what = [
    ...(messages.length
      ? [
        `${messages.length} message${messages.length === 1 ? "" : "s"} in ${rooms} ` +
        `conversation${rooms === 1 ? "" : "s"}`,
      ]
      : []),
    ...(calls ? [`${calls} call${calls === 1 ? "" : "s"} of yours`] : []),
  ].join(" and ") || `${rows.length} rows`;
  const after = new Date(Date.parse(rows[0].ts) - 1).toISOString();
  const note = `Not in this record: ${what}, after ${after}; too much to read into it. ` +
    `search reads them word for word, with calls: true for the calls.`;
  return previous ? `${previous.parts.map((p) => p.text).join("\n")}\n\n${note}` : note;
}

/** Run the checkpoint step and mint the summary event. Null ⇒ under threshold: there was
 *  nothing to write. An error draft ⇒ there was, and it could not be written — the call
 *  never completed, or the model answered without a usable checkpoint (cut at the ceiling,
 *  or empty). All three end the turn on the error, unstamped, and the next input retries:
 *  a partial record would stand for the whole window, and a checkpoint that keeps failing
 *  would otherwise cost a call on every wake and show nowhere. A call that got no record
 *  climbs a rung (`tries`): the window, then the window lean at low effort, whose prefix
 *  is no longer the cached one, then the record `unread` writes with no call at all, so a
 *  span no request carries still moves the floor. */
export async function buildSummary(
  input: CompactInput,
  call: StepCall,
): Promise<Draft<SummaryEvent> | Draft<ErrorEvent> | null> {
  const span = compactionSpan(input.events, input.session, input.compactAt, input.keepRecent);
  if (!span) return null;

  const record = (text: string): Draft<SummaryEvent> => ({
    ts: new Date().toISOString(),
    type: "summary",
    agent: { id: input.session.agentId, session_id: input.session.id },
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: input.session.conversation },
    },
    payload: { covers: span.covers, ...(input.turnId ? { turn_id: input.turnId } : {}) },
    parts: [{ type: "text", kind: "text", text }],
  });
  const tried = tries(input.events);
  if (tried >= TRIES) return record(unread(span.covered));

  const failed = (why: string, attempt = false): Draft<ErrorEvent> => ({
    ts: new Date().toISOString(),
    type: "error",
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: input.session.conversation },
    }, // harness-authored: no `agent` (§3)
    parts: [{
      type: "data",
      kind: "error",
      data: { error: `checkpoint failed: ${why}`, ...(attempt ? { attempt: true } : {}) },
    }],
    // what the checkpoint's request read through: the window it could not record
    ...(input.events.length ? { extra: { consumed: input.events.at(-1)!.id } } : {}),
  });

  // the instruction is read lazily: only a window that actually compacts pays the read
  const instruction = await input.prompt();
  if (instruction === null) return failed("system/compaction.md is missing");
  // the window as the think read it, up to the cut and closing on the instruction; lean
  // once a try has failed
  const lean = tried > 0;
  const messages = input.window({
    covered: new Set(span.covered.map((e) => e.id)),
    cut: span.covered.at(-1)!.id,
    instruction,
    ...(lean ? { lean } : {}),
  });

  const res = await call({
    system: input.system ?? [],
    messages,
    model: input.model,
    effort: lean ? "low" : input.effort,
    maxTokens: summaryCap(input.compactAt, input.keepRecent, input.maxTokens),
    tools: input.tools ?? [],
    ...(input.tools?.length ? { toolChoice: "none" as const } : {}),
    turnId: input.turnId,
    signal: input.signal,
  });
  // weather was retried in nu and a failed call cost nothing: only the call that answered
  // without a record, or was refused for its size, is a try
  if (!res.ok) return failed(res.error, TOO_LONG.test(res.error));
  if (res.stop === "max_tokens") return failed("cut off at the output ceiling", true);
  if (res.stop === "model_context_window_exceeded") {
    return failed("cut off at the end of the context window", true);
  }
  const summary = res.emissions.filter((e) => e.kind === "assistant")
    .map((e) => e.text).join("\n").trim();
  if (summary.length === 0) return failed("the model wrote nothing", true);
  return record(summary);
}
