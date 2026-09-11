import { assertEquals } from "@std/assert";
import { createPresence, type PresenceDeps } from "./presence.ts";
import type { AliasRow } from "../store/connections.ts";
import type { About, DeltaEvent, Draft } from "../types.ts";

const NOW = Date.parse("2026-09-11T12:00:00Z");
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
function watching(over: Partial<PresenceDeps> = {}) {
  const wrote: Draft<DeltaEvent>[] = [];
  const on = createPresence({
    aliases: () => [binding()],
    now: () => NOW,
    publish: (draft) => {
      wrote.push(draft);
      return Promise.resolve(draft);
    },
    ...over,
  });
  const said = () => wrote.map((d) => d.parts[0].data.kind);
  return { on, wrote, said };
}

const spokeAt = (ms: number, service = "whatsapp"): About => ({
  service,
  connection: OWN,
  conversation: "5492614694650",
  since: new Date(NOW - ms).toISOString(),
});

Deno.test("presence: a thinking delta is one fact in the mind's room, once", async () => {
  const { on, wrote, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(5_000)]);
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

Deno.test("presence: both kinds are said, each once", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), ["checkpoint", "thinking"]);
});

Deno.test("presence: nobody is waiting — a stale turn says nothing", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(10 * 60_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: a turn with no news at all — the tick's wake — says nothing", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", []);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: the mind is one — fresh news on another wire still counts", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(10 * 60_000), spokeAt(2_000, "slack")]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), ["thinking"]);
});

Deno.test("presence: a named session is mirrored nowhere, so it says nothing", async () => {
  const { on, said } = watching();
  on.status(AGENT, "build", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "build", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: the words themselves are not presence", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "text", text: "hola" });
  on.delta(AGENT, "mind", { kind: "error", text: "boom" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: a re-announced turn does not repeat itself; the next turn may", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]); // main discloses again mid-turn
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said().length, 1);

  on.status(AGENT, "mind", "idle", []);
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
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
  const { on, said } = watching({
    aliases: () => [
      binding({ live: false }), // revoked: nobody is reading
      binding({ agentId: "a2" }), // another agent's mind
    ],
  });
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: a write that fails is a line nobody needed", async () => {
  const errors: unknown[] = [];
  const { on } = watching({
    publish: () => Promise.reject(new Error("log closed")),
    onError: (err) => errors.push(err),
  });
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(errors.length, 1);
});
