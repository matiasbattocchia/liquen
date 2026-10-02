/**
 * The SQLite adapter runs the timers suite; the cron arithmetic beside it is pure and runs
 * once, over no store.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fireAtOf, momentOf, nextFire, type When, zonedTime } from "./timers.ts";
import { timersSuite } from "./suite/timers.ts";
import { sqlite } from "./suite/mod.ts";

timersSuite(sqlite);

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

Deno.test("fireAtOf: one way of saying when, inside the horizon", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const tz = "America/Argentina/Buenos_Aires";
  assertEquals(fireAtOf({ in: "20m" }, tz, now), "2026-09-01T12:20:00.000Z");
  assertEquals(fireAtOf({ at: "2026-09-01T17:00" }, tz, now), "2026-09-01T20:00:00.000Z");
  assertEquals(fireAtOf({ at: "2026-09-01T17:00Z" }, tz, now), "2026-09-01T17:00:00.000Z");
  // a cron's first fire is the next one strictly after now, on the org's clock
  assertEquals(fireAtOf({ cron: "*/15 8-21 * * 1-5" }, tz, now), "2026-09-01T12:15:00.000Z");
  const bad = (when: When, word: string) => {
    const err = assertThrows(() => fireAtOf(when, tz, now), Error);
    assert(err.message.includes(word), `${err.message} should mention ${word}`);
  };
  bad({}, "say when");
  bad({ in: "20m", cron: "0 9 * * *" }, "pick one");
  bad({ in: "nope" }, "not a delay");
  bad({ at: "tomorrow" }, "not a moment");
  bad({ at: "2020-01-01T09:00" }, "already passed");
  bad({ in: "99w" }, "more than a year out");
});

Deno.test("momentOf: a stamp as the lines show it reads back on the org's clock", () => {
  const tz = "America/Argentina/Buenos_Aires";
  const now = Date.parse("2026-10-02T20:56:00.000Z"); // 2 Oct 17:56 on that clock
  assertEquals(momentOf("2 Oct 17:36", tz, now), "2026-10-02T20:36:00.000Z");
  assertEquals(momentOf("2 Oct 2026 17:36", tz, now), "2026-10-02T20:36:00.000Z");
  assertEquals(momentOf("2 oct", tz, now), "2026-10-02T03:00:00.000Z");
  // with no year, the nearest such date: last December from January, next January from
  // December
  const january = Date.parse("2027-01-05T12:00:00.000Z");
  assertEquals(momentOf("28 Dec 9:00", tz, january), "2026-12-28T12:00:00.000Z");
  const december = Date.parse("2026-12-30T12:00:00.000Z");
  assertEquals(momentOf("3 Jan 9:00", tz, december), "2027-01-03T12:00:00.000Z");
  // 29 Feb is a date only in a leap year among the candidates
  const leapish = Date.parse("2027-11-10T12:00:00.000Z");
  assertEquals(momentOf("29 Feb", tz, leapish), "2028-02-29T03:00:00.000Z");
  for (const spec of ["2 Oct 17", "2 Octubre 17:36", "31 Feb 9:00", "2 Oct 25:00", "Oct 2"]) {
    const err = assertThrows(() => momentOf(spec, tz, now), Error);
    assert(err.message.includes("not a moment"), err.message);
  }
});
