import { assert, assertEquals } from "@std/assert";
import { createPresence, PRESENCE_TEXT, type PresenceDeps } from "./presence.ts";
import { ephemeral, silenced } from "../render.ts";
import type { AliasRow } from "../store/connections.ts";
import type { About, Draft, Event, MessageEvent } from "../types.ts";

const NOW = Date.parse("2026-09-11T12:00:00Z");
const AGENT = "a1";
const OWN = "5491100000000";
const SELF_CHAT = "5491100000000"; // the WA self-chat: the mirror's surface

const binding = (over: Partial<AliasRow> = {}): AliasRow => ({
  service: "whatsapp",
  connection: OWN,
  conversation: SELF_CHAT,
  agentId: AGENT,
  principal: "matias",
  live: true,
  ...over,
});

/** Presence with the log captured: what it would have written, in order. */
function watching(over: Partial<PresenceDeps> = {}) {
  const wrote: Draft<MessageEvent>[] = [];
  const on = createPresence({
    aliases: () => [binding()],
    now: () => NOW,
    publish: (drafts) => {
      wrote.push(...drafts);
      return Promise.resolve(drafts);
    },
    ...over,
  });
  const said = () =>
    wrote.map((d) => ({
      text: (d.parts[0] as { text: string }).text,
      to: d.envelope.conversation.address,
    }));
  return { on, wrote, said };
}

const spokeAt = (ms: number, service = "whatsapp"): About => ({
  service,
  connection: OWN,
  conversation: "5492614694650",
  since: new Date(NOW - ms).toISOString(),
});

Deno.test("presence: a thinking delta says so, once, on the mirror's surface", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(5_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), [{ text: PRESENCE_TEXT.thinking, to: SELF_CHAT }]);
});

Deno.test("presence: the row is the agent's leg, flagged as transport", async () => {
  const { on, wrote } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  const row = wrote[0];
  assertEquals(row.agent, { id: AGENT, session_id: "mind" });
  assertEquals(row.envelope.service, "whatsapp");
  assertEquals(row.envelope.connection_address, OWN);
  assertEquals(row.extra, { delta: true });
  // …and the flag is the whole contract: the mind never reads it back
  assert(ephemeral(row as Event));
  assert(silenced(row as Event));
});

Deno.test("presence: both states reach the surface, each once", async () => {
  const { on, said } = watching();
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  on.delta(AGENT, "mind", { kind: "thinking" });
  on.delta(AGENT, "mind", { kind: "checkpoint" });
  await Promise.resolve();
  assertEquals(said().map((s) => s.text), [PRESENCE_TEXT.checkpoint, PRESENCE_TEXT.thinking]);
});

Deno.test("presence: every live surface of that agent hears it, and nobody else's", async () => {
  const { on, said } = watching({
    aliases: () => [
      binding(),
      binding({ conversation: "C123", service: "slack" }), // another wire, same mind
      binding({ conversation: "dead", live: false }), // revoked: nobody is reading
      binding({ conversation: "otro", agentId: "a2" }), // another agent's mind
    ],
  });
  on.status(AGENT, "mind", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "mind", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said().map((s) => s.to), [SELF_CHAT, "C123"]);
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
  assertEquals(said().length, 1);
});

Deno.test("presence: a named session is mirrored nowhere, so it says nothing", async () => {
  const { on, said } = watching();
  on.status(AGENT, "build", "busy", [spokeAt(1_000)]);
  on.delta(AGENT, "build", { kind: "thinking" });
  await Promise.resolve();
  assertEquals(said(), []);
});

Deno.test("presence: the words themselves are not mirrored", async () => {
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

Deno.test("presence: no surface bound — it writes nothing at all", async () => {
  const { on, said } = watching({ aliases: () => [] });
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
