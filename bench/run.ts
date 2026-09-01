/**
 * bench/run.ts — behavioral benchmark over the REAL model (Terminal-Bench methodology):
 * each task = an instruction + a fresh org + a PROGRAMMATIC check over resulting state
 * (log, workspace, docs — never transcript prose). Binary pass/fail + machine invariants.
 *
 *   deno task bench            # all tasks (needs credentials; uses MU_BENCH_MODEL,
 *   deno task bench greet mem  # subset by name prefix        default claude-sonnet-5)
 *
 * The scripted-step integration tests are the oracle layer (machine correctness, free);
 * this suite is the behavior layer (does the real model drive the machine well) — kept
 * cheap: small contexts, Sonnet-tier default, sequential tasks.
 */

import { start } from "../src/main.ts";
import { type AgentConfig, decide, type Gate } from "../src/xi.ts";
import type { Event, MessageEvent } from "../src/types.ts";
import type { Log } from "../src/store/log.ts";
import { newId } from "../src/store/id.ts";

const MODEL = "claude-sonnet-5";
const MIND = "mind@alter";
const SESSION = { id: "mind", agentId: "alter", conversation: MIND };

interface Ctx {
  dir: string;
  log: Log;
  gate: Gate;
  send(text: string): Promise<void>;
  /** Wait until nothing is owed and the log has been still for a beat. */
  quiesce(timeoutMs?: number): Promise<Event[]>;
  respond(behavior: "allow" | "deny", reason?: string): Promise<void>;
}

interface Task {
  name: string;
  gated?: boolean; // default: gating off (only the gate tasks keep `send` gated)
  config?: Partial<AgentConfig>;
  run(ctx: Ctx): Promise<string | null>; // null = pass · string = failure note
}

/* ── helpers ──────────────────────────────────────────────────────────── */

const principalMsg = (text: string): MessageEvent => ({
  id: newId(),
  ts: new Date().toISOString(),
  type: "message",
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: MIND },
    sender: { address: "principal", name: "Matias" },
  },
  parts: [{ type: "text", kind: "text", text }],
});

const textOf = (e: Event): string => JSON.stringify(e.type === "message" ? e.parts : []);

const closings = (events: Event[]): MessageEvent[] =>
  events.filter((e): e is MessageEvent =>
    e.type === "message" && e.agent?.session_id === SESSION.id &&
    e.envelope.conversation.address === MIND
  );

/** Machine invariants every task must satisfy at the end. */
function invariants(events: Event[]): string | null {
  const answered = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => e.payload.ref_id),
  );
  const orphan = events.find((e) => e.type === "tool_use" && !answered.has(e.id));
  if (orphan) return `unanswered tool_use ${orphan.id}`;
  if (decide(events, SESSION, {}) !== "ignore") {
    return "not quiescent (work still owed)";
  }
  const err = events.find((e) => e.type === "error");
  if (err) return `error event: ${JSON.stringify(err.parts[0]).slice(0, 120)}`;
  return null;
}

/* ── the tasks ────────────────────────────────────────────────────────── */

