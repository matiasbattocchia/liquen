import { assert, assertEquals, assertObjectMatch, assertRejects } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { explained, googleClient, googleTransport } from "./google.ts";
import { silenced } from "./mod.ts";
import { mu } from "../mu.ts";
import { retryable } from "../nu.ts";
import type { Delta } from "../types.ts";

const KEY = Deno.env.get("GEMINI_API_KEY");
// the model is the operator's choice: the free tier meters each one separately
const MODEL = Deno.env.get("GEMINI_SMOKE_MODEL") ?? "gemini-3.5-flash";

// Real round-trips through the SDK. Skipped unless GEMINI_API_KEY is set (CI stays green and
// offline). Run them with a key — `deno task smoke` — to verify the wire's load-bearing
// assumptions: a stateless streamed interaction, the tool cycle replayed under the
// PROVIDER's call ids with the thought signature alongside, and parallel calls to one tool.

Deno.test({
  name: "smoke (google): a streamed text round-trip",
  ignore: !KEY,
  fn: async () => {
    const textDeltas: string[] = [];
    const res = await mu(
      {
        model: MODEL,
        maxTokens: 512,
        system: [{ type: "text", text: "Answer with a single short word." }],
        messages: [{ role: "user", content: "Reply with the word: pong" }],
        tools: [],
        effort: "low",
      },
      googleTransport(googleClient()),
      (d) => {
        if (d.kind === "text" && d.text) textDeltas.push(d.text);
      },
    );
    assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assertEquals(res.stop, "end_turn");
      assert(res.emissions.some((e) => e.kind === "assistant"), "expected an assistant emission");
      assert(textDeltas.length > 0, "expected streamed text deltas via emit");
      assert(res.usage.output_tokens > 0, "expected usage");
    }
  },
});

Deno.test({
  name:
    "smoke (google): two parallel calls to ONE tool replay under the provider's ids + signature",
  ignore: !KEY,
  fn: async () => {
    const tools: Anthropic.Tool[] = [{
      name: "get_time",
      description: "Returns the current time in a city. Call it once per city, in parallel.",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }];
    const system: Anthropic.TextBlockParam[] = [{
      type: "text",
      text: "Always use get_time for time questions. Ask for every city in one turn.",
    }];
    const ask: Anthropic.MessageParam = {
      role: "user",
      content: "What time is it in Paris and in Tokyo?",
    };
    const transport = googleTransport(googleClient());

    // step 1 — expect the calls, each with the id the wire minted
    const step1 = await mu({
      model: MODEL,
      maxTokens: 2048,
      system,
      messages: [ask],
      tools,
      effort: "low",
    }, transport);
    assert(step1.ok, `step1 failed: ${JSON.stringify(step1)}`);
    if (!step1.ok) return;
    assertEquals(step1.stop, "tool_use");
    const uses = step1.emissions.flatMap((e) => e.kind === "tool_use" ? [e] : []);
    assertEquals(uses.length, 2, `expected two parallel calls, got ${JSON.stringify(uses)}`);
    assert(uses.every((u) => u.call_id), "every call carries the provider's id");
    assert(uses[0].call_id !== uses[1].call_id, "the two ids differ");
    const thought = step1.emissions.find((e) => e.kind === "thinking");
    assert(thought && thought.kind === "thinking" && thought.signature, "expected a signature");

    // step 2 — replay the turn the way render does: the thinking block (its body may be
    // empty; the signature is what matters), each tool_use under its call_id, then the
    // results answering by the same ids
    const replayed: Anthropic.ContentBlockParam[] = step1.emissions.flatMap(
      (e): Anthropic.ContentBlockParam[] => {
        if (e.kind === "thinking") {
          return [{ type: "thinking", thinking: e.thinking, signature: e.signature }];
        }
        if (e.kind === "assistant") return [{ type: "text", text: e.text }];
        if (e.kind === "tool_use") {
          return [{ type: "tool_use", id: e.call_id!, name: e.name, input: e.input }];
        }
        return [];
      },
    );
    const results: Anthropic.ToolResultBlockParam[] = uses.map((u) => ({
      type: "tool_result",
      tool_use_id: u.call_id!,
      content: (u.input as { city?: string }).city === "Paris" ? "14:30" : "21:30",
    }));
    const step2 = await mu({
      model: MODEL,
      maxTokens: 2048,
      system,
      messages: [ask, { role: "assistant", content: replayed }, { role: "user", content: results }],
      tools,
      effort: "low",
    }, transport);
    assert(
      step2.ok,
      `REPLAY REJECTED — ids or signature did not round-trip: ${JSON.stringify(step2)}`,
    );
    if (step2.ok) {
      assertEquals(step2.stop, "end_turn");
      const said = step2.emissions.flatMap((e) => e.kind === "assistant" ? [e.text] : []);
      assertEquals(said.length, 1, `one utterance, one message: ${JSON.stringify(said)}`);
      assert(
        /14:30|2:30/.test(said[0]) && /21:30|9:30/.test(said[0]),
        `expected both results reflected, got ${JSON.stringify(said)}`,
      );
    }
  },
});

