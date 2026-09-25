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
  });
  assertEquals(databaseOf("/org/data", "postgres://liquen@db:5432/liquen?sslmode=require"), {
    engine: "postgres",
    url: "postgres://liquen@db:5432/liquen?sslmode=require",
    schema: "public",
  });
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
