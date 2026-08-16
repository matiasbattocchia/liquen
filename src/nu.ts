/**
 * nu.ts — the turn (DESIGN §2): one think, assembled and stamped. Touches no log.
 *
 * **xi owns the log on both sides** — it reads (the window, `search`, gate/barrier queries)
 * and it is the only publisher. nu never sees a `Log`: it's handed the window and docs xi
 * already read, runs render → mu (with slow retries), stamps the emissions into events, and
 * RETURNS them for xi to publish. Its only impurities are the injected model call and
 * id/clock minting — no substrate.
 *
 * The purity gradient: mu (one model call) ⊂ nu (render → mu → stamp) ⊂ xi (all log I/O +
 * policy) ⊂ main (the process).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentId,
  Draft,
  Emit,
  Event,
  MessageEvent,
  SessionId,
  ThinkingEvent,
  ToolUseEvent,
} from "./types.ts";
import type { DocEntry } from "./store/docs.ts";
import { newId } from "./store/id.ts";
import { buildSummary } from "./compact.ts";
import { render } from "./render.ts";
import { type Effort, type ModelTransport, mu, type StepResult } from "./mu.ts";

/** Re-exported so the layer above talks to nu, not past it (main → xi → nu → mu). */
export type { ModelTransport };

export interface TurnConfig {
  agentId: AgentId;
  sessionId: SessionId;
  home: string; // the principal-DM conversation id
  model: string;
  maxTokens: number;
  effort?: Effort;
  /** IANA timezone every rendered stamp formats through (org config; §5). Unset ⇒ the
   *  deployment's own zone. Stored `ts` stays UTC — that one is a sort key (§3). */
  timezone?: string;
  /** Parked until the i18n seam — org config carries it; render is English for now (§5). */
  locale?: string;
  /** Slow OUTER retries for mu failures. The SDK client already retries fast (2×, backoff +
   *  jitter, honors retry-after on 429/5xx); this layer covers persistent failure (§2). */
  retryDelaysMs?: number[];
  compactAt?: number; // est. tokens before a checkpoint displaces the turn (§5; default 150K)
  keepRecent?: number; // est. tokens left uncovered by a checkpoint (default ~20K)
}

export interface TurnInput {
  events: Event[]; // the window xi read
  docs: DocEntry[]; // the cascade xi listed
  tools: Anthropic.Tool[]; // the registry's specs
  config: TurnConfig;
  ambient?: string[]; // volatile env lines for the anchor block (§5) — xi composes them
  /** Lazy source for the checkpoint instruction (the `harness/instruction/compaction` doc) —
   *  xi resolves the I/O, nu only calls it when a checkpoint actually runs (§5). */
  compactPrompt?: () => Promise<string | null>;
  /** Media resolver for the trailing-region blocks (§5) — xi injects
   *  `store/media.loadMediaBlock`; render decides which uris to resolve. */
  loadMedia?: (uri: string) => { media_type: string; data: string } | null;
}

/** nu's output IS events (the symmetry: events in → events out). The turn's outcome is not a
 *  separate channel — it rides on the last event's `meta.stop`, where `decide` reads it. */
export type TurnOutput = Draft<Event>[];

const DEFAULT_RETRIES = [5_000, 20_000];