const TASKS: Task[] = [
  {
    name: "greet — one closing reply, no machinery",
    async run(ctx) {
      await ctx.send("hola! todo bien?");
      const events = await ctx.quiesce();
      const c = closings(events);
      if (c.length === 0) return "no closing reply";
      const turns = new Set(
        events.filter((e) => e.type === "thinking").map((e) => e.payload.turn_id),
      );
      if (turns.size > 2) return `${turns.size} turns for a greeting (expected ≤2)`;
      return null;
    },
  },
  {
    name: "file — awrite + verify in the workspace",
    async run(ctx) {
      await ctx.send(
        "creá un archivo lista.txt en tu workspace con exactamente tres líneas: pan, leche, café. verificá releyéndolo.",
      );
      const events = await ctx.quiesce();
      const file = await Deno.readTextFile(`${ctx.dir}/workspace/lista.txt`).catch(() => null);
      if (file === null) return "lista.txt not created";
      const lines = file.trim().split("\n").map((l) => l.trim());
      if (lines.length !== 3 || !file.includes("pan") || !file.includes("café")) {
        return `unexpected content: ${JSON.stringify(file)}`;
      }
      if (!events.some((e) => e.type === "tool_use")) return "no tool_use in the log";
      return null;
    },
  },
  {
    name: "memory — a well-formed fact file",
    async run(ctx) {
      await ctx.send("recordá esto de mí: mi cafetería favorita es La Norma, en Palermo.");
      await ctx.quiesce();
      const dir = `${ctx.dir}/docs/agent/alter/memory`;
      for await (const f of Deno.readDir(dir)) {
        if (!f.name.endsWith(".md") || f.name === "example.md") continue;
        const body = await Deno.readTextFile(`${dir}/${f.name}`);
        if (body.includes("La Norma")) {
          return body.startsWith("---") && body.includes("description:")
            ? null
            : `memory ${f.name} lacks description frontmatter`;
        }
      }
      return "no memory file mentioning La Norma";
    },
  },
  {
    name: "gate-approve — request surfaces, allow delivers",
    gated: true,
    async run(ctx) {
      await ctx.send("mandale a wa:mariana este mensaje: nos vemos mañana a las 10");
      // wait for the approval card, then allow
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const events = await ctx.log.read({ types: ["permission_request"] });
        if (events.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const reqs = await ctx.log.read({ types: ["permission_request"] });
      if (reqs.length === 0) return "no permission_request surfaced";
      await ctx.respond("allow");
      const events = await ctx.quiesce();
      const directed = events.filter((e) =>
        e.type === "message" && e.envelope.conversation.address === "wa:mariana"
      );
      if (directed.length !== 1) return `${directed.length} directed messages (expected 1)`;
      return null;
    },
  },
  {
    name: "gate-deny — denial respected, nothing delivered",
    gated: true,
    async run(ctx) {
      await ctx.send("mandale a wa:mariana: hola");
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await ctx.log.read({ types: ["permission_request"] })).length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if ((await ctx.log.read({ types: ["permission_request"] })).length === 0) {
        return "no permission_request surfaced";
      }
      await ctx.respond("deny", "ahora no, después le escribo yo");
      const events = await ctx.quiesce();
      const directed = events.filter((e) =>
        e.type === "message" && e.envelope.conversation.address === "wa:mariana"
      );
      if (directed.length > 0) return "delivered despite denial";
      if (closings(events).length === 0) return "no closing reply after denial";
      return null;
    },
  },
  {
    name: "truncation — big output paged, answer correct",
    async run(ctx) {
      await ctx.send(
        "generá los números del 1 al 5000 en numeros.txt y decime cuántas líneas tiene el archivo.",
      );
      const events = await ctx.quiesce(180_000);
      const c = closings(events);
      if (c.length === 0) return "no reply";
      if (!c.some((m) => textOf(m).includes("5000"))) return "reply doesn't contain 5000";
      return null;
    },
  },
  {
    name: "burst — rapid messages coalesce, all answered",
    async run(ctx) {
      await ctx.send("tres preguntas rápidas. primera: capital de Francia?");
      await new Promise((r) => setTimeout(r, 1200)); // land mid-turn or between turns
      await ctx.send("segunda: 7 por 8?");
      await ctx.send("tercera: color del cielo?");
      const events = await ctx.quiesce();
      const c = closings(events);
      if (c.length === 0) return "no replies";
      const all = c.map(textOf).join(" ");
      for (const [q, a] of [["París", "Par"], ["56", "56"], ["azul", "azul"]] as const) {
        if (!all.toLowerCase().includes(a.toLowerCase())) return `question unanswered: ${q}`;
      }
      const turns = new Set(
        events.filter((e) => e.type === "thinking").map((e) => e.payload.turn_id),
      ).size;
      if (turns > 3) return `${turns} turns for a 3-message burst (coalescing failed?)`;
      return null;
    },
  },
  {
    name: "world — a peer message reaches the principal",
    async run(ctx) {
      // simulate an inbound channel message (what a Slack/WA producer will publish in v0.1)
      await ctx.log.publish({
        id: newId(),
        ts: new Date().toISOString(),
        type: "message",
        envelope: {
          service: "whatsapp",
          connection_address: "agent",
          conversation: { address: "wa:cliente-juan", name: "Juan" },
          sender: { address: "549115550001", name: "Juan" },
        },
        parts: [{
          type: "text",
          kind: "text",
          text: "Hola! Necesito cambiar mi reunión del jueves al viernes, se puede?",
        }],
      });
      const events = await ctx.quiesce();
      const home = closings(events);
      const sent = events.filter((e) =>
        e.type === "message" && e.agent?.session_id === SESSION.id &&
        e.envelope.conversation.address === "wa:cliente-juan"
      );
      // acceptable behaviors: brief the principal, and/or reply to Juan directly
      if (home.length === 0 && sent.length === 0) return "no reaction to the peer message";
      if (
        home.length > 0 && !closings(events).some((m) => textOf(m).match(/[Jj]uan|jueves|viernes/))
      ) {
        return "principal briefing doesn't mention the peer or the ask";
      }
      return null;
    },
  },
  {
    name: "compaction — memory survives the checkpoint",
    config: { compactAt: 400, keepRecent: 100 }, // tiny: force a checkpoint immediately
    async run(ctx) {
      await ctx.send("hola! dato importante: el código del proyecto secreto es AZUL-47.");
      await ctx.quiesce();
      await ctx.send("che, se me olvidó — cuál era el código del proyecto?");
      const events = await ctx.quiesce();
      const summaries = events.filter((e) => e.type === "summary");
      if (summaries.length === 0) return "no summary event (compaction never fired)";
      const last = closings(events).at(-1)!;
      if (!textOf(last).includes("AZUL-47")) {
        return "the code did not survive compaction";
      }
      return null;
    },
  },
];

