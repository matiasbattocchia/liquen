/**
 * transport.ts — the real `ModelTransport`: the one impure edge that talks to Anthropic.
 *
 * mu stays pure by taking the model call as a parameter (see mu.ts). This is the production
 * wiring of that parameter: open a streaming request, pump `text`/`thinking` deltas to the
 * Stream via `emit`, and return the final message. Errors propagate as a rejected promise —
 * mu's boundary turns that into `{ ok: false, error }`, and nu owns the retry (§2).
 *
 * Swap this for a recording/replay transport, a retry wrapper, or another provider without
 * touching mu — that's the whole point of the seam.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTransport } from "./mu.ts";
import type { UsageRow } from "./store/log.ts";

/** Re-exported: main picks a transport here, and never needs to reach into mu. */
export type { ModelTransport };

/**
 * Meter a transport: record every model call's spend — turns, compaction checkpoints,
 * whatever passes through — into the usage table (§2: telemetry, not the log). This is THE
 * seam for it: every call crosses the transport, and the response already carries `usage`,
 * so no layer above changes. Wrapped per agent in main, which is what attributes the spend
 * (and matches where per-agent providers will plug in).
 *
 * The row also carries the call's `turn_id` (`CallMeta`, minted by nu before the request):
 * spend is telemetry, but a turn is a log key, so "what did this conversation cost" is a
 * join rather than a guess from timestamps.
 */
export function metered(
  transport: ModelTransport,
  meter: (row: UsageRow) => void,
  agentId?: string,
): ModelTransport {
  return async (params, emit, meta) => {
    const message = await transport(params, emit, meta); // a failed call spends nothing meterable
    try {
      meter({
        created_at: new Date().toISOString(),
        agent_id: agentId,
        ...(meta?.turn_id ? { turn_id: meta.turn_id } : {}),
        model: params.model,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_tokens: message.usage.cache_read_input_tokens ?? undefined,
        cache_write_tokens: message.usage.cache_creation_input_tokens ?? undefined,
      });
    } catch { /* telemetry must never fail the call */ }
    return message;
  };
}

/** Wrap an Anthropic client as a `ModelTransport`. */
export function anthropicTransport(client: Anthropic): ModelTransport {
  return (params, emit) => {
    const stream = client.messages.stream(params);
    // Always attach listeners: they no-op when `emit` is absent, and an attached `error`
    // listener keeps a stream error from surfacing as an unhandled event (it still rejects
    // `finalMessage()`, which is the path mu catches).
    stream.on("text", (delta) => emit?.({ kind: "text", text: delta }));
    stream.on("thinking", (delta) => emit?.({ kind: "thinking", text: delta }));
    stream.on("error", (err) => emit?.({ kind: "error", text: errorText(err) }));
    return stream.finalMessage();
  };
}

/** Build a client. An explicit (or env) key wins; otherwise `apiKey: null` hands auth to
 *  the SDK's credential chain — `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` OAuth
 *  profile on disk. Caveat: an EMPTY `ANTHROPIC_API_KEY=` line still shadows the chain
 *  inside the SDK — delete the line rather than leaving it blank. */
export function anthropicClient(
  apiKey: string | undefined = Deno.env.get("ANTHROPIC_API_KEY"),
): Anthropic {
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic({ apiKey: null });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
