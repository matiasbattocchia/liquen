/**
 * agenda.ts: the anchor's `today` section (§5), read off the calendar's events the log
 * holds, the dated lines of the agent's memories and the session's wakes.
 *
 * A dated line is a list item whose moment follows its status:
 *
 *   - [ ] @7 Nov 17:30 Leo V graba su set #grabacion (2 Nov, 8be1d0)
 *
 * The status is optional, and so are the year (the nearest such date to today, as a stamp
 * the model was shown reads back, `momentOf`), the time (a line for the whole day) and an
 * end (`17:30-18:30`). The text keeps its `#tags`; the grounding that closes a memory entry
 * stays in the doc. The nearest heading under the doc's title names the line's block: a
 * board's `##` headings are its columns, and the heading tags its block as a `#tag` tags a
 * line.
 *
 * The section lists the whole day, past hours included, so it moves only when what the day
 * holds moves, never with the clock: the anchor is rewritten every step, and a section that
 * stands still is the one a cache keeps.
 */

import type { CalendarData, CalendarPart, MessageEvent } from "./types.ts";
import { clockOf } from "./render.ts";
import { MONTHS } from "./store/timers.ts";

/** A calendar date, month 1-based: a triple, not an instant. */
export interface Day {
  year: number;
  month: number;
  day: number;
}

/** One entry of the day: the minute it starts at (none for the whole day), the slot it
 *  prints (`17:30`, `17:30-18:30`), its words and where it comes from. */
export interface Entry {
  at?: number;
  slot?: string;
  text: string;
  tail: string;
}

/** A dated line of a doc, read off its body. */
export interface DatedLine {
  status?: "open" | "done";
  day: Day;
  at?: number;
  slot?: string;
  text: string;
  heading?: string;
}

/** The day `ts` falls on, on the org's clock. */
export function dayOf(ts: string, zone?: string): Day | undefined {
  const c = clockOf(ts, zone);
  return c ? { year: c.year, month: c.month + 1, day: c.day } : undefined;
}

function serial(d: Day): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 864e5;
}

function real(d: Day): boolean {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return t.getUTCFullYear() === d.year && t.getUTCMonth() === d.month - 1 &&
    t.getUTCDate() === d.day;
}

/** The year a yearless date means: of last year, this one and the next, the one whose date
 *  lies nearest `today`. A date some years lack (29 Feb) is read in the years that hold it. */
export function nearestYear(month: number, day: number, today: Day): number | undefined {
  const near = [today.year - 1, today.year, today.year + 1]
    .map((year) => ({ year, month, day }))
    .filter(real)
    .map((d) => ({ year: d.year, gap: Math.abs(serial(d) - serial(today)) }));
  if (near.length === 0) return undefined;
  return near.reduce((a, b) => b.gap < a.gap ? b : a).year;
}

const ITEM = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?@(.+)$/;
const SHOWN =
  /^(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?(?: (\d{1,2}):(\d{2})(?:\s*[-–]\s*(\d{1,2}):(\d{2}))?)?(?:\s+(.*))?$/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2})(?:\s*[-–]\s*(\d{1,2}):(\d{2}))?)?(?:\s+(.*))?$/;
/** A memory entry's grounding: the day it holds from, and the ids that taught it. */
const GROUND = /\s*\(\d{1,2} [A-Za-z]{3}[^()]*\)\s*$/;

/** A time of day as minutes, or nothing when it names no real minute. */
function minutes(h?: string, m?: string): number | undefined {
  if (h === undefined || m === undefined) return undefined;
  const hh = +h, mm = +m;
  return hh < 24 && mm < 60 ? hh * 60 + mm : undefined;
}

/** `17:30`, as every stamp the model reads spells a time. */
export function clock(at: number): string {
  return `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`;
}

/** The moment and words after a line's `@`, or nothing when they name no real date. */
function momentAndText(rest: string, today: Day) {
  const shown = SHOWN.exec(rest);
  const iso = shown ? null : ISO.exec(rest);
  let day: Day | undefined;
  let g: (string | undefined)[];
  if (shown) {
    const month = MONTHS.findIndex((m) => m.toLowerCase() === shown[2].toLowerCase()) + 1;
    if (month === 0) return undefined;
    const year = shown[3] ? +shown[3] : nearestYear(month, +shown[1], today);
    if (year === undefined) return undefined;
    day = { year, month, day: +shown[1] };
    g = shown.slice(4);
  } else if (iso) {
    day = { year: +iso[1], month: +iso[2], day: +iso[3] };
    g = iso.slice(4);
  } else return undefined;
  if (!real(day)) return undefined;
  const at = minutes(g[0], g[1]);
  const end = minutes(g[2], g[3]);
  if (g[0] !== undefined && at === undefined) return undefined;
  const slot = at === undefined
    ? undefined
    : end === undefined
    ? clock(at)
    : `${clock(at)}-${clock(end)}`;
  const text = (g[4] ?? "").replace(GROUND, "").trim();
  return { day, at, slot, text };
}

