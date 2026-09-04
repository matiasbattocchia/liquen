/**
 * store/timers.ts — the scheduler's rows (§10): the one non-log fact about the FUTURE.
 *
 * Everything else in mu is derived from the log, which records what happened; a wake that
 * has not happened yet cannot be an event, so it is a row. The row is not the wake — when
 * it comes due the clock publishes an `alarm` carrying its note, and THAT event is the
 * wake, log-shaped like everything else. Recovery needs no work: rows outlive the process,
 * and the first tick after a restart fires whatever came due while it was down.
 *
 * A timer always carries a NOTE, because an alarm always informs (§2): the agent wakes to
 * words it wrote for itself — "send the appointment reminders" — and decides then, with
 * today's log in front of it, what to do about them. That is deliberately not a stored
 * tool call: yesterday's judgment executed blind against today's state is exactly what the
 * permission table exists to prevent, and a note costs nothing but keeps the veto.
 *
 * `cron` null ⇒ one-shot: it fires once and the row is gone. Otherwise the row is advanced
 * to its next fire AFTER now — an org that was down for a week fires each cron once, not
 * once per missed occurrence, because the note said "check the appointments", not "check
 * them 168 times".
 *
 * Firing is a CLAIM, then a settle. More than one clock can be sweeping the same table —
 * an ephemeral main raised beside a backing-off `mu start`, a tick that overlaps the last —
 * and `due` is a read, so every sweeper lists the same rows; `claim` is the single
 * conditional UPDATE that decides who fires each one, and exactly one caller wins. The
 * claim is a lease written into `fire_at` itself: the row is parked `CLAIM_LEASE_MS` past
 * now, so no other sweep sees it due while the winner publishes, and a winner that dies
 * before settling leaves a row that simply comes due again at the horizon. One column,
 * one meaning: `fire_at` is the next moment anyone may fire it.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./id.ts";

/** An armed wake. `fireAt` is UTC ISO (the store's law, §3); `cron` is org-local (§5). */
export interface TimerRow {
  id: string;
  agentId: string;
  /** Whose wake it is (§4): a session arms it, that session lists it, cancels it, and is
   *  the one woken — the agent id beside it is who to bill it to, not who reads it. */
  sessionId: string;
  fireAt: string;
  /** Five-field expression; unset ⇒ one-shot. */
  cron?: string;
  /** What the agent wakes to — its own words, read cold. */
  note: string;
  /** Where the alarm lands: the session's own conversation. */
  conversation: string;
  /** Provenance (§10): the scheduling `tool_use`'s id — the alarm carries it back as
   *  `payload.ref_id`, so a note read cold leads to the call that wrote it. */
  refId?: string;
  /** When it was armed (UTC ISO) — the other half of the provenance an alarm hands over. */
  armedAt?: string;
}

/** How long a claimed row stays parked before it is due again — the window a winner has
 *  to publish and settle, and the delay a dead winner's row is refired after. */
export const CLAIM_LEASE_MS = 5 * 60_000;

export interface Timers {
  /** Arm a wake. The id and `armedAt` are minted here; the id is what `cancel` takes. */
  arm(row: Omit<TimerRow, "id" | "armedAt">): TimerRow;
  /** Everything due at `nowIso`, oldest first — the clock's scan. A read: listing is not
   *  winning. */
  due(nowIso: string): TimerRow[];
  /** Win a due row: the one atomic statement that decides who fires it. The row comes
   *  back for the winner to publish (its `fireAt` now the lease horizon); `null` means
   *  another sweep won it, or it is no longer due. */
  claim(id: string, nowIso: string): TimerRow | null;
  /** Consume a fired timer: one-shot ⇒ gone; cron ⇒ advanced past `nowIso` — in `tz`, the
   *  same clock the cron was armed against (§10): "0 9" means 9 on the org's wall, every
   *  fire, not just the first. */
  settle(id: string, nowIso: string, tz?: string): void;
  /** A session's armed wakes, next first — what its anchor lists (§5). The pair, because
   *  bare session names collide across agents (§4): `mind` alone names everyone's. */
  timers(agentId: string, sessionId: string): TimerRow[];
  /** Disarm by id, but only the session's own. `false` ⇒ no such timer of theirs. */
  disarm(id: string, agentId: string, sessionId: string): boolean;
}

