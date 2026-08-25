import { assert, assertEquals, assertRejects } from "@std/assert";
import { type ConnectorSpec, ensureConnectorConfig, ensureOrgConfig } from "./config.ts";

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

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a connector heals its subsection into the file — values, comments, defaults", async () => {
  await withDir(async (dir) => {
    const cfg = await ensureConnectorConfig<{ port: number; things: string[] }>(dir, SPEC);
    assertEquals(cfg, { port: 9999, things: ["a"] });
    const raw = await Deno.readTextFile(`${dir}/config.jsonc`);
    assert(raw.includes('"acme"'), "the subsection landed");
    assert(raw.includes("// the port"), "the spec's comments landed");
    // a set value survives the next heal and wins over the default
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      raw.replace('"port": 9999', '"port": 1234'),
    );
    assertEquals((await ensureConnectorConfig<{ port: number }>(dir, SPEC)).port, 1234);
  });
});

Deno.test("an unknown key in the subsection is a boot error", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      JSON.stringify({ connections: { acme: { prot: 1234 } } }),
    );
    await assertRejects(
      () => ensureConnectorConfig(dir, SPEC),
      Error,
      'unknown key "connections.acme.prot"',
    );
  });
});

Deno.test("a check failure is a boot error naming the key", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      JSON.stringify({ connections: { acme: { things: [] } } }),
    );
    await assertRejects(
      () => ensureConnectorConfig(dir, SPEC),
      Error,
      "connections.acme.things must be a non-empty array",
    );
  });
});

Deno.test("main preserves subsections it does not know; a foreign heal keeps them too", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      JSON.stringify({ connections: { custom: { anything: true } } }),
    );
    const org = await ensureOrgConfig(dir); // heals the harness sections around it
    assertEquals(org.connections.custom, { anything: true });
    await ensureConnectorConfig(dir, SPEC); // another connector heals ITS subsection
    const again = await ensureOrgConfig(dir);
    assertEquals(again.connections.custom, { anything: true }, "the foreign subsection survived");
    assertEquals(again.connections.acme, { port: 9999, things: ["a"] });
  });
});

Deno.test("a connections subsection that is not an object is a boot error", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      JSON.stringify({ connections: { acme: 5 } }),
    );
    await assertRejects(() => ensureOrgConfig(dir), Error, "connections.acme must be an object");
  });
});
