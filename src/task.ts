/**
 * task.ts — headless one-shot mode (the `pi --print` equivalent), for benchmarks and
 * scripted use: run ONE instruction to quiescence in the CURRENT directory, print the
 * agent's closing message, exit 0/1.
 *
 *   mu-task "<instruction>"            # workspace = cwd (the task container's workdir)
 *   mu-task afs read|write|edit …      # multi-call dispatch: the compiled binary IS the
 *                                      # exec-plane binary too (no Deno in the container)
 *
 * Task mode differs from the org REPL deliberately: no persona seeds (an agent told to
 * "ask your principal" is poison for autonomous tasks — a task instruction doc replaces
 * them), gates off, 10-minute bash timeout, org state in a throwaway temp dir. Env:
 * MU_MODEL · MU_EFFORT · MU_TASK_TIMEOUT_S (wall clock, default 1800).
 *
 * Compile: deno compile -A --include seed/docs -o mu-task src/task.ts
 */

import { start } from "./main.ts";
import { type AgentConfig, decide } from "./xi.ts";
import { bashAmbient, type BashState, bashTool, type Job } from "./exec/bash.ts";
import type { Draft, MessageEvent } from "./types.ts";

const TASK_DOC = `---
kind: instruction
load: always
---
You are an autonomous engineer completing one task. Work in the current directory until
the task is fully done, then stop. Verify your work before finishing (run the code, read
the file back, check the output). Nobody will answer questions — decide and proceed.

Work efficiently — every tool call is a round-trip:
- Chain independent steps into one bash command with && or ;; batch reads and checks.
- Emit several bash calls in one turn when they don't depend on each other.
- Background long-running work (train, build, fetch) with 'cmd > log 2>&1 &' and poll
  'tail log' — don't block a whole turn on a slow command.
- The working directory persists between calls; don't re-cd every time.

Your final message should state what you did and how you verified it.
`;

async function runTask(instruction: string): Promise<number> {
  const dir = await Deno.makeTempDir({ prefix: "mu-task-" });
  const workspace = Deno.cwd(); // the task's own directory — not the org data dir

  // exec plane: bash in the TASK directory, shims dispatching back into this binary
  const binDir = `${dir}/bin`;
  await Deno.mkdir(binDir, { recursive: true });
  const self = Deno.execPath();
  for (const name of ["aread", "awrite", "aedit"]) {
    const shim = `${binDir}/${name}`;
    await Deno.writeTextFile(
      shim,
      `#!/bin/sh\nexec "${self}" afs ${name.slice(1)} "$@"\n`,
    );
    await Deno.chmod(shim, 0o755);
  }
  const jobs = new Set<Job>(); // background jobs the task leaves running (reaped in finally)
  const state: BashState = { cwd: workspace };
  const exec = {
    bash: bashTool({ workspace, binDir, defaultTimeoutMs: 600_000, jobs, state }),
  };
  const reap = () => {
    for (const { pgid } of jobs) {
      try {
        Deno.kill(-pgid, "SIGKILL");
      } catch { /* gone */ }
    }
  };

  // the task instruction doc replaces the persona seeds
  await Deno.mkdir(`${dir}/system/instructions`, { recursive: true });
  await Deno.writeTextFile(`${dir}/system/instructions/task.md`, TASK_DOC);

  const agent: AgentConfig = {
    agentId: "task",
    sessionId: "task",
    home: "home",
    model: Deno.env.get("MU_MODEL") ?? "claude-opus-4-8",
    effort: Deno.env.get("MU_EFFORT") as AgentConfig["effort"],
    // a maxed turn must fit under the wall: 64k output tokens takes ~13min (~60-80 tok/s),
    // longer than MU_TASK_TIMEOUT_S — so it can never finish. 32k keeps worst-case turns
    // interruptible between iterations; xi's max_tokens continuation covers larger outputs.
    maxTokens: Number(Deno.env.get("MU_MAX_TOKENS") ?? 32_000),
    gate: () => false,
  };
  const gate = agent.gate!;
  const session = { id: agent.sessionId, agentId: agent.agentId };

  const main = await start({
    dir,
    principals: [agent],
    exec,
    seed: false,
    ambient: () => bashAmbient(state, jobs),
  });
  await main.log.publish(
    {
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: agent.home },
        sender: { address: "task", name: "task" },
      },
      parts: [{ type: "text", kind: "text", text: instruction }],
    } satisfies Draft<MessageEvent>,
  );

  const wallMs = Number(Deno.env.get("MU_TASK_TIMEOUT_S") ?? 1800) * 1000;
  const deadline = Date.now() + wallMs;
  let code = 1;
  let repokes = 0;
  try {
    while (Date.now() < deadline) {
      const events = await main.log.read();
      const last = events.at(-1);
      const age = last ? Date.now() - Date.parse(last.ts) : 0;
      const still = last ? age > 3_000 : false;
      // stall-retry: work owed but the machine is idle (a failed turn's error-idle, e.g.
      // an API outage) — poke it awake with an alarm; bounded so a hard failure still ends
      if (
        still && age > 45_000 && repokes < 5 &&
        decide(events, session, agent.home, gate) !== "ignore"
      ) {
        repokes++;
        await main.log.publish({
          ts: new Date().toISOString(),
          type: "alarm",
          envelope: {
            service: "local",
            connection_address: "agent",
            conversation: { address: "mind:task" },
          },
          parts: [{ type: "data", kind: "alarm", data: { reason: `stall-retry ${repokes}` } }],
        });
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      if (still && decide(events, session, agent.home, gate) === "ignore") {
        const closing = events.filter((e): e is MessageEvent =>
          e.type === "message" && e.agent?.session_id === session.id &&
          e.envelope.conversation.address === agent.home
        ).at(-1);
        if (closing) {
          console.log(
            closing.parts.filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text).join("\n"),
          );
          code = 0;
        } else console.error("quiescent without a closing message");
        break;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    if (code !== 0 && Date.now() >= deadline) console.error("task wall-clock timeout");
    // trajectory trace → stderr (harvested by bench harnesses; MU_TASK_TRACE=0 disables)
    if (Deno.env.get("MU_TASK_TRACE") !== "0") {
      const events = await main.log.read();
      for (const e of events) {
        const head = e.type === "tool_use"
          ? String(
            (e.parts[0] as { data: { input: { command?: string } } }).data.input.command ?? "",
          )
          : e.type === "message" || e.type === "thinking"
          ? JSON.stringify(e.parts).slice(0, 100)
          : "";
        console.error(`[mu-trace] ${e.type} ${head.replaceAll("\n", "⏎").slice(0, 140)}`);
      }
      const turns = new Set(
        events.filter((e) => typeof e.payload?.turn_id === "string")
          .map((e) => e.payload!.turn_id),
      ).size;
      const tools = events.filter((e) => e.type === "tool_use").length;
      console.error(`[mu-trace] totals: turns=${turns} tools=${tools} events=${events.length}`);
    }
  } finally {
    await main.stop();
    reap(); // no background job outlives the task run
  }
  return code;
}

if (import.meta.main) {
  if (Deno.args[0] === "afs") {
    // multi-call: the compiled artifact IS the exec-plane binary too
    const { run } = await import("./bin/afs.ts");
    Deno.exit(await run(Deno.args.slice(1)));
  }
  const instruction = Deno.args.join(" ").trim();
  if (!instruction) {
    console.error('usage: mu-task "<instruction>"  |  mu-task afs read|write|edit …');
    Deno.exit(2);
  }
  Deno.exit(await runTask(instruction));
}
