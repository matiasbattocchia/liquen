import { assertEquals } from "@std/assert";
import {
  calendarEntries,
  datedLines,
  docEntries,
  nearestYear,
  ruleTakes,
  todayOn,
} from "./agenda.ts";
import type { CalendarData, MessageEvent } from "./types.ts";

const NOV4 = { year: 2026, month: 11, day: 4 };

Deno.test("a yearless date is the one nearest today", () => {
  assertEquals(nearestYear(11, 7, NOV4), 2026);
  assertEquals(nearestYear(1, 3, { year: 2026, month: 12, day: 20 }), 2027); // the January coming
  assertEquals(nearestYear(12, 28, { year: 2027, month: 1, day: 5 }), 2026); // the December gone
  assertEquals(nearestYear(2, 29, { year: 2027, month: 3, day: 1 }), 2028); // a year that holds it
  assertEquals(nearestYear(2, 30, NOV4), undefined);
});

Deno.test("a dated line: status, moment, text with its tags, the grounding left in the doc", () => {
  const [line] = datedLines(
    "- [ ] @7 Nov 17:30 Leo V graba su set #grabacion (2 Nov, 8be1d0)",
    NOV4,
  );
  assertEquals(line, {
    status: "open",
    day: { year: 2026, month: 11, day: 7 },
    at: 17 * 60 + 30,
    slot: "17:30",
    text: "Leo V graba su set #grabacion",
  });
  const lines = datedLines(
    [
      "- @4 Nov cumple de Lu",
      "- [x] @4 Nov 2027 9:05-10:00 dentista",
      "* @2026-11-04 8:00 caminar",
      "- Leo @7 Nov graba", // the moment follows the status, or the line is undated
      "- @31 Nov nada", // no such date
      "- @4 Nov 25:00 tampoco",
    ].join("\n"),
    NOV4,
  );
  assertEquals(lines.map((l) => [l.status, l.day.year, l.slot, l.text]), [
    [undefined, 2026, undefined, "cumple de Lu"],
    ["done", 2027, "9:05-10:00", "dentista"],
    [undefined, 2026, "8:00", "caminar"],
  ]);
});

Deno.test("a heading tags its block; the title and fenced examples tag nothing", () => {
  const body = [
    "# Grabaciones",
    "- @4 Nov 9:00 sin columna",
    "## Por grabar",
    "- @4 Nov 17:30 Leo V graba su set #grabacion",
    "```",
    "- @4 Nov 10:00 un ejemplo",
    "```",
    "## Hecho",
    "- @4 Nov 11:00 Ringo",
    "- @5 Nov 11:00 mañana",
  ].join("\n");
  assertEquals(docEntries("memories/grabaciones", body, NOV4), [
    { at: 540, slot: "9:00", text: "sin columna", tail: "memories/grabaciones" },
    {
      at: 1050,
      slot: "17:30",
      text: "Leo V graba su set #grabacion",
      tail: "memories/grabaciones › Por grabar",
    },
    { at: 660, slot: "11:00", text: "Ringo", tail: "memories/grabaciones › Hecho" },
  ]);
  // a checkbox stays on the line, so a done item reads as done
  assertEquals(
    docEntries("todo", "- [x] @4 Nov pagar la luz\n- [ ] @4 Nov llamar a Sam", NOV4)
      .map((e) => e.text),
    ["[x] pagar la luz", "[ ] llamar a Sam"],
  );
});

