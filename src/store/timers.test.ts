/**
 * timers: the scheduler's rows (§10) — the one non-log fact about the future. Armed by the
 * `schedule` tool, scanned by the clock, consumed on firing: one-shot rows vanish, cron rows
 * advance PAST NOW so an outage costs one late fire, never a burst of catch-up ones.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { openLog } from "./log.ts";
import { nextFire, type TimerRow, zonedTime } from "./timers.ts";

const wake = (over: Partial<TimerRow> = {}): Omit<TimerRow, "id" | "armedAt"> => ({
  agentId: "ana",
  sessionId: "mind", // the row is the SESSION's — keyed by the (agent, session) pair (§4)
  fireAt: "2026-09-01T17:00:00.000Z",
  note: "call the clinic",
  conversation: "mind@ana",
  ...over,
});

Deno.test("timers: a one-shot fires once and is gone", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const t = log.arm(wake());
    assert(t.id.length > 0, "the row is armed with an id — cancel's handle");
    assertEquals(log.due("2026-09-01T16:59:00.000Z"), []); // not yet
    assertEquals(log.due("2026-09-01T17:00:00.000Z").map((r) => r.id), [t.id]); // due AT the moment
    log.settle(t.id, "2026-09-01T17:00:00.000Z");
    assertEquals(log.due("2026-09-02T00:00:00.000Z"), []); // consumed
    assertEquals(log.timers("ana", "mind"), []);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timers: a cron advances past NOW — a week down fires once, not 168 times", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const t = log.arm(wake({ cron: "0 9 * * *", fireAt: "2026-09-01T09:00:00.000Z" }));
    // the org was down for a week; the clock's first pass fires it ONCE
    const now = "2026-09-08T11:30:00.000Z";
    assertEquals(log.due(now).map((r) => r.id), [t.id]);
    log.settle(t.id, now);
    const [after] = log.timers("ana", "mind");
    assertEquals(after.fireAt, "2026-09-09T09:00:00.000Z"); // the next 09:00 after now
    assertEquals(after.cron, "0 9 * * *"); // still armed — a cron is forever
    assertEquals(log.due(now), []); // and not due again in the same pass
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timers: a cron advances on the clock it was armed against, not UTC", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    // "0 9" said in Madrid means 9 on Madrid's wall EVERY fire — an advance that fell back
    // to UTC would silently shift the second fire to 10:00 or 11:00 local
    const t = log.arm(wake({ cron: "0 9 * * *", fireAt: "2026-09-08T07:00:00.000Z" }));
    log.settle(t.id, "2026-09-08T11:30:00.000Z", "Europe/Madrid");
    const [after] = log.timers("ana", "mind");
    assertEquals(after.fireAt, "2026-09-09T07:00:00.000Z"); // 09:00 CEST, not 09:00Z
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timers: rows outlive the process — recovery is just reading them", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const t = log.arm(wake({ refId: "use-1", cron: "*/5 * * * *" }));
  await log.close();
  const reopened = await openLog(dir);
  try {
    const [row] = reopened.timers("ana", "mind");
    assertEquals(row, {
      id: t.id,
      agentId: "ana",
      sessionId: "mind",
      fireAt: "2026-09-01T17:00:00.000Z",
      cron: "*/5 * * * *",
      note: "call the clinic",
      conversation: "mind@ana",
      refId: "use-1",
      armedAt: t.armedAt, // stamped at arm — the other half of an alarm's provenance
    });
  } finally {
    await reopened.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timers: a wake is the session's — disarm is theirs alone, and the list is next-first", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    const late = log.arm(wake({ fireAt: "2026-09-03T10:00:00.000Z", note: "later" }));
    const soon = log.arm(wake({ fireAt: "2026-09-02T10:00:00.000Z", note: "sooner" }));
    // bo's session shares ana's bare name — the PAIR is what keeps them apart (§4)
    const theirs = log.arm(wake({ agentId: "bo", note: "bo's" }));
    assertEquals(log.timers("ana", "mind").map((r) => r.note), ["sooner", "later"]);
    assertEquals(log.disarm(theirs.id, "ana", "mind"), false); // not ana's to unset (§6)
    assertEquals(log.timers("bo", "mind").length, 1);
    assertEquals(log.disarm(soon.id, "ana", "mind"), true);
    assertEquals(log.timers("ana", "mind").map((r) => r.id), [late.id]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("nextFire: the fields a human writes, on the org's clock", () => {
  const from = "2026-09-01T12:34:56.000Z"; // a Tuesday
  // strictly after, on the minute
  assertEquals(nextFire("* * * * *", from), "2026-09-01T12:35:00.000Z");
  assertEquals(nextFire("0 9 * * *", from), "2026-09-02T09:00:00.000Z"); // 09:00 has passed
  assertEquals(nextFire("*/15 * * * *", from), "2026-09-01T12:45:00.000Z");
  assertEquals(nextFire("0 9 * * 1", from), "2026-09-07T09:00:00.000Z"); // next Monday
  assertEquals(nextFire("30 8 1 * *", from), "2026-10-01T08:30:00.000Z"); // the 1st, month wrap
  assertEquals(nextFire("0 0 29 2 *", from), "2028-02-29T00:00:00.000Z"); // leap day, years out

  // the zone is the ORG's: "0 9" means nine in Buenos Aires (UTC-3), i.e. 12:00Z
  assertEquals(
    nextFire("0 9 * * *", from, "America/Argentina/Buenos_Aires"),
    "2026-09-02T12:00:00.000Z",
  );
  // …and the offset is measured AT the fire, so DST is the zone's problem, not ours
  assertEquals(
    nextFire("0 9 * * *", "2026-01-15T12:00:00.000Z", "Europe/Madrid"), // CET, +1
    "2026-01-16T08:00:00.000Z",
  );
  assertEquals(
    nextFire("0 9 * * *", "2026-07-15T12:00:00.000Z", "Europe/Madrid"), // CEST, +2
    "2026-07-16T07:00:00.000Z",
  );

  // both day fields restricted ⇒ EITHER may match (the crontab convention)
  assertEquals(nextFire("0 0 5 * 0", from), "2026-09-05T00:00:00.000Z"); // Sat the 5th (dom)
  assertEquals(nextFire("0 0 5 * 3", from), "2026-09-02T00:00:00.000Z"); // Wed the 2nd (dow)
});

Deno.test("zonedTime: a wall clock reading names one instant, and DST is the zone's own", () => {
  // the hour a spring-forward erases: 02:30 never happens in Madrid on 2026-03-29 —
  // the reading resolves just past the gap rather than inventing an offset
  assertEquals(
    new Date(zonedTime({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Madrid"))
      .toISOString(),
    "2026-03-29T01:30:00.000Z", // = 03:30 +02:00, the first instant the clock reads it
  );
  // the hour a fall-back repeats: 02:30 happens twice on 2026-10-25 — the FIRST pass wins,
  // so a daily cron fires once that day, not twice
  assertEquals(
    new Date(zonedTime({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Madrid"))
      .toISOString(),
    "2026-10-25T00:30:00.000Z", // = 02:30 +02:00 (CEST), before the clocks go back
  );
  // and a reading that names no date at all is refused, never slid to a nearby one
  assertThrows(() => zonedTime({ year: 2026, month: 2, day: 31 }, "UTC"), RangeError);
});

Deno.test("nextFire: a malformed expression is refused, not silently never-fired", () => {
  assertThrows(() => nextFire("0 9 * *", "2026-09-01T00:00:00.000Z"), Error, "five fields");
  assertThrows(() => nextFire("99 * * * *", "2026-09-01T00:00:00.000Z"), Error, "out of range");
  assertThrows(() => nextFire("0 9 * * *", "not a time"), Error, "bad timestamp");
  assertThrows(() => nextFire("0 0 30 2 *", "2026-09-01T00:00:00.000Z"), Error, "never fires");
});
