/**
 * moment.ts: a stamp as the model reads it, read back into the instant it names.
 */

/**
 * A wall-clock reading in `tz` → the instant it names, as epoch ms.
 *
 * The direction `Intl` has no API for — it maps instant → local and never back — which is
 * exactly what `Temporal` adds. DST is the zone's business, not ours, and the two hard cases
 * are NAMED rather than emergent: the hour a spring-forward erases resolves just past the
 * gap, and an hour repeated by a fall-back takes the first pass (`disambiguation:
 * "compatible"`, the default).
 *
 * A reading that names no date at all — 31 February, hour 25 — is REFUSED (`overflow:
 * "reject"`), not quietly slid to the nearest real one.
 */
export function zonedTime(
  p: { year: number; month: number; day: number; hour?: number; minute?: number },
  tz: string,
): number {
  return Temporal.PlainDateTime
    .from({ ...p, hour: p.hour ?? 0, minute: p.minute ?? 0 }, { overflow: "reject" })
    .toZonedDateTime(tz).epochMilliseconds;
}

/** The months as every rendered stamp names them (`2 Oct 17:36`, render's `hhmm`), so a
 *  stamp copied off a line reads back. */
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A moment → UTC ISO. A stamp carrying its own offset (or `Z`) is absolute and passes
 * through; a bare one (`2026-09-01T17:00`) means the ORG's wall clock — the clock every
 * stamp is rendered in, so it is the one whoever typed this was reading. A stamp as the
 * lines are rendered (`2 Oct 17:36`, `2 Oct 2026 17:36`) reads the same way: what the
 * model was shown is what it may hand back. One without its year is the nearest such date
 * to `now`, so a January read of a `28 Dec` line means the December just gone and a
 * December one `3 Jan` the one coming. `zonedTime` does the zone math, DST included.
 */
export function momentOf(spec: string, tz: string, now = Date.now()): string {
  const raw = spec.trim();
  const refused = () => new Error(`"${spec}" is not a moment — try \`2026-09-01T17:00\``);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw);
    if (Number.isNaN(t)) throw new Error(`"${spec}" is not a moment I can read`);
    return new Date(t).toISOString();
  }
  // a reading that names no real date (31 February, hour 25) is refused, not slid
  const at = (c: { year: number; month: number; day: number; hour: number; minute: number }) => {
    try {
      return zonedTime(c, tz);
    } catch {
      throw refused();
    }
  };
  // anchored: a stamp with trailing garbage is refused, not silently truncated to its date;
  // seconds are tolerated and dropped
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(raw);
  if (iso) {
    const [year, month, day, hour, minute] = iso.slice(1).map((x) => x === undefined ? 0 : +x);
    return new Date(at({ year, month, day, hour, minute })).toISOString();
  }
  const shown = /^(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?(?: (\d{1,2}):(\d{2}))?$/.exec(raw);
  const month = shown ? MONTHS.findIndex((m) => m.toLowerCase() === shown[2].toLowerCase()) : -1;
  if (!shown || month < 0) throw refused();
  const clock = {
    month: month + 1,
    day: +shown[1],
    hour: +(shown[4] ?? 0),
    minute: +(shown[5] ?? 0),
  };
  if (shown[3]) return new Date(at({ year: +shown[3], ...clock })).toISOString();
  // 29 Feb names a date only in some of the candidate years; the others drop out
  const year = new Date(now).getUTCFullYear();
  const candidates = [year - 1, year, year + 1].flatMap((y) => {
    try {
      return [at({ year: y, ...clock })];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) throw refused();
  const nearest = candidates.reduce((a, b) => Math.abs(b - now) < Math.abs(a - now) ? b : a);
  return new Date(nearest).toISOString();
}
