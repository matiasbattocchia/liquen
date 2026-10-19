import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/jsonc";
import { linked, PACKAGE, packageCommands, pinned, scaffoldTasks, syncTasks } from "./update.ts";

Deno.test("syncTasks: what the org lacks is added in its own lines; what it has stays its own", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const raw = [
      "// the org",
      "{",
      '  "tasks": {',
      '    "start": "deno run -A --env-file=.env @liquen/liquen/start",',
      '    "schedule": "deno run -A @liquen/liquen/schedule",',
      '    "bench": "deno run -A bench.ts" // ours',
      "  }",
      "}",
      "",
    ].join("\n");
    Deno.writeTextFileSync(`${tmp}/deno.jsonc`, raw);
    const scaffold = await scaffoldTasks();
    const { added, differing } = await syncTasks(tmp, scaffold);
    assertEquals(added, Object.keys(scaffold).filter((n) => n !== "start" && n !== "schedule"));
    assertEquals(differing.map(([n]) => n), ["schedule"]);
    const after = Deno.readTextFileSync(`${tmp}/deno.jsonc`);
    const tasks = (parse(after) as { tasks: Record<string, unknown> }).tasks;
    assertEquals(tasks.schedule, "deno run -A @liquen/liquen/schedule"); // never rewritten
    assertEquals(tasks.stop, scaffold.stop);
    assertEquals(tasks.start, scaffold.start); // the package's command, now described
    assertEquals(tasks.bench, "deno run -A bench.ts");
    assert(after.startsWith("// the org\n{\n"), "the comments survive");
    assert(after.includes('"bench": "deno run -A bench.ts", // ours'));
    // a second sync has nothing to add
    assertEquals((await syncTasks(tmp, scaffold)).added, []);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("every task the scaffold ships runs a module the package exports", async () => {
  const exports = (await import("../deno.json", { with: { type: "json" } })).default.exports;
  for (const [name, task] of Object.entries(await scaffoldTasks())) {
    const command = typeof task === "string" ? task : task.command;
    const [, entry] = /@liquen\/liquen\/(\S+)/.exec(command) ?? [];
    assert(entry !== undefined && `./${entry}` in exports, `${name}: ${command}`);
  }
});

Deno.test("pinned: the exact version the org's lock resolved the harness to", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmp}/deno.lock`,
      JSON.stringify({
        version: "5",
        specifiers: { "jsr:@std/jsonc@1": "1.0.2", [`jsr:${PACKAGE}@0.1`]: "0.1.32" },
      }),
    );
    assertEquals(pinned(tmp), "0.1.32");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("pinned: an org with no lock, or a lock without us, pins nothing", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertEquals(pinned(tmp), null);
    Deno.writeTextFileSync(`${tmp}/deno.lock`, JSON.stringify({ version: "5" }));
    assertEquals(pinned(tmp), null);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("linked: a checkout standing in for the registry is the org's version, and is said so", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const org = `${tmp}/org`, checkout = `${tmp}/liquen`;
    Deno.mkdirSync(org), Deno.mkdirSync(checkout);
    Deno.writeTextFileSync(`${checkout}/deno.json`, JSON.stringify({ name: PACKAGE }));
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ // the org\n  "links": ["../liquen"]\n}`);
    assertEquals(linked(org), `${org}/../liquen`);
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "links": [${JSON.stringify(checkout)}] }`);
    assertEquals(linked(org), checkout); // absolute links are taken as they are
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "links": ["../elsewhere"] }`);
    assertEquals(linked(org), null); // a link to something that is not the harness is not ours
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "imports": {} }`);
    assertEquals(linked(org), null); // the shape every deployed org has
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("syncTasks: a package task whose command the release no longer has goes; an org's is named", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const raw = [
      "{",
      '  "tasks": {',
      '    "turns": {',
      '      "command": "deno run -A --env-file=.env @liquen/liquen/turns",',
      '      "description": "each agent\'s last turns"',
      "    },",
      '    "mine": "deno run -A @liquen/liquen/turns --limit 5", // ours',
      '    "gone": "deno run -A @liquen/liquen/gone"',
      "  }",
      "}",
      "",
    ].join("\n");
    Deno.writeTextFileSync(`${tmp}/deno.jsonc`, raw);
    const { removed, broken } = await syncTasks(tmp, {}, ["log", "start"]);
    assertEquals(removed, ["turns", "gone"]);
    assertEquals(broken, ["mine"]);
    const after = Deno.readTextFileSync(`${tmp}/deno.jsonc`);
    assertEquals(
      after,
      [
        "{",
        '  "tasks": {',
        '    "mine": "deno run -A @liquen/liquen/turns --limit 5" // ours',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("the release's commands are its manifest's exports, by subpath", async () => {
  const commands = (await packageCommands())!;
  assert(commands.includes("log"));
  assert(commands.includes("start"));
  assert(!commands.includes(""));
});

Deno.test("a checkout's release is its deno.json: the version and the exports", async () => {
  const { read } = await import("./package.ts");
  const manifest = (await import("../deno.json", { with: { type: "json" } })).default;
  const here = await read(new URL("./update.ts", import.meta.url).href);
  assertEquals(here.version, manifest.version);
  assertEquals(here.exports, manifest.exports);
});
