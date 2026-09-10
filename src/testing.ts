/**
 * testing.ts — the scripted model edge. Test-only; nothing in the harness imports it.
 *
 * Since nu calls `mu` directly and mu calls a `ModelTransport`, the transport IS the seam a
 * test injects at (main takes one, and it travels down the chain untouched). That's one layer
 * lower than the old scripted `step`, and better for it: the canned response goes through mu's
 * real parsing, so a test exercises content-block handling instead of mocking past it.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Emit } from "./types.ts";
import { type Emission, type ModelTransport, mu, type StepCall } from "./mu.ts";
import { SILENCE } from "./render.ts";

/** An `Emission[]` as the model would actually have sent it: real content blocks. */
export function canned(
  emissions: Emission[],
  stop: Anthropic.StopReason = "end_turn",
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  let n = 0;
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_sequence: null,
    stop_reason: stop,
    usage: { input_tokens: 1, output_tokens: 1, ...usage } as Anthropic.Usage,
    content: emissions.map((em) =>
      em.kind === "thinking"
        ? { type: "thinking", thinking: em.thinking, signature: em.signature }
        : em.kind === "redacted_thinking"
        ? { type: "redacted_thinking", data: em.data }
        : em.kind === "assistant"
        ? { type: "text", text: em.text, citations: null }
        : { type: "tool_use", id: `toolu_${++n}`, name: em.name, input: em.input }
    ) as Anthropic.ContentBlock[],
  } as Anthropic.Message;
}

/** A transport that hands back the script in order, then keeps closing with the `SILENCE`
 *  sentinel — the compliant model's terse close (§5): every turn publishes, so its batch
 *  wakes whoever bounced off its lease. `calls` counts model calls. */
export function scripted(
  script: (Anthropic.Message | Error)[],
): { transport: ModelTransport; calls: () => number } {
  let n = 0;
  return {
    transport: (_params, emit) => {
      n++;
      const next = script.shift() ?? canned([{ kind: "assistant", text: SILENCE }]);
      if (next instanceof Error) return Promise.reject(next);
      for (const block of next.content) {
        if (block.type === "text") emit?.({ kind: "text", text: block.text });
      }
      return Promise.resolve(next);
    },
    calls: () => n,
  };
}

/** A `StepCall` over a transport — what nu hands down to whoever needs a model call, with
 *  no ladder around it: one attempt, so a test's script is exactly what the caller sees. */
export function stepping(transport: ModelTransport, emit?: Emit): StepCall {
  return (step) => mu(step, transport, emit);
}