/** Run one turn: render → mu (retrying) → stamp. Never throws; failure returns an error event. */
export async function nu(
  input: TurnInput,
  transport: ModelTransport,
  emit?: Emit,
): Promise<TurnOutput> {
  const { config } = input;
  const self = { id: config.agentId, session_id: config.sessionId };
  const mind = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: `mind:${config.agentId}` },
  };
  const home = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: config.home },
  };
  const ts = () => new Date().toISOString();
  const errorEvent = (error: string): Draft<Event> => ({
    ts: ts(),
    type: "error",
    envelope: mind, // harness-authored: no `agent` (§3)
    parts: [{ type: "data", kind: "error", data: { error } }],
  });

  // Maintenance first — and nu is where it belongs: nu is the layer that formats the window,
  // so it's the one that knows what the turn will actually weigh. When the VISIBLE window
  // outgrows the budget, THIS turn is the checkpoint: one model call either way (the
  // one-call-per-invocation invariant), and the summary's own insert wakes the think it
  // displaced — the log is the continuation engine, applied to maintenance (§5). Failure is
  // silent: null falls through to a normal turn; the next think retries the checkpoint.
  const summary = await buildSummary({
    events: input.events,
    sessionId: config.sessionId,
    agentId: config.agentId,
    home: config.home,
    model: config.model,
    effort: config.effort,
    compactAt: config.compactAt,
    keepRecent: config.keepRecent,
    prompt: input.compactPrompt,
  }, transport);
  if (summary) return [summary];

  const rendered = render({
    events: input.events,
    docs: input.docs,
    session: config.sessionId,
    home: config.home,
    now: ts(),
    zone: config.timezone,
    ambient: input.ambient,
    loadMedia: input.loadMedia,
  });

  let res: StepResult = { ok: false, error: "not attempted" };
  const delays = config.retryDelaysMs ?? DEFAULT_RETRIES;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    res = await mu(
      {
        ...rendered,
        model: config.model,
        maxTokens: config.maxTokens,
        effort: config.effort,
        tools: input.tools,
      },
      transport,
      emit,
    );
    if (res.ok) break;
  }
  if (!res.ok) return [errorEvent(res.error)]; // unstamped ⇒ terminal (decide idles)

  // stamp emissions → events (mint ids; envelope by channel; one turnId per step, §5)
  const turnId = newId();
  const events: Draft<Event>[] = [];
  for (const em of res.emissions) {
    if (em.kind === "thinking") {
      const e: Draft<ThinkingEvent> = {
        ts: ts(),
        type: "thinking",
        payload: { turn_id: turnId },
        agent: self,
        envelope: mind,
        parts: [{
          type: "data",
          kind: "thinking",
          data: { thinking: em.thinking, signature: em.signature },
        }],
      };
      events.push(e);
    } else if (em.kind === "assistant") {
      const e: Draft<MessageEvent> = {
        ts: ts(),
        type: "message",
        agent: self,
        envelope: home,
        // turn_id: render's boundary rule (§5). consumed: the coalescing horizon — what
        // this step actually read; xi's `unanswered` measures against it (§2). It rides
        // `extra` (harness sidecar), not payload: nothing about the MESSAGE depends on it.
        payload: { turn_id: turnId },
        ...(input.events.at(-1) ? { extra: { consumed: input.events.at(-1)!.id } } : {}),
        parts: [{ type: "text", kind: "text", text: em.text }],
      };
      events.push(e);
    } else {
      const e: Draft<ToolUseEvent> = {
        ts: ts(),
        type: "tool_use",
        payload: { turn_id: turnId },
        agent: self,
        envelope: mind,
        parts: [{ type: "data", kind: "tool_use", data: { name: em.name, input: em.input } }],
      };
      events.push(e);
    }
  }

  // refusal is terminal — surface it and stop. max_tokens is NOT terminal: the turn was
  // cut off at the output ceiling, so xi CONTINUES it (like pause_turn); the advisory rides
  // along so the model knows it was truncated and steers large output to files (§2).
  if (res.stop === "refusal") {
    events.push(errorEvent("model stopped: refusal"));
  } else if (res.stop === "max_tokens") {
    events.push(errorEvent(
      "your previous turn hit the output token limit and was cut off mid-generation. " +
        "Continue from where you stopped. For large outputs, write them to a file " +
        "incrementally (append via bash/awrite) instead of emitting everything in one message.",
    ));
  }
  // The turn's outcome rides on its LAST event: `pause_turn` (the server paced it) and
  // `max_tokens` (cut off at the ceiling) are not endings — xi re-enters and CONTINUES.
  // Stamping it here is what lets the log carry that, instead of a loop in xi (§2). The
  // transport-failure path above returns before this: an unstamped error is a real stop.
  const last = events.at(-1);
  if (last) last.payload = { ...last.payload, stop_reason: res.stop };
  return events;
}
