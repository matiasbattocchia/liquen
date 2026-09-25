/**
 * The store's address: what the catalog's `system.database` resolves to, and that the
 * SQLite address opens the files where every local process expects them.
 */

import { assertEquals } from "@std/assert";
import { databaseOf, openStore, storeAt } from "./mod.ts";

Deno.test("databaseOf: null is SQLite under the data root; a URL is Postgres, its schema lifted off the query", () => {
  assertEquals(databaseOf("/org/data", null), { engine: "sqlite", dir: "/org/data" });
  assertEquals(databaseOf("/org/data", "postgres://liquen@db:5432/liquen?schema=acme"), {
    engine: "postgres",
    url: "postgres://liquen@db:5432/liquen",
    schema: "acme",
    dir: "/org/data",
    docs: "files",
  });
  assertEquals(
    databaseOf("/org/data", "postgres://liquen@db:5432/liquen?sslmode=require", "table"),
    {
      engine: "postgres",
      url: "postgres://liquen@db:5432/liquen?sslmode=require",
      schema: "public",
      dir: "/org/data",
      docs: "table",
    },
  );
});

Deno.test("storeAt: the SQLite store's docs are the files under its data root, seeded there", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const docs = await storeAt({ engine: "sqlite", dir }).docs();
    assertEquals(docs.on, "files");
    assertEquals(docs.as, undefined);
    assertEquals(
      await docs.bed.lay("agent", "a1", "memories/x", "---\nkind: memory\n---\nx"),
      true,
    );
    assertEquals(await docs.bed.lay("agent", "a1", "memories/x", "again"), false);
    assertEquals(await docs.bed.laid("agent", "a1", "memories"), true);
    assertEquals(
      (await docs.list({ agent: "a1" })).map((d) => d.header.handle),
      ["memories/x.md"],
    );
    await docs.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openStore: an org with no database knob opens log.db under data/log, log and vault on one file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/config.jsonc`, "{}");
    const store = await openStore(root);
    const log = await store.log();
    const vault = await store.vault();
    try {
      await vault.put({ key: "token:x", value: { token: "t" } });
      assertEquals((await Deno.stat(`${root}/data/log/log.db`)).isFile, true);
      // the same store through its explicit address answers what the vault wrote
      const again = await storeAt({ engine: "sqlite", dir: `${root}/data` }).vault();
      assertEquals((await again.get("token:x"))?.value, { token: "t" });
      await again.close();
    } finally {
      await vault.close();
      await log.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
