/**
 * mu.ts — the pure step (DESIGN §2): one model call. Render's request in → emissions out.
 *
 * mu builds the Anthropic request from what `render` produced, calls the model (streaming
 * deltas to the Stream via `emit`), and parses the response's content blocks into the three
 * things the model can produce — **thinking · assistant · tool_use**. It stamps nothing: ids,
 * envelope, agent, and turnId are nu's to assign when it appends. mu never reads the log,
 * writes, executes tools, stores, or touches channels — its one effect is the model call.
 *
 * The model call itself is a `ModelTransport` PARAMETER, so mu stays pure and testable — and
 * so the transport is where a different provider adapts in (main picks one and passes it down
 * the chain). Usage is returned for nu's telemetry table (never logged); `stop` is what the
 * turn ended on, which nu stamps on its last event so the log carries the continuation (§2).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, Emit, Json, Usage } from "./types.ts";
import type { RenderedRequest } from "./render.ts";
import { DEFAULT_MAX_TOKENS } from "./config.ts";

export type { Effort };

/** What the model produced this step, pre-log. nu stamps id/ts/envelope/agent/turnId.
 *  `assistant` is the model's text (the assistant channel, §5); `thinking` is private; `tool_use` acts. */
export type Emission =
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; name: string; input: Json };

export interface StepInput extends RenderedRequest {
  model: string;
  tools?: Anthropic.Tool[]; // omit ⇒ a toolless call (wiring, not a knob — tools are code)
  maxTokens?: number; // API-required output cap; default: the catalog's (§9)
  effort?: Effort; // adaptive thinking depth; omit ⇒ the model's default
  turnId?: string; // the turn this call IS — rides past the params, to the meter (§2)
}

/** `stop` routes the loop in nu: `tool_use` → continue · `end_turn` → idle ·
 *  `pause_turn` → continue (server turn paused) · `refusal`/`max_tokens` → handle. */
export type StepResult =
  | { ok: true; emissions: Emission[]; usage: Usage; stop: Anthropic.StopReason }
  | { ok: false; error: string };

/**
 * The impure edge: run the request, stream deltas via `emit`, return the final message.
 * Injected so mu itself stays pure. Production wraps the real client's streaming; tests
 * hand back a canned message.
 */
export type ModelTransport = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  emit?: Emit,
  meta?: CallMeta,
) => Promise<Anthropic.Message>;

/** What the call is FOR, for whoever wraps the transport. Not part of the request — the
 *  provider never sees it; the metering wrapper does (§2: spend, joinable to the log). */
export interface CallMeta {
  turn_id?: string;
}

/** Build `mu` over a transport. Returns the step function nu calls each invocation. */
export async function mu(
  input: StepInput,
  transport: ModelTransport,
  emit?: Emit,
): Promise<StepResult> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: input.model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: input.messages,
    tools: input.tools ?? [],
    thinking: { type: "adaptive" }, // modern models reason adaptively (§2)
    ...(input.system.length > 0 ? { system: input.system } : {}),
    ...(input.effort ? { output_config: { effort: input.effort } } : {}),
  };

  let message: Anthropic.Message;
  try {
    message = await transport(params, emit, { turn_id: input.turnId });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return {
    ok: true,
    emissions: parse(message.content),
    usage: usageOf(message.usage),
    stop: message.stop_reason ?? "end_turn",
  };
}

/** Content blocks → the three emissions. Server-tool blocks are skipped (none in v0's tool
 *  set). `redacted_thinking` is not handled — a Claude 3.7 behavior, removed in Claude 4+. */
function parse(content: Anthropic.ContentBlock[]): Emission[] {
  const out: Emission[] = [];
  for (const b of content) {
    if (b.type === "text") out.push({ kind: "assistant", text: b.text });
    else if (b.type === "thinking") {
      out.push({ kind: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "tool_use") {
      out.push({ kind: "tool_use", name: b.name, input: b.input as Json });
    }
  }
  return out;
}

function usageOf(u: Anthropic.Usage): Usage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    ...(u.cache_read_input_tokens != null ? { cache_read_tokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens != null
      ? { cache_write_tokens: u.cache_creation_input_tokens }
      : {}),
  };
}
