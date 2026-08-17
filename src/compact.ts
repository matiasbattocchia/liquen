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

import type { Draft, Event, SummaryEvent } from "./types.ts";
import { applySummary, closingBoundary, deferredInput, ownVoice } from "./render.ts";
import { type ModelTransport, mu, type StepInput } from "./mu.ts";

export const DEFAULT_COMPACT_AT = 150_000; // est. tokens — matches the API's own server-side compaction trigger
export const DEFAULT_KEEP_RECENT = 20_000; // est. tokens left uncovered

/** chars/4 — crude but monotone; both thresholds are order-of-magnitude knobs. */
export const estTokens = (events: Event[]): number => Math.ceil(JSON.stringify(events).length / 4);

/** The checkpoint instruction (task + format + the fold-a-previous-summary rule in one — the
 *  prompt itself branches on <previous-summary>, so the code doesn't). The LIVE copy is a doc
 *  — `harness/instruction/compaction` (seeded from seed/docs) — so it's readable and editable
 *  like any instruction, not hidden in code; this constant is the fallback when the doc is
 *  absent (task mode, unseeded stores). */
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
  events: Event[]; // the window, log order
  sessionId: string;
  agentId: string;
  home: string;
  model: string;
  effort?: StepInput["effort"];
  /** Lazy source for the checkpoint instruction (the `harness/instruction/compaction` doc).
   *  Called only when a compaction actually runs; null/absent ⇒ `DEFAULT_PROMPT`. */
  prompt?: () => Promise<string | null>;
  compactAt?: number;
  keepRecent?: number;
}

/** Decide the covered span: closed events beyond the keep-recent budget. Null ⇒ nothing to do. */
export function compactionSpan(
  events: Event[],
  sessionId: string,
  home: string,
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
  const boundary = closingBoundary(events, sessionId, home);
  if (boundary < 0) return null; // no closed region yet — nothing safely coverable
  const deferred = deferredInput(events, sessionId, boundary);
  const closed = events.slice(0, boundary + 1).filter((e) => !deferred.has(e));
  // walk back from the boundary keeping ~keepRecent est. tokens uncovered
  let keep = 0;
  let cut = closed.length; // first KEPT index
  for (let i = closed.length - 1; i >= 0; i--) {
    keep += Math.ceil(JSON.stringify(closed[i]).length / 4);
    if (keep > keepRecent) break;
    cut = i;
  }
  const covered = closed.slice(0, cut);
  if (covered.length === 0) return null; // everything closed is recent — skip
  return { covered, covers: [covered[0].id, covered[cut - 1].id] };
}

/** The covered span as a plain transcript + the previous checkpoint (if one is inside). */
function transcript(covered: Event[], sessionId: string): { text: string; previous?: string } {
  let previous: string | undefined;
  const lines: string[] = [];
  for (const e of covered) {
    if (e.type === "summary") {
      previous = e.parts.map((p) => p.text).join("\n");
    } else if (e.type === "message") {
      const who = ownVoice(e, sessionId)
        ? "me"
        : e.envelope.sender?.name ?? e.envelope.sender?.address ?? "?";
      const text = e.parts.filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text).join(" ");
      lines.push(`[${who} @ ${e.envelope.conversation.address}] ${text}`);
    }
    // tool traffic / thinking: already pruned semantics — the checkpoint works from messages
  }
  return { text: lines.join("\n"), previous };
}

/** Run the checkpoint step and mint the summary event. Null ⇒ under threshold or mu failed. */
export async function buildSummary(
  input: CompactInput,
  transport: ModelTransport,
): Promise<Draft<SummaryEvent> | null> {
  const span = compactionSpan(
    input.events,
    input.sessionId,
    input.home,
    input.compactAt,
    input.keepRecent,
  );
  if (!span) return null;
  const { text, previous } = transcript(span.covered, input.sessionId);

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
    maxTokens: 4096,
    tools: [],
  }, transport);
  if (!res.ok) return null; // silent — the next think retries
  const summary = res.emissions.filter((e) => e.kind === "assistant")
    .map((e) => e.text).join("\n").trim();
  if (summary.length === 0) return null;

  return {
    ts: new Date().toISOString(),
    type: "summary",
    agent: { id: input.agentId, session_id: input.sessionId },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: `mind:${input.agentId}` },
    },
    payload: { covers: span.covers },
    parts: [{ type: "text", kind: "text", text: summary }],
  };
}
