/**
 * org: the file applied to the store (§9) — a key it declares overwrites, a key it leaves
 * out keeps the store's value, an agent it does not name is left alone.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { applyFile, connectorConfig, readConfig } from "./org.ts";
import { openStore } from "./store/mod.ts";
import type { Log } from "./store/log.ts";

async function withOrg(fn: (root: string, log: Log) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, "{}");
  const log = await (await openStore(root)).log();
  try {
    await fn(root, log);
  } finally {
    await log.close();
    await Deno.remove(root, { recursive: true });
  }
}

const write = (root: string, yaml: string) => Deno.writeTextFile(`${root}/config.yaml`, yaml);

Deno.test("applyFile: a declared key overwrites the store's, a key left out keeps it, and taking a key out resets nothing", async () => {
  await withOrg(async (root, log) => {
    // what a command set while the org ran
    await log.setConfig([
      { scope: "shared.agents", key: "model", value: "claude-runtime" },
      { scope: "shared.agents", key: "effort", value: "high" },
    ]);
    await write(root, "shared:\n  timezone: Europe/Madrid\n  agents:\n    model: claude-file\n");
    const org = await applyFile(root, log);
    assertEquals(org.shared.agents.model, "claude-file"); // declared: the file's
    assertEquals(org.shared.agents.effort, "high"); // left out: the store's
    assertEquals(org.shared.agents.maxTokens, 64_000); // set nowhere: the catalog's
    assertEquals(org.shared.timezone, "Europe/Madrid");
    // the key leaves the file: it stops being pinned, and stays as it was
    await write(root, "shared:\n  timezone: Europe/Madrid\n");
    assertEquals((await applyFile(root, log)).shared.agents.model, "claude-file");
    assertEquals(await readConfig(root, log), await applyFile(root, log)); // idempotent
  });
});

Deno.test("applyFile: the agents it declares are made or changed key by key; one it does not name is left alone", async () => {
  await withOrg(async (root, log) => {
    await log.putAgents([{
      agentId: "runtime",
      mind: "mind@runtime",
      name: "Made by a command",
      since: "2026-01-01T00:00:00.000Z",
      settings: { model: "claude-own" },
    }, {
      agentId: "ana",
      mind: "mind@ana",
      name: "Ana",
      email: "old@org.example",
      principals: ["runtime"],
      since: "2026-02-02T00:00:00.000Z",
    }]);
    await write(
      root,
      "agents:\n  ana:\n    identity:\n      email: ana@org.example\n    effort: low\n  bo:\n    principals: ['*']\n",
    );
    await assertRejects(() => applyFile(root, log), Error, 'principals names "*"');
    await write(
      root,
      "agents:\n  ana:\n    identity:\n      email: ana@org.example\n    effort: low\n  bo:\n    principals: '*'\n",
    );
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    const org = await applyFile(root, log, now);
    assertEquals(await log.agents(), [
      {
        agentId: "ana",
        mind: "mind@ana",
        name: "Ana", // a handle the file leaves out stays
        email: "ana@org.example", // one it states replaces
        principals: ["runtime"], // principals it leaves out stay
        since: "2026-02-02T00:00:00.000Z", // the floor is never moved
      },
      // a new row's floor is its making, less the org's backlog
      { agentId: "bo", mind: "mind@bo", principals: "*", since: "2026-11-12T12:00:00.000Z" },
      {
        agentId: "runtime",
        mind: "mind@runtime",
        name: "Made by a command",
        since: "2026-01-01T00:00:00.000Z",
      },
    ]);
    assertEquals(org.agents.runtime.model, "claude-own");
    assertEquals(org.agents.ana.effort, "low");
    // a later boot moves no floor
    await applyFile(root, log, now + 86_400_000);
    assertEquals((await log.agents())[1].since, "2026-11-12T12:00:00.000Z");
  });
});

Deno.test("applyFile: the org as it would stand is checked whole, and a file boot cannot run writes nothing", async () => {
  await withOrg(async (root, log) => {
    await log.setConfig([{ scope: "shared.agents", key: "keepRecent", value: 40_000 }]);
    // each key is fine alone; together, with what the store holds, the pair is not
    await write(root, "shared:\n  agents:\n    compactAt: 30000\n    model: claude-x\n");
    await assertRejects(() => applyFile(root, log), Error, "keepRecent must be a positive number");
    assertEquals(await log.config(), [
      { scope: "shared.agents", key: "keepRecent", value: 40_000 },
    ]);
    await write(root, "agents:\n  ana:\n    principals: [ghost]\n");
    await assertRejects(() => applyFile(root, log), Error, 'names "ghost", not in the roster');
    assertEquals(await log.agents(), []);
  });
});

Deno.test("a connection the file declares stands in the store with its knobs; a connector reads them over its defaults", async () => {
  await withOrg(async (root, log) => {
    await write(root, "connections:\n  acme:\n    port: 4321\n  bare: {}\n");
    const org = await applyFile(root, log);
    assertEquals(org.connections, { acme: { port: 4321 }, bare: {} });
    const spec = {
      name: "acme",
      doc: "acme",
      entries: [{ key: "port", value: 9999, doc: "the port" }, {
        key: "host",
        value: "localhost",
        doc: "the host",
      }],
    };
    assertEquals(await connectorConfig<Record<string, unknown>>(root, spec, log), {
      port: 4321,
      host: "localhost",
      crowd: 20,
      busy: 40,
      follow: [],
    });
    await log.setConfig([{ scope: "connections.acme", key: "prot", value: 1 }]);
    await assertRejects(
      () => connectorConfig(root, spec, log),
      Error,
      'unknown key "connections.acme.prot"',
    );
  });
});
