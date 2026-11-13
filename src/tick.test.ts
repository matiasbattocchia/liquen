/**
 * tick: one beat of the clock over a real store — due reminders become alarms, unanswered
 * asks lapse, and a second beat over the same rows owes nothing.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Clock, lapseGates, tick } from "./tick.ts";
import { openLog } from "./store/log.ts";
import { members } from "./testing.ts";
import type { DocEntry, DocScope } from "./store/docs.ts";
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
    connection_address: "default",
    conversation: { address: `mind@${agent}` },
  },
  parts: [{
    type: "data",
    kind: "permission_request",
    data: { tool: "send", call: "send(to: x)", detail: "send(to: x, text: hi)" },
  }],
});

/** A clock over one agent's docs, by scope and name, each a lazy memory read on demand. */
function clockOver(
  docs: Record<string, string>,
  timezone = "America/Argentina/Buenos_Aires",
  backlogHours = 24,
): Clock {
  const entries = (): DocEntry[] =>
    Object.keys(docs).map((key) => {
      const [scope, name] = key.split(":") as [DocScope, string];
      return {
        header: { scope, kind: "memory", name, load: "lazy", handle: `/${scope}/${name}.md` },
      };
    });
  return {
    agents: () => [{ agentId: "a1", timezone }],
    docs: {
      list: () => Promise.resolve(entries()),
      read: (_ctx, ref) => Promise.resolve(docs[`${ref.scope}:${ref.name}`] ?? null),
    },
    backlogHours,
  };
}

const NOBODY: Clock = {
  agents: () => [],
  docs: { list: () => Promise.resolve([]), read: () => Promise.resolve(null) },
  backlogHours: 24,
};

const textOf = (e: Event) => e.parts?.[0].type === "text" ? e.parts[0].text : undefined;

