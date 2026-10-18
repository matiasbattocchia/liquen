/**
 * gates: the open asks and the rulings still owed (§9), read off the whole log. The store's
 * SQL and xi's derivation over a list are held to the same answer, and the reason the store
 * has the read at all is shown: a card deeper than any window is as open as one asked now.
 */

import { assertEquals } from "@std/assert";
import { openCards, owedOf } from "../../xi.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "../../types.ts";
import type { Substrate } from "./mod.ts";

export function gatesSuite(s: Substrate): void {
  const ana = { id: "ana", session_id: "mind" };
  const SESSION = { id: "mind", agentId: "ana", conversation: "mind@ana" };
  const here = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: "mind@ana" },
  };
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 15, 12, 0, clock++)).toISOString();

  const use = (agent = ana): Draft<ToolUseEvent> => ({
    ts: ts(),
    type: "tool_use",
    payload: { turn_id: "t1" },
    agent,
    envelope: here,
    parts: [{
      type: "data",
      kind: "tool_use",
      data: { name: "send", input: { to: "x", text: "hi" } },
    }],
  });
  const ask = (ref: string, agent = ana): Draft<PermissionRequestEvent> => ({
    ts: ts(),
    type: "permission_request",
    payload: { ref_id: ref as Event["id"] },
    agent,
    envelope: here,
    parts: [{
      type: "data",
      kind: "permission_request",
      data: { tool: "send", call: "send(to: x)", detail: "send(to: x, text: hi)" },
    }],
  });
  const result = (ref: string, gated = false): Draft<ToolResultEvent> => ({
    ts: ts(),
    type: "tool_result",
    payload: { turn_id: "t1", ref_id: ref as Event["id"], ...(gated ? { gated: true } : {}) },
    agent: ana,
    envelope: here,
    parts: [{ type: "data", kind: "tool_result", data: { output: "pending" } }],
  });
  const rule = (ref: string, turn_id?: string): Draft<PermissionResponseEvent> => ({
    ts: ts(),
    type: "permission_response",
    payload: { ref_id: ref as Event["id"], ...(turn_id ? { turn_id } : {}) },
    envelope: here,
    parts: [{
      type: "data",
      kind: "permission_response",
      data: { behavior: "allow", scope: "once" },
    }],
  });
  const noise = (n: number): Draft<MessageEvent> => ({
    ts: ts(),
    type: "message",
    envelope: { ...here, conversation: { address: `room${n}` }, sender: { address: `p${n}` } },
    parts: [{ type: "text", kind: "text", text: `line ${n}` }],
  });

  Deno.test("gates: open is the absence of a ruling — the store and the derivation agree", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const u1 = await log.publish(use());
      const u2 = await log.publish(use());
      await log.publish([ask(u1!.id), result(u1!.id), ask(u2!.id), result(u2!.id)]);
      const ids = async () =>
        (await log.gates({ agentId: "ana", sessionId: "mind" })).map((c) => c.payload.ref_id);
      assertEquals(await ids(), [u1!.id, u2!.id]);
      assertEquals((await log.gates()).map((c) => c.payload.ref_id), [u1!.id, u2!.id]); // org-wide scan
      await log.publish(rule(u1!.id));
      assertEquals(await ids(), [u2!.id]);
      // the derivation over the whole log says the same
      assertEquals(openCards(await log.read()).map((c) => c.payload.ref_id), await ids());
      // another session's card is its own
      const u3 = await log.publish(use({ id: "ana", session_id: "build" }));
      await log.publish(ask(u3!.id, { id: "ana", session_id: "build" }));
      assertEquals(await ids(), [u2!.id]);
      assertEquals(
        (await log.gates({ agentId: "ana", sessionId: "build" })).map((c) => c.payload.ref_id),
        [u3!.id],
      );
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("gates: a card deeper than the window is still open — that is why the store reads it", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const u1 = await log.publish(use());
      await log.publish([ask(u1!.id), result(u1!.id)]);
      for (let i = 0; i < 30; i++) await log.publish(noise(i));
      const window = await log.read({ limit: 10 });
      assertEquals(openCards(window), []); // the window has never heard of it
      assertEquals(
        (await log.gates({ agentId: "ana", sessionId: "mind" })).map((c) => c.payload.ref_id),
        [
          u1!.id,
        ],
      );
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("owed: a ruling by someone else, on a use answered and not yet reported — once", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const u1 = await log.publish(use());
      await log.publish([ask(u1!.id), result(u1!.id)]);
      const owed = () => log.owed("ana", "mind");
      assertEquals(await owed(), []); // asked, not ruled
      await log.publish(rule(u1!.id));
      assertEquals((await owed()).map((o) => o.use.id), [u1!.id]);
      assertEquals((await owed())[0].verdict, { behavior: "allow", scope: "once" });
      // the derivation over the whole log says the same
      assertEquals(owedOf(await log.read(), SESSION).map((o) => o.use.id), [u1!.id]);
      // a second ruling on the same use is not stored: one errand per use, the first word
      assertEquals(await log.publish(rule(u1!.id)), null);
      assertEquals((await owed()).length, 1);
      // the gated outcome closes it
      await log.publish(result(u1!.id, true));
      assertEquals(await owed(), []);
      // the model's own withdrawal (turn-marked) is never the errand
      const u2 = await log.publish(use());
      await log.publish([ask(u2!.id), result(u2!.id), rule(u2!.id, "t1")]);
      assertEquals(await owed(), []);
      assertEquals(await log.gates({ agentId: "ana", sessionId: "mind" }), []); // and it closed the card
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("a card is settled once: the first ruling stands, a racing one is not stored", async () => {
    const store = await s.fresh();
    const one = await store.open();
    const two = await store.open(); // another process's view: the phone's answer, the lapse
    try {
      const u = await one.publish(use());
      const v = await one.publish(use());
      await one.publish([ask(u!.id), ask(v!.id)]);
      // the two answers race; whichever the store takes first is the only one kept
      const [a, b] = await Promise.all([one.publish(rule(u!.id)), two.publish(rule(u!.id))]);
      assertEquals([a, b].filter((r) => r !== null).length, 1);
      // a batch keeps the cards still open and omits the settled one
      const both = await two.publish([rule(u!.id), rule(v!.id)]);
      assertEquals(both.map((r) => r.payload?.ref_id), [v!.id]);
      assertEquals((await one.read({ types: ["permission_response"] })).length, 2);
    } finally {
      await one.close();
      await two.close();
      await store.drop();
    }
  });

  Deno.test("unended: a call answered async is owed until a final update, and only its tool's", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const late = (ref: string, flags: Record<string, true>): Draft<ToolResultEvent> => {
        const r = result(ref);
        return { ...r, payload: { ...r.payload, ...flags } };
      };
      const bash = (): Draft<ToolUseEvent> => {
        const u = use();
        return {
          ...u,
          parts: [{
            type: "data",
            kind: "tool_use",
            data: { name: "bash", input: { command: "make" } },
          }],
        };
      };
      const ended = await log.publish(bash());
      const running = await log.publish(bash());
      const told = await log.publish(bash());
      const sync = await log.publish(bash());
      const sent = await log.publish(use());
      await log.publish([
        late(ended!.id, { async: true }),
        late(running!.id, { async: true }),
        late(told!.id, { async: true }),
        result(sync!.id),
        late(sent!.id, { async: true }),
        late(ended!.id, { update: true, final: true }),
        late(told!.id, { update: true }), // a word, not the last one
      ]);
      assertEquals((await log.unended("bash")).map((u) => u.id), [running!.id, told!.id]);
      assertEquals((await log.unended("send")).map((u) => u.id), [sent!.id]);
    } finally {
      await log.close();
      await store.drop();
    }
  });
}
