/**
 * door.test.ts — the syscall boundary (§9): every verb a script speaks — send and search
 * alike — is a gated tool_use in the caller's name, settled by the existing act machinery
 * on the caller's scoped port. One path: a policy on any tool rules scripts and model
 * alike, and the answers land in the log for the mind, never in the script.
 *
 * Every test that speaks through the door runs with `sanitizeResources: false`: the client
 * holds its socket for the life of the process — a script's exit is its hang-up, and the
 * API deliberately has no close.
 */

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { installDoors } from "./door.ts";
import { bind, type Mu } from "./script.ts";
import { type Log, openLog } from "./store/log.ts";
import { openFileDocs } from "./store/docs.ts";
import { scoped } from "./policy.ts";
import { type AgentConfig, xi } from "./xi.ts";
import { scripted } from "./testing.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionResponseEvent,
  SearchHit,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";

const AGENT = { agentId: "ana", sessionId: "ana" };

async function up(policy?: Parameters<typeof scoped>[1]) {
  const dir = await Deno.makeTempDir({ prefix: "mu-door-" });
  const log = await openLog(`${dir}/log`);
  const slog = policy ? scoped(log, policy) : log;
  const doors = await installDoors(dir, [{ ...AGENT, log: slog }]);
  // the client exactly as a script builds it: this module, bound to the folder it sits in
  const mu: Mu = bind(`${dir}/agents/ana`);
  const down = async () => {
    await doors.close();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { dir, log, slog, mu, down };
}

/** One ordinary act invocation on the agent's own port — no model script: pendingOf finds
 *  the queued uses, the gate rules them, execute answers into the log (§2, §9). */
async function act(dir: string, log: Log) {
  const config: AgentConfig = {
    agentId: "ana",
    sessionId: "ana",
    mind: "mind:ana",
    model: "claude-test",
    maxTokens: 1000,
    gate: () => "allow", // the clinic's standing rule, compiled (§9)
  };
  await xi(config, { log, docs: openFileDocs(dir), transport: scripted([]).transport });
}

/** A world message, as a connector lands one — what a script's search reads back. */
function msg(address: string, text: string): Draft<MessageEvent> {
  return {
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address },
      sender: { address: "wa:+34600", name: "Juan" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

Deno.test({
  name: "door: a script send is a tool_use in the agent's name, under a job turn",
  sanitizeResources: false,
  async fn() {
    const { log, mu, down } = await up();
    try {
      const q = await mu.send({ to: "wa:+34600", text: "recordatorio" });
      assertEquals(q.status, "queued");
      const [use] = await log.read({ types: ["tool_use"] }) as ToolUseEvent[];
      assertEquals(use.id, q.id);
      // identity is the runtime's (§9): the socket stamped it, the script never could
      assertEquals(use.agent, { id: "ana", session_id: "ana" });
      // a turn no session ever held — act reads the use as fresh work, never as stolen
      assertMatch(use.payload.turn_id, /^job:/);
      assertEquals(use.envelope.conversation.address, "mind:ana");
      assertEquals(use.parts[0].data, {
        name: "send",
        input: { to: "wa:+34600", text: "recordatorio" },
      });
      // one connection, one run: a second send shares the turn
      const q2 = await mu.send({ to: "wa:+34600", text: "otra" });
      const uses = await log.read({ types: ["tool_use"] }) as ToolUseEvent[];
      assertEquals(uses.length, 2);
      assertEquals(new Set(uses.map((u) => u.payload.turn_id)).size, 1);
      assert(q2.id !== q.id);
    } finally {
      await down();
    }
  },
});

Deno.test({
  name: "door: a script search queues like its send — act answers it into the log",
  sanitizeResources: false,
  async fn() {
    const { dir, log, mu, down } = await up();
    try {
      await log.publish(msg("wa:+34600", "la cita es mañana"));
      await log.publish(msg("wa:+34611", "otra cosa"));
      // never the rows: the ask is in the log, the answer belongs to the next turn
      const q = await mu.search({ text: "cita" });
      assertEquals(q.status, "queued");
      const [use] = await log.read({ types: ["tool_use"] }) as ToolUseEvent[];
      assertEquals(use.parts[0].data, { name: "search", input: { text: "cita" } });
      await act(dir, log);
      const [res] = await log.read({ types: ["tool_result"] }) as ToolResultEvent[];
      assertEquals(res.payload.ref_id, q.id);
      const hits = res.parts[0].data.output as SearchHit[];
      assertEquals(hits.map((h) => [h.address, h.sender, h.text]), [
        ["wa:+34600", "Juan", "la cita es mañana"],
      ]);
    } finally {
      await down();
    }
  },
});

Deno.test({
  name: "door: the scoped port is the door's law — writes refused, reads filtered (§6)",
  sanitizeResources: false,
  async fn() {
    // the policy refuses the write ⇒ NOTHING lands — a search's ask is a write too
    const denied = await up({ writable: () => false });
    try {
      await assertRejects(() => denied.mu.send({ to: "x", text: "no" }), Error, "not writable");
      await assertRejects(() => denied.mu.search({}), Error, "not writable");
    } finally {
      await denied.down();
    }
    // what the agent may not see, its scripts may not search up: act runs the queued
    // search on the agent's own scoped port, so the hits are the agent's eyes, no wider
    const blind = await up({ readable: (e) => e.envelope.conversation.address !== "wa:secret" });
    try {
      await blind.log.publish(msg("wa:secret", "callado"));
      await blind.log.publish(msg("wa:+34600", "visible"));
      const q = await blind.mu.search({});
      await act(blind.dir, blind.slog);
      const [res] = await blind.log.read({ types: ["tool_result"] }) as ToolResultEvent[];
      assertEquals(res.payload.ref_id, q.id);
      assertEquals((res.parts[0].data.output as SearchHit[]).map((h) => h.text), ["visible"]);
    } finally {
      await blind.down();
    }
  },
});

/** A raw attach client — the interface's half of the wire, newline-JSON by hand:
 *  requests answered in order, {event}/{delta} pushed after a tail. */
async function rawClient(dir: string) {
  const conn = await Deno.connect({ transport: "unix", path: `${dir}/agents/ana/door.sock` });
  const events: Event[] = [];
  const deltas: unknown[] = [];
  const replies: ((r: Record<string, unknown>) => void)[] = [];
  (async () => {
    const lines = conn.readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new (await import("@std/streams")).TextLineStream());
    for await (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { event?: Event; delta?: unknown } & Record<string, unknown>;
      if (msg.event) events.push(msg.event);
      else if (msg.delta) deltas.push(msg.delta);
      else replies.shift()?.(msg);
    }
  })().catch(() => {/* hang-up */});
  const request = async (req: Record<string, unknown>) => {
    const reply = new Promise<Record<string, unknown>>((resolve) => replies.push(resolve));
    await conn.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));
    return await reply;
  };
  const settle = async (cond: () => boolean, ms = 5_000) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  };
  return { conn, events, deltas, request, settle };
}

