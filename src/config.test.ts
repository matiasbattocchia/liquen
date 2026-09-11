import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  connectorConfig,
  type ConnectorSpec,
  declareAgent,
  declareConnection,
  findRoot,
  materialize,
  orgFlag,
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
        org: {
          timezone: "Europe/Madrid",
          locale: "es_ES.UTF-8",
          agent: { effort: "low" },
        },
        system: { debounceMs: 0 },
      }),
    );
    const cfg = await readConfig(root);
    assertEquals(cfg.org.timezone, "Europe/Madrid");
    assertEquals(cfg.org.locale, "es_ES.UTF-8");
    assertEquals(cfg.org.agent.effort, "low");
    assertEquals(cfg.org.agent.model, "claude-sonnet-5"); // the default filled in
    assertEquals(cfg.system.debounceMs, 0);
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
          ana: { effort: "low", identity: { name: "Ana", phone: "+549...", email: null } },
          bo: {},
        },
      }),
    );
    const cfg = await readConfig(root);
    assertEquals(Object.keys(cfg.agents), ["ana", "bo"]);
    assertEquals(cfg.agents.ana, {
      effort: "low",
      identity: { name: "Ana", phone: "+549...", email: null },
    });
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

Deno.test("starterConfig: the machine's locale, LC_ALL over LANG, and C is none", () => {
  const was = { LC_ALL: Deno.env.get("LC_ALL"), LANG: Deno.env.get("LANG") };
  const setEnv = (k: string, v: string | undefined) =>
    v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    setEnv("LC_ALL", undefined);
    setEnv("LANG", "es_AR.UTF-8");
    assertEquals(starterConfig().org.locale, "es_AR.UTF-8");
    setEnv("LC_ALL", "en_US.UTF-8");
    assertEquals(starterConfig().org.locale, "en_US.UTF-8");
    setEnv("LC_ALL", undefined);
    setEnv("LANG", "C.UTF-8");
    assertEquals(starterConfig().org.locale, null);
    setEnv("LANG", undefined);
    assertEquals(starterConfig().org.locale, null);
  } finally {
    setEnv("LC_ALL", was.LC_ALL);
    setEnv("LANG", was.LANG);
  }
});

Deno.test("materialize: the whole catalog, commented, and it reads back verbatim", async () => {
  await withDir(async (root) => {
    const cfg = starterConfig();
    cfg.agents.ana = { identity: { name: "Ana", email: null, phone: null } };
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
    const raw = materialize(starterConfig(), [SPEC]);
    await Deno.writeTextFile(`${root}/config.jsonc`, raw);

    assertEquals(await declareConnection(root, "slack"), true);
    assertEquals((await readConfig(root)).connections, { slack: {} });
    const after = await Deno.readTextFile(`${root}/config.jsonc`);
    assert(after.includes("// the model an agent runs on"), "the comments survive");
    assertEquals(after.replace('\n    "slack": {}', ""), raw); // one line, nothing else

    // a second service joins the same block with what its door decided, and declaring
    // twice is not a second line — nor a rewrite of what the operator has since edited
    assertEquals(await declareConnection(root, "acme", { port: 1234 }), true);
    assertEquals(await declareConnection(root, "slack"), false);
    assertEquals(await declareConnection(root, "acme", { port: 5678 }), false);
    assertEquals((await readConfig(root)).connections, { slack: {}, acme: { port: 1234 } });
  });
});

Deno.test("declareAgent: the roster entry with every handle in view, every other byte as it was", async () => {
  await withDir(async (root) => {
    const raw = materialize(starterConfig(), [SPEC]);
    await Deno.writeTextFile(`${root}/config.jsonc`, raw);

    await declareAgent(root, "ana", { name: "Ana Pérez", phone: "+34600" });
    assertEquals((await readConfig(root)).agents, {
      ana: { identity: { name: "Ana Pérez", email: null, phone: "+34600" } },
    });
    const after = await Deno.readTextFile(`${root}/config.jsonc`);
    assert(after.includes("// the model an agent runs on"), "the comments survive");
    // the entry is the only change, under the roster's comment: strip its lines and the
    // file is what init wrote
    const entry = [
      '\n    "ana": {',
      '      "identity": {',
      '        "name": "Ana Pérez",',
      '        "email": null,',
      '        "phone": "+34600"',
      "      }",
      "    }",
    ].join("\n");
    assert(after.indexOf("// <name>: any org.agent key re-declared") < after.indexOf('"ana"'));
    assertEquals(after.replace(entry, ""), raw);

    // a second agent follows the first; the same name twice is refused, the file untouched
    await declareAgent(root, "bo", {});
    assertEquals(Object.keys((await readConfig(root)).agents), ["ana", "bo"]);
    const twice = await Deno.readTextFile(`${root}/config.jsonc`);
    await assertRejects(() => declareAgent(root, "ana", {}), Error, "already in the roster");
    assertEquals(await Deno.readTextFile(`${root}/config.jsonc`), twice);

    // the roster's grammar, refused before anything is written
    for (const bad of ["Ana", "no way", "-ana", "ana.b", "a".repeat(32), ""]) {
      await assertRejects(
        () => declareAgent(root, bad, {}),
        Error,
        "a name is a folder and a unix user",
      );
    }
    assertEquals(await Deno.readTextFile(`${root}/config.jsonc`), twice);
  });
});