Deno.test("a beat: the lines due remind as one alarm in the mind's room, the old ask lapses, and the next beat is quiet", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    const now = Date.parse("2026-11-06T13:00:00Z"); // 6 Nov 10:00 on the agent's clock
    const board = (jana: string) =>
      [
        "# Playas",
        "## Agendado",
        `- @7 Nov 15:00 remind 1 day before at 10:00 ${jana} (4 Nov, 5c356f)`,
        "- @7 Nov 15:00 remind 1 day before at 10:00 Ringo (4 Nov, 5efe54)",
        "- @7 Nov 17:30 remind 1 day before at 11:00 Leo V",
        "- [x] @6 Nov 10:30 remind 1 hour before ya está",
      ].join("\n");
    const docs = {
      "agent:playas": board("Jana"),
      "shared:equipo": "- @6 Nov 10:00 remind Reunión de equipo", // a shared line reminds too
    };
    await log.publish([card("old", at(30, now)), card("fresh", at(1, now))]);
    assertEquals(await tick(log, clockOver(docs), now), {
      fired: 2,
      lapsed: 1,
      swept: 0,
      reported: 0,
      failed: [],
    });
    const alarms = await log.read({ types: ["alarm"] });
    assertEquals(alarms.length, 2);
    assertEquals(textOf(alarms[1]), "6 Nov 10:00 Reunión de equipo — shared/equipo, remind");
    assertEquals(alarms[0].envelope.conversation.address, "mind@a1");
    assertEquals(alarms[0].agent, undefined); // harness-authored: the relational rule wakes on it
    assertEquals(
      textOf(alarms[0]),
      "7 Nov 15:00 Jana — playas › Agendado, remind 1 day before at 10:00\n" +
        "7 Nov 15:00 Ringo — playas › Agendado, remind 1 day before at 10:00",
    );
    assertEquals(alarms[0].extra?.reminder, { doc: "playas", at: "2026-11-06T10:00" });
    assertEquals((await log.gates()).map((c) => c.payload.ref_id), ["fresh"]);
    // a line edited after it reminded, a beat later: what it reminded of stays reminded
    docs["agent:playas"] = board("Jana Techno Camp");
    assertEquals((await tick(log, clockOver(docs), now + 60_000)).fired, 0);
    // at its own minute, the next line
    assertEquals((await tick(log, clockOver(docs), now + 3_600_000)).fired, 1);
    assertEquals(
      textOf((await log.read({ types: ["alarm"] })).at(-1)!),
      "7 Nov 17:30 Leo V — playas › Agendado, remind 1 day before at 11:00",
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a clock that was down fires a repeat once, at the latest step it missed", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    const docs = {
      "agent:wakes":
        "- @1 Nov 2026 0:00 every 90 minutes from 19:30 to 12:00 remind Revisar la cola.",
    };
    // 6 Nov 13:10: the last step inside the span was 12:00
    const now = Date.parse("2026-11-06T16:10:00Z");
    assertEquals((await tick(log, clockOver(docs), now)).fired, 1);
    const [alarm] = await log.read({ types: ["alarm"] });
    assertEquals(alarm.extra?.reminder, { doc: "wakes", at: "2026-11-06T12:00" });
    assertEquals(
      textOf(alarm),
      "6 Nov 12:00 Revisar la cola. — wakes, every 90 minutes from 19:30 to 12:00, remind",
    );
    // the quiet span passes with nothing, and 19:30 is the next
    assertEquals((await tick(log, clockOver(docs), Date.parse("2026-11-06T22:29:00Z"))).fired, 0);
    assertEquals((await tick(log, clockOver(docs), Date.parse("2026-11-06T22:30:00Z"))).fired, 1);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a reminder fires within the backlog and not past it", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    const docs = { "agent:x": "- @6 Nov 2026 9:00 remind Llamar a Ana." };
    const zone = "America/Argentina/Buenos_Aires";
    // 6 Nov 14:00 on the agent's clock: five hours past 9:00
    const now = Date.parse("2026-11-06T17:00:00Z");
    assertEquals((await tick(log, clockOver(docs, zone, 4), now)).fired, 0);
    assertEquals((await tick(log, clockOver(docs, zone, 6), now)).fired, 1);
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
  envelope: {
    service: "local",
    connection_address: "default",
    conversation: { address: "mind@a1" },
  },
  parts: [{
    type: "data",
    kind: "tool_use",
    data: { name: "send", input: { to: "5491155550124", text } },
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
    conversation: { address: "5491155550124", name: "Banco Hipotecario SA" },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("a send that failed for good is told against the call that sent it, once", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
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
    const beat = await tick(log, NOBODY, now);
    assertEquals(beat.reported, 2);
    const updates = (await log.read({ types: ["tool_result"] })) as ToolResultEvent[];
    assertEquals(updates.map((r) => r.payload.ref_id), [uses[0].id, uses[2].id]);
    assertEquals(updates.map((r) => r.payload.turn_id), ["t1", "t3"]);
    assertEquals(updates[0].payload.update, true);
    assertEquals(updates[0].payload.final, true); // nothing more will happen to it
    assertEquals(updates[0].payload.quiet, true); // the world's tale: it wakes nobody
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
    assertEquals((await tick(log, NOBODY, now)).reported, 0); // told once
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a send not out past the stall is told so, still tried, and told again when it goes out after all", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
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
    assertEquals((await tick(log, NOBODY, now + 14 * 60_000)).reported, 0);
    const stall = now + 16.5 * 60_000;
    assertEquals((await tick(log, NOBODY, stall)).reported, 2);
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
    assertEquals((await tick(log, NOBODY, stall + 60_000)).reported, 0); // once
    // the bridge is back: the next re-offer goes out
    await log.setDelivery(retrying.id, {
      external_id: "whatsapp:wamid.1",
      status: { state: "dispatched", dispatched_at: after(21.5) },
    });
    assertEquals((await tick(log, NOBODY, now + 22 * 60_000)).reported, 1);
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

Deno.test("a withdrawn send is told to the session that sent it, final, naming who took it back", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    await log.upsertConnections([{ service: "whatsapp", address: "5491100000000", agentId: "a1" }]);
    const uses = await log.publish([
      call("hola", "t1"),
      call("¿seguís?", "t2"),
      call("chau", "t3"),
      call("ya voy", "t4"),
    ]);
    const rows = await log.publish([
      sent("hola", "t1", uses[0].id),
      sent("¿seguís?", "t2", uses[1].id),
      sent("chau", "t3", uses[2].id),
      sent("ya voy", "t4", uses[3].id),
    ]);
    await log.withdraw(rows[0].id, stamp, { id: "a1", session_id: "mind" });
    await log.withdraw(rows[1].id, stamp, { id: "a1", session_id: "s2" });
    await log.withdraw(rows[2].id, stamp, { id: "bo", session_id: "mind" });
    // taken back while its post was on the wire: the post lands, and that is its word
    await log.withdraw(rows[3].id, stamp, { id: "bo", session_id: "mind" });
    await log.setDelivery(rows[3].id, {
      external_id: "whatsapp:wamid.4",
      status: { state: "dispatched", dispatched_at: new Date(now + 2.5 * 60_000).toISOString() },
    });
    assertEquals((await tick(log, NOBODY, now)).reported, 4);
    const told = (await log.read({ types: ["tool_result"] })) as ToolResultEvent[];
    assertEquals(told.map((r) => r.payload.ref_id), uses.map((u) => u.id));
    assertEquals(told.every((r) => r.payload.final === true), true);
    assertEquals(told.every((r) => r.agent?.id === "a1" && r.agent.session_id === "mind"), true);
    assertEquals(told[0].parts[0].data.is_error, undefined); // nothing failed
    assertEquals(told.map((r) => outcomeLine(r)), [
      "send(to: Banco Hipotecario SA, text: hola) → withdrawn: you took it back before it " +
      "went out",
      'send(to: Banco Hipotecario SA, text: ¿seguís?) → withdrawn: your session "s2" took ' +
      "it back before it went out",
      "send(to: Banco Hipotecario SA, text: chau) → withdrawn: bo took it back before it " +
      "went out",
      "send(to: Banco Hipotecario SA, text: ya voy) → delivered after all, 2m after it was " +
      "sent: it was already on its way when bo took it back",
    ]);
    assertEquals((await tick(log, NOBODY, now + 60_000)).reported, 0); // once
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failing pass is reported in the beat, and the passes after it still run", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    const now = Date.now();
    await log.publish([card("old", at(30, now))]);
    const docs = clockOver({ "agent:x": "" }).docs;
    const broken: Clock = {
      agents: () => [{ agentId: "a1" }],
      docs: { ...docs, list: () => Promise.reject(new Error("docs gone")) },
      backlogHours: 24,
    };
    const beat = await tick(log, broken, now);
    assertEquals(beat.fired, 0);
    assertEquals(beat.lapsed, 1); // the lapse pass ran after the fire pass failed
    assertEquals(beat.failed.map((f) => f.pass), ["fire"]);
    assertEquals((beat.failed[0].error as Error).message, "docs gone");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an ask nobody answers lapses (§9): a day on, the harness settles it as lapsed", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  await members(log, "a1");
  try {
    await log.publish([card("old", at(30)), card("fresh", at(1)), card("peer's", at(30), "a2")]);
    assertEquals(await lapseGates(log), 2);
    assertEquals((await log.gates()).map((c) => c.payload.ref_id), ["fresh"]);
    const settled = (await log.read({ types: ["permission_response"] }))
      .find((e) => e.payload?.ref_id === "old")!;
    assertEquals(settled.agent, undefined); // the harness's own word (§3)
    assertEquals(settled.parts?.[0].type === "data" && settled.parts[0].data, {
      behavior: "deny",
      scope: "once",
      lapsed: true,
      reason: "unanswered for 24h",
    });
    assertEquals(await lapseGates(log), 0); // settled once
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
