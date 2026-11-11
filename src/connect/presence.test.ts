import { assertEquals } from "@std/assert";
import { createPresence, type PresenceDeps } from "./presence.ts";
import type { AliasRow } from "../store/connections.ts";
import type { DeltaEvent, Draft, PresenceLevel } from "../types.ts";

const AGENT = "a1";
const OWN = "5491100000000";

const binding = (over: Partial<AliasRow> = {}): AliasRow => ({
  service: "whatsapp",
  connection: OWN,
  conversation: OWN, // the WA self-chat: the mirror's surface
  agentId: AGENT,
  principal: "matias",
  live: true,
  ...over,
});

/** Presence with the log captured: the facts it would have written, in order. */
function watching(level: PresenceLevel = "waiting", over: Partial<PresenceDeps> = {}) {
  const wrote: Draft<DeltaEvent>[] = [];
  const on = createPresence({
    aliases: () => Promise.resolve([binding()]),
    level: () => level,
    publish: (draft) => {
      wrote.push(draft);
      return Promise.resolve(draft);
    },
    ...over,
  });
  const said = () => wrote.map((d) => d.parts[0].data.kind);
  return { on, wrote, said };
}

Deno.test("presence: a thinking delta is one fact in the mind's room, once", async () => {
  const { on, wrote, said } = watching();
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), ["thinking"]);
  // the fact, and nothing but: harness-authored, the mind's own, in the mind's room —
  // where it goes from here is the mirror's business
  const fact = wrote[0];
  assertEquals(fact.type, "delta");
  assertEquals(fact.agent, { id: AGENT, session_id: "mind" });
  assertEquals(fact.envelope.service, "local");
  assertEquals(fact.envelope.conversation.address, "mind@a1");
  assertEquals(fact.parts, [{ type: "data", kind: "delta", data: { kind: "thinking" } }]);
});

Deno.test("presence: waiting says each kind of work as it starts, each once, and leaves the calls to the mirror", async () => {
  const { on, said } = watching("waiting");
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "tool", name: "bash", text: '{"comm' });
  on.delta(AGENT, "mind", { kind: "tool", name: "bash", text: 'and":' });
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), ["checkpoint", "thinking"]);
});

Deno.test("presence: tools leaves the work to the calls, which cross by name", async () => {
  const { on, said } = watching("tools");
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "tool", name: "bash", text: "{}" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), ["thinking", "checkpoint"]);
});

Deno.test("presence: off says nothing", async () => {
  const { on, said } = watching("off");
  on.status(AGENT, "mind", "busy", "asked");
  for (const kind of ["thinking", "checkpoint", "tool"] as const) on.delta(AGENT, "mind", { kind });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: the level is read at each delta, so a changed one is heard at once", async () => {
  let level: PresenceLevel = "off";
  const { on, said } = watching("off", { level: () => level });
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  level = "waiting";
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), ["checkpoint"]);
});

Deno.test("presence: a named session is mirrored nowhere, so it says nothing", async () => {
  const { on, said } = watching();
  on.status(AGENT, "build", "busy", "asked");
  on.delta(AGENT, "build", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: the words themselves are not presence", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "text", text: "hola" });
  on.delta(AGENT, "mind", { kind: "error", text: "boom" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: a re-announced turn does not repeat itself; the next turn may", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.status(AGENT, "mind", "busy", "asked"); // main discloses again mid-turn
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said().length, 1);

  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said().length, 2);
});

Deno.test("presence: deltas outside any open turn are dropped", async () => {
  const { on, said } = watching();
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: no live surface of this agent's — it writes nothing at all", async () => {
  const { on, said } = watching("waiting", {
    aliases: () =>
      Promise.resolve([
        binding({ live: false }), // revoked: nobody is reading
        binding({ agentId: "a2" }), // another agent's mind
      ]),
  });
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: a write that fails is a line nobody needed", async () => {
  const errors: unknown[] = [];
  const { on } = watching("waiting", {
    publish: () => Promise.reject(new Error("log closed")),
    onError: (err) => errors.push(err),
  });
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(errors.length, 1);
});

Deno.test("presence: work the world woke says nothing; work somebody asked for does", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", "world"); // a stranger's line in some group
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy", "asked"); // the principal's word, or a reminder due
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), ["thinking"]);
});

Deno.test("presence: the tail of a stretch keeps its cause, however long the turn before it ran", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", "asked");
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy"); // the unload, minutes later: no cause of its own
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy"); // the checkpoint after it
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), ["thinking", "thinking", "checkpoint"]);
  assertEquals(on.asked(AGENT), true);

  // a stretch the world woke keeps its silence through its own tail
  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy", "world");
  on.status(AGENT, "mind", "idle");
  on.status(AGENT, "mind", "busy");
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said().length, 3);
  assertEquals(on.asked(AGENT), false);
});

Deno.test("presence: the principal's word mid-stretch makes it theirs, and says what is running", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", "world");
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), []);
  on.heard(AGENT); // they write while it compacts
  await Promise.resolve();
  assertEquals(said(), ["checkpoint"]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), ["checkpoint", "thinking"]);
});

Deno.test("presence: a word while idle says nothing until there is work to name", async () => {
  const { on, said } = watching();
  on.heard(AGENT);
  await Promise.resolve();
  assertEquals(said(), []);
  on.status(AGENT, "mind", "busy");
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), ["thinking"]);
});
