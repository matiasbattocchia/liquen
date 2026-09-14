import { assert, assertEquals } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { googleClient, googleTransport } from "./google.ts";
import { mu } from "../mu.ts";

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
