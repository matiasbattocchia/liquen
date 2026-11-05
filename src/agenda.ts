/**
 * agenda.ts: the anchor's `today` and `tomorrow` sections (§5), read off the calendar's
 * events the log holds and the dated lines of the agent's memories, and the reminders those
 * lines ask for, which the clock fires (§10).
 *
 * A dated line is a list item whose moment follows its status:
 *
 *   - [ ] @7 Nov 17:30 Leo V graba su set #grabacion (2 Nov, 8be1d0)
 *
 * The status is optional, and so are the year (the nearest such date to today, as a stamp
 * the model was shown reads back, `momentOf`), the time (a line for the whole day) and an
 * end (`17:30-18:30`). A repeat may follow the moment, which is then its first occurrence:
 *
 *   - @3 Nov 2026 18:00 every Tue Clase de inglés (28 Oct, e52aa0)
 *
 * `every day`, `every Tue Thu`, `every 2 weeks`, `every month`, `every last Fri`, `every
 * year`, each with an optional `until 15 Dec`, read as the RRULE `ruleTakes` judges a
 * calendar series by. `every 15 minutes` and `every 2 hours` step from the line's time, and
 * `from 19:30 to 12:00` keeps the steps inside a span of the day, across midnight when it
 * ends before it starts.
 *
 * A reminder may follow, and then the clock wakes the agent with the line:
 *
 *   - @7 Nov 17:30 remind 1 day before at 10:00 Leo V (2 Nov, a60609)
 *
 * `remind` alone is the moment itself, `remind 1 hour before` counts back from it, and
 * `remind at 9:00` or `remind 2 days before at 9:00` names the time on that day. A line for
 * the whole day has no moment to count back from, so its reminder names its time. A done
 * line reminds of nothing.
 *
 * The text keeps its `#tags`; the grounding that closes a memory entry stays in the doc.
 * The nearest heading under the doc's title names the line's block: a board's `##` headings
 * are its columns, and the heading tags its block as a `#tag` tags a line.
 *
 * A section lists the whole day, past hours included, so it moves only when what the day
 * holds moves, never with the clock: the anchor is rewritten every step, and a section that
 * stands still is the one a cache keeps.
 */

import type { CalendarData, CalendarPart, MessageEvent } from "./types.ts";
import type { DocHeader } from "./store/docs.ts";
import { clockOf } from "./render.ts";
import { MONTHS } from "./moment.ts";

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

/** When a line reminds: `back` minutes before its moment, or `days` before it at `at`. */
export type Remind = { back: number } | { days: number; at: number };

/** A dated line of a doc, read off its body. A repeating one names the words that said it
 *  and its rule: an RRULE for whole days, or a `step` of minutes kept inside a `span` of the
 *  day until its `last` day. Its `day` is the first occurrence. A reminding one names the
 *  words that said it too. */
export interface DatedLine {
  status?: "open" | "done";
  day: Day;
  at?: number;
  slot?: string;
  rule?: string;
  step?: number;
  span?: [number, number];
  last?: Day;
  every?: string;
  remind?: Remind;
  reminder?: string;
  text: string;
  heading?: string;
}

/** The day `ts` falls on, on the org's clock. */
export function dayOf(ts: string, zone?: string): Day | undefined {
  const c = clockOf(ts, zone);
  return c ? { year: c.year, month: c.month + 1, day: c.day } : undefined;
}

/** The minute `ts` falls on, on the org's clock, counted as a wall clock counts: the day's
 *  serial times a day's minutes, plus the minute of the day. The clock reads reminders this
 *  way, so a line at 9:00 fires at 9:00 on either side of a change of offset. */
export function wallOf(ts: string, zone?: string): number | undefined {
  const c = clockOf(ts, zone);
  return c
    ? serial({ year: c.year, month: c.month + 1, day: c.day }) * DAY_MINUTES + c.hour * 60 +
      c.minute
    : undefined;
}

