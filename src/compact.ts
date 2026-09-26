/**
 * compact.ts — the checkpoint layer (DESIGN §5 "Compaction", from pi).
 *
 * Pruning is already render's closed-region collapse; this is the other layer: when the
 * window outgrows `compactAt`, one mu call (no tools, under the agent's own system prefix)
 * writes a structured checkpoint over the older CLOSED events, published as a `summary`
 * event with `covers: [from, to]`.
 * Iterative: a later compaction folds the previous summary in (pi's update rule), and
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
  closingBoundary,
  deferredInput,
  errorTextOf,
  isCancelled,
  outcomeLine,
  ownVoice,
} from "./render.ts";
import type { StepCall, StepInput } from "./mu.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { describeCall } from "./describe.ts";

import { DEFAULT_COMPACT_AT, DEFAULT_KEEP_RECENT } from "./config.ts";

/** chars/4 over what renders — crude but monotone; both thresholds are order-of-magnitude
 *  knobs. The wire sidecar (`extra`, where a connector keeps the raw delivery) never reaches
 *  the prompt, so it never weighs. */
export const estTokens = (events: Event[]): number =>
  Math.ceil(JSON.stringify(events, (k, v) => k === "extra" ? undefined : v).length / 4);

/** The output ceiling of a checkpoint call. A structured summary of a whole window has to
 *  fit under it whole: a cut summary is not a record, it is a failure (see `buildSummary`). */
export const SUMMARY_MAX_TOKENS = 16_384;

/** How much of one tool outcome the checkpoint transcript carries. */
const RESULT_CHARS = 500;

export interface CompactInput {
  /** The turn's interrupt (§2) — a cut checkpoint call is the cut turn's. */
  signal?: AbortSignal;
  /** The prefix the agent's think reads (its instructions, memories, environment): the
   *  checkpoint is written against it, so what the prefix already says is not carried. */
  system?: Anthropic.TextBlockParam[];
  events: Event[]; // the window, log order
  session: Session; // whose window it is, and where it speaks (§4)
  model: string;
  effort?: StepInput["effort"];
  /** Lazy source for the checkpoint instruction: the `system/instructions/compaction.md`
   *  doc, read from the data root. Called only when a compaction actually runs; it carries
   *  no frontmatter, so it is the harness's to send and never the agent's to read. A null
   *  read is a checkpoint that cannot be written. */
  prompt: () => Promise<string | null>;
  compactAt?: number;
  keepRecent?: number;
  /** The invocation's turn (nu mints it): the checkpoint call's spend is metered under it,
   *  and the summary carries it — a checkpoint is a model turn like any other. */
  turnId?: string;
}

/** The API refused the request for its size: "prompt is too long: N tokens > M maximum"
 *  (Anthropic's wording, the one measured). The window's own estimate is chars/4 over the
 *  raw events — order-of-magnitude, and blind to inlined media — so the ceiling that
 *  counts is the API's, and this is how it says so. */
const TOO_LONG = /prompt is too long/i;

/** The last event says the previous request was over the model's ceiling: the window has to
 *  shrink before any think can run, whatever `compactAt` says. */
export function overflowed(events: Event[]): boolean {
  const last = events.at(-1);
  return last?.type === "error" && TOO_LONG.test(errorTextOf(last));
}

/** Is the turn over? The trailing chain — everything after the last closing — replays its
 *  thinking on the next request, and a summary inserted under it changes the prefix every
 *  signature was bound to. So a checkpoint waits for the turn to end: a closing (nothing
 *  trails), or the harness's word that the turn is dead — a terminal error or a cancel as
 *  the last event. A dead turn's chain replays too, but nothing continues it: the
 *  checkpoint covers it whole, and the record says what its tools found. */
