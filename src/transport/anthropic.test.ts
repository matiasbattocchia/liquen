import { assert, assertEquals, assertObjectMatch, assertRejects } from "@std/assert";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, anthropicTransport } from "./anthropic.ts";
import { silenced } from "./mod.ts";
import { mu } from "../mu.ts";
import { retryable } from "../nu.ts";
import type { Delta } from "../types.ts";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5"; // adaptive-thinking-capable (mu always sends thinking)

// Real round-trips through the SDK. Skipped unless ANTHROPIC_API_KEY is set (CI stays green
// and offline). Run them with a key — `deno task smoke` — to verify the risky assumptions:
// adaptive thinking, effort, streaming deltas, and the re-minted tool_use id on replay.

Deno.test({
  name: "smoke: a streamed text round-trip",
  ignore: !KEY,
  fn: async () => {
    const textDeltas: string[] = [];

    const res = await mu(
      {
        model: MODEL,
        maxTokens: 8192,
        system: [{ type: "text", text: "Answer with a single short word." }],
        messages: [{ role: "user", content: "Reply with the word: pong" }],
        tools: [],
        effort: "low",
      },
      anthropicTransport(anthropicClient()),
      (d) => {
        if (d.kind === "text" && d.text) textDeltas.push(d.text);
      },
    );

    assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assert(res.emissions.some((e) => e.kind === "assistant"), "expected an assistant emission");
      assert(textDeltas.length > 0, "expected streamed text deltas via emit");
      assert(res.usage.output_tokens > 0, "expected usage");
    }
  },
});

// the cycle runs on a model that binds a thinking block to its conversation too, under
// `error`: a replay that changed what the block read fails here instead of degrading
for (const model of [MODEL, "claude-opus-5-5"]) {
  Deno.test({
    name:
      `smoke: tool cycle replays with OUR re-minted tool_use id (+ thinking verbatim) — ${model}`,
    ignore: !KEY,
    fn: async () => {
      const tools: Anthropic.Tool[] = [{
        name: "get_time",
        description: "Returns the current time. Always use this when asked for the time.",
        input_schema: { type: "object", properties: {}, required: [] },
      }];
      const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: "You must use the get_time tool to answer time questions." },
      ];
      const ask: Anthropic.MessageParam = { role: "user", content: "What time is it?" };

      // step 1 — expect a tool_use
      const step1 = await mu({
        model,
        maxTokens: 8192,
        system,
        messages: [ask],
        tools,
        effort: "low",
      }, anthropicTransport(anthropicClient()));
      assert(step1.ok, `step1 failed: ${JSON.stringify(step1)}`);
      if (!step1.ok) return;
      assert(step1.stop === "tool_use", `expected stop=tool_use, got ${step1.stop}`);
      const use = step1.emissions.find((e) => e.kind === "tool_use");
      assert(use && use.kind === "tool_use", "expected a tool_use emission");

      // step 2 — replay the turn the way render does: thinking verbatim + tool_use with a
      // re-minted id (the design's bet), then the tool_result under the same id.
      const OUR_ID = "01890000-0000-7000-8000-00000000abcd"; // uuidv7-shaped, ours not the API's
      const replayed: Anthropic.ContentBlockParam[] = step1.emissions.flatMap(
        (e): Anthropic.ContentBlockParam[] => {
          if (e.kind === "thinking") {
            return [{ type: "thinking", thinking: e.thinking, signature: e.signature }];
          }
          if (e.kind === "redacted_thinking") return [{ type: "redacted_thinking", data: e.data }];
          if (e.kind === "assistant") return [{ type: "text", text: e.text }];
          return [{ type: "tool_use", id: OUR_ID, name: e.name, input: e.input }];
        },
      );
      const step2 = await mu({
        model,
        maxTokens: 8192,
        system,
        messages: [
          ask,
          { role: "assistant", content: replayed },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: OUR_ID, content: "14:30 UTC" }],
          },
        ],
        tools,
        effort: "low",
      }, anthropicTransport(anthropicClient(), { mismatch: "error" }));

      assert(step2.ok, `REPLAY REJECTED — the re-minted-id bet fails: ${JSON.stringify(step2)}`);
      if (step2.ok) {
        const final = step2.emissions.find((e) => e.kind === "assistant");
        assert(
          final && final.kind === "assistant" && final.text.includes("14:30"),
          "expected the tool result reflected in the answer",
        );
      }
    },
  });
}

