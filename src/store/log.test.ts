/**
 * The SQLite adapter runs the log suite, and answers for what is the engine's own: the
 * migrations a live file takes on open, the index a bounded read walks, and the write
 * lock's patience.
 */

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { type Log, openLog } from "./log.ts";
import type { Draft, MessageEvent } from "../types.ts";
import { logSuite } from "./suite/log.ts";
import { sqlite } from "./suite/mod.ts";

logSuite(sqlite);

async function withLog(fn: (log: Log, dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await fn(log, dir);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const msg = (id: string, conversation: string, text: string): MessageEvent => ({
  id,
  ts: `2026-07-16T00:00:${id}Z`,
  type: "message",
  envelope: {
    service: "local",
    connection_address: "org",
    conversation: { address: conversation },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("migrate v6: a pre-sessions log settles on the pair vocabulary (§4, §7)", async () => {
  const dir = await Deno.makeTempDir();
  // an old-shaped database: agent-id session stamps, `mind:` rooms, version 5
  const first = await openLog(dir);
  await first.publish({
    ts: "2026-08-30T10:00:00.000Z",
    type: "message",
    agent: { id: "ana", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@ana" },
    },
    parts: [{ type: "text", kind: "text", text: "dale" }],
  } as Draft<MessageEvent>);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `UPDATE events SET session_id = 'ana', conversation_address = 'mind:ana';
   UPDATE memberships SET conversation_address = 'mind:ana';
   PRAGMA user_version = 5;`,
  );
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    const [e] = await log.read();
    assertEquals(e.agent, { id: "ana", session_id: "mind" });
    assertEquals(e.envelope.conversation.address, "mind@ana");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v9: a log from before named wakes opens, and its timers take a handle", async () => {
  const dir = await Deno.makeTempDir();
  const first = await openLog(dir);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `DROP INDEX timers_named;
   ALTER TABLE timers DROP COLUMN name;
   PRAGMA user_version = 8;`,
  );
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  await log.close();
  const again = new DatabaseSync(`${dir}/log.db`);
  try {
    const cols = (again.prepare("SELECT name FROM pragma_table_info('timers')").all() as {
      name: string;
    }[]).map((c) => c.name);
    assert(cols.includes("name"));
    assert(again.prepare("SELECT 1 FROM sqlite_master WHERE name = 'timers_named'").get());
  } finally {
    again.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("events are indexed by timestamp — a time-bounded read does not scan", async () => {
  await withLog((_log, dir) => {
    const db = new DatabaseSync(`${dir}/log.db`, { readOnly: true });
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
    ).all() as { name: string }[]).map((r) => r.name);
    db.close();
    assertEquals(names.includes("events_timestamp"), true);
    return Promise.resolve();
  });
});

Deno.test("publish outlasts a writer holding the lock past the busy timeout (slow)", async () => {
  await withLog(async (log, dir) => {
    // another PROCESS holds the write lock for longer than busy_timeout
    const holder = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync("${dir}/log.db");
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       await new Promise((r) => setTimeout(r, 5_600));
       db.exec("COMMIT");
       db.close();`,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const reader = holder.stdout.getReader();
    await reader.read(); // "held"
    reader.releaseLock();
    await holder.stdout.cancel();
    const e = (await log.publish(msg("01", "c1", "hola")))!;
    assertEquals(e.type, "message");
    await holder.status;
  });
});
