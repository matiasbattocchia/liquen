/**
 * transport/google.ts — the Google edge: one stateless, streamed Interactions request per
 * model call. The request is the harness's (steps.ts translates it), the interaction is
 * never stored (`store: false` — the log is the only record of a conversation, §3), and its
 * steps are assembled here from the event stream, since `interaction.completed` carries the
 * status and usage but not the steps.
 *
 * Deltas reach the Stream as they arrive: a `model_output` text fragment as `text`, a
 * `thought` summary as `thinking`. The turn's interrupt aborts the underlying fetch.
 */

import { GoogleGenAI } from "@google/genai";
import type { ModelTransport } from "../mu.ts";
import { assemble, type Event, failure, toMessage, toRequest } from "./steps.ts";

/** Wrap a Google client as a `ModelTransport`. */
export function googleTransport(client: GoogleGenAI): ModelTransport {
  return async (params, emit, _meta, signal) => {
    let stream: AsyncIterable<Event>;
    try {
      stream = await client.interactions.create(
        { ...toRequest(params), stream: true, store: false },
        signal ? { fetch_options: { signal } } : undefined,
      ) as unknown as AsyncIterable<Event>;
    } catch (err) {
      throw explained(err);
    }
    const a = assemble();
    for await (const ev of stream) {
      a.take(ev);
      if (ev.event_type === "step.delta") {
        const d = ev.delta;
        if (d.type === "text") emit?.({ kind: "text", text: d.text });
        else if (d.type === "thought_summary" && d.content?.type === "text") {
          emit?.({ kind: "thinking", text: d.content.text });
        }
      } else if (ev.event_type === "error") {
        emit?.({ kind: "error", text: ev.error?.message ?? "interaction error" });
      }
    }
    return toMessage(params.model, a);
  };
}

/** A refused request, with the server's own words. The API sends a refusal such as a 429 as
 *  an event stream, `event: error` then `data: {"error":{"message":…,"code":…}}`, which the
 *  SDK does not parse: its message is then "API error occurred: {"httpMeta":…}", and the
 *  server's words are only in the raw body. Any other error passes through as it is. */
export function explained(err: unknown): unknown {
  const { body, status } = (err ?? {}) as { body?: unknown; status?: unknown };
  const data = typeof body === "string" ? /^data: (.*)$/m.exec(body)?.[1] : undefined;
  if (!data || typeof status !== "number") return err;
  let message: unknown;
  try {
    message = JSON.parse(data)?.error?.message;
  } catch {
    return err;
  }
  return typeof message === "string" ? failure(`${status} ${message}`, status) : err;
}

/** Build a client. An explicit key (a test's) wins; otherwise the key is the environment's
 *  — `GEMINI_API_KEY`, the one secret this edge needs — and mu never reads it. */
export function googleClient(apiKey?: string): GoogleGenAI {
  const key = apiKey ?? Deno.env.get("GEMINI_API_KEY");
  return new GoogleGenAI(key ? { apiKey: key } : {});
}
