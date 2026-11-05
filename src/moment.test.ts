import { assert, assertEquals, assertThrows } from "@std/assert";
import { momentOf, zonedTime } from "./moment.ts";

Deno.test("zonedTime: a wall clock reading names one instant, and DST is the zone's own", () => {
  // the hour a spring-forward erases: 02:30 never happens in Madrid on 2026-03-29 —
  // the reading resolves just past the gap rather than inventing an offset
  assertEquals(
    new Date(zonedTime({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Madrid"))
      .toISOString(),
    "2026-03-29T01:30:00.000Z", // = 03:30 +02:00, the first instant the clock reads it
  );
  // the hour a fall-back repeats: 02:30 happens twice on 2026-10-25 — the FIRST pass wins
  assertEquals(
    new Date(zonedTime({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Madrid"))
      .toISOString(),
    "2026-10-25T00:30:00.000Z", // = 02:30 +02:00 (CEST), before the clocks go back
  );
  // and a reading that names no date at all is refused, never slid to a nearby one
  assertThrows(() => zonedTime({ year: 2026, month: 2, day: 31 }, "UTC"), RangeError);
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
