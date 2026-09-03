import { assertEquals, assertRejects } from "@std/assert";
import { type Log, openLog } from "./log.ts";
import { LeaseLost } from "./lock.ts";
import type { Draft, Event } from "../types.ts";

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

/** A holder whose PROCESS died: it took the lease and stopped heartbeating without ever
 *  releasing. Closing its view of the store is that exactly — the beats can no longer land,
 *  so `seen` stands still and the lease goes stale on schedule. Returns the token the
 *  zombie would quote if it ever came back. */
async function crashedHolder(dir: string, name: string, ttlMs: number) {
  const dead = await openLog(dir);
  const lock = dead.lock(name, ttlMs);
  assertEquals(await lock.acquire(), "acquired");
  const stale = lock.lease();
  await dead.close();
  return stale;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

Deno.test("a LIVE holder is never stolen from, however long its turn runs", async () => {
  await withLogs(async (one, two) => {
    // the whole point of the heartbeat: `act` can sit on a ten-minute tool and `think` on a
    // model call plus its retry sleeps, and neither is confusable with a crash
    const working = one.lock("turn-a1", 60);
    assertEquals(await working.acquire(), "acquired");
    await sleep(300); // five TTLs of honest work
    assertEquals(await two.lock("turn-a1", 60).acquire(), "held");
    assertEquals(await working.held(), true);
    await working.release();
  });
});

Deno.test("a crashed holder stops beating, and its lease is stolen after the TTL", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await crashedHolder(dir, "turn-a1", 50);
    await sleep(150);
    const stealer = log.lock("turn-a1", 50);
    assertEquals(await stealer.acquire(), "stolen"); // the stealer sweeps
    await stealer.release();
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a zombie cannot write the log: its turn's events are refused, the successor keeps the lease", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    // it held the lease, was declared dead, and comes back mid-publish still quoting it
    const stale = await crashedHolder(dir, "turn-a1", 50);
    await sleep(150);
    const successor = log.lock("turn-a1", 50);
    assertEquals(await successor.acquire(), "stolen");

    const draft: Draft<Event> = {
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@a1" },
      },
      parts: [{ type: "text", kind: "text", text: "the turn nobody is waiting for" }],
    };
    await assertRejects(() => log.publishAndRelease([draft], stale), LeaseLost);

    // nothing landed — the successor is redoing this window, and two turns publishing one
    // window is exactly what the lease exists to prevent
    assertEquals((await log.read()).length, 0);
    assertEquals(await successor.held(), true); // and the lease it works under is untouched
    await successor.release();
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("two stealers race for one stale lease: exactly one wins", async () => {
  const dir = await Deno.makeTempDir();
  const one = await openLog(dir);
  const two = await openLog(dir);
  try {
    await crashedHolder(dir, "turn-a1", 50);
    await sleep(150);
    // the steal is ONE atomic statement, so the loser sees a fresh lease, not a second steal
    const winner = one.lock("turn-a1", 50);
    const first = await winner.acquire();
    const second = await two.lock("turn-a1", 50).acquire();
    assertEquals([first, second], ["stolen", "held"]);
    await winner.release();
  } finally {
    await one.close();
    await two.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("held: true while someone is beating, false once nobody is", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const probe = log.lock("turn-a1", 50);
    assertEquals(await probe.held(), false); // nothing there
    await crashedHolder(dir, "turn-a1", 50);
    assertEquals(await probe.held(), true); // freshly stamped
    await sleep(150);
    assertEquals(await probe.held(), false); // the beats stopped — invoke; acquire will steal
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("independent agents lock independently", async () => {
  await withLogs(async (one) => {
    const a1 = one.lock("turn-a1");
    const a2 = one.lock("turn-a2");
    assertEquals(await a1.acquire(), "acquired");
    assertEquals(await a2.acquire(), "acquired"); // different agent
    await a1.release();
    await a2.release();
  });
});
