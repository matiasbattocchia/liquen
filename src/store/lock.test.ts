/**
 * The SQLite adapter runs the lock suite, and answers for the beat alone: a locker with no
 * change stream still reads its mark, one heartbeat late at most.
 */

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { CANCEL_SQL, createLocker, LOCKS_DDL, sqliteLeases } from "./lock.ts";
import { lockSuite } from "./suite/lock.ts";
import { sqlite } from "./suite/mod.ts";

lockSuite(sqlite);

Deno.test("the lease carries the interrupt: with no ring, the heartbeat reads the mark within a beat", async () => {
  const dir = await Deno.makeTempDir();
  const db = new DatabaseSync(`${dir}/locks.db`);
  db.exec(LOCKS_DDL);
  const locker = createLocker(sqliteLeases(db)); // no change stream: the beat is all there is
  try {
    const lock = locker.lock("turn-mind@ana", 60); // beats every 20ms
    assertEquals(await lock.acquire(), "acquired");
    const signal = lock.signal();
    db.prepare(CANCEL_SQL).run("turn-mind@ana"); // another process's control row, landed
    const t0 = Date.now();
    while (!signal.aborted && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    assertEquals(signal.aborted, true);
    await lock.release();
  } finally {
    locker.stop();
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