Deno.test("findRoot: the nearest config.jsonc up from cwd names the org", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, "{}");
    await Deno.mkdir(`${root}/data/agents/ana`, { recursive: true });
    assertEquals(findRoot({ from: `${root}/data/agents/ana` }), await Deno.realPath(root));
    assertThrows(() => findRoot({ from: "/usr/lib" }), Error, "not inside a liquen org");
  });
});

Deno.test("findRoot: --dir names the org wherever liquen runs, and must be one itself", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, "{}");
    assertEquals(findRoot({ dir: root, from: "/usr/lib" }), await Deno.realPath(root));
    assertThrows(() => findRoot({ dir: `${root}/nowhere` }), Error, "is not a liquen project");
  });
});

Deno.test("orgFlag: strips --dir in both spellings and leaves the rest in order", () => {
  assertEquals(orgFlag(["a", "--dir", "/x", "b"]), { dir: "/x", args: ["a", "b"] });
  assertEquals(orgFlag(["--dir=/y", "--agent", "ana"]), { dir: "/y", args: ["--agent", "ana"] });
  assertEquals(orgFlag(["hello"]), { dir: undefined, args: ["hello"] });
});

Deno.test("the reader tells an absent file from an unreadable one — only absence is the defaults", async () => {
  await withDir(async (root) => {
    await Deno.mkdir(`${root}/config.jsonc`); // a directory where the file should be
    await assertRejects(() => readConfig(root));
  });
});

Deno.test("an agent's model, maxTokens and provider are type-checked", async () => {
  for (
    const bad of [
      { model: 42 },
      { model: "" },
      { maxTokens: "lots" },
      { maxTokens: 0 },
      { maxTokens: 1.5 },
      { provider: 1 },
    ]
  ) {
    await withDir(async (root) => {
      await Deno.writeTextFile(
        `${root}/config.jsonc`,
        JSON.stringify({ agents: { ana: bad } }),
      );
      await assertRejects(() => readConfig(root), Error, "ana", JSON.stringify(bad));
    });
  }
});

Deno.test("the roster's principals and mind: names must be in the roster, mind a boolean", async () => {
  await withDir(async (root) => {
    const write = (agents: unknown) =>
      Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ agents }));
    await write({ matias: {}, ventas: { principals: ["matias"] }, sol: { mind: false } });
    const cfg = await readConfig(root);
    assertEquals(cfg.agents.ventas.principals, ["matias"]);
    assertEquals(cfg.agents.sol.mind, false);
    await write({ ventas: { principals: ["nobody"] } });
    await assertRejects(() => readConfig(root), Error, 'names "nobody", not in the roster');
    await write({ ventas: { principals: "matias" } });
    await assertRejects(() => readConfig(root), Error, "must be a list of roster names");
    await write({ sol: { mind: "no" } });
    await assertRejects(() => readConfig(root), Error, "must be true or false");
  });
});

Deno.test("declareAgent: --principal and --no-mind land as the entry's own keys", async () => {
  await withDir(async (root) => {
    await Deno.writeTextFile(`${root}/config.jsonc`, materialize(starterConfig(), [SPEC]));
    await declareAgent(root, "matias", {});
    await declareAgent(root, "sol", { name: "Sol" }, { mind: false });
    await declareAgent(root, "ventas", { phone: "549117770000" }, {
      principals: ["matias", "sol"],
    });
    const { agents } = await readConfig(root);
    assertEquals(agents.sol, { identity: { name: "Sol", email: null, phone: null }, mind: false });
    assertEquals(agents.ventas, {
      identity: { name: null, email: null, phone: "549117770000" },
      principals: ["matias", "sol"],
    });
    // a principal has to be in the roster already — the door refuses before writing
    const before = await Deno.readTextFile(`${root}/config.jsonc`);
    await assertRejects(
      () => declareAgent(root, "bot", {}, { principals: ["ghost"] }),
      Error,
      '"ghost" is not in the roster',
    );
    assertEquals(await Deno.readTextFile(`${root}/config.jsonc`), before);
  });
});

Deno.test("org.agent.mind: the org's default, an entry's override, and a boolean or nothing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/config.jsonc`, materialize(starterConfig()));
    assertEquals((await readConfig(root)).org.agent.mind, true); // materialized, on by default

    // the whole org paused, one agent kept awake by its own entry
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { agent: { mind: false } }, agents: { ana: {}, sol: { mind: true } } }),
    );
    const cfg = await readConfig(root);
    assertEquals(cfg.org.agent.mind, false);
    assertEquals(cfg.agents.ana.mind, undefined); // sparse: inherits the org's
    assertEquals(cfg.agents.sol.mind, true);

    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ org: { agent: { mind: "no" } } }),
    );
    await assertRejects(() => readConfig(root), Error, "mind must be true or false");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
