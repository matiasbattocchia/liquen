/**
 * door.test.ts — the syscall boundary (§9): every verb a script speaks — send and search
 * alike — is a gated tool_use in the caller's name, settled by the existing act machinery
 * on the caller's scoped port. One path: a policy on any tool rules scripts and model
 * alike, and the answers land in the log for the mind, never in the script.
 *
 * Every test that speaks through the stub runs with `sanitizeResources: false`: the client
 * holds its socket for the life of the process — a script's exit is its hang-up, and the
 * API deliberately has no close.
 */

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { installDoors } from "./door.ts";
import type { Mu } from "./script.ts";
import { type Log, openLog } from "./store/log.ts";
import { openFileDocs } from "./store/docs.ts";
import { scoped } from "./policy.ts";
import { type AgentConfig, xi } from "./xi.ts";
import { scripted } from "./testing.ts";
import type { Draft, MessageEvent, SearchHit, ToolResultEvent, ToolUseEvent } from "./types.ts";

const AGENT = { agentId: "ana", sessionId: "ana" };

async function up(policy?: Parameters<typeof scoped>[1]) {
  const dir = await Deno.makeTempDir({ prefix: "mu-door-" });
  const log = await openLog(`${dir}/log`);
  const slog = policy ? scoped(log, policy) : log;
  const doors = await installDoors(dir, [{ ...AGENT, log: slog }]);
  // the client exactly as a script gets it: the generated stub, bound to its own folder
  const mu: Mu = await import(`file://${dir}/agents/ana/mu.ts`);
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
