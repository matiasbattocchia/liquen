import { assert, assertEquals } from "@std/assert";
import { nu, type TurnConfig } from "./nu.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { Emission } from "./mu.ts";
import { canned } from "./testing.ts";
import { SILENCE } from "./render.ts";
import type { Event, MessageEvent, ThinkingEvent, ToolUseEvent } from "./types.ts";

const CONFIG: TurnConfig = {
  agentId: "a1",
  sessionId: "s1",
  home: "home",
  model: "claude-x",
  maxTokens: 1024,
  retryDelaysMs: [0, 0],
};

const once = (emissions: Emission[], stop: Anthropic.StopReason = "end_turn") => () =>
  Promise.resolve(canned(emissions, stop));

Deno.test("nu stamps emissions: thinking→mind, assistant→home(+meta.turnId), tool_use→mind", async () => {
  const out = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    once([
      { kind: "thinking", thinking: "hm", signature: "sig" },
      { kind: "assistant", text: "hola" },
      { kind: "tool_use", name: "echo", input: { v: 1 } },
    ], "tool_use"),
  );

  assertEquals(out.at(-1)?.payload?.stop_reason, "tool_use"); // the outcome rides the last event
  const [th, msg, use] = out as [ThinkingEvent, MessageEvent, ToolUseEvent];
  assertEquals(th.type, "thinking");
  assertEquals(th.envelope.conversation.address, "mind:a1");
  assertEquals(th.agent, { id: "a1", session_id: "s1" });
  assertEquals(msg.envelope.conversation.address, "home");
  assertEquals(msg.payload?.turn_id, th.payload.turn_id); // one turn_id per step
  assertEquals(use.payload.turn_id, th.payload.turn_id);
  assertEquals(use.envelope.conversation.address, "mind:a1");
});

Deno.test("nu: persistent step failure → a single harness-authored error event", async () => {
  let calls = 0;
  const out = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    () => {
      calls++;
      return Promise.reject(new Error("overloaded"));
    },
  );
  assertEquals(calls, 3); // initial + 2 slow retries (SDK's fast retries live below this)

  assertEquals(out.length, 1);
  const [err] = out;
  assert(err.type === "error");
  assertEquals(err.parts[0].data, { error: "overloaded" });
  assertEquals(err.agent, undefined); // harness-authored (§3)
});

Deno.test("nu: refusal surfaces as an error event alongside the emissions", async () => {
  const out = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    once([{ kind: "assistant", text: "no puedo" }], "refusal"),
  );
  assertEquals(out.length, 2);
  assertEquals(out[1].type, "error");
});

Deno.test("nu renders the window it was handed (events reach mu)", async () => {
  const seen: string[] = [];
  const principal: Event = {
    id: "e1",
    ts: "2026-07-19T10:00:00Z",
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "home" },
      sender: { address: "ana", name: "Ana" },
    },
    parts: [{ type: "text", kind: "text", text: "¿todo bien?" }],
  };
  await nu(
    { events: [principal], docs: [], tools: [], config: CONFIG },
    (params) => {
      seen.push(JSON.stringify(params.messages));
      return Promise.resolve(canned([{ kind: "assistant", text: "sí" }]));
    },
  );
  assert(seen[0].includes("¿todo bien?"));
});

Deno.test("nu: the sentinel is SILENCE wherever it lands — the word governs the reply", async () => {
  const world: Event = {
    id: "01000000-0000-7000-8000-00000000000a" as Event["id"],
    ts: "2026-01-01T10:00:00.000Z",
    type: "message",
    envelope: { service: "local", connection_address: "c", conversation: { address: "g" } },
    parts: [{ type: "text", kind: "text", text: "algo" }],
  };
  const [quiet] = await nu(
    { events: [world], docs: [], tools: [], config: CONFIG },
    once([{ kind: "assistant", text: `\n${SILENCE}\n` }]), // alone, whitespace and all
  ) as [MessageEvent];
  assertEquals(quiet.extra?.silence, true);
  assertEquals(quiet.extra?.consumed, world.id); // it still carries the horizon: it IS the close

  // the word GOVERNS: a model that explains itself before saying it still said it, and the
  // explanation was addressed to nobody — it goes nowhere with the rest
  const [hedged] = await nu(
    { events: [world], docs: [], tools: [], config: CONFIG },
    once([{ kind: "assistant", text: `Nada de esto necesita respuesta.\n\n${SILENCE}` }]),
  ) as [MessageEvent];
  assertEquals(hedged.extra?.silence, true);

  const [spoken] = await nu(
    { events: [world], docs: [], tools: [], config: CONFIG },
    once([{ kind: "assistant", text: "listo, ya le contesté" }]),
  ) as [MessageEvent];
  assertEquals(spoken.extra?.silence, undefined);
});
