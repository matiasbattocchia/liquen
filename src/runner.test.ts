/**
 * runner: a session built from the store, the agent's config and the host's ports — the
 * row and the org's configuration are the config, the seams ride beside it, and a host
 * with no sandbox builds a session with no exec plane.
 */

import { assert, assertEquals } from "@std/assert";
import { configOf, type Host, runnerFor } from "./runner.ts";
import { orgOf, parseDeclared } from "./config.ts";
import { openLog } from "./store/log.ts";
import { openFileDocs } from "./store/docs.ts";
import { NOTHING } from "./policy.ts";
import type { AgentRow } from "./store/agents.ts";
import type { ModelTransport } from "./transport/mod.ts";

const row: AgentRow = {
  agentId: "ana",
  mind: "mind@ana",
  name: "Ana",
  since: "2026-09-25T00:00:00.000Z",
};

/** The org over these rows: ana's own settings, the org's for the rest. */
const org = orgOf(parseDeclared("", "test").deployment, [
  { scope: "agents.ana", key: "model", value: "claude-x" },
  { scope: "agents.ana", key: "effort", value: "low" },
  { scope: "agents.ana", key: "maxTokens", value: 512 },
  { scope: "agents.ana", key: "tools", value: ["send"] },
  { scope: "agents.ana", key: "sleepHours", value: null },
  { scope: "agents.bo", key: "provider", value: "google" },
  { scope: "agents.bo", key: "model", value: "gemini-x" },
  { scope: "shared.agents", key: "digestMinutes", value: 7 },
  { scope: "shared", key: "timezone", value: "Asia/Tokyo" },
  { scope: "processors", key: "audio", value: "transcribe.sh" },
], [row, { agentId: "bo", mind: "mind@bo" }]);

Deno.test("configOf: the row's identity and floor, its own settings over the org's, and what the org shares", () => {
  assertEquals(configOf(row, org, "mind"), {
    agentId: "ana",
    sessionId: "mind",
    model: "claude-x",
    effort: "low",
    name: "Ana",
    maxTokens: 512,
    tools: ["send"],
    rules: org.shared.agents.rules,
    since: "2026-09-25T00:00:00.000Z",
    timezone: "Asia/Tokyo",
    engagedMinutes: 15,
    digestAfterMessages: 25,
    digestMinutes: 7, // the org's, since ana sets none
    sleepHours: null, // a value: never sleeps
    processors: ["audio"],
    compactAt: 50_000,
    keepRecent: 20_000,
    cache: "marked", // the provider's: ana names none, so Anthropic's
  });
  // a key the org changes reaches an agent that does not set it, when the config is read
  const later = orgOf(org.deployment, [
    { scope: "shared.agents", key: "model", value: "claude-y" },
    { scope: "shared.agents", key: "tools", value: null },
  ], [{ agentId: "bo", mind: "mind@bo" }]);
  const bo = configOf({ agentId: "bo", mind: "mind@bo" }, later, "mind");
  assertEquals([bo.model, bo.tools, bo.since], ["claude-y", undefined, undefined]);
});

Deno.test("runner: the config is the session's, the seams ride beside it, and no sandbox means no exec plane", async () => {
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
    const config = configOf(row, org, "build");
    const r = runnerFor(host, config, undefined, { gate });
    assertEquals(r.config, { ...config, gate });
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
    const r = runnerFor(host, configOf(row, org, "build"), undefined);
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
          stop: () => (w.stopped++, undefined),
        };
      },
    };
    const mind = runnerFor(host, configOf(row, org, "mind"), undefined);
    const gemini = runnerFor(
      host,
      configOf({ agentId: "bo", mind: "mind@bo" }, org, "mind"),
      "google",
    );
    const build = runnerFor(host, configOf(row, org, "build"), undefined);
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