/** A wall minute as its ISO stamp on the org's clock, `2026-11-06T10:00`. */
export function wallStamp(wall: number): string {
  const d = daySerial(Math.floor(wall / DAY_MINUTES));
  const two = (n: number) => String(n).padStart(2, "0");
  const m = wall - serial(d) * DAY_MINUTES;
  return `${d.year}-${two(d.month)}-${two(d.day)}T${two(Math.floor(m / 60))}:${two(m % 60)}`;
}

const DAY_MINUTES = 1440;

function serial(d: Day): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 864e5;
}

function daySerial(s: number): Day {
  const t = new Date(s * 864e5);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** A doc as a line's tail names it: by its name in the agent's own scope, under its scope
 *  in the two the org shares. */
export function docName(h: Pick<DocHeader, "scope" | "name">): string {
  return h.scope === "agent" ? h.name : `${h.scope}/${h.name}`;
}

/** The day after `d`. */
export function nextDay(d: Day): Day {
  return daySerial(serial(d) + 1);
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
const WEEKDAY =
  "mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
const AND = /\s*,\s*|\s+and\s+|\s+/i;
const UNIT = "minute|hour|day|week|month|year";
/** A repeat opening a line's words: a unit with its count, a unit, an nth weekday of the
 *  month or a list of weekdays, then an optional span of the day and an optional last day.
 *  It ends where a word does. */
const EVERY = new RegExp(
  `^every\\s+(?:(\\d+)\\s+(${UNIT})s?|(${UNIT})|` +
    `(1st|2nd|3rd|4th|5th|last)\\s+(${WEEKDAY})|((?:${WEEKDAY})(?:(?:${AND.source})(?:${WEEKDAY}))*))` +
    `(?:\\s+from\\s+(\\d{1,2}):(\\d{2})\\s+to\\s+(\\d{1,2}):(\\d{2}))?` +
    `(?:\\s+until\\s+(?:(\\d{1,2}) ([A-Za-z]{3})(?: (\\d{4}))?|(\\d{4})-(\\d{2})-(\\d{2})))?(?=\\s|$)`,
  "i",
);
const FREQ: Record<string, string> = {
  day: "DAILY",
  week: "WEEKLY",
  month: "MONTHLY",
  year: "YEARLY",
};
/** The units a repeat steps by within the day, in minutes. */
const STEP: Record<string, number> = { minute: 1, hour: 60 };
const NTH: Record<string, number> = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, last: -1 };
/** A reminder opening a line's words, after any repeat. */
const REMIND =
  /^remind(?:\s+(\d+)\s+(minute|hour|day|week)s?\s+before)?(?:\s+at\s+(\d{1,2}):(\d{2}))?(?=\s|$)/i;
const BACK: Record<string, number> = {
  minute: 1,
  hour: 60,
  day: DAY_MINUTES,
  week: 7 * DAY_MINUTES,
};

/** A weekday's name as BYDAY spells it. */
function byDayCode(name: string): string {
  return WEEKDAYS[
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
      .indexOf(name.slice(0, 3).toLowerCase())
  ];
}

interface Repeat {
  rule?: string;
  step?: number;
  span?: [number, number];
  last?: Day;
  every?: string;
  text: string;
}

/** The repeat that opens a line's words, and the words after it; words that open with none
 *  are all text. Whole days read as an RRULE; minutes and hours as a step from the line's
 *  time, which they need. Nothing when the repeat cannot hold: an `until` that names no
 *  real date, a span on whole days, a step on a line with no time. A yearless `until` is
 *  the first such date from the line's own. */
function repeatOf(words: string, start: Day, at?: number): Repeat | undefined {
  const m = EVERY.exec(words);
  if (!m) return { text: words };
  const unit = (m[2] ?? m[3])?.toLowerCase();
  const step = unit && STEP[unit] ? STEP[unit] * (m[1] ? +m[1] : 1) : undefined;
  let span: [number, number] | undefined;
  if (m[7] !== undefined) {
    const from = minutes(m[7], m[8]), to = minutes(m[9], m[10]);
    if (from === undefined || to === undefined || step === undefined) return undefined;
    span = [from, to];
  }
  if (step !== undefined && (at === undefined || step === 0)) return undefined;
  let last: Day | undefined;
  if (m[11]) {
    const month = MONTHS.findIndex((x) => x.toLowerCase() === m[12].toLowerCase()) + 1;
    if (month === 0) return undefined;
    last = { year: m[13] ? +m[13] : start.year, month, day: +m[11] };
    if (!m[13] && serial(last) < serial(start)) last = { ...last, year: start.year + 1 };
  } else if (m[14]) last = { year: +m[14], month: +m[15], day: +m[16] };
  if (last && !real(last)) return undefined;
  const every = m[0], text = words.slice(m[0].length).trim();
  if (step !== undefined) {
    return { step, ...(span ? { span } : {}), ...(last ? { last } : {}), every, text };
  }
  const rule = m[1]
    ? [`FREQ=${FREQ[unit!]}`, `INTERVAL=${+m[1]}`]
    : m[3]
    ? [`FREQ=${FREQ[unit!]}`]
    : m[4]
    ? ["FREQ=MONTHLY", `BYDAY=${NTH[m[4].toLowerCase()]}${byDayCode(m[5])}`]
    : ["FREQ=WEEKLY", `BYDAY=${[...new Set(m[6].split(AND).map(byDayCode))].join(",")}`];
  if (last) {
    const two = (n: number) => String(n).padStart(2, "0");
    rule.push(`UNTIL=${last.year}${two(last.month)}${two(last.day)}`);
  }
  return { rule: rule.join(";"), every, text };
}

/** The reminder that opens a line's words, and the words after it. Words that open with
 *  none, or with one the line cannot keep (a count back from a line with no time, a time of
 *  day after minutes or hours), are all text. */
function remindOf(
  words: string,
  at?: number,
): { remind?: Remind; reminder?: string; text: string } {
  const m = REMIND.exec(words);
  if (!m) return { text: words };
  const unit = m[2]?.toLowerCase();
  const back = unit ? +m[1] * BACK[unit] : 0;
  const time = minutes(m[3], m[4]);
  if (m[3] !== undefined && time === undefined) return { text: words };
  let remind: Remind;
  if (time !== undefined) {
    if (back % DAY_MINUTES !== 0) return { text: words };
    remind = { days: back / DAY_MINUTES, at: time };
  } else if (at !== undefined) remind = { back };
  else return { text: words };
  return { remind, reminder: m[0], text: words.slice(m[0].length).trim() };
}

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
  const repeat = repeatOf(g[4] ?? "", day, at);
  if (!repeat) return undefined;
  const { text: words, ...rule } = repeat;
  const { text, ...remind } = remindOf(words, at);
  return { day, at, slot, ...rule, ...remind, text: text.replace(GROUND, "").trim() };
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
      ...(m.rule ? { rule: m.rule } : {}),
      ...(m.step ? { step: m.step } : {}),
      ...(m.span ? { span: m.span } : {}),
      ...(m.last ? { last: m.last } : {}),
      ...(m.every ? { every: m.every } : {}),
      ...(m.remind ? { remind: m.remind, reminder: m.reminder } : {}),
      text: m.text,
      ...(heading ? { heading } : {}),
    });
  }
  return out;
}

