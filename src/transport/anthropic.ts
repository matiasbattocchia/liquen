/**
 * transport/anthropic.ts — the Anthropic edge: a streaming Messages request, deltas pumped
 * to the Stream via `emit`, the final message returned as is. The request vocabulary IS this
 * API's, so nothing is translated on the way in or out (see transport/mod.ts).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTransport } from "../mu.ts";

/** The beta that lets a request say what happens to a thinking block whose conversation
 *  changed under it, and makes every response report what it dropped. */
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** A replayed thinking block is bound to everything its request held before it. On a
 *  mismatch, `drop_block` answers without that reasoning and `error` refuses the request. */
export type PrefixMismatch = "drop_block" | "error";

type InputTransformation = { type: string; path?: string; reason?: string };

/** Wrap an Anthropic client as a `ModelTransport`. */
export function anthropicTransport(
  client: Anthropic,
  { mismatch = "drop_block" }: { mismatch?: PrefixMismatch } = {},
): ModelTransport {
  return async (params, emit, meta, signal) => {
    // set explicitly: an account's default on a mismatch depends on when it was created
    const bound = {
      ...params,
      ...(params.thinking
        ? {
          thinking: { ...params.thinking, block_binding: { prefix_mismatch_behavior: mismatch } },
        }
        : {}),
    } as Anthropic.MessageStreamParams;
    // the turn's interrupt reaches the request: an abort closes the stream mid-flight
    const stream = client.messages.stream(bound, {
      headers: { "anthropic-beta": BINDING_BETA },
      ...(signal ? { signal } : {}),
    });
    // Always attach listeners: they no-op when `emit` is absent, and an attached `error`
    // listener keeps a stream error from surfacing as an unhandled event (it still rejects
    // `finalMessage()`, which is the path mu catches).
    stream.on("text", (delta) => emit?.({ kind: "text", text: delta }));
    stream.on("thinking", (delta) => emit?.({ kind: "thinking", text: delta }));
    stream.on("error", (err) => emit?.({ kind: "error", text: errorText(err) }));
    const message = await stream.finalMessage();
    // a dropped block is reasoning the model answered without: the request that dropped
    // it changed something the block had read
    const dropped = (message as { input_transformations?: InputTransformation[] })
      .input_transformations ?? [];
    for (const t of dropped) {
      console.error(
        `[anthropic] turn ${meta?.turn_id ?? "?"}: ${t.type} at ${t.path ?? "?"} (${
          t.reason ?? "?"
        })`,
      );
    }
    return message;
  };
}

/** Build a client. An explicit key (a test's, or later a vault credential) wins;
 *  otherwise credentials are the SDK's own affair — `ANTHROPIC_API_KEY`,
 *  `ANTHROPIC_AUTH_TOKEN`, an `ant auth login` OAuth profile — mu never reads them. */
export function anthropicClient(apiKey?: string): Anthropic {
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
