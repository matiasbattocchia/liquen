import { assert, assertEquals } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { type ModelTransport, mu } from "./mu.ts";

/** A fake model message with the given content + usage. Cast past the SDK's many required
 *  response fields — these fixtures only need what mu actually reads. */
function message(content: Array<Record<string, unknown>>, stop: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}

/** A transport that returns a canned message and records the params it was handed. */
function fakeTransport(
  msg: Anthropic.Message,
): { transport: ModelTransport; seen: () => Anthropic.MessageCreateParamsNonStreaming } {
  let captured: Anthropic.MessageCreateParamsNonStreaming;
  return {
    transport: (params) => {
      captured = params;
      return Promise.resolve(msg);
    },
    seen: () => captured,
  };
}

const baseInput = {
  system: [{ type: "text" as const, text: "you are Ana's alter-ego" }],
  messages: [{ role: "user" as const, content: "hola" }],
  model: "claude-x",
  maxTokens: 8192,
  tools: [{
    name: "send",
    description: "dispatch to a peer",
    input_schema: { type: "object" as const },
  }],
};

Deno.test("parses thinking · assistant · tool_use into emissions, in order", async () => {
  const { transport } = fakeTransport(message([
    { type: "thinking", thinking: "she wants a reply", signature: "sig" },
    { type: "text", text: "Le escribo a Mariana.", citations: null },
    { type: "tool_use", id: "toolu_x", name: "send", input: { text: "hola" } },
  ], "tool_use"));

  const res = await mu(baseInput, transport);
  assert(res.ok);
  assertEquals(res.emissions, [
    { kind: "thinking", thinking: "she wants a reply", signature: "sig" },
    { kind: "assistant", text: "Le escribo a Mariana." },
    { kind: "tool_use", name: "send", input: { text: "hola" } },
  ]);
  assertEquals(res.stop, "tool_use");
});

Deno.test("maps usage (incl. cache) for telemetry; drops the API tool_use id (nu re-mints)", async () => {
  const { transport } = fakeTransport(message([
    { type: "tool_use", id: "toolu_DISCARDED", name: "search", input: { q: "x" } },
  ], "tool_use"));

  const res = await mu(baseInput, transport);
  assert(res.ok);
  assertEquals(res.usage, { input_tokens: 120, output_tokens: 45, cache_read_tokens: 100 });
  assertEquals(res.emissions[0], { kind: "tool_use", name: "search", input: { q: "x" } });
});

Deno.test("builds the request: nu's maxTokens; adaptive thinking; effort sets output_config", async () => {
  const fake = fakeTransport(message([{ type: "text", text: "ok", citations: null }], "end_turn"));
  await mu(baseInput, fake.transport);
  let p = fake.seen();
  assertEquals(p.max_tokens, 8192); // exactly what nu passed — mu has no default
  assertEquals(p.tools?.length, 1);
  assertEquals(p.thinking, { type: "adaptive" });
  assertEquals("output_config" in p, false); // no effort ⇒ model default

  const fake2 = fakeTransport(message([{ type: "text", text: "ok", citations: null }], "end_turn"));
  await mu({ ...baseInput, effort: "high" }, fake2.transport);
  p = fake2.seen();
  assertEquals(p.output_config, { effort: "high" });
  assertEquals(p.thinking, { type: "adaptive" });
});

Deno.test("an empty system (no docs) is omitted from the request", async () => {
  const fake = fakeTransport(message([{ type: "text", text: "ok", citations: null }], "end_turn"));
  await mu({ ...baseInput, system: [] }, fake.transport);
  assertEquals("system" in fake.seen(), false);
});

Deno.test("a transport failure becomes { ok: false, error } — nu owns retry", async () => {
  const boom: ModelTransport = () => Promise.reject(new Error("overloaded"));
  const res = await mu(baseInput, boom);
  assertEquals(res, { ok: false, error: "overloaded" });
});

Deno.test("emit is threaded through to the transport (deltas are the transport's job)", async () => {
  const seen: string[] = [];
  const transport: ModelTransport = (_params, emit) => {
    emit?.({ kind: "text", text: "streaming…" });
    return Promise.resolve(message([{ type: "text", text: "done", citations: null }], "end_turn"));
  };
  await mu(baseInput, transport, (d) => seen.push(d.text ?? ""));
  assertEquals(seen, ["streaming…"]);
});
