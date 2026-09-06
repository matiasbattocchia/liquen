/**
 * compact.ts — the checkpoint layer (DESIGN §5 "Compaction", from pi).
 *
 * Pruning is already render's closed-region collapse; this is the other layer: when the
 * window outgrows `compactAt`, one bare mu call (no tools) writes a structured checkpoint
 * over the older CLOSED events, published as a `summary` event with `covers: [from, to]`.
 * Iterative: a later compaction folds the previous summary in (pi's update rule), and
 * `covers` chains from the previous summary's start so survivors get re-covered.
 *
 * xi calls `maybeCompact` under the turn lock, before thinking. Failure is silent — the
 * next think retries; nothing depends on a checkpoint existing.
 */

import type { Draft, ErrorEvent, Event, Session, SummaryEvent } from "./types.ts";
import { applySummary, closingBoundary, deferredInput, outcomeLine, ownVoice } from "./render.ts";
import { type ModelTransport, mu, type StepInput } from "./mu.ts";
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

/** The checkpoint instruction (task + format + the fold-a-previous-summary rule in one — the
 *  prompt itself branches on <previous-summary>, so the code doesn't). The LIVE copy is a doc
 *  — `harness/instruction/compaction` (seeded from seed/docs) — so it's readable and editable
 *  like any instruction, not hidden in code; this constant is the fallback when the doc is
 *  absent (unseeded stores). */
export const DEFAULT_PROMPT =
  `The conversation above is being archived. Write a structured checkpoint summary that a later step of the same agent will rely on to continue seamlessly.

If a <previous-summary> block is present, fold it in: PRESERVE everything still relevant from it, ADD the new threads/facts/commitments, UPDATE state that moved on, and drop only what is clearly obsolete.

Use this EXACT format:

## Ongoing threads
[Per conversation: who it is, what is being discussed, current state]

## Constraints & preferences
- [How the principal wants things done — or "(none)"]

## Commitments
- [Things promised or pending, with owner and any deadline — or "(none)"]

## Key facts & decisions
- **[Fact/decision]**: [brief context]

## Critical context
- [Exact names, ids, paths, and figures needed to continue — or "(none)"]

Keep each section concise. Preserve exact names, paths and figures.`;

export interface CompactInput {
  /** The turn's interrupt (§2) — a cut checkpoint call is the cut turn's. */
  signal?: AbortSignal;
  events: Event[]; // the window, log order
  session: Session; // whose window it is, and where it speaks (§4)
  model: string;
  effort?: StepInput["effort"];
  /** Lazy source for the checkpoint instruction (the `harness/instruction/compaction` doc).
   *  Called only when a compaction actually runs; null/absent ⇒ `DEFAULT_PROMPT`. */
  prompt?: () => Promise<string | null>;
  compactAt?: number;
  keepRecent?: number;
  /** The invocation's turn (nu mints it): the checkpoint call's spend is metered under it,
   *  and the summary carries it — a checkpoint is a model turn like any other. */
  turnId?: string;
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
 *  tail. Null ⇒ nothing to do. */
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
  if (estTokens(events) <= compactAt) return null;
  const boundary = closingBoundary(events, session);
  const deferred = deferredInput(events, session, boundary);
  // walk back from the end keeping ~keepRecent est. tokens uncovered: `kept` = the first
  // kept index. The tail may be a long open tool loop — that is exactly when the closed
  // region is not where the weight is, and a cut between two of its steps is what shrinks
  // the window (the checkpoint then leads a trailing chain that starts on a whole step).
  let keep = 0;
  let kept = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    keep += estTokens([events[i]]);
    if (keep > keepRecent) break;
    kept = i;
  }
  // where the cut may fall: in the closed region, after any event no step straddles; in
  // the open chain beyond it, only after a tool outcome — a world message there is INPUT
  // the agent has not answered, and a checkpoint is a record, not an answer. Input the
  // closing never consumed sits BEFORE the boundary and is input all the same: `covers` is
  // an id range, so the cut stays below the first such message, or the range would hide it
  const safe = cutPoints(events);
  const firstDeferred = events.findIndex((e) => deferred.has(e));
  const ceiling = firstDeferred === -1 ? kept : Math.min(kept, firstDeferred);
  let cut = -1;
  for (let c = ceiling - 1; c >= 0; c--) {
    if (safe.has(c) && (c <= boundary || events[c].type === "tool_result")) {
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
    }
    // thinking: private — never part of the record
  }
  return { text: lines.join("\n"), previous };
}

/** Run the checkpoint step and mint the summary event. Null ⇒ under threshold, or the
 *  call itself failed (weather — the next think retries). An error draft ⇒ the model
 *  answered but wrote no usable checkpoint — cut at the ceiling, or empty: a partial
 *  record would stand for the whole window, and an empty one would run again on every
 *  wake, so the turn ends on the error instead and the next input retries. */
export async function buildSummary(
  input: CompactInput,
  transport: ModelTransport,
): Promise<Draft<SummaryEvent> | Draft<ErrorEvent> | null> {
  const span = compactionSpan(
    input.events,
    input.session,
    input.compactAt,
    input.keepRecent,
  );
  if (!span) return null;
  const { text, previous } = transcript(span.covered, input.session);

  let prompt = `<conversation>\n${text}\n</conversation>\n\n`;
  if (previous) prompt += `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  // the instruction comes from the docs cascade when available (fetched lazily — only a
  // window that actually compacts pays the read); the embedded default otherwise
  prompt += (await input.prompt?.()) ?? DEFAULT_PROMPT;

  const res = await mu({
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    model: input.model,
    effort: input.effort,
    maxTokens: SUMMARY_MAX_TOKENS,
    tools: [],
    turnId: input.turnId,
    signal: input.signal,
  }, transport);
  if (!res.ok) return null; // silent — the next think retries
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
