import { assert, assertEquals, assertThrows } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { assemble, type Event, THINKING_LEVEL, toMessage, toRequest } from "./steps.ts";

const params = (
  over: Partial<Anthropic.MessageCreateParamsNonStreaming> = {},
): Anthropic.MessageCreateParamsNonStreaming => ({
  model: "gemini-3.5-flash",
  max_tokens: 512,
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

Deno.test("toRequest: system blocks join into one string, their cache marks dropped", () => {
  const r = toRequest(params({
    system: [
      { type: "text", text: "A" },
      { type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  }));
  assertEquals(r.system_instruction, "A\n\nB");
  assertEquals(r.input, [{ type: "user_input", content: [{ type: "text", text: "hi" }] }]);
});

Deno.test("toRequest: tools, output cap and effort take the wire's names", () => {
  const r = toRequest(params({
    tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
    output_config: { effort: "low" },
  }));
  assertEquals(r.tools, [{
    type: "function",
    name: "t",
    description: "d",
    parameters: { type: "object", properties: {} },
  }]);
  assertEquals(r.generation_config, {
    max_output_tokens: 512,
    thinking_summaries: "auto",
    thinking_level: "low",
  });
  // no effort ⇒ no level: the model decides, on either wire
  assertEquals("thinking_level" in toRequest(params()).generation_config, false);
  // the catalog's five depths collapse onto the wire's top from `high` up
  assertEquals(THINKING_LEVEL.xhigh, "high");
  assertEquals(THINKING_LEVEL.max, "high");
});

Deno.test("toRequest: an assistant message explodes into one step per block, ids and signatures kept", () => {
  const r = toRequest(params({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "thinking", thinking: "a summary", signature: "sig2" },
        { type: "text", text: "on it" },
        { type: "tool_use", id: "call_7", name: "bash", input: { cmd: "ls" } },
        { type: "redacted_thinking", data: "opaque" },
      ],
    }],
  }));
  assertEquals(r.input, [
    { type: "thought", signature: "sig" },
    { type: "thought", signature: "sig2", summary: [{ type: "text", text: "a summary" }] },
    { type: "model_output", content: [{ type: "text", text: "on it" }] },
    { type: "function_call", id: "call_7", name: "bash", arguments: { cmd: "ls" } },
  ]);
});

Deno.test("toRequest: a user message folds runs of blocks into one user_input, each tool_result its own step", () => {
  const r = toRequest(params({
    messages: [{
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "bash", input: {} },
        { type: "tool_use", id: "call_2", name: "aread", input: {} },
      ],
    }, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
        {
          type: "tool_result",
          tool_use_id: "call_2",
          is_error: true,
          content: [
            { type: "text", text: "boom" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
        { type: "text", text: "<conv>…</conv>" },
        { type: "image", source: { type: "url", url: "https://x/y.png" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "CC" } },
        { type: "mid_conv_system", content: [{ type: "text", text: "now: 12:00" }] },
        { type: "tool_result", tool_use_id: "call_3", content: [] },
        { type: "text", text: "after" },
      ],
    }],
  }));
  // a result names the tool it answers — read off its call, which the API requires
  assertEquals(r.input.slice(2), [
    { type: "function_result", call_id: "call_1", name: "bash", result: "ok" },
    {
      type: "function_result",
      call_id: "call_2",
      name: "aread",
      is_error: true,
      result: [
        { type: "text", text: "boom" },
        { type: "image", data: "AAAA", mime_type: "image/png" },
      ],
    },
    {
      type: "user_input",
      content: [
        { type: "text", text: "<conv>…</conv>" },
        { type: "text", text: '<image src="https://x/y.png"/>' },
        { type: "image", data: "BBBB", mime_type: "image/jpeg" },
        { type: "document", data: "CC", mime_type: "application/pdf" },
        { type: "text", text: "now: 12:00" },
      ],
    },
    { type: "function_result", call_id: "call_3", result: [] },
    { type: "user_input", content: [{ type: "text", text: "after" }] },
  ]);
});

/** The stream of a tool-calling turn, as the wire sends it: signature-only thought, two
 *  calls to the same tool with arguments streamed as JSON fragments, then the completion
 *  with usage and no steps. */
