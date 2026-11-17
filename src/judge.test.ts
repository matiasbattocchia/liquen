import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { answerOf, judge, lightOf, type Seat, sliceOf } from "./judge.ts";
import type { ModelTransport } from "./mu.ts";
import type { Event } from "./types.ts";

const SEAT: Seat = { agentId: "a1", id: "mind", conversation: "mind@a1" };
const NOW = Date.parse("2026-11-17T15:00:00Z");

let n = 0;
const line = (text: string, minAgo: number, over: Partial<Event> = {}): Event =>
  ({
    id: `e${String(++n).padStart(3, "0")}`,
    ts: new Date(NOW - minAgo * 60_000).toISOString(),
    type: "message",
    envelope: {
      service: "whatsapp",
      connection_address: "549110",
      conversation: { address: "5491133", name: "Facu", kind: "direct" },
      sender: { address: "5491133", name: "Facu" },
    },
    parts: [{ type: "text", kind: "text", text }],
    ...over,
  }) as Event;

Deno.test("sliceOf: the room's lines with the news set off, who spoke on our side, and the day", () => {
  const agent = line("hasta luego", 6, {
    agent: { id: "a1", session_id: "mind" },
    payload: { turn_id: "T1" },
  } as Partial<Event>);
  const bye = line("nos hablamos", 1);
  const slice = sliceOf(
    [line("¿mañana a las 10?", 9), agent, bye],
    "5491133",
    new Set([bye.id]),
    SEAT,
    ["· 10:00 dentista"],
    "UTC",
    NOW,
  );
  assertStringIncludes(slice, "Room: Facu (direct, whatsapp)");
  assertStringIncludes(slice, "The agent spoke last on your side here, 6 min ago");
  assertStringIncludes(slice, "Today:\n· 10:00 dentista");
  assertMatch(slice, /14:54 agent: hasta luego\n— new, to judge —\n.*14:59 Facu: nos hablamos$/);
});

Deno.test("answerOf: a color and a reason, or nothing", () => {
  assertEquals(answerOf('{"reason":"se despide","color":"red"}'), {
    color: "red",
    reason: "se despide",
  });
  assertEquals(answerOf('{"reason":"x","color":"blue"}'), undefined);
  assertEquals(answerOf("not json"), undefined);
});

Deno.test("judge: one structured call, metered as a decision; a failure judges nothing", async () => {
  const asked: { params: Parameters<ModelTransport>[0]; kind?: string }[] = [];
  const answering = (text: string): ModelTransport => (params, _e, meta) => {
    asked.push({ params, kind: meta?.kind });
    return Promise.resolve({ content: [{ type: "text", text }] } as Anthropic.Message);
  };
  const j = await judge(
    answering('{"reason":"lo esperan abajo","color":"green"}'),
    { model: "claude-haiku-5-5", effort: "low" },
    "sort the news",
    "Room: …",
  );
  assertEquals(j, { color: "green", reason: "lo esperan abajo" });
  assertEquals(asked[0].kind, "decision");
  assertEquals(asked[0].params.model, "claude-haiku-5-5");
  assertEquals(asked[0].params.system, "sort the news");
  const config =
    (asked[0].params as { output_config?: { effort?: string; format?: { type: string } } })
      .output_config;
  assertEquals(config?.effort, "low");
  assertEquals(config?.format?.type, "json_schema");
  const error = console.error;
  console.error = () => {};
  try {
    const failing: ModelTransport = () => Promise.reject(new Error("overloaded"));
    assertEquals(await judge(failing, { model: "m", effort: null }, "i", "s"), undefined);
  } finally {
    console.error = error;
  }
});

Deno.test("lightOf: a light in the mind's room, covering the room up to what the judge read", () => {
  const l = lightOf(SEAT, "5491133", "e042", { color: "yellow", reason: "r" }, "m");
  assertEquals(l.type, "light");
  assertEquals(l.envelope.conversation.address, "mind@a1");
  assertEquals(l.extra?.consumed, "e042");
  assertEquals(l.payload, undefined); // no turn_id: never the agent's voice
  assertEquals(l.parts[0].data, { color: "yellow", reason: "r", model: "m", room: "5491133" });
});