Deno.test("a repeat after the moment reads as the rule it says, its words left out", () => {
  const rule = (words: string) => datedLines(`- @3 Nov 2026 18:00 ${words} x`, NOV4)[0];
  assertEquals(rule("every day").rule, "FREQ=DAILY");
  assertEquals(rule("every 2 weeks").rule, "FREQ=WEEKLY;INTERVAL=2");
  assertEquals(rule("every Tue").rule, "FREQ=WEEKLY;BYDAY=TU");
  assertEquals(rule("every tuesday, Thu and sat").rule, "FREQ=WEEKLY;BYDAY=TU,TH,SA");
  assertEquals(rule("every last Fri").rule, "FREQ=MONTHLY;BYDAY=-1FR");
  assertEquals(rule("every 1st Mon").rule, "FREQ=MONTHLY;BYDAY=1MO");
  assertEquals(rule("every month").rule, "FREQ=MONTHLY");
  assertEquals(rule("every year").rule, "FREQ=YEARLY");
  assertEquals(rule("every Tue until 15 Dec").rule, "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215");
  assertEquals(rule("every Tue until 2 Feb").rule, "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270202");
  assertEquals(rule("every Tue until 2027-03-02").rule, "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270302");
  assertEquals(rule("every Tue until 31 Nov"), undefined); // no such date
  // a word that only starts like one is text, and so is the line
  assertEquals(rule("every Tuesdays").rule, undefined);
  assertEquals(rule("every guest brings wine").text, "every guest brings wine x");
  assertEquals(
    datedLines("- @3 Nov 2026 18:00 every Tue Clase de inglés (28 Oct, e52aa0)", NOV4)[0],
    {
      day: { year: 2026, month: 11, day: 3 },
      at: 18 * 60,
      slot: "18:00",
      rule: "FREQ=WEEKLY;BYDAY=TU",
      every: "every Tue",
      text: "Clase de inglés",
    },
  );
});

Deno.test("a repeating line shows on each day its rule takes, never before its first", () => {
  const body = [
    "# Mars",
    "- @3 Nov 2026 18:00 every Tue Clase de inglés (28 Oct, e52aa0)",
    "## Cumples",
    "- @11 Nov every year Vivian",
    "- @1 Dec every 2 weeks until 29 Dec Feria",
  ].join("\n");
  const on = (month: number, day: number, year = 2026) =>
    docEntries("profiles/mars", body, { year, month, day });
  assertEquals(on(11, 10), [
    {
      at: 1080,
      slot: "18:00",
      text: "Clase de inglés",
      tail: "profiles/mars, every Tue",
    },
  ]);
  assertEquals(on(11, 11), [
    { text: "Vivian", tail: "profiles/mars › Cumples, every year" },
  ]);
  assertEquals(on(10, 27), []); // a Tuesday before the first
  assertEquals(on(11, 11, 2027).map((e) => e.text), ["Vivian"]);
  assertEquals(on(12, 15).map((e) => e.text), ["Clase de inglés", "Feria"]);
  assertEquals(on(12, 8).map((e) => e.text), ["Clase de inglés"]); // the week between
  assertEquals(on(12, 29).map((e) => e.text), ["Clase de inglés", "Feria"]);
  assertEquals(on(1, 12, 2027).map((e) => e.text), ["Clase de inglés"]); // past its last
});

Deno.test("the section: the whole day first, then by the minute, ties as they came", () => {
  assertEquals(
    todayOn([
      { at: 1050, slot: "17:30", text: "graba Leo", tail: "memories/grabaciones" },
      { text: "cumple de Lu", tail: "profiles/lu" },
      { at: 540, slot: "9:00", text: "mandar los recordatorios", tail: "wake · id ab12" },
    ]),
    [
      "today — 3:",
      "· cumple de Lu — profiles/lu",
      "· 9:00 mandar los recordatorios — wake · id ab12",
      "· 17:30 graba Leo — memories/grabaciones",
    ],
  );
  assertEquals(todayOn([]), []);
});