Deno.test({
  name: "door: the attach verbs — a principal message, a tail, an answered gate",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { dir, log, down } = await up();
    try {
      const client = await rawClient(dir);
      assertEquals(await client.request({ op: "tail" }), { ok: true, status: "tailing" });

      // message: the principal's half of the complex — stamped for the mind, NO turn_id
      const r = await client.request({
        op: "message",
        text: "hola",
        sender: { address: "matias", name: "matias" },
      });
      assertEquals(r.ok, true);
      const [msg] = await log.read({ types: ["message"] }) as MessageEvent[];
      assertEquals(msg.id, r.id);
      assertEquals(msg.agent, { id: "ana", session_id: "ana" });
      assertEquals(msg.payload?.turn_id, undefined);
      assertEquals(msg.envelope.sender, { address: "matias", name: "matias" });
      assertEquals(msg.envelope.conversation.address, "mind:ana");

      // the tail pushed the same row back — full disclosure, the interface decides
      await client.settle(() => client.events.length >= 1);
      assertEquals(client.events[0].id, msg.id);

      // permission_response: the verdict lands referencing the gated use
      const pr = await client.request({
        op: "permission_response",
        ref_id: msg.id, // any referent works for the door's own contract
        verdict: { behavior: "allow", scope: "once" },
      });
      assertEquals(pr.ok, true);
      const [resp] = await log.read({
        types: ["permission_response"],
      }) as PermissionResponseEvent[];
      assertEquals(resp.payload.ref_id, msg.id);
      assertEquals(resp.parts[0].data, { behavior: "allow", scope: "once" });

      client.conn.close();
    } finally {
      await down();
    }
  },
});

Deno.test({
  name: "door: attachments are the live connections, and a delta fans out to the tailers",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "mu-door-" });
    const log = await openLog(`${dir}/log`);
    const doors = await installDoors(dir, [{ ...AGENT, log }]);
    try {
      assertEquals(doors.attachments(), 0);
      const tailing = await rawClient(dir);
      await tailing.request({ op: "tail" });
      const passive = await rawClient(dir); // attached, not tailing — a script mid-run
      await tailing.settle(() => doors.attachments() === 2);
      assertEquals(doors.attachments(), 2);

      doors.emit("ana", { kind: "text", text: "hola" });
      await tailing.settle(() => tailing.deltas.length >= 1);
      assertEquals(tailing.deltas, [{ kind: "text", text: "hola" }]);
      assertEquals(passive.deltas, []); // deltas reach only who asked for the stream

      // a hang-up — clean or killed, the same event — leaves the count honest
      tailing.conn.close();
      passive.conn.close();
      await tailing.settle(() => doors.attachments() === 0);
      assertEquals(doors.attachments(), 0);
    } finally {
      await doors.close();
      await log.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "door → act: the existing machinery gates, executes, and answers a script's send",
  sanitizeResources: false,
  async fn() {
    const { dir, log, mu, down } = await up();
    try {
      const q = await mu.send({ to: "wa:+34600", text: "mañana a las 10" });
      await act(dir, log);
      const [res] = await log.read({ types: ["tool_result"] }) as ToolResultEvent[];
      assertEquals(res.payload.ref_id, q.id);
      assertEquals((res.parts[0].data.output as { sent: boolean }).sent, true);
      const sent = (await log.read({ conversation: "wa:+34600" })) as MessageEvent[];
      // the dispatched message carries the job turn — the model's voice rules apply (§3)
      assertMatch(String(sent[0].payload?.turn_id), /^job:/);
      // and a script's search reads its own work back — through the same door, next turn
      const qs = await mu.search({ in: "wa:+34600" });
      await act(dir, log);
      const results = await log.read({ types: ["tool_result"] }) as ToolResultEvent[];
      const found = results.find((r) => r.payload.ref_id === qs.id)!;
      assertEquals(
        (found.parts[0].data.output as SearchHit[]).map((h) => h.text),
        ["mañana a las 10"],
      );
    } finally {
      await down();
    }
  },
});
