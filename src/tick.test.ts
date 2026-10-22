/**
 * tick: one beat of the clock over a real store — due wakes become alarms, unanswered asks
 * lapse, and a second beat over the same rows owes nothing.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { lapseGates, tick } from "./tick.ts";
import { openLog } from "./store/log.ts";
import { RETRY_BACKOFF_MS } from "./store/sweep.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionRequestEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import { outcomeLine, shortId } from "./render.ts";

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

/** The send call a turn made. */
const call = (text: string, turn: string): Draft<ToolUseEvent> => ({
  ts: new Date().toISOString(),
  type: "tool_use",
  agent: { id: "a1", session_id: "mind" },
  payload: { turn_id: turn },
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind@a1" } },
  parts: [{
    type: "data",
    kind: "tool_use",
    data: { name: "send", input: { to: "5491144117777", text } },
  }],
});

/** A message the model sent (a turn's, by its send call), or a mirror's copy (no turn), to
 *  a bot. */
const sent = (text: string, turn?: string, use?: Event["id"]): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  agent: { id: "a1", session_id: "mind" },
  ...(turn ? { payload: { turn_id: turn, ...(use ? { ref_id: use } : {}) } } : {}),
  envelope: {
    service: "whatsapp",
    connection_address: "5491100000000",
    conversation: { address: "5491144117777", name: "Banco Hipotecario SA" },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("a send that failed for good is told against the call that sent it, once", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const now = Date.now();
    await log.upsertConnections([{ service: "whatsapp", address: "5491100000000", agentId: "a1" }]);
    const uses = await log.publish([
      call("¡Sigamos!", "t1"),
      call("hola", "t2"),
      call("¿seguís ahí?", "t3"),
    ]);
    const [refused, retrying, exhausted, copy] = await log.publish([
      sent("¡Sigamos!", "t1", uses[0].id),
      sent("hola", "t2", uses[1].id),
      sent("¿seguís ahí?", "t3", uses[2].id),
      sent("[agent] listo"),
    ]);
    const failed = (code: number | null, attempts = 0) => ({
      status: {
        state: "failed",
        failed_at: at(48, now),
        error: "Error: server returned error 479",
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
    const updates = (await log.read({ types: ["tool_result"] })) as ToolResultEvent[];
    assertEquals(updates.map((r) => r.payload.ref_id), [uses[0].id, uses[2].id]);
    assertEquals(updates.map((r) => r.payload.turn_id), ["t1", "t3"]);
    assertEquals(updates[0].payload.update, true);
    assertEquals(updates[0].payload.final, true); // nothing more will happen to it
    assertEquals(updates[0].envelope.conversation.address, "mind@a1");
    assertEquals(updates[0].agent, { id: "a1", session_id: "mind" });
    // the call as the card shows it, the address named, and why it did not land
    assertEquals(
      outcomeLine(updates[0]),
      "send(to: Banco Hipotecario SA, text: ¡Sigamos!) — not delivered: " +
        "server returned error 479",
    );
    assertEquals(updates[0].parts[0].data.is_error, true);
    assertStringIncludes(
      outcomeLine(updates[1]),
      `still failing after ${RETRY_BACKOFF_MS.length} retries`,
    );
    assertEquals((await tick(log, () => undefined, now)).reported, 0); // told once
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a send not out past the stall is told so, still tried, and told again when it goes out after all", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const now = Date.now();
    const after = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    await log.upsertConnections([{ service: "whatsapp", address: "5491100000000", agentId: "a1" }]);
    const uses = await log.publish([call("hola", "t1"), call("¿seguís?", "t2")]);
    const [retrying] = await log.publish([
      sent("hola", "t1", uses[0].id),
      sent("¿seguís?", "t2", uses[1].id), // queued, and no connector ever takes it
    ]);
    // two re-offers behind it, the last failing six minutes in
    await log.setDelivery(retrying.id, {
      status: {
        state: "failed",
        failed_at: after(6),
        error: "Error: bridge /dispatch: connection refused",
        attempts: 2,
      },
    });
    assertEquals((await tick(log, () => undefined, now + 14 * 60_000)).reported, 0);
    const stall = now + 16.5 * 60_000;
    assertEquals((await tick(log, () => undefined, stall)).reported, 2);
    const told = (await log.read({ types: ["tool_result"] })) as ToolResultEvent[];
    assertEquals(told.map((r) => r.payload.ref_id), [uses[0].id, uses[1].id]);
    assertEquals(told[0].payload.final, undefined); // it may yet go out
    assertEquals(told[0].parts[0].data.is_error, true);
    assertEquals(
      outcomeLine(told[0]),
      "send(to: Banco Hipotecario SA, text: hola) — not delivered yet, 16m after it was " +
        "sent: bridge /dispatch: connection refused. It is retried for about 17h more, and " +
        "you are told when it goes out or is given up. To keep it from going out late, take " +
        `it back: cancel ${shortId(retrying.id)}.`,
    );
    assertStringIncludes(
      outcomeLine(told[1]),
      "nothing has taken it to whatsapp: its connector is not running. It is offered again " +
        "while it waits",
    );
    assertEquals((await tick(log, () => undefined, stall + 60_000)).reported, 0); // once
    // the bridge is back: the next re-offer goes out
    await log.setDelivery(retrying.id, {
      external_id: "whatsapp:wamid.1",
      status: { state: "dispatched", dispatched_at: after(21.5) },
    });
    assertEquals((await tick(log, () => undefined, now + 22 * 60_000)).reported, 1);
    const [late] = (await log.read({ types: ["tool_result"] })).slice(2) as ToolResultEvent[];
    assertEquals(late.payload.ref_id, uses[0].id);
    assertEquals(late.payload.final, true);
    assertEquals(
      outcomeLine(late),
      "send(to: Banco Hipotecario SA, text: hola) → delivered after all, 21m after it was sent",
    );
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
