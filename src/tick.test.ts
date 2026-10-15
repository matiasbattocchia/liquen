/**
 * tick: one beat of the clock over a real store — due wakes become alarms, unanswered asks
 * lapse, and a second beat over the same rows owes nothing.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { lapseGates, tick } from "./tick.ts";
import { openLog } from "./store/log.ts";
import { RETRY_BACKOFF_MS } from "./store/sweep.ts";
import type { Draft, Event, MessageEvent, PermissionRequestEvent } from "./types.ts";

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
    assertEquals(await tick(log, settings, now), {
      fired: 1,
      lapsed: 1,
      swept: 0,
      reported: 0,
      failed: [],
    });
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
    assertEquals(await tick(log, settings, now), {
      fired: 0,
      lapsed: 0,
      swept: 0,
      reported: 0,
      failed: [],
    });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

/** A message the model sent (a turn's), or a mirror's copy (no turn), to a bot. */
const sent = (text: string, turn?: string): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  agent: { id: "a1", session_id: "mind" },
  ...(turn ? { payload: { turn_id: turn } } : {}),
  envelope: {
    service: "whatsapp",
    connection_address: "5491100000000",
    conversation: { address: "5491144117777", name: "Banco Hipotecario SA" },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("a send that failed for good is reported to the session that sent it, once", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const now = Date.now();
    await log.upsertConnections([{ service: "whatsapp", address: "5491100000000", agentId: "a1" }]);
    const [refused, retrying, exhausted, copy] = await log.publish([
      sent("¡Sigamos!", "t1"),
      sent("hola", "t2"),
      sent("¿seguís ahí?", "t3"),
      sent("[agent] listo"),
    ]);
    const failed = (code: number | null, attempts = 0) => ({
      status: {
        state: "failed",
        failed_at: at(48, now),
        error: "Error: bridge /dispatch HTTP 422: server returned error 479",
        error_code: code,
        ...(attempts ? { attempts } : {}),
      },
    });
    await log.setDelivery(refused.id, failed(422));
    await log.setDelivery(retrying.id, failed(503)); // the ladder offers it again
    await log.setDelivery(exhausted.id, failed(503, RETRY_BACKOFF_MS.length));
    await log.setDelivery(copy.id, failed(422)); // nobody's turn to tell
    const beat = await tick(log, () => undefined, now);
    assertEquals(beat.reported, 2);
    const reports = await log.read({ types: ["alarm"] });
    assertEquals(reports.map((r) => r.payload?.ref_id), [refused.id, exhausted.id]);
    assertEquals(reports[0].envelope.conversation.address, "mind@a1");
    assertEquals(reports[0].agent, undefined); // harness-authored: it wakes the session
    assertEquals((reports[0].extra?.report as { kind: string }).kind, "undelivered");
    assertStringIncludes(
      reports[0].parts?.[0].type === "text" ? reports[0].parts[0].text : "",
      '"¡Sigamos!" to Banco Hipotecario SA (5491144117777) was not delivered: ' +
        "bridge /dispatch HTTP 422: server returned error 479",
    );
    assertStringIncludes(
      reports[1].parts?.[0].type === "text" ? reports[1].parts[0].text : "",
      `still failing after ${RETRY_BACKOFF_MS.length} retries`,
    );
    assertEquals((await tick(log, () => undefined, now)).reported, 0); // told once
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