export function turnOver(events: Event[], session: Session): boolean {
  const last = events.at(-1);
  if (last !== undefined && (last.type === "error" || isCancelled(last))) return true;
  const boundary = closingBoundary(events, session);
  return !events.slice(boundary + 1).some((e) =>
    (e.type === "thinking" || e.type === "tool_use" || e.type === "tool_result") &&
    ownVoice(e, session)
  );
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

/** Decide the covered span: everything up to the last safe cut before the keep-recent
 *  tail. Null ⇒ nothing to do: under the threshold, a turn still running, or nothing
 *  coverable yet. */
export function compactionSpan(
  events: Event[],
  session: Session,
  compactAt = DEFAULT_COMPACT_AT,
  keepRecent = DEFAULT_KEEP_RECENT,
): { covered: Event[]; covers: [string, string] } | null {
  // measure and span the VISIBLE window (latest summary applied): the raw window stays heavy
  // after a checkpoint (the read is windowLimit-capped, not from-the-summary), so a raw
  // estimate would fire again on the very next invocation — a compact-forever livelock now
  // that the checkpoint is its own turn (§5). Chaining survives: the summary sits first in
  // the visible window, so a new span covers it and `covers[0]` chains from it.
  events = applySummary(events);
  // the ceiling that counts is the API's: a window it refused shrinks whatever it estimates
  if (estTokens(events) <= compactAt && !overflowed(events)) return null;
  // never under a running turn (see the header): its replayed thinking is bound to the
  // prefix as it stands
  if (!turnOver(events, session)) return null;
  const boundary = closingBoundary(events, session);
  const deferred = deferredInput(events, session, boundary);
  // walk back from the end keeping ~keepRecent est. tokens uncovered: `kept` = the first
  // kept index
  let keep = 0;
  let kept = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    keep += estTokens([events[i]]);
    if (keep > keepRecent) break;
    kept = i;
  }
  // where the cut may fall: in the closed region, after any event no step straddles. Never
  // after unanswered input: a world message is INPUT, and a checkpoint is a record, not
  // an answer. Input the closing never consumed sits BEFORE the boundary and is input all
  // the same: `covers` is an id range, so the cut stays below the first such message, or
  // the range would hide it.
  // A DEAD turn — an error or a cancel ended it — is covered WHOLE, its chain and the
  // input it was answering, down to the row that killed it: its thinking replays on the
  // next request, and a summary under part of it is the prefix edit this layer exists to
  // avoid; nothing continues the turn, so its results are not being worked from; and the
  // record carries what it was asked and what its tools found, which is what the next
  // think answers from. `keepRecent` is a live conversation's tail, and does not apply.
  const last = events.at(-1);
  const dead = last !== undefined && (last.type === "error" || isCancelled(last));
  const safe = cutPoints(events);
  const firstDeferred = events.findIndex((e) => deferred.has(e));
  const reach = dead ? events.length : kept;
  const ceiling = firstDeferred === -1 ? reach : Math.min(reach, firstDeferred);
  let cut = -1;
  for (let c = ceiling - 1; c >= 0; c--) {
    if (safe.has(c) && (c <= boundary || dead)) {
      cut = c;
      break;
    }
  }
  if (cut < 0) return null; // everything is recent, or one step — nothing coverable yet
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

/** The covered span as a plain transcript + the previous checkpoint (if one is inside).
 *  Tool traffic is in it: inside an open loop the calls and their outcomes ARE the
 *  content, and a checkpoint that leads a trailing chain has to say what the work found. */
function transcript(covered: Event[], session: Session): { text: string; previous?: string } {
  let previous: string | undefined;
  const lines: string[] = [];
  for (const e of covered) {
    if (e.type === "summary") {
      previous = e.parts.map((p) => p.text).join("\n");
    } else if (e.type === "message") {
      const who = ownVoice(e, session)
        ? "me"
        : e.envelope.sender?.name ?? e.envelope.sender?.address ?? "?";
      const text = e.parts.filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text).join(" ");
      lines.push(`[${who} @ ${e.envelope.conversation.address}] ${text}`);
    } else if (e.type === "tool_use") {
      const { name, input } = e.parts[0].data;
      lines.push(`[me → ${describeCall({ name, input }, { full: true })}]`);
    } else if (e.type === "tool_result") {
      lines.push(`[tool] ${outcomeLine(e, RESULT_CHARS)}`);
    } else if (e.type === "error") {
      // a dead turn's last word: the record says the work stopped, and why
      lines.push(`[error] ${errorTextOf(e)}`);
    } else if (isCancelled(e)) {
      lines.push(`[cancelled] the turn was stopped`);
    }
    // thinking: private — never part of the record
  }
  return { text: lines.join("\n"), previous };
}

/** Run the checkpoint step and mint the summary event. Null ⇒ under threshold: there was
 *  nothing to write. An error draft ⇒ there was, and it could not be written — the call
 *  never completed, or the model answered without a usable checkpoint (cut at the ceiling,
 *  or empty). All three end the turn on the error, unstamped, and the next input retries:
 *  a partial record would stand for the whole window, and a checkpoint that keeps failing
 *  would otherwise cost a call on every wake and show nowhere. */
export async function buildSummary(
  input: CompactInput,
  call: StepCall,
): Promise<Draft<SummaryEvent> | Draft<ErrorEvent> | null> {
  const span = compactionSpan(input.events, input.session, input.compactAt, input.keepRecent);
  if (!span) return null;
  const { text, previous } = transcript(span.covered, input.session);

  const failed = (why: string): Draft<ErrorEvent> => ({
    ts: new Date().toISOString(),
    type: "error",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: input.session.conversation },
    }, // harness-authored: no `agent` (§3)
    parts: [{ type: "data", kind: "error", data: { error: `checkpoint failed: ${why}` } }],
  });

  // the instruction is read lazily: only a window that actually compacts pays the read
  const instruction = await input.prompt();
  if (instruction === null) return failed("system/instructions/compaction.md is missing");
  let prompt = `<conversation>\n${text}\n</conversation>\n\n`;
  if (previous) prompt += `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  prompt += instruction;

  const res = await call({
    system: input.system ?? [],
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    model: input.model,
    effort: input.effort,
    maxTokens: SUMMARY_MAX_TOKENS,
    tools: [],
    turnId: input.turnId,
    signal: input.signal,
  });
  if (!res.ok) return failed(res.error);
  if (res.stop === "max_tokens") return failed("cut off at the output ceiling");
  const summary = res.emissions.filter((e) => e.kind === "assistant")
    .map((e) => e.text).join("\n").trim();
  if (summary.length === 0) return failed("the model wrote nothing");

  return {
    ts: new Date().toISOString(),
    type: "summary",
    agent: { id: input.session.agentId, session_id: input.session.id },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: input.session.conversation },
    },
    payload: { covers: span.covers, ...(input.turnId ? { turn_id: input.turnId } : {}) },
    parts: [{ type: "text", kind: "text", text: summary }],
  };
}