export const TIMERS_DDL = `CREATE TABLE IF NOT EXISTS timers (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  fire_at      TEXT NOT NULL,
  cron         TEXT,
  note         TEXT NOT NULL,
  conversation TEXT NOT NULL,
  ref_id       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (fire_at);`;

type Raw = Record<string, string | null>;

const rowOf = (r: Raw): TimerRow => ({
  id: r.id!,
  agentId: r.agent_id!,
  sessionId: r.session_id!,
  fireAt: r.fire_at!,
  ...(r.cron ? { cron: r.cron } : {}),
  note: r.note!,
  conversation: r.conversation!,
  ...(r.ref_id ? { refId: r.ref_id } : {}),
  ...(r.created_at ? { armedAt: r.created_at } : {}),
});

/** Bind the timers to an open DB (the `createLocker`/`createRegistry` pattern — openLog composes). */
export function createTimers(db: DatabaseSync): Timers {
  const put = db.prepare(
    `INSERT INTO timers
       (id, agent_id, session_id, fire_at, cron, note, conversation, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ripe = db.prepare("SELECT * FROM timers WHERE fire_at <= ? ORDER BY fire_at, id");
  // the predicate is the whole claim: the winner's write makes it false for everyone else
  const take = db.prepare(
    "UPDATE timers SET fire_at = ? WHERE id = ? AND fire_at <= ? RETURNING *",
  );
  const byId = db.prepare("SELECT * FROM timers WHERE id = ?");
  const mine = db.prepare(
    "SELECT * FROM timers WHERE agent_id = ? AND session_id = ? ORDER BY fire_at, id",
  );
  const advance = db.prepare("UPDATE timers SET fire_at = ? WHERE id = ?");
  const del = db.prepare("DELETE FROM timers WHERE id = ?");
  const delMine = db.prepare(
    "DELETE FROM timers WHERE id = ? AND agent_id = ? AND session_id = ?",
  );

  return {
    arm(row: Omit<TimerRow, "id" | "armedAt">): TimerRow {
      const armed: TimerRow = { ...row, id: newId(), armedAt: new Date().toISOString() };
      put.run(
        armed.id,
        armed.agentId,
        armed.sessionId,
        armed.fireAt,
        armed.cron ?? null,
        armed.note,
        armed.conversation,
        armed.refId ?? null,
        armed.armedAt!,
      );
      return armed;
    },

    due(nowIso: string): TimerRow[] {
      return (ripe.all(nowIso) as Raw[]).map(rowOf);
    },

    claim(id: string, nowIso: string): TimerRow | null {
      const horizon = new Date(Date.parse(nowIso) + CLAIM_LEASE_MS).toISOString();
      const raw = take.get(horizon, id, nowIso) as Raw | undefined;
      return raw ? rowOf(raw) : null;
    },

    settle(id: string, nowIso: string, tz?: string): void {
      const [raw] = byId.all(id) as Raw[];
      if (!raw) return;
      const row = rowOf(raw);
      if (!row.cron) return void del.run(id);
      // past NOW, not past the stamp it was due at: a long outage collapses to one fire
      advance.run(nextFire(row.cron, nowIso, tz), id);
    },

    timers(agentId: string, sessionId: string): TimerRow[] {
      return (mine.all(agentId, sessionId) as Raw[]).map(rowOf);
    },

    disarm(id: string, agentId: string, sessionId: string): boolean {
      return delMine.run(id, agentId, sessionId).changes > 0;
    },
  };
}

/* ── cron ──────────────────────────────────────────────────────────────── */

const FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
] as const;

/** One field → the set of values it matches: `*`, `n`, `a,b`, `a-b`, and step forms (`a-b/n`). */
function fieldOf(spec: string, i: number): Set<number> {
  const { min, max } = FIELDS[i];
  const out = new Set<number>();
  for (const term of spec.split(",")) {
    const [range, step] = term.split("/");
    const by = step === undefined ? 1 : Number(step);
    if (!Number.isInteger(by) || by < 1) throw new Error(`bad cron step "${term}"`);
    let lo: number = min, hi: number = max;
    if (range !== "*") {
      const ends = range.split("-").map(Number);
      if (ends.some((n) => !Number.isInteger(n))) throw new Error(`bad cron field "${term}"`);
      lo = ends[0];
      hi = ends.length > 1 ? ends[1] : (step === undefined ? ends[0] : max);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${term}" out of range`);
    for (let v = lo; v <= hi; v += by) out.add(v);
  }
  return out;
}