/* ── the runner ───────────────────────────────────────────────────────── */

async function runTask(task: Task): Promise<{ note: string | null; ms: number; steps: number }> {
  const dir = await Deno.makeTempDir({ prefix: "mu-bench-" });
  const gate: Gate = task.gated ? (name) => (name === "send" ? "ask" : "allow") : () => "allow";
  const config: AgentConfig = {
    agentId: SESSION.agentId,
    sessionId: SESSION.id,
    model: MODEL,
    maxTokens: 16_000,
    gate,
    ...task.config,
  };
  const t0 = Date.now();
  const main = await start({ dir, principals: [config] });
  const ctx: Ctx = {
    dir,
    log: main.log,
    gate,
    send: async (text) => {
      await main.log.publish(principalMsg(text));
    },
    quiesce: async (timeoutMs = 120_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = await main.log.read();
        const last = events.at(-1);
        const still = last ? Date.now() - Date.parse(last.ts) > 2_500 : false;
        if (
          still && decide(events, SESSION, {}) === "ignore"
        ) return events;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`quiesce timeout (${timeoutMs / 1000}s)`);
    },
    respond: async (behavior, reason) => {
      const reqs = await main.log.read({ types: ["permission_request"] });
      const req = reqs.at(-1)!;
      if (req.type !== "permission_request") throw new Error("no request to respond to");
      await main.log.publish({
        ts: new Date().toISOString(),
        type: "permission_response",
        payload: { ref_id: req.payload.ref_id },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: MIND },
        },
        parts: [{
          type: "data",
          kind: "permission_response",
          data: {
            behavior,
            scope: "once",
            ...(reason ? { reason } : {}),
          },
        }],
      });
    },
  };

  let note: string | null;
  let steps = 0;
  try {
    note = await task.run(ctx);
    const events = await main.log.read();
    steps = new Set(
      events.filter((e) => e.type === "thinking" || e.type === "tool_use").map((e) =>
        e.payload.turn_id
      ),
    ).size;
    note ??= invariants(events);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  } finally {
    await main.stop();
  }
  return { note, ms: Date.now() - t0, steps };
}

if (import.meta.main) {
  const filters = Deno.args;
  const picked = filters.length > 0
    ? TASKS.filter((t) => filters.some((f) => t.name.startsWith(f)))
    : TASKS;
  console.log(`bench: ${picked.length} task(s) · model ${MODEL}\n`);
  let failed = 0;
  for (const task of picked) {
    const { note, ms, steps } = await runTask(task);
    const status = note === null ? "PASS" : "FAIL";
    if (note !== null) failed++;
    console.log(
      `${status}  ${task.name}  (${(ms / 1000).toFixed(0)}s · ${steps} turns)` +
        (note ? `\n      ↳ ${note}` : ""),
    );
  }
  console.log(`\n${picked.length - failed}/${picked.length} passed`);
  Deno.exit(failed > 0 ? 1 : 0);
}
