import { assert, assertEquals } from "@std/assert";
import { nu, type TurnConfig } from "./nu.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { Emission } from "./mu.ts";
import { canned } from "./testing.ts";
import { SILENCE } from "./render.ts";
import type { Event, MessageEvent, ThinkingEvent, ToolUseEvent } from "./types.ts";

const CONFIG: TurnConfig = {
  agentId: "a1",
  sessionId: "mind",
  model: "claude-x",
  maxTokens: 1024,
  retryDelaysMs: [0, 0],
};

const once = (emissions: Emission[], stop: Anthropic.StopReason = "end_turn") => () =>
  Promise.resolve(canned(emissions, stop));

Deno.test("nu stamps emissions: one session, one place — all of them carry the turn", async () => {
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
  assertEquals(th.envelope.conversation.address, "mind@a1");
  assertEquals(th.agent, { id: "a1", session_id: "mind" });
  assertEquals(msg.envelope.conversation.address, "mind@a1");
  assertEquals(msg.payload?.turn_id, th.payload.turn_id); // one turn_id per step
  assertEquals(use.payload.turn_id, th.payload.turn_id);
  assertEquals(use.envelope.conversation.address, "mind@a1");
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
      conversation: { address: "mind@a1" },
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

/* ── failure classes, silence, cuts, checkpoints ─────────────────────────── */

const WORLD: Event = {
  id: "01000000-0000-7000-8000-00000000000b" as Event["id"],
  ts: "2026-01-01T10:00:00.000Z",
  type: "message",
  envelope: { service: "local", connection_address: "c", conversation: { address: "g" } },
  parts: [{ type: "text", kind: "text", text: "algo" }],
};

const failing = (status?: number) => {
  let calls = 0;
  return {
    transport: () => {
      calls++;
      return Promise.reject(Object.assign(new Error("model said no"), status ? { status } : {}));
    },
    calls: () => calls,
  };
};

Deno.test("nu: a deterministic failure is not retried — one call, one error", async () => {
  for (const status of [400, 401, 403, 404]) {
    const f = failing(status);
    const out = await nu({ events: [], docs: [], tools: [], config: CONFIG }, f.transport);
    assertEquals(f.calls(), 1, `status ${status}`);
    assertEquals(out.length, 1);
    assert(out[0].type === "error");
  }
});

Deno.test("nu: weather is retried — 429, 5xx and a connection failure get the slow retries", async () => {
  for (const status of [408, 429, 500, 529, undefined]) {
    const f = failing(status);
    await nu({ events: [], docs: [], tools: [], config: CONFIG }, f.transport);
    assertEquals(f.calls(), 3, `status ${status}`);
  }
});

Deno.test("nu: a whitespace-only reply says nothing — silence, and it still closes", async () => {
  const [quiet] = await nu(
    { events: [WORLD], docs: [], tools: [], config: CONFIG },
    once([{ kind: "assistant", text: "  \n\n\t" }]),
  ) as [MessageEvent];
  assertEquals(quiet.type, "message");
  assertEquals(quiet.extra?.silence, true);
  assertEquals(quiet.extra?.consumed, WORLD.id);
});

Deno.test("nu: a step with no content still closes the turn — a silent message carries the horizon", async () => {
  const out = await nu({ events: [WORLD], docs: [], tools: [], config: CONFIG }, once([]));
  assertEquals(out.length, 1);
  const [quiet] = out as [MessageEvent];
  assertEquals(quiet.type, "message");
  assertEquals(quiet.extra?.silence, true);
  assertEquals(quiet.extra?.consumed, WORLD.id);
  assertEquals(quiet.payload?.stop_reason, "end_turn");
});

Deno.test("nu: a max_tokens cut inside a tool_use drops the half-written call — the continuation re-issues it", async () => {
  const out = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    once([
      { kind: "assistant", text: "voy a limpiar" },
      { kind: "tool_use", name: "bash", input: { command: "rm -rf /tm" } },
    ], "max_tokens"),
  );
  assertEquals(out.some((e) => e.type === "tool_use"), false);
  assertEquals(out.at(-1)?.type, "error"); // the advisory
  assertEquals(out.at(-1)?.payload?.stop_reason, "max_tokens"); // and the continuation

  // a tool_use that closed BEFORE the cut is whole, and stays
  const whole = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    once([
      { kind: "tool_use", name: "bash", input: { command: "ls" } },
      { kind: "assistant", text: "y después" },
    ], "max_tokens"),
  );
  assertEquals(whole.filter((e) => e.type === "tool_use").length, 1);
});

Deno.test("nu stamps a redacted thinking block as a thinking event — replayed as it came", async () => {
  const out = await nu(
    { events: [], docs: [], tools: [], config: CONFIG },
    once([{ kind: "redacted_thinking", data: "EmUCAQ" }, { kind: "assistant", text: "ok" }]),
  );
  const [th] = out as [ThinkingEvent];
  assertEquals(th.type, "thinking");
  assertEquals(th.parts[0].data, { data: "EmUCAQ" });
});

/** A closed exchange in the mind's own room — the shape a checkpoint covers. */
function exchange(i: number): Event[] {
  const here = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: "mind@a1" },
  };
  return [
    {
      id: `01000000-0000-7000-8000-${String(i * 2).padStart(12, "0")}`,
      ts: "2026-01-01T10:00:00.000Z",
      type: "message",
      envelope: { ...here, sender: { address: "ana", name: "Ana" } },
      parts: [{ type: "text", kind: "text", text: `pregunta ${i}` }],
    },
    {
      id: `01000000-0000-7000-8000-${String(i * 2 + 1).padStart(12, "0")}`,
      ts: "2026-01-01T10:00:01.000Z",
      type: "message",
      agent: { id: "a1", session_id: "mind" },
      payload: { turn_id: `T${i}` },
      envelope: here,
      parts: [{ type: "text", kind: "text", text: `respuesta ${i}` }],
    },
  ];
}

Deno.test("nu: a checkpoint cut at max_tokens is an error, not a record — and no second call", async () => {
  const events = Array.from({ length: 6 }, (_, i) => exchange(i)).flat();
  let calls = 0;
  const out = await nu(
    { events, docs: [], tools: [], config: { ...CONFIG, compactAt: 1, keepRecent: 0 } },
    () => {
      calls++;
      return Promise.resolve(
        canned([{ kind: "assistant", text: "## Ongoing threads\n- cut" }], "max_tokens"),
      );
    },
  );
  assertEquals(calls, 1); // the checkpoint WAS the turn — its failure is not followed by a think
  assertEquals(out.length, 1);
  assert(out[0].type === "error");
  assertEquals(out[0].agent, undefined); // harness-authored, unstamped ⇒ terminal
});

Deno.test("nu: an empty checkpoint is an error too — not a full re-run on every wake", async () => {
  const events = Array.from({ length: 6 }, (_, i) => exchange(i)).flat();
  let calls = 0;
  const out = await nu(
    { events, docs: [], tools: [], config: { ...CONFIG, compactAt: 1, keepRecent: 0 } },
    () => {
      calls++;
      return Promise.resolve(canned([{ kind: "assistant", text: "  \n" }]));
    },
  );
  assertEquals(calls, 1);
  assertEquals(out.length, 1);
  assert(out[0].type === "error");
});