/** Every dated line of a doc's body, with the heading of the block it stands in. Fenced
 *  code is skipped: an example is no appointment. */
export function datedLines(body: string, today: Day): DatedLine[] {
  const out: DatedLine[] = [];
  let heading: string | undefined;
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1].length === 1 ? undefined : h[2];
      continue;
    }
    const item = ITEM.exec(line);
    if (!item) continue;
    const m = momentAndText(item[2], today);
    if (!m) continue;
    out.push({
      ...(item[1] !== undefined ? { status: item[1] === " " ? "open" : "done" } : {}),
      day: m.day,
      ...(m.at !== undefined ? { at: m.at, slot: m.slot } : {}),
      text: m.text,
      ...(heading ? { heading } : {}),
    });
  }
  return out;
}

/** A doc's lines dated `today`, as entries: a checkbox stays on the line, so a done item
 *  reads as done. */
export function docEntries(name: string, body: string, today: Day): Entry[] {
  return datedLines(body, today)
    .filter((l) => serial(l.day) === serial(today))
    .map((l) => ({
      ...(l.at !== undefined ? { at: l.at, slot: l.slot } : {}),
      text: `${l.status === "open" ? "[ ] " : l.status === "done" ? "[x] " : ""}${l.text}`,
      tail: l.heading ? `${name} › ${l.heading}` : name,
    }));
}

/* ── the calendar ──────────────────────────────────────────────────────────────────── */

/** An event as the log last holds it: its latest data, and the calendar it is in. */
interface Held {
  data: CalendarData;
  calendar: string;
  key: string;
}

function calendarPart(e: MessageEvent): CalendarPart | undefined {
  return e.parts?.find((p): p is CalendarPart => p.type === "data" && p.kind === "calendar");
}

/** The calendar's events the log holds, folded to their last state (`connect/calendar.ts`
 *  is the row grammar): an edit carries the whole event, a delete or a `deleted` stamp on
 *  the create takes it away, and a cancelled occurrence leaves its date out of the series.
 *  `skips` names a series' dates that a cancellation or an occurrence of its own took. */
function fold(rows: MessageEvent[]): { held: Held[]; skips: Set<string> } {
  const byRef = new Map<string, Held | null>();
  const skips = new Set<string>();
  for (const e of rows) {
    const part = calendarPart(e);
    const action = e.payload?.action;
    const ref = action === undefined ? e.envelope.external_id : e.payload?.ref_external_id;
    if (!ref) continue;
    const calendar = e.envelope.conversation.address;
    if (action === "delete") {
      byRef.set(ref, null);
      if (part?.data.series && part.data.was) {
        skips.add(`${calendar} ${part.data.series} ${part.data.was}`);
      }
      continue;
    }
    if (!part) continue;
    if (byRef.get(ref) === null) continue; // a gone event stays gone
    if (e.status?.state === "deleted") {
      byRef.set(ref, null);
      continue;
    }
    byRef.set(ref, {
      data: part.data,
      calendar: e.envelope.conversation.name ?? calendar,
      key: calendar,
    });
  }
  const held = [...byRef.values()].filter((h): h is Held => h !== null);
  for (const h of held) {
    if (h.data.series && h.data.was) skips.add(`${h.key} ${h.data.series} ${h.data.was}`);
  }
  return { held, skips };
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function weekday(d: Day): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether a BYDAY entry (`TU`, `2TU`, `-1FR`) takes `d` within its month. */
function byDay(entry: string, d: Day): boolean {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(entry);
  if (!m || WEEKDAYS.indexOf(m[2]) !== weekday(d)) return false;
  if (m[1] === undefined) return true;
  const n = +m[1];
  const nth = Math.ceil(d.day / 7);
  const fromEnd = Math.ceil((daysIn(d.year, d.month) - d.day + 1) / 7);
  return n > 0 ? nth === n : fromEnd === -n;
}

/** Whether one RRULE (RFC 5545) takes `d` for a series that starts on `start`: FREQ,
 *  INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, UNTIL and COUNT, weeks starting Monday. A part
 *  outside these (BYSETPOS, BYWEEKNO) is read as absent, so the series may show on a day
 *  it skips, never vanish from one it holds. */
export function ruleTakes(rule: string, start: Day, d: Day, zone?: string): boolean {
  const p = new Map(
    rule.replace(/^RRULE:/, "").split(";").map((kv) => kv.split("=") as [string, string]),
  );
  const freq = p.get("FREQ");
  const interval = +(p.get("INTERVAL") ?? 1) || 1;
  const until = p.get("UNTIL");
  if (until) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
    if (u) {
      const last = u[7]
        ? dayOf(`${u[1]}-${u[2]}-${u[3]}T${u[4]}:${u[5]}:${u[6]}Z`, zone)
        : { year: +u[1], month: +u[2], day: +u[3] };
      if (last && serial(d) > serial(last)) return false;
    }
  }
  const takes = (x: Day): boolean => {
    if (serial(x) < serial(start)) return false;
    const months = p.get("BYMONTH")?.split(",").map(Number);
    const days = p.get("BYDAY")?.split(",");
    const monthDays = p.get("BYMONTHDAY")?.split(",").map(Number);
    if (months && !months.includes(x.month)) return false;
    const onMonthDay = () =>
      monthDays
        ? monthDays.some((n) => n > 0 ? x.day === n : x.day === daysIn(x.year, x.month) + n + 1)
        : days
        ? days.some((e) => byDay(e, x))
        : x.day === start.day;
    switch (freq) {
      case "DAILY":
        return (serial(x) - serial(start)) % interval === 0 &&
          (!days || days.some((e) => byDay(e, x))) &&
          (!monthDays || onMonthDay());
      case "WEEKLY": {
        const monday = (y: Day) => serial(y) - (weekday(y) + 6) % 7;
        const weeks = (monday(x) - monday(start)) / 7;
        return weeks % interval === 0 &&
          (days ? days.some((e) => byDay(e, x)) : weekday(x) === weekday(start));
      }
      case "MONTHLY": {
        const gap = (x.year - start.year) * 12 + x.month - start.month;
        return gap % interval === 0 && onMonthDay();
      }
      case "YEARLY":
        return (x.year - start.year) % interval === 0 &&
          (months || x.month === start.month) && onMonthDay();
      default:
        return false;
    }
  };
  if (!takes(d)) return false;
  const count = p.get("COUNT");
  if (count === undefined) return true;
  // COUNT bounds the series by occurrences, so they are counted from its start
  let n = 0;
  for (let s = serial(start); s <= serial(d); s++) {
    const x = new Date(s * 864e5);
    if (takes({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() })) n++;
    if (n > +count) return false;
  }
  return true;
}

