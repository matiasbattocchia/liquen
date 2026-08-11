import { assert } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, anthropicTransport } from "./transport.ts";
import { mu } from "./mu.ts";

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

Deno.test({
  name: "smoke: tool cycle replays with OUR re-minted tool_use id (+ thinking verbatim)",
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
      model: MODEL,
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
        if (e.kind === "assistant") return [{ type: "text", text: e.text }];
        return [{ type: "tool_use", id: OUR_ID, name: e.name, input: e.input }];
      },
    );
    const step2 = await mu({
      model: MODEL,
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
    }, anthropicTransport(anthropicClient()));

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
