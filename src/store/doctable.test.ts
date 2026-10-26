/**
 * The SQLite docs table runs the docs suite, and answers for what is the file's own: the
 * table lives in `log.db` beside the log and the vault, and the store opens it there where
 * the catalog puts the docs in the table.
 */

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { docsSuite } from "./suite/docs.ts";
import { sqliteDocs } from "./suite/mod.ts";
import { openStore } from "./mod.ts";

docsSuite(sqliteDocs);

Deno.test("openStore: docs in the table are a table of log.db, beside the log and the vault", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/config.jsonc`,
      JSON.stringify({ deployment: { docs: "table" } }),
    );
    const store = await openStore(root);
    const log = await store.log();
    const vault = await store.vault();
    const docs = await store.docs();
    try {
      assertEquals(docs.on, "table");
      assertEquals(
        await docs.as!({ agent: "a1" }).write("agent/memories/x", "---\nkind: memory\n---\nx"),
        "wrote 22 bytes to agent/memories/x",
      );
      await vault.put({ key: "token:x", value: { token: "t" } });
      const db = new DatabaseSync(`${root}/data/log/log.db`, { readOnly: true });
      try {
        const tables = (db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('docs', 'events', 'credentials') ORDER BY name",
        ).all() as { name: string }[]).map((r) => r.name);
        assertEquals(tables, ["credentials", "docs", "events"]);
      } finally {
        db.close();
      }
      // nothing of the docs is a file under the data root
      assertEquals(
        await Deno.stat(`${root}/data/agents/a1/memories/x.md`).then(() => true, () => false),
        false,
      );
    } finally {
      await docs.close();
      await vault.close();
      await log.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
