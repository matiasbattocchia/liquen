import { assertEquals, assertRejects } from "@std/assert";
import { type Log, openLog } from "./log.ts";
import { LeaseLost, LOCK_TTL_MS } from "./lock.ts";
import type { Draft, Event } from "../types.ts";

/** A clock the test moves (§9): every lease comparison reads it, so a TTL is aged by
 *  advancing it rather than waited out. Starts at wall time so stamps stay plausible. */
function clock() {
  let skew = 0;
  return { now: () => Date.now() + skew, advance: (ms: number) => (skew += ms) };
}

/** The lock lives in the log's DB, so a second `openLog` on the same dir is another
 *  process's view of the same lease (§2). */
async function withLogs(
  fn: (a: Log, b: Log, dir: string, t: ReturnType<typeof clock>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const t = clock();
  const a = await openLog(dir, { now: t.now });
  const b = await openLog(dir, { now: t.now });
  try {
    await fn(a, b, dir, t);
  } finally {
    await a.close();
    await b.close();
    await Deno.remove(dir, { recursive: true });
  }
}

/** A holder whose PROCESS died: it took the lease and stopped heartbeating without ever
 *  releasing. Closing its view of the store is that exactly — the beats stop with it, so
 *  `seen` stands still. Returns the token the zombie would quote if it ever came back. */
async function crashedHolder(dir: string, name: string) {
  const dead = await openLog(dir);
  const lock = dead.lock(name);
  assertEquals(await lock.acquire(), "acquired");
  const stale = lock.lease();
  await dead.close();
  return stale;
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

Deno.test("a LIVE holder is never stolen from, however long its turn runs", async () => {
  // the one test that must wait real time: what it proves is that the heartbeat FIRES,
  // and a timer firing is the one thing a moved clock cannot stand in for
  await withLogs(async (one, two) => {
    const working = one.lock("turn-a1", 60);
    assertEquals(await working.acquire(), "acquired");
    await new Promise((r) => setTimeout(r, 300)); // five TTLs of honest work
    assertEquals(await two.lock("turn-a1", 60).acquire(), "held");
    assertEquals(await working.held(), true);
    await working.release();
  });
});

Deno.test("a crashed holder stops beating, and its lease is stolen after the TTL", async () => {
  await withLogs(async (one, _two, dir, t) => {
    await crashedHolder(dir, "turn-a1");
    assertEquals(await one.lock("turn-a1").acquire(), "held"); // still within the TTL
    t.advance(LOCK_TTL_MS + 1);
    const stealer = one.lock("turn-a1");
    assertEquals(await stealer.acquire(), "stolen"); // the stealer sweeps
    await stealer.release();
  });
});

Deno.test("a zombie cannot write the log: its turn's events are refused, the successor keeps the lease", async () => {
  await withLogs(async (one, _two, dir, t) => {
    // it held the lease, was declared dead, and comes back mid-publish still quoting it
    const stale = await crashedHolder(dir, "turn-a1");
    t.advance(LOCK_TTL_MS + 1);
    const successor = one.lock("turn-a1");
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
    await assertRejects(() => one.publishAndRelease([draft], stale), LeaseLost);

    // nothing landed — the successor is redoing this window, and two turns publishing one
    // window is exactly what the lease exists to prevent
    assertEquals((await one.read()).length, 0);
    assertEquals(await successor.held(), true); // and the lease it works under is untouched
    await successor.release();
  });
});

Deno.test("two stealers race for one stale lease: exactly one wins", async () => {
  await withLogs(async (one, two, dir, t) => {
    await crashedHolder(dir, "turn-a1");
    t.advance(LOCK_TTL_MS + 1);
    // the steal is ONE atomic statement, so the loser sees a fresh lease, not a second steal
    const winner = one.lock("turn-a1");
    const first = await winner.acquire();
    const second = await two.lock("turn-a1").acquire();
    assertEquals([first, second], ["stolen", "held"]);
    await winner.release();
  });
});

Deno.test("held: true while someone is beating, false once nobody is", async () => {
  await withLogs(async (one, _two, dir, t) => {
    const probe = one.lock("turn-a1");
    assertEquals(await probe.held(), false); // nothing there
    await crashedHolder(dir, "turn-a1");
    assertEquals(await probe.held(), true); // freshly stamped
    t.advance(LOCK_TTL_MS + 1);
    assertEquals(await probe.held(), false); // the beats stopped — invoke; acquire will steal
  });
});

Deno.test("closing the store ends every heartbeat it started", async () => {
  // an abandoned turn (stop() gave up waiting on it) must not keep beating into a DB that
  // is gone — and a process that closes its store has no holder left to speak for
  const dir = await Deno.makeTempDir();
  try {
    const log = await openLog(dir);
    const lock = log.lock("turn-a1", 60);
    assertEquals(await lock.acquire(), "acquired");
    await log.close(); // no release: the sanitizer would report a beat that survived this
  } finally {
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