Deno.test("a rule takes the days RFC 5545 gives it", () => {
  const mon = { year: 2026, month: 9, day: 14 }; // a Monday
  const on = (y: number, m: number, d: number) => ({ year: y, month: m, day: d });
  assertEquals(ruleTakes("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", mon, on(2026, 9, 28)), true);
  assertEquals(ruleTakes("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", mon, on(2026, 9, 21)), false);
  assertEquals(ruleTakes("FREQ=WEEKLY;BYDAY=MO,WE", mon, on(2026, 9, 16)), true);
  assertEquals(ruleTakes("FREQ=WEEKLY", mon, on(2026, 9, 15)), false);
  assertEquals(ruleTakes("FREQ=DAILY;COUNT=3", mon, on(2026, 9, 16)), true);
  assertEquals(ruleTakes("FREQ=DAILY;COUNT=3", mon, on(2026, 9, 17)), false);
  assertEquals(ruleTakes("FREQ=DAILY;UNTIL=20260920", mon, on(2026, 9, 21)), false);
  assertEquals(ruleTakes("FREQ=MONTHLY;BYDAY=-1FR", mon, on(2026, 10, 30)), true);
  assertEquals(ruleTakes("FREQ=MONTHLY;BYDAY=2TU", mon, on(2026, 10, 13)), true);
  assertEquals(ruleTakes("FREQ=MONTHLY", mon, on(2026, 11, 14)), true);
  assertEquals(ruleTakes("FREQ=YEARLY", on(1990, 11, 4), NOV4), true);
  assertEquals(ruleTakes("FREQ=YEARLY", on(1990, 11, 4), on(2026, 12, 4)), false);
  assertEquals(ruleTakes("FREQ=WEEKLY;BYDAY=MO", mon, on(2026, 9, 7)), false); // before the start
});

let n = 0;
function row(
  data: CalendarData,
  action?: "edit" | "delete",
  ref?: string,
): MessageEvent {
  n++;
  return {
    id: `0000000${n}`,
    ts: "2026-10-01T12:00:00.000Z",
    type: "message",
    envelope: {
      service: "google",
      connection_address: "me@x.com",
      conversation: { address: "me@x.com", kind: "broadcast", name: "Personal" },
      external_id: action ? `${ref}:${n}` : `calendar:me@x.com:${data.gid}`,
    },
    ...(action ? { payload: { action, ref_external_id: ref } } : {}),
    parts: [{ type: "data", kind: "calendar", data }],
  } as unknown as MessageEvent;
}

Deno.test("the calendar's day: last state, whole days, series and what left them", () => {
  const zone = "America/Argentina/Buenos_Aires";
  const rows = [
    row({
      gid: "a",
      title: "Dentista",
      start: "2026-11-04T17:30:00-03:00",
      end: "2026-11-04T18:15:00-03:00",
      loc: "Clínica",
    }),
    row({ gid: "b", title: "Feriado", start: "2026-11-03", end: "2026-11-05" }),
    row({ gid: "c", title: "Otro día", start: "2026-11-05T10:00:00-03:00" }),
    // moved onto today by an edit: the last state is the one that counts
    row({ gid: "d", title: "Pablo", start: "2026-11-02T18:00:00-03:00" }),
    row(
      { gid: "d", title: "Pablo", start: "2026-11-04T08:00:00-03:00" },
      "edit",
      "calendar:me@x.com:d",
    ),
    // gone
    row({ gid: "e", title: "Cancelado", start: "2026-11-04T12:00:00-03:00" }),
    row({ gid: "e" }, "delete", "calendar:me@x.com:e"),
    // a weekly series on Wednesdays, and one whose today an occurrence of its own took
    row({
      gid: "s",
      title: "Yoga",
      start: "2026-10-07T07:00:00-03:00",
      end: "2026-10-07T08:00:00-03:00",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
    }),
    row({ gid: "t", title: "Matías B", start: "2026-10-07T19:00:00-03:00", rrule: "FREQ=WEEKLY" }),
    row(
      {
        gid: "t_1",
        series: "t",
        was: "2026-11-04T19:00:00-03:00",
        title: "Matías B",
        start: "2026-11-05T19:00:00-03:00",
      },
      "edit",
      "calendar:me@x.com:t_1",
    ),
    // a series with its today cancelled
    row({
      gid: "u",
      title: "Inglés",
      start: "2026-10-07T20:00:00-03:00",
      rrule: "FREQ=WEEKLY",
      exdates: ["2026-11-04T20:00:00-03:00"],
    }),
  ];
  assertEquals(todayOn(calendarEntries(rows, NOV4, zone)), [
    "today — 4:",
    "· Feriado — calendar Personal",
    "· 7:00-8:00 Yoga — calendar Personal",
    "· 8:00 Pablo — calendar Personal",
    "· 17:30-18:15 Dentista — calendar Personal, in Clínica",
  ]);
});
