/**
 * roster: the one path an agent is made, changed and removed by (§9) — the checks, the
 * rows, the refusals — and a room routed to an agent made on its first line.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  declareConnection,
  ensureRoute,
  idleAgents,
  members,
  poke,
  removeAgent,
  undeclareConnection,
  upsertAgent,
} from "./roster.ts";
import { applyFile, readConfig } from "./org.ts";
import { openStore } from "./store/mod.ts";
import type { Log } from "./store/log.ts";
import { onFiles } from "./store/seed.ts";
import { cksum } from "./users.ts";

async function withOrg(
  fn: (root: string, log: Log) => Promise<void>,
  yaml = "{}",
): Promise<void> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, yaml);
  const log = await (await openStore(root)).log();
  try {
    await applyFile(root, log);
    await fn(root, log);
  } finally {
    await log.close();
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("upsertAgent: makes the agent — its row, its floor, its docs — then changes only what is named", async () => {
  await withOrg(async (root, log) => {
    const docs = onFiles(`${root}/data`);
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    assertEquals(
      await upsertAgent(root, log, "ana", {
        identity: { name: "Ana", phone: "+34600" },
        set: { model: "claude-x", effort: "low" },
      }, { docs, now }),
      { made: true },
    );
    assertEquals(await log.agents(), [{
      agentId: "ana",
      mind: "mind@ana",
      name: "Ana",
      phone: "+34600",
      since: "2026-11-12T12:00:00.000Z",
    }]);
    await Deno.stat(`${root}/data/agents/ana/instructions.md`); // the persona, there to write
    assertEquals(
      await upsertAgent(root, log, "ana", {
        identity: { phone: null, email: "ana@org.example" },
        principals: [],
        set: { sleepHours: null },
        unset: ["effort"],
      }, { now: now + 86_400_000 }),
      { made: false },
    );
    assertEquals(await log.agents(), [{
      agentId: "ana",
      mind: "mind@ana",
      name: "Ana",
      email: "ana@org.example",
      principals: [],
      since: "2026-11-12T12:00:00.000Z", // written once
    }]);
    assertEquals((await readConfig(root, log)).agents.ana, {
      identity: { name: "Ana", email: "ana@org.example", phone: null },
      principals: [],
      model: "claude-x",
      sleepHours: null, // a value: never sleeps
    });
    // `null` puts who steers back to ownership
    await upsertAgent(root, log, "ana", { principals: null });
    assertEquals((await log.agents())[0].principals, undefined);
    // a person alone: a row, and no folder of its own
    await upsertAgent(root, log, "sol", { set: { mind: false } }, { docs });
    assertEquals((await log.agents()).find((a) => a.agentId === "sol")?.runs, false);
    assertEquals(await Deno.stat(`${root}/data/agents/sol`).catch(() => null), null);
  });
});

Deno.test("upsertAgent: what it refuses, it refuses before a row is written", async () => {
  await withOrg(async (root, log) => {
    for (const bad of ["Ana", "no way", "-ana", "ana.b", "a".repeat(32), ""]) {
      await assertRejects(
        () => upsertAgent(root, log, bad),
        Error,
        "a name is a folder and a unix user",
      );
    }
    await assertRejects(
      () => upsertAgent(root, log, "bot", { principals: ["ghost"] }),
      Error,
      'names "ghost", not in the roster',
    );
    await assertRejects(
      () => upsertAgent(root, log, "bot", { set: { effort: "extreme" as never } }),
      Error,
      'unknown effort "extreme"',
    );
    await assertRejects(
      () => upsertAgent(root, log, "bot", { set: { colour: "red" } as never }),
      Error,
      'unknown setting "colour"',
    );
    // the provider can run the model at the effort it is given: refused here, not mid-turn
    await assertRejects(
      () => upsertAgent(root, log, "bot", { set: { provider: "google", model: "claude-x" } }),
      Error,
      "is not a google model",
    );
    // the pair is held to the org's other half
    await assertRejects(
      () => upsertAgent(root, log, "bot", { set: { keepRecent: 60_000 } }),
      Error,
      "keepRecent must be a positive number below compactAt",
    );
    assertEquals(await log.agents(), []);
    assertEquals(await log.config(), []);
    // an agent may name itself, and anyone
    await upsertAgent(root, log, "bot", { principals: ["bot"] });
    await upsertAgent(root, log, "sonar", { principals: "*" });
    assertEquals((await log.agents()).map((a) => a.principals), [["bot"], "*"]);
  });
});

Deno.test("every key has one owner: a command refuses what the file declares, and changes the rest", async () => {
  await withOrg(async (root, log) => {
    await assertRejects(
      () => upsertAgent(root, log, "dubiku", { set: { model: "claude-y" } }),
      Error,
      "agents.dubiku.model is declared in config.yaml; edit it there",
    );
    await assertRejects(
      () => upsertAgent(root, log, "dubiku", { identity: { email: "x@y.z" } }),
      Error,
      "agents.dubiku.identity.email is declared in config.yaml",
    );
    await assertRejects(
      () => upsertAgent(root, log, "dubiku", { unset: ["model"] }),
      Error,
      "agents.dubiku.model is declared",
    );
    // what the file leaves out is the command's
    await upsertAgent(root, log, "dubiku", { identity: { name: "Dubi" }, set: { effort: "high" } });
    assertEquals((await readConfig(root, log)).agents.dubiku, {
      identity: { name: "Dubi", email: "d@org.example", phone: null },
      model: "claude-x",
      effort: "high",
    });
    // and a boot puts the file's word back over nothing the command set
    await applyFile(root, log);
    assertEquals((await readConfig(root, log)).agents.dubiku.effort, "high");
    // the file's agent is the file's to remove
    await assertRejects(
      () => removeAgent(root, log, "dubiku"),
      Error,
      "agents.dubiku is declared in config.yaml; remove it there first",
    );
  }, "agents:\n  dubiku:\n    identity:\n      email: d@org.example\n    model: claude-x\n");
});

Deno.test("removeAgent: total — its rows, its scope and its folder; refused while it steers another", async () => {
  await withOrg(async (root, log) => {
    const docs = onFiles(`${root}/data`);
    await upsertAgent(root, log, "ana", { set: { model: "claude-x" } }, { docs });
    await upsertAgent(root, log, "ventas", { principals: ["ana"] }, { docs });
    await log.upsertConnections([{ service: "slack", address: "T1:U1", agentId: "ana" }]);
    await assertRejects(() => removeAgent(root, log, "ghost"), Error, "no agent named ghost");
    await assertRejects(
      () => removeAgent(root, log, "ana"),
      Error,
      "ana is a principal of ventas",
    );
    await Deno.stat(`${root}/data/agents/ana`); // a refusal took nothing
    await removeAgent(root, log, "ventas");
    await removeAgent(root, log, "ana");
    assertEquals(await log.agents(), []);
    assertEquals(await log.config(), []);
    assertEquals(await log.connections(), []);
    assertEquals(await Deno.stat(`${root}/data/agents/ana`).catch(() => null), null);
    // the name added again is the agent coming back: a row, and a folder laid anew
    assertEquals((await upsertAgent(root, log, "ana", {}, { docs })).made, true);
    await Deno.stat(`${root}/data/agents/ana/instructions.md`);
  });
});

Deno.test("poke: with no main running the rows stand, and the answer is null", async () => {
  await withOrg(async (root) => {
    assertEquals(await poke(root, { agent: "ana" }), null);
  });
});

Deno.test("a connection is declared in the store with what its door decided, and taken out unless the file declares it", async () => {
  await withOrg(async (root, log) => {
    assertEquals(await declareConnection(log, "slack"), true);
    assertEquals(await declareConnection(log, "acme", { port: 1234 }), true);
    assertEquals(await declareConnection(log, "acme", { port: 5678 }), false); // left as found
    assertEquals((await readConfig(root, log)).connections, {
      slack: {},
      acme: { port: 1234 },
      sonar: { rooms: true },
    });
    assertEquals(await undeclareConnection(root, log, "acme"), true);
    assertEquals(await undeclareConnection(root, log, "acme"), false);
    await assertRejects(
      () => undeclareConnection(root, log, "sonar"),
      Error,
      "connections.sonar is declared in config.yaml; remove it from config.yaml first",
    );
    assertEquals(Object.keys((await readConfig(root, log)).connections), ["slack", "sonar"]);
  }, "connections:\n  sonar:\n    rooms: true\n");
});

Deno.test("ensureRoute: a room's first line makes its agent, nobody steering it, and routes the room; a second room is one merge", async () => {
  await withOrg(async (root, log) => {
    const docs = onFiles(`${root}/data`);
    await log.upsertConnections([{
      service: "sonar",
      address: "t1",
      credentialKey: "sonar:t1",
      extra: { raw: true },
    }]);
    const route = { service: "sonar", connection: "t1" };
    assertEquals(
      await ensureRoute(root, log, { ...route, room: "room-ana", agent: "ana" }, {
        identity: { name: "Ana", email: "ana@org.example" },
      }, { docs }),
      { made: true },
    );
    assertEquals(
      await ensureRoute(root, log, { ...route, room: "room-bo", agent: "bo" }, {
        principals: ["ana"],
      }),
      { made: true },
    );
    // the agent stands: only the route moves
    assertEquals(
      await ensureRoute(root, log, { ...route, room: "room-ana-2", agent: "ana" }),
      { made: false },
    );
    const rows = await log.agents();
    assertEquals(rows.map((a) => [a.agentId, a.name, a.principals]), [
      ["ana", "Ana", []],
      ["bo", undefined, ["ana"]],
    ]);
    assertEquals((await log.connection("sonar", "t1"))?.extra, {
      raw: true,
      mirrors: { rooms: { ana: "room-ana-2", bo: "room-bo" } },
    });
    assertEquals(
      (await log.aliases()).map((a) => [a.agentId, a.conversation]).sort(),
      [["ana", "room-ana-2"], ["bo", "room-bo"]],
    );
    await Deno.stat(`${root}/data/agents/ana/instructions.md`);
  });
});

Deno.test("the roster listed: whose word each agent is, whether it runs, its last turn — and who is idle", async () => {
  await withOrg(async (root, log) => {
    const now = Date.parse("2026-11-13T00:00:00.000Z");
    const long = now - 40 * 86_400_000;
    await upsertAgent(root, log, "stale", {}, { now: long });
    await upsertAgent(root, log, "fresh", {}, { now: long });
    await upsertAgent(root, log, "paused", { set: { mind: false } }, { now: long });
    await log.meter({
      created_at: "2026-11-10T00:00:00.000Z",
      agent_id: "fresh",
      model: "claude-x",
      input_tokens: 1,
      output_tokens: 1,
    });
    assertEquals(await members(root, log), [
      { agentId: "declared", declared: true, runs: true },
      { agentId: "fresh", declared: false, runs: true, last: "2026-11-10T00:00:00.000Z" },
      { agentId: "paused", declared: false, runs: false },
      { agentId: "stale", declared: false, runs: true },
    ]);
    // idle: nothing declares it, it runs, and no turn in 30 days
    assertEquals(await idleAgents(root, log, now), ["stale"]);
  }, "agents:\n  declared: {}\n");
});

Deno.test("an agent's uid is pinned by its name: the POSIX cksum, as the shell computes it", () => {
  // `printf %s sonar | cksum` and `printf %s a | cksum`
  assertEquals(cksum("sonar"), 3946747136);
  assertEquals(cksum("a"), 1220704766);
});
