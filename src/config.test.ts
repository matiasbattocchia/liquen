import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  connectorConfig,
  type ConnectorSpec,
  declareConnection,
  findRoot,
  materialize,
  readConfig,
  starterConfig,
} from "./config.ts";

const SPEC: ConnectorSpec = {
  name: "acme",
  doc: "acme — a test connector",
  entries: [
    { key: "port", value: 9999, doc: "the port" },
    {
      key: "things",
      value: ["a"],
      doc: "the things",
      check: (v) => Array.isArray(v) && v.length > 0 ? null : "must be a non-empty array",
    },
  ],
};

async function withDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("the reader only reads: an absent file is the defaults, and stays absent", async () => {
  await withDir(async (root) => {
    const cfg = await readConfig(root);
    assertEquals(cfg.org.agent.tools, ["search", "schedule", "cancel", "bash"]);
    assertEquals(cfg.agents, {});
    await assertRejects(() => Deno.stat(`${root}/config.jsonc`), Deno.errors.NotFound);
  });
});

Deno.test("a sparse file: a set key wins, a left-out key defaults", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({
        org: { timezone: "Europe/Madrid", agent: { effort: "low" } },
        system: { debounceMs: 0 },
      }),
    );
    const cfg = await readConfig(root);
    assertEquals(cfg.org.timezone, "Europe/Madrid");
    assertEquals(cfg.org.agent.effort, "low");
    assertEquals(cfg.org.agent.model, "claude-sonnet-5"); // the default filled in
    assertEquals(cfg.system.debounceMs, 0);
    assertEquals(cfg.system.stopTimeoutMs, 5000);
  });
});

Deno.test("an unknown section or key is a boot error — a typo must not run silently", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ sytem: {} }));
    await assertRejects(() => readConfig(root), Error, 'unknown section "sytem"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { agent: { modle: "x" } } }),
    );
    await assertRejects(() => readConfig(root), Error, 'unknown key "org.agent.modle"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { backlogHours: 24, model: "x" } }),
    );
    await assertRejects(() => readConfig(root), Error, 'unknown key "org.model"');
  });
});

Deno.test("the roster: agents.<name> — sparse overrides, identity handles, checked names", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({
        agents: {
          ana: { effort: "low", identity: { phone: "+549..." } },
          bo: {},
        },
      }),
    );
    const cfg = await readConfig(root);
    assertEquals(Object.keys(cfg.agents), ["ana", "bo"]);
    assertEquals(cfg.agents.ana, { effort: "low", identity: { phone: "+549..." } });
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ agents: { ana: { timezone: "UTC" } } }),
    );
    // the clock is the org's — no per-agent seat
    await assertRejects(() => readConfig(root), Error, 'unknown key "agents.ana.timezone"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ agents: { ana: { identity: { fax: "1" } } } }),
    );
    await assertRejects(() => readConfig(root), Error, 'unknown key "agents.ana.identity.fax"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ agents: { "Ana!": {} } }));
    await assertRejects(() => readConfig(root), Error, "a folder and a unix user");
  });
});

Deno.test("org-level validation: timezone, backlogHours, an agent override's effort", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { timezone: "Mars/Olympus" } }),
    );
    await assertRejects(() => readConfig(root), Error, 'unknown timezone "Mars/Olympus"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ agents: { ana: { effort: "supreme" } } }),
    );
    await assertRejects(() => readConfig(root), Error, 'unknown effort "supreme"');
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { agent: { tools: "send" } } }),
    );
    await assertRejects(() => readConfig(root), Error, "tools must be an array of tool names");
  });
});

Deno.test("a connector reads its subsection over its defaults; nothing is written", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ connections: { acme: { port: 1234 } } }),
    );
    const cfg = await connectorConfig<{ port: number; things: string[] }>(root, SPEC);
    assertEquals(cfg, { port: 1234, things: ["a"] });
    const raw = await Deno.readTextFile(`${root}/config.jsonc`);
    assertEquals(raw, JSON.stringify({ connections: { acme: { port: 1234 } } }));
  });
});

Deno.test("a connector's unknown key and failed check are boot errors", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ connections: { acme: { prot: 1234 } } }),
    );
    await assertRejects(
      () => connectorConfig(root, SPEC),
      Error,
      'unknown key "connections.acme.prot"',
    );
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ connections: { acme: { things: [] } } }),
    );
    await assertRejects(
      () => connectorConfig(root, SPEC),
      Error,
      "connections.acme.things must be a non-empty array",
    );
  });
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ connections: { acme: 5 } }),
    );
    await assertRejects(() => readConfig(root), Error, "connections.acme must be an object");
  });
});

Deno.test("a subsection no connector claims passes through opaque", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ connections: { custom: { anything: true } } }),
    );
    assertEquals((await readConfig(root)).connections.custom, { anything: true });
  });
});

Deno.test("materialize: the whole catalog, commented, and it reads back verbatim", async () => {
  await withDir(async (root) => {
    const cfg = starterConfig(["ana"]);
    cfg.connections.acme = { port: 4321, things: ["x"] };
    const raw = materialize(cfg, [SPEC]);
    for (
      const comment of [
        "// the model an agent runs on",
        "// the org's clock (IANA)",
        "// acme — a test connector",
        "// the port",
      ]
    ) assert(raw.includes(comment), `${comment} present`);
    await Deno.writeTextFile(`${root}/config.jsonc`, raw);
    const back = await readConfig(root);
    assertEquals(back, cfg);
  });
});

Deno.test("declareConnection: the grant's own line, every other byte as it was", async () => {
  await withDir(async (root) => {
    const raw = materialize(starterConfig(["ana"]), [SPEC]);
    await Deno.writeTextFile(`${root}/config.jsonc`, raw);

    assertEquals(await declareConnection(root, "slack"), true);
    assertEquals((await readConfig(root)).connections, { slack: {} });
    const after = await Deno.readTextFile(`${root}/config.jsonc`);
    assert(after.includes("// the model an agent runs on"), "the comments survive");
    assertEquals(after.replace('\n    "slack": {}', ""), raw); // one line, nothing else

    // a second service joins the same block, and declaring twice is not a second line
    assertEquals(await declareConnection(root, "acme"), true);
    assertEquals(await declareConnection(root, "slack"), false);
    assertEquals(await declareConnection(root, "acme"), false);
    assertEquals((await readConfig(root)).connections, { slack: {}, acme: {} });
  });
});

Deno.test("findRoot: the nearest config.jsonc up from cwd names the org", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, "{}");
    await Deno.mkdir(`${root}/data/agents/ana`, { recursive: true });
    assertEquals(findRoot(`${root}/data/agents/ana`), await Deno.realPath(root));
    assertThrows(() => findRoot("/usr/lib"), Error, "not inside a mu project");
  });
});