Deno.test("the request states what a mismatched thinking block does, under the beta that lets it", async () => {
  const seen: { params?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const stream = {
    on: () => stream,
    finalMessage: () => Promise.resolve({ content: [], input_transformations: [] }),
  };
  const client = {
    messages: {
      stream: (params: Record<string, unknown>, opts: { headers: Record<string, string> }) => {
        seen.params = params;
        seen.headers = opts.headers;
        return stream;
      },
    },
  } as unknown as Anthropic;
  const params = {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user" as const, content: "hola" }],
    thinking: { type: "adaptive" as const, display: "summarized" as const },
  };

  await anthropicTransport(client)(params);
  assertEquals(seen.headers, { "anthropic-beta": "thinking-binding-controls-2026-08-01" });
  assertEquals(seen.params?.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });

  await anthropicTransport(client, { mismatch: "error" })(params);
  assertEquals(
    (seen.params?.thinking as { block_binding: unknown }).block_binding,
    { prefix_mismatch_behavior: "error" },
  );

  // every tool's arguments stream as they are written, so a long call is never a silence
  const bash = { name: "bash", input_schema: { type: "object" as const } };
  await anthropicTransport(client)({ ...params, tools: [bash] });
  assertEquals(seen.params?.tools, [{ ...bash, eager_input_streaming: true }]);
});

// Offline: a local server answers as the Messages API does — the event stream of one tool
// call. Held, it sends the call's first half and then nothing more.
const TOOL_CALL = [
  {
    type: "message_start",
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "t1", name: "bash", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"command":' },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"ls"}' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

async function serving(
  held: boolean,
  run: (client: Anthropic) => Promise<void>,
): Promise<void> {
  const sse = (e: { type: string }) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const events = held ? TOOL_CALL.slice(0, 3) : TOOL_CALL;
  const server = Deno.serve({ port: 0, onListen: () => {} }, () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(events.map(sse).join("")));
        if (!held) c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    await run(
      new Anthropic({
        apiKey: "test",
        baseURL: `http://127.0.0.1:${server.addr.port}`,
        maxRetries: 0,
      }),
    );
  } finally {
    await server.shutdown();
  }
}

const REQUEST = {
  model: MODEL,
  max_tokens: 100,
  messages: [{ role: "user" as const, content: "hi" }],
};

Deno.test("a tool call's arguments reach the Stream as tool deltas, named, as they are written", async () => {
  await serving(false, async (client) => {
    const seen: Delta[] = [];
    const message = await anthropicTransport(client)(REQUEST, (d) => seen.push(d));
    assertEquals(seen, [
      { kind: "tool", name: "bash", text: '{"command":' },
      { kind: "tool", name: "bash", text: '"ls"}' },
    ]);
    // the deltas are a view: the message is still the SDK's own assembly of the call
    assertObjectMatch(message.content[0], { name: "bash", input: { command: "ls" } });
  });
});

Deno.test("anthropic, silenced: a stream gone silent mid-call fails as a dropped connection", async () => {
  await serving(true, async (client) => {
    const began = Date.now();
    const err = await assertRejects(
      () => silenced(anthropicTransport(client), 200)(REQUEST),
      Error,
      "no word from the model in 0.2s",
    );
    assert(Date.now() - began < 2_000, "the deadline cut the wait: the SDK honors the signal");
    const status = (err as { status?: number }).status;
    assertEquals(status, undefined);
    assert(retryable(status, (err as Error).message));
  });
});
