import { assertEquals } from "@std/assert";
import { type Log, openLog } from "./log.ts";

/** The lock lives in the log's DB, so a second `openLog` on the same dir is another
 *  process's view of the same lease (§2). */
async function withLogs(fn: (a: Log, b: Log) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const a = await openLog(dir);
  const b = await openLog(dir);
  try {
    await fn(a, b);
  } finally {
    await a.close();
    await b.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("acquire is exclusive; release frees; safe to release when not held", async () => {
  await withLogs(async (one, two) => {
    const a = one.lock("turn-a1");
    const b = two.lock("turn-a1"); // another process's view of the same lock

    assertEquals(await a.acquire(), "acquired");
    assertEquals(await b.acquire(), "held");
    await a.release();
    assertEquals(await b.acquire(), "acquired"); // freed — a clean acquire, not a steal
    await b.release();
    await b.release(); // idempotent — a stale steal may have removed it already
  });
});

Deno.test("a stale lock (crashed holder) is stolen after TTL — and reported as a steal", async () => {
  await withLogs(async (one, two) => {
    const crashed = one.lock("turn-a1", 50); // 50ms TTL
    assertEquals(await crashed.acquire(), "acquired");
    // the crashed holder never releases…
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(await two.lock("turn-a1", 50).acquire(), "stolen"); // the stealer sweeps
    await two.lock("turn-a1", 50).release();
  });
});

Deno.test("two stealers race for one stale lease: exactly one wins", async () => {
  await withLogs(async (one, two) => {
    assertEquals(await one.lock("turn-a1", 50).acquire(), "acquired");
    await new Promise((r) => setTimeout(r, 80));
    // the steal is ONE atomic statement, so the loser sees a fresh lease, not a second steal
    const first = await one.lock("turn-a1", 50).acquire();
    const second = await two.lock("turn-a1", 50).acquire();
    assertEquals([first, second], ["stolen", "held"]);
  });
});

Deno.test("held: true only for a live, unexpired holder", async () => {
  await withLogs(async (one) => {
    const lock = one.lock("turn-a1", 50);
    assertEquals(await lock.held(), false); // nothing there
    await lock.acquire();
    assertEquals(await lock.held(), true); // live
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(await lock.held(), false); // expired — invoke; acquire will steal
    await lock.release();
  });
});

Deno.test("independent agents lock independently", async () => {
  await withLogs(async (one) => {
    assertEquals(await one.lock("turn-a1").acquire(), "acquired");
    assertEquals(await one.lock("turn-a2").acquire(), "acquired"); // different agent
    await one.lock("turn-a1").release();
    await one.lock("turn-a2").release();
  });
});