/** The org's wall clock at `ms`, as numbers — `Temporal` owns the zone math (and the IANA
 *  database with it), so nothing here knows what an offset is. */
function localParts(ms: number, tz: string) {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
  return { year: z.year, month: z.month, day: z.day, hour: z.hour, minute: z.minute };
}

/**
 * A wall-clock reading in `tz` → the instant it names, as epoch ms.
 *
 * The direction `Intl` has no API for — it maps instant → local and never back — which is
 * exactly what `Temporal` adds. DST is the zone's business, not ours, and the two hard cases
 * are NAMED rather than emergent: the hour a spring-forward erases resolves just past the
 * gap, and an hour repeated by a fall-back takes the first pass (`disambiguation:
 * "compatible"`, the default). A cron that asks for a time that happened twice fires once.
 *
 * A reading that names no date at all — 31 February, hour 25 — is REFUSED (`overflow:
 * "reject"`), not quietly slid to the nearest real one: a wake the agent cannot read back
 * is worse than an error at the moment it asked for it.
 */
export function zonedTime(
  p: { year: number; month: number; day: number; hour?: number; minute?: number },
  tz: string,
): number {
  return Temporal.PlainDateTime
    .from({ ...p, hour: p.hour ?? 0, minute: p.minute ?? 0 }, { overflow: "reject" })
    .toZonedDateTime(tz).epochMilliseconds;
}

const DAY = 864e5;

/**
 * The next time `cron` fires strictly after `fromIso`, as UTC ISO.
 *
 * Minute resolution — the same as the clock that reads it (`TICK_MS`), so a finer field would
 * promise what the tick cannot keep. A cron expression is a PREDICATE, not a formula: there
 * is no arithmetic for "the next 29 February that is also a Tuesday", so the next fire is
 * searched for, and the only real question is how many candidates get built and what each
 * one costs. The search runs over the ORG's calendar, because that is what a human means by
 * "0 9 * * *": walk candidate DAYS — which days qualify is pure calendar arithmetic, no zone
 * involved — and only for a day whose month/dom/dow match, resolve its matching wall-clock
 * times into instants. Days, not minutes: a leap-day cron is ~1400 candidate days of integer
 * comparison against ~2M candidate minutes, each of which would need a zone conversion.
 *
 * Day-of-month and day-of-week are OR'd when both are restricted (the crontab convention).
 * The bound is eight years — past `0 0 29 2 *`'s worst gap; beyond it, nothing matches.
 */
export function nextFire(cron: string, fromIso: string, tz = "UTC"): string {
  const spec = cron.trim().split(/\s+/);
  if (spec.length !== 5) throw new Error(`cron needs five fields, got ${spec.length}: "${cron}"`);
  const [min, hour, dom, mon, dow] = spec.map(fieldOf);
  const domAny = spec[2] === "*", dowAny = spec[4] === "*";
  const hours = [...hour].sort((a, b) => a - b);
  const minutes = [...min].sort((a, b) => a - b);

  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) throw new Error(`bad timestamp "${fromIso}"`);
  const here = localParts(from, tz);
  // the local calendar date as a plain UTC midnight — a date is a triple, not an instant
  let date = Date.UTC(here.year, here.month - 1, here.day);
  for (let n = 0; n < 8 * 366; n++, date += DAY) {
    const d = new Date(date);
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    if (!mon.has(m)) continue;
    // both restricted ⇒ either may match (crontab's rule); one restricted ⇒ it decides
    const day = domAny && dowAny
      ? true
      : domAny
      ? dow.has(d.getUTCDay())
      : dowAny
      ? dom.has(dd)
      : dom.has(dd) || dow.has(d.getUTCDay());
    if (!day) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const t = zonedTime({ year: y, month: m, day: dd, hour: h, minute: mi }, tz);
        if (t > from) return new Date(t).toISOString();
      }
    }
  }
  throw new Error(`cron "${cron}" never fires`);
}