const TOOL_TURN: Event[] = [
  { event_type: "interaction.created", interaction: { id: "", status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "SIG" } },
  { event_type: "step.stop", index: 0 },
  {
    event_type: "step.start",
    index: 1,
    step: { type: "function_call", id: "call_1", name: "get_time", arguments: {} },
  },
  { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '{"city":' } },
  { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '"Paris"}' } },
  { event_type: "step.stop", index: 1 },
  {
    event_type: "step.start",
    index: 2,
    step: { type: "function_call", id: "call_2", name: "get_time", arguments: { city: "Tokyo" } },
  },
  { event_type: "step.stop", index: 2 },
  {
    event_type: "interaction.completed",
    interaction: {
      id: "",
      status: "requires_action",
      usage: {
        total_input_tokens: 100,
        total_cached_tokens: 60,
        total_output_tokens: 10,
        total_thought_tokens: 30,
        total_tokens: 140,
      },
    },
  },
] as Event[];

const fold = (events: Event[]) => {
  const a = assemble();
  for (const ev of events) a.take(ev);
  return a;
};

Deno.test("assemble → toMessage: steps rebuilt from the stream, ids and signature on the blocks", () => {
  const m = toMessage("gemini-3.5-flash", fold(TOOL_TURN));
  assertEquals(m.stop_reason, "tool_use");
  assertEquals(m.content as unknown, [
    { type: "thinking", thinking: "", signature: "SIG" },
    { type: "tool_use", id: "call_1", name: "get_time", input: { city: "Paris" } },
    { type: "tool_use", id: "call_2", name: "get_time", input: { city: "Tokyo" } },
  ]);
  // input leaves the cached prefix OUT, output takes the thought tokens IN — the Messages
  // shape's conventions, so the usage table compares across providers
  assertEquals(m.usage.input_tokens, 40);
  assertEquals(m.usage.output_tokens, 40);
  assertEquals(m.usage.cache_read_input_tokens, 60);
  assertEquals(m.usage.cache_creation_input_tokens, null);
});

Deno.test("assemble → toMessage: text and summaries accumulate; statuses map to stops", () => {
  const text: Event[] = [
    { event_type: "step.start", index: 0, step: { type: "thought" } },
    { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "S" } },
    {
      event_type: "step.delta",
      index: 0,
      delta: { type: "thought_summary", content: { type: "text", text: "thinking…" } },
    },
    { event_type: "step.start", index: 1, step: { type: "model_output" } },
    { event_type: "step.delta", index: 1, delta: { type: "text", text: "po" } },
    { event_type: "step.delta", index: 1, delta: { type: "text", text: "ng" } },
    { event_type: "interaction.completed", interaction: { id: "", status: "completed" } },
  ] as Event[];
  const m = toMessage("m", fold(text));
  assertEquals(m.stop_reason, "end_turn");
  assertEquals(m.content, [
    { type: "thinking", thinking: "thinking…", signature: "S" },
    { type: "text", text: "pong", citations: null }, // one utterance, however it streamed
  ]);
  const ended = (status: string) =>
    toMessage(
      "m",
      fold([{
        event_type: "interaction.completed",
        interaction: { id: "", status },
      }] as Event[]),
    ).stop_reason;
  assertEquals(ended("incomplete"), "max_tokens");
  assertEquals(ended("budget_exceeded"), "max_tokens");
});

Deno.test("toMessage: what did not finish throws with the status nu classifies on", () => {
  const status = (fn: () => unknown): number | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as { status?: number }).status;
    }
  };
  const done = (s: string) =>
    [{ event_type: "interaction.completed", interaction: { id: "", status: s } }] as Event[];
  assertEquals(status(() => toMessage("m", fold(done("failed")))), 500);
  assertEquals(status(() => toMessage("m", fold(done("cancelled")))), 400);
  assertEquals(status(() => toMessage("m", fold([]))), 400); // the stream ended early
  // a streamed error: weather codes map to their HTTP twins, anything else is the request's
  const errored = (code?: string) =>
    fold([{ event_type: "error", error: { code, message: "m" } }] as Event[]);
  assertEquals(status(() => toMessage("m", errored("gateway_timeout"))), 504);
  assertEquals(status(() => toMessage("m", errored("too_many_requests"))), 429);
  assertEquals(status(() => toMessage("m", errored("invalid_argument"))), 400);
  assertEquals(status(() => toMessage("m", errored())), 400);
  assertThrows(() => toMessage("m", errored("internal")), Error, "m");
  assert(true);
});