/** A stamp's day and minute on the org's clock; a bare date is the whole day. */
function placed(stamp: string, zone?: string): { day: Day; at?: number } | undefined {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp);
  if (bare) return { day: { year: +bare[1], month: +bare[2], day: +bare[3] } };
  const c = clockOf(stamp, zone);
  return c
    ? { day: { year: c.year, month: c.month + 1, day: c.day }, at: c.hour * 60 + c.minute }
    : undefined;
}

/** The calendar's events on `today`, from its rows in the log: a single event on the day it
 *  starts, a whole-day one on each day it spans, and a series on each day its rule takes,
 *  at its first occurrence's hour. */
export function calendarEntries(rows: MessageEvent[], today: Day, zone?: string): Entry[] {
  const { held, skips } = fold(rows);
  const t = serial(today);
  const out: Entry[] = [];
  for (const { data, calendar, key } of held) {
    if (!data.start) continue;
    const start = placed(data.start, zone);
    const end = data.end ? placed(data.end, zone) : undefined;
    if (!start) continue;
    let on: boolean;
    if (data.rrule) {
      const taken = data.rrule.split("\n").some((r) => ruleTakes(r, start.day, today, zone));
      const skipped = [
        ...(data.exdates ?? []),
        ...[...skips].flatMap((s) => {
          const [k, series, was] = s.split(" ");
          return k === key && series === data.gid ? [was] : [];
        }),
      ].some((x) => {
        const p = placed(x, zone);
        return p !== undefined && serial(p.day) === t;
      });
      on = taken && !skipped;
    } else if (start.at === undefined) {
      // a whole-day event's end is the day after its last
      on = serial(start.day) <= t && t < (end ? serial(end.day) : serial(start.day) + 1);
    } else on = serial(start.day) === t;
    if (!on) continue;
    const slot = start.at === undefined
      ? undefined
      : end?.at !== undefined && serial(end.day) === serial(start.day)
      ? `${clock(start.at)}-${clock(end.at)}`
      : clock(start.at);
    out.push({
      ...(start.at !== undefined ? { at: start.at, slot } : {}),
      text: data.title ?? "(untitled)",
      tail: `calendar ${calendar}${data.loc ? `, in ${data.loc}` : ""}`,
    });
  }
  return out;
}

/** The anchor's `today` section: the whole-day entries first, then the rest by the minute
 *  they start, ties in the order they came. Nothing on the day, no section. */
export function todayOn(entries: Entry[]): string[] {
  if (entries.length === 0) return [];
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at ?? -1) - (b.e.at ?? -1) || a.i - b.i)
    .map(({ e }) => e);
  return [
    `today — ${entries.length}:`,
    ...sorted.map((e) => `· ${e.slot ? `${e.slot} ` : ""}${e.text} — ${e.tail}`),
  ];
}