/** The minutes of day `d` a timed line stands at: its time on a day its rule takes, or each
 *  step that falls on the day inside its span. */
function timesOn(l: DatedLine, d: Day): number[] {
  if (l.at === undefined) return [];
  if (!l.step) return takes(l, d) ? [l.at] : [];
  const day = serial(d);
  if (day < serial(l.day) || (l.last && day > serial(l.last))) return [];
  const first = serial(l.day) * DAY_MINUTES + l.at;
  const out: number[] = [];
  const from = day * DAY_MINUTES;
  for (
    let t = first + Math.max(0, Math.ceil((from - first) / l.step)) * l.step;
    t < from + DAY_MINUTES;
    t += l.step
  ) {
    const m = t - from;
    const [a, b] = l.span ?? [0, DAY_MINUTES - 1];
    if (a <= b ? a <= m && m <= b : m >= a || m <= b) out.push(m);
  }
  return out;
}

/** Whether a line stands on day `d`: its own day, a day its rule takes, a day one of its
 *  steps falls on. */
function takes(l: DatedLine, d: Day): boolean {
  if (l.step) return timesOn(l, d).length > 0;
  return l.rule ? ruleTakes(l.rule, l.day, d) : serial(l.day) === serial(d);
}

/** Where a line stands, as a section's tail and a reminder name it: the doc, the heading
 *  of its block, its repeat and its reminder. */
