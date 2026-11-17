import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { aboutOf, answerOf, judge, lightOf, type Seat, sliceOf, standingOf } from "./judge.ts";
import type { ModelTransport } from "./mu.ts";
import type { Event } from "./types.ts";
import type { DocEntry, DocHeader } from "./store/docs.ts";

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

Deno.test("sliceOf: a transcript speaks as its note's author, and a note without words says its kind", () => {
  const audio = (over: Partial<Event>, external: string) =>
    line("", 3, {
      ...over,
      envelope: {
        service: "whatsapp",
        connection_address: "549110",
        conversation: { address: "5491133", name: "Gasti", kind: "direct" },
        sender: { address: "5491133", name: "Gasti" },
        external_id: external,
      },
      parts: [{
        type: "file",
        kind: "audio",
        file: { uri: "storage://media/a", mime_type: "audio/ogg" },
      }],
    } as Partial<Event>);
  const words = (external: string, text: string) =>
    line(text, 1, {
      envelope: {
        service: "whatsapp",
        connection_address: "549110",
        conversation: { address: "5491133", name: "Gasti", kind: "direct" },
      },
      payload: { action: "add", ref_external_id: external },
      parts: [{ type: "text", kind: "transcript", text }],
    } as Partial<Event>);
  const mine = audio({ agent: { id: "a1", session_id: "mind" } } as Partial<Event>, "w1");
  const theirs = audio({}, "w2");
  const slice = sliceOf(
    [mine, theirs, words("w1", "organizo el domingo"), words("w2", "dale, en lo de Lílian")],
    "5491133",
    new Set(),
    SEAT,
    [],
    "UTC",
    NOW,
  );
  assertMatch(slice, /principal: \[audio\]\n.*Gasti: \[audio\]/);
  assertStringIncludes(slice, "principal (voice note, transcribed): organizo el domingo");
  assertStringIncludes(slice, "Gasti (voice note, transcribed): dale, en lo de Lílian");
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
    undefined,
    "the principal's word",
  );
  assertEquals(j, { color: "green", reason: "lo esperan abajo" });
  assertEquals(asked[0].kind, "decision");
  assertEquals(asked[0].params.model, "claude-haiku-5-5");
  // the instruction, then the standing word, the system closing on the cache mark
  assertEquals(asked[0].params.system, [
    { type: "text", text: "sort the news" },
    { type: "text", text: "the principal's word", cache_control: { type: "ephemeral" } },
  ]);
  await judge(answering('{"reason":"r","color":"red"}'), { model: "m", effort: null }, "i", "s");
  assertEquals(asked[1].params.system, [
    { type: "text", text: "i", cache_control: { type: "ephemeral" } },
  ]);
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

/** A doc as `list` hands it over: its header, and its body when it loads. */
const doc = (
  scope: DocHeader["scope"],
  name: string,
  load: DocHeader["load"],
  body: string | undefined,
  conversations?: DocHeader["conversations"],
): DocEntry => ({
  header: {
    scope,
    kind: name === "instructions" ? "instruction" : "memory",
    name,
    load,
    handle: `${scope}/${name}`,
    ...(conversations ? { conversations } : {}),
  },
  ...(body !== undefined ? { body } : {}),
});

Deno.test("standingOf and aboutOf: the principal's word, and what the agent keeps about the room", () => {
  const carlos = doc(
    "agent",
    "profiles/carlos",
    "conditional",
    "Se quejó de que no le responden.",
    [
      { service: "whatsapp", address: "5492612339930" },
    ],
  );
  const docs = [
    doc("agent", "instructions", "always", "Lo de Leo se lo paso a dubiku."),
    doc("agent", "memories", "always", "- Lu en Córdoba."),
    doc("agent", "profiles/matias", "always", "Nada sale a las 8: nada."),
    doc("agent", "playas-serranas", "always", "Las playas de San Luis."), // says nothing of who
    doc("agent", "pagos-mensuales", "lazy", undefined),
    doc("system", "instructions/10-core", "always", "the harness's words"),
    carlos,
    doc("agent", "profiles/ana", "conditional", undefined, [
      { service: "whatsapp", address: "5492610000001" },
    ]),
  ];
  const standing = standingOf(docs);
  assertStringIncludes(standing, "[instructions]\nLo de Leo se lo paso a dubiku.");
  assertStringIncludes(standing, "[memories]\n- Lu en Córdoba.");
  assertStringIncludes(standing, "[profiles/matias]\nNada sale a las 8");
  assertEquals(standing.includes("playas"), false);
  assertEquals(standing.includes("harness"), false);
  assertEquals(standingOf([]), "");
  assertEquals(aboutOf(docs, { service: "whatsapp", address: "5492612339930" }), [carlos]);
  assertEquals(aboutOf(docs, { service: "slack", address: "5492612339930" }), []);
  // the slice carries it, ahead of the lines
  const slice = sliceOf([line("hola", 0)], "5491133", new Set(), SEAT, [], "UTC", NOW, [carlos]);
  assertStringIncludes(
    slice,
    "About this room [profiles/carlos]:\nSe quejó de que no le responden.",
  );
});

Deno.test("lightOf: a light in the mind's room, covering the room up to what the judge read", () => {
  const l = lightOf(SEAT, "5491133", "e042", { color: "yellow", reason: "r" }, "m");
  assertEquals(l.type, "light");
  assertEquals(l.envelope.conversation.address, "mind@a1");
  assertEquals(l.extra?.consumed, "e042");
  assertEquals(l.payload, undefined); // no turn_id: never the agent's voice
  assertEquals(l.parts[0].data, { color: "yellow", reason: "r", model: "m", room: "5491133" });
});
