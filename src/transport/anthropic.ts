/**
 * transport/anthropic.ts — the Anthropic edge: a streaming Messages request, deltas pumped
 * to the Stream via `emit`, the final message returned as is. The request vocabulary IS this
 * API's, so nothing is translated on the way in or out (see transport/mod.ts).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTransport } from "../mu.ts";

/** Wrap an Anthropic client as a `ModelTransport`. */
export function anthropicTransport(client: Anthropic): ModelTransport {
  return (params, emit, _meta, signal) => {
    // the turn's interrupt reaches the request: an abort closes the stream mid-flight
    const stream = client.messages.stream(params, signal ? { signal } : undefined);
    // Always attach listeners: they no-op when `emit` is absent, and an attached `error`
    // listener keeps a stream error from surfacing as an unhandled event (it still rejects
    // `finalMessage()`, which is the path mu catches).
    stream.on("text", (delta) => emit?.({ kind: "text", text: delta }));
    stream.on("thinking", (delta) => emit?.({ kind: "thinking", text: delta }));
    stream.on("error", (err) => emit?.({ kind: "error", text: errorText(err) }));
    return stream.finalMessage();
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
