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
  settings: { maxTokens: 512, tools: ["send"], sleepHours: null },
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
      sleepHours: null,
      cache: "marked", // the provider's: the row names none, so Anthropic's
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

Deno.test("runner: a host with a reach into the docs table gives the session the three doc tools, as its agent", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  try {
    const asked: string[] = [];
    const host: Host = {
      log,
      docs: openFileDocs(dir),
      reach: (ctx) => {
        asked.push(ctx.agent);
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
    assertEquals(asked, ["ana"]);
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

Deno.test("runner: a mind has a keeper, kept where its provider is Anthropic; a named session none", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  const made: { kept: (boolean | undefined)[]; stopped: number }[] = [];
  try {
    const transport = {} as ModelTransport;
    const host: Host = {
      log,
      docs: openFileDocs(dir),
      policy: () => ({ using: NOTHING }),
      transport: () => transport,
      warmth: () => {
        const w = { kept: [] as (boolean | undefined)[], stopped: 0 };
        made.push(w);
        return {
          through: (t, kept) => (w.kept.push(kept), t),
          stop: () => w.stopped++,
        };
      },
    };
    const mind = runnerFor(host, row, "mind");
    const gemini = runnerFor(host, { ...row, agentId: "bo", provider: "google" }, "mind");
    const build = runnerFor(host, row, "build");
    assertEquals(made.map((w) => w.kept), [[true], [false]]);
    assert(mind.warmth !== gemini.warmth);
    assertEquals(build.warmth, undefined);
    assertEquals(mind.ports.transport, transport);
    assertEquals(build.ports.transport, transport);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("configOf: a row without settings or model is one no session runs on", () => {
  assertThrows(() => configOf({ ...row, settings: undefined }, "mind"), Error, "no settings");
  assertThrows(() => configOf({ ...row, model: undefined }, "mind"), Error, "no settings");
});
