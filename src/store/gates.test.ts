/**
 * gates: the open asks and the rulings still owed (§9), read off the whole log. The store's
 * SQL and xi's derivation over a list are held to the same answer, and the reason the store
 * has the read at all is shown: a card deeper than any window is as open as one asked now.
 */

import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";
import { openCards, owedOf } from "../xi.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "../types.ts";

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
const result = (ref: string, deferred = false): Draft<ToolResultEvent> => ({
  ts: ts(),
  type: "tool_result",
  payload: { turn_id: "t1", ref_id: ref as Event["id"], ...(deferred ? { deferred: true } : {}) },
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
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const u1 = await log.publish(use());
    const u2 = await log.publish(use());
    await log.publish([ask(u1!.id), result(u1!.id), ask(u2!.id), result(u2!.id)]);
    const ids = () => log.gates({ agentId: "ana", sessionId: "mind" }).map((c) => c.payload.ref_id);
    assertEquals(ids(), [u1!.id, u2!.id]);
    assertEquals(log.gates().map((c) => c.payload.ref_id), [u1!.id, u2!.id]); // org-wide scan
    await log.publish(rule(u1!.id));
    assertEquals(ids(), [u2!.id]);
    // the derivation over the whole log says the same
    assertEquals(openCards(await log.read()).map((c) => c.payload.ref_id), ids());
    // another session's card is its own
    const u3 = await log.publish(use({ id: "ana", session_id: "build" }));
    await log.publish(ask(u3!.id, { id: "ana", session_id: "build" }));
    assertEquals(ids(), [u2!.id]);
    assertEquals(
      log.gates({ agentId: "ana", sessionId: "build" }).map((c) => c.payload.ref_id),
      [u3!.id],
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gates: a card deeper than the window is still open — that is why the store reads it", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const u1 = await log.publish(use());
    await log.publish([ask(u1!.id), result(u1!.id)]);
    for (let i = 0; i < 30; i++) await log.publish(noise(i));
    const window = await log.read({ limit: 10 });
    assertEquals(openCards(window), []); // the window has never heard of it
    assertEquals(log.gates({ agentId: "ana", sessionId: "mind" }).map((c) => c.payload.ref_id), [
      u1!.id,
    ]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("owed: a ruling by someone else, on a use answered and not yet reported — once", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const u1 = await log.publish(use());
    await log.publish([ask(u1!.id), result(u1!.id)]);
    const owed = () => log.owed("ana", "mind");
    assertEquals(owed(), []); // asked, not ruled
    await log.publish(rule(u1!.id));
    assertEquals(owed().map((o) => o.use.id), [u1!.id]);
    assertEquals(owed()[0].verdict, { behavior: "allow", scope: "once" });
    // the derivation over the whole log says the same
    assertEquals(owedOf(await log.read(), SESSION).map((o) => o.use.id), [u1!.id]);
    // a second ruling on the same use changes nothing: one errand per use, the first word
    await log.publish(rule(u1!.id));
    assertEquals(owed().length, 1);
    // the deferred report closes it
    await log.publish(result(u1!.id, true));
    assertEquals(owed(), []);
    // the model's own withdrawal (turn-marked) is never the errand
    const u2 = await log.publish(use());
    await log.publish([ask(u2!.id), result(u2!.id), rule(u2!.id, "t1")]);
    assertEquals(owed(), []);
    assertEquals(log.gates({ agentId: "ana", sessionId: "mind" }), []); // and it closed the card
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