// Offline: the body is the one the API sent for a 429 (a free tier's zero quota), 2026-09-27.
const REFUSED = 'event: error\ndata: {"error":{"message":"Rate limit exceeded for model ' +
  "gemini-3.1-pro (limit: 0 input tokens per minute on Free Tier). Please upgrade your tier " +
  'at https://ai.dev/rate-limit.","code":"rate_limit_exceeded"},"event_type":"error"}\n';

Deno.test("google: a refusal sent as an event stream keeps its status and the server's words", () => {
  const sdk = Object.assign(
    new Error('429 API error occurred: {"httpMeta":{"response":{},"request":{}}}'),
    { status: 429, body: REFUSED },
  );
  const e = explained(sdk) as Error & { status: number };
  assertEquals(e.status, 429);
  assertEquals(
    e.message,
    "429 Rate limit exceeded for model gemini-3.1-pro (limit: 0 input tokens per minute on " +
      "Free Tier). Please upgrade your tier at https://ai.dev/rate-limit.",
  );
});

Deno.test("google: an error the SDK could read, or with no status, passes through as it is", () => {
  const read = Object.assign(new Error("404 Model 'x' not found."), {
    status: 404,
    body: '{"error":{"message":"Model \'x\' not found.","code":"not_found"}}',
  });
  assertEquals(explained(read), read);
  const dropped = new TypeError("fetch failed");
  assertEquals(explained(dropped), dropped);
});

// Offline: a local server answers as the Interactions API does — an event stream — with the
// events a test scripts, `null` holding the stream open with nothing more to say.
const sse = (ev: unknown) => `event: message\ndata: ${JSON.stringify(ev)}\n\n`;
const start = { event_type: "step.start", index: 0, step: { type: "model_output" } };
const delta = (text: string) => ({
  event_type: "step.delta",
  index: 0,
  delta: { type: "text", text },
});
const completed = {
  event_type: "interaction.completed",
  interaction: { status: "completed", usage: { total_input_tokens: 1, total_output_tokens: 1 } },
};
const REQUEST = {
  model: "gemini-3.8-flash",
  max_tokens: 100,
  messages: [{ role: "user" as const, content: "hi" }],
};

async function scripted(
  script: { after: number; event: unknown | null }[],
  run: (client: GoogleGenAI) => Promise<void>,
): Promise<void> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (const { after, event } of script) {
          timers.push(setTimeout(() => {
            if (event === null) return;
            try {
              c.enqueue(enc.encode(sse(event)));
              if (event === completed) c.close();
            } catch { /* the client hung up first */ }
          }, after));
        }
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    await run(
      new GoogleGenAI({
        apiKey: "test",
        httpOptions: { baseUrl: `http://127.0.0.1:${server.addr.port}` },
      }),
    );
  } finally {
    for (const t of timers) clearTimeout(t);
    await server.shutdown();
  }
}

Deno.test("google: a function call's arguments reach the Stream as a tool delta, named", async () => {
  const call = {
    event_type: "step.start",
    index: 1,
    step: { type: "function_call", id: "c1", name: "bash" },
  };
  const args = {
    event_type: "step.delta",
    index: 1,
    delta: { type: "arguments_delta", arguments: '{"command":"ls"}' },
  };
  const stop = { event_type: "step.stop", index: 1 };
  const script = [start, delta("ho"), call, args, stop, completed]
    .map((event) => ({ after: 0, event }));
  await scripted(script, async (c) => {
    const seen: Delta[] = [];
    const message = await googleTransport(c)(REQUEST, (d) => seen.push(d));
    assertEquals(seen, [
      { kind: "text", text: "ho" },
      { kind: "tool", name: "bash", text: '{"command":"ls"}' },
    ]);
    assertObjectMatch(message.content.at(-1)!, {
      id: "c1",
      name: "bash",
      input: { command: "ls" },
    });
  });
});

Deno.test("google, silenced: a stream gone silent fails as a dropped connection, which nu retries", async () => {
  await scripted([{ after: 0, event: start }, { after: 0, event: delta("ho") }], async (c) => {
    const began = Date.now();
    const err = await assertRejects(
      () => silenced(googleTransport(c), 200)(REQUEST),
      Error,
      "no word from the model in 0.2s",
    );
    assert(Date.now() - began < 2_000, "the deadline cut the wait: the SDK honors the signal");
    const status = (err as { status?: number }).status;
    assertEquals(status, undefined);
    assert(retryable(status, (err as Error).message));
  });
});
