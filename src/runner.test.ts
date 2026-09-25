/**
 * runner: a session built from the store, the row and the host's ports — the row is the
 * config, the seams ride beside it, and a host with no sandbox builds a session with no
 * exec plane.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { configOf, type Host, runnerFor } from "./runner.ts";
import { openLog } from "./store/log.ts";
import { openFileDocs } from "./store/docs.ts";
import { NOTHING } from "./policy.ts";
import type { AgentRow } from "./store/agents.ts";
import type { ModelTransport } from "./transport/mod.ts";

const row: AgentRow = {
  agentId: "ana",
  mind: "mind@ana",
  model: "claude-x",
  effort: "low",
  name: "Ana",
  settings: { maxTokens: 512, tools: ["send"], gateHours: null },
};

Deno.test("runner: the row is the config, the seams ride beside it, and no sandbox means no exec plane", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const transport = {} as ModelTransport;
    const seen: string[] = [];
    const host: Host = {
      log,
      docs: openFileDocs(dir),
      policy: (agentId, sessionId) => {
        seen.push(`${sessionId}@${agentId}`);
        return { using: NOTHING };
      },
      transport: () => transport,
      onDelta: (agentId, sessionId) => seen.push(`delta ${sessionId}@${agentId}`),
    };
    const gate = () => "allow" as const;
    const r = runnerFor(host, row, "build", { gate });
    assertEquals(r.config, {
      agentId: "ana",
      sessionId: "build",
      model: "claude-x",
      effort: "low",
      name: "Ana",
      maxTokens: 512,
      tools: ["send"],
      gateHours: null,
      gate,
    });
    assertEquals(r.ports.transport, transport);
    assertEquals(r.ports.exec, undefined);
    assertEquals(r.ports.files, undefined);
    assertEquals(r.ports.ambient, undefined);
    assertEquals(r.ports.history, undefined);
    assertEquals(r.ports.onDecision, undefined);
    assert(r.ports.log === r.log);
    r.ports.onDelta!({ kind: "text", text: "hi" });
    assertEquals(seen, ["build@ana", "delta build@ana"]);
    assertEquals(await r.log.read({}), []); // the view is the policy's: nothing admitted
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a host with a reach into the docs table gives the session the three doc tools, over its own conversation", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const asked: string[] = [];
    const host: Host = {
      log,
      docs: openFileDocs(dir),
      reach: (ctx) => {
        asked.push(`${ctx.agent} in ${ctx.conversation}`);
        return {
          read: (handle) => Promise.resolve(`read ${handle}`),
          write: () => Promise.resolve(""),
          edit: () => Promise.resolve(""),
        };
      },
      policy: () => ({ using: NOTHING }),
      transport: () => ({} as ModelTransport),
    };
    const r = runnerFor(host, row, "build");
    assertEquals(Object.keys(r.ports.exec!), ["read", "write", "edit"]);
    assertEquals(asked, ["ana in build@ana"]);
    assertEquals(
      await r.ports.exec!.read.execute({ handle: "agent/x" }, new AbortController().signal),
      "read agent/x",
    );
    assertEquals(r.ports.files, undefined); // no sandbox: no file scope, no shell
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("configOf: a row without settings or model is one no session runs on", () => {
  assertThrows(() => configOf({ ...row, settings: undefined }, "mind"), Error, "no settings");
  assertThrows(() => configOf({ ...row, model: undefined }, "mind"), Error, "no settings");
});
