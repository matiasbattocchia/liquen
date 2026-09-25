/**
 * tick: one beat of the clock over a real store — due wakes become alarms, unanswered asks
 * lapse, and a second beat over the same rows owes nothing.
 */

import { assertEquals } from "@std/assert";
import { lapseGates, tick } from "./tick.ts";
import { openLog } from "./store/log.ts";
import type { Draft, Event, PermissionRequestEvent } from "./types.ts";

const at = (hoursAgo: number, now = Date.now()) =>
  new Date(now - hoursAgo * 3_600_000).toISOString();

const card = (ref: string, ts: string, agent = "a1"): Draft<PermissionRequestEvent> => ({
  ts,
  type: "permission_request",
  payload: { ref_id: ref as Event["id"] },
  agent: { id: agent, session_id: "mind" },
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: `mind@${agent}` },
  },
  parts: [{
    type: "data",
    kind: "permission_request",
    data: { tool: "send", call: "send(to: x)", detail: "send(to: x, text: hi)" },
  }],
});

Deno.test("a beat: the due wake is an alarm in the arming session's room, the old ask lapses, and the next beat is quiet", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const now = Date.now();
    await log.arm({
      agentId: "a1",
      sessionId: "build",
      fireAt: at(1, now),
      note: "check the build",
      conversation: "build@a1",
    });
    await log.arm({
      agentId: "a1",
      sessionId: "mind",
      fireAt: at(-1, now), // an hour from now: not this beat's
      note: "later",
      conversation: "mind@a1",
    });
    await log.publish([card("old", at(30, now)), card("fresh", at(1, now))]);
    const settings = (id: string) => id === "a1" ? { gateHours: 24 } : undefined;
    assertEquals(await tick(log, settings, now), { fired: 1, lapsed: 1, swept: 0, failed: [] });
    const alarms = await log.read({ types: ["alarm"] });
    assertEquals(alarms.length, 1);
    assertEquals(alarms[0].envelope.conversation.address, "build@a1");
    assertEquals(alarms[0].agent, undefined); // harness-authored: the relational rule wakes on it
    assertEquals(
      alarms[0].parts?.[0].type === "text" && alarms[0].parts[0].text,
      "check the build",
    );
    assertEquals((alarms[0].extra?.timer as { session_id: string }).session_id, "build");
    assertEquals((await log.gates()).map((c) => c.payload.ref_id), ["fresh"]);
    assertEquals(await tick(log, settings, now), { fired: 0, lapsed: 0, swept: 0, failed: [] });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failing pass is reported in the beat, and the passes after it still run", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const now = Date.now();
    await log.publish([card("old", at(30, now))]);
    const broken = { ...log, due: () => Promise.reject(new Error("timers table gone")) };
    const beat = await tick(broken, () => ({ gateHours: 24 }), now);
    assertEquals(beat.fired, 0);
    assertEquals(beat.lapsed, 1); // the lapse pass ran after the fire pass failed
    assertEquals(beat.failed.map((f) => f.pass), ["fire"]);
    assertEquals((beat.failed[0].error as Error).message, "timers table gone");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an ask nobody answers lapses (§9): past gateHours the harness settles it as lapsed", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    await log.publish([card("old", at(30)), card("fresh", at(1)), card("stands", at(30), "a2")]);
    const hours = (id: string) => id === "a1" ? 24 : null; // a2's asks stand until answered
    assertEquals(await lapseGates(log, hours), 1);
    assertEquals((await log.gates()).map((c) => c.payload.ref_id), ["fresh", "stands"]);
    const settled = (await log.read({ types: ["permission_response"] })).at(-1)!;
    assertEquals(settled.payload?.ref_id, "old");
    assertEquals(settled.agent, undefined); // the harness's own word (§3)
    assertEquals(settled.parts?.[0].type === "data" && settled.parts[0].data, {
      behavior: "deny",
      scope: "once",
      lapsed: true,
      reason: "unanswered for 24h",
    });
    assertEquals(await lapseGates(log, hours), 0); // settled once
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