function tailOf(name: string, l: DatedLine): string {
  return `${l.heading ? `${name} › ${l.heading}` : name}${l.every ? `, ${l.every}` : ""}${
    l.reminder ? `, ${l.reminder}` : ""
  }`;
}

/** A line's words with its checkbox, so a done item reads as done. */
function boxed(l: DatedLine): string {
  return `${l.status === "open" ? "[ ] " : l.status === "done" ? "[x] " : ""}${l.text}`;
}

/** A doc's lines on day `d`, dated to it or repeating onto it, as entries: a stepping line
 *  at its first step of the day, and its repeat and reminder close the tail. */
export function docEntries(name: string, body: string, d: Day): Entry[] {
  return datedLines(body, d)
    .filter((l) => takes(l, d))
    .map((l) => {
      const at = l.step ? timesOn(l, d)[0] : l.at;
      return {
        ...(at !== undefined ? { at, slot: l.step ? clock(at) : l.slot } : {}),
        text: boxed(l),
        tail: tailOf(name, l),
      };
    });
}

/** A reminder that came due: the wall minute it fires at, and the line it reminds of. */
export interface Due {
  fire: number;
  text: string;
}

/** The reminders of a doc's lines that fall due in the wall minutes `(from, to]`, each line
 *  once, at the latest of its due ones: a clock that was down fires a repeat once, not once
 *  per step it missed. Each names the occurrence it reminds of, the line and where it
 *  stands. */
export function remindersDue(
  name: string,
  body: string,
  from: number,
  to: number,
  today: Day,
): Due[] {
  const out: Due[] = [];
  for (const l of datedLines(body, today)) {
    if (!l.remind || l.status === "done") continue;
    const r = l.remind;
    let due: { fire: number; day: number; at?: number } | undefined;
    const hit = (fire: number, day: number, at?: number) => {
      if (fire > from && fire <= to && (!due || fire > due.fire)) due = { fire, day, at };
    };
    if ("days" in r) {
      for (let fd = Math.floor(from / DAY_MINUTES); fd <= Math.floor(to / DAY_MINUTES); fd++) {
        const day = fd + r.days;
        if (takes(l, daySerial(day))) {
          hit(fd * DAY_MINUTES + r.at, day, timesOn(l, daySerial(day))[0]);
        }
      }
    } else {
      const lo = from + r.back, hi = to + r.back;
      for (let day = Math.floor(lo / DAY_MINUTES); day <= Math.floor(hi / DAY_MINUTES); day++) {
        for (const m of timesOn(l, daySerial(day))) hit(day * DAY_MINUTES + m - r.back, day, m);
      }
    }
    if (!due) continue;
    const d = daySerial(due.day);
    const when = `${d.day} ${MONTHS[d.month - 1]}${d.year === today.year ? "" : ` ${d.year}`}${
      due.at === undefined ? "" : ` ${clock(due.at)}`
    }`;
    out.push({ fire: due.fire, text: `${when} ${boxed(l)} — ${tailOf(name, l)}` });
  }
  return out;
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

/** The anchor's section for one day, `today` or `tomorrow`: the whole-day entries first,
 *  then the rest by the minute they start, ties in the order they came. Nothing on the day,
 *  no section. */
export function daySection(label: string, entries: Entry[]): string[] {
  if (entries.length === 0) return [];
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at ?? -1) - (b.e.at ?? -1) || a.i - b.i)
    .map(({ e }) => e);
  return [
    `${label} — ${entries.length}:`,
    ...sorted.map((e) => `· ${e.slot ? `${e.slot} ` : ""}${e.text} — ${e.tail}`),
  ];
}
