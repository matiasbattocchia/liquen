/**
 * views.ts — the readings `liquen log` makes of the log beside the turns: what went wrong
 * (`errors`), what the agents ran (`tool-calls`), what the egress proxy sent (`requests`)
 * and what the model calls cost (`spend`). Each is a pure function over rows the CLI read
 * (`log.ts`), so the same rows always read the same way, whatever store they came from.
 */

import type { ErrorEvent, Event, EventId, Json, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { EgressRow, UsageRow } from "./store/log.ts";
import type { ExecRecord } from "./xi.ts";
import { describeCall } from "./describe.ts";
import { shortId } from "./render.ts";
import { type Cost, costOfAll, type Price } from "./prices.ts";
import type { Turn } from "./turns.ts";

/* ── time ─────────────────────────────────────────────────────────────── */

const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A `--since`/`--until` as an ISO instant: an age (`30m`, `12h`, `3d`) counted back from
 * `now`, a day (`2026-10-19`) or a time (`2026-10-19T09:00`) on the org's clock, or an
 * instant that names its own zone (`…Z`, `…-03:00`).
 */
export function parseWhen(when: string, zone: string, now: number = Date.now()): string {
  const age = when.match(/^(\d+)([mhd])$/);
  if (age) return new Date(now - Number(age[1]) * UNIT[age[2]]).toISOString();
  const local = when.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (local) {
    const [y, mo, d, h, mi, s] = local.slice(1).map((v) => Number(v ?? 0));
    return new Date(onClock(zone, y, mo, d, h, mi, s)).toISOString();
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(when) && !Number.isNaN(Date.parse(when))) {
    return new Date(Date.parse(when)).toISOString();
  }
  throw new Error(
    `"${when}" is not a time: an age (30m, 12h, 3d), a day (2026-10-19) or a time ` +
      "(2026-10-19T09:00) on the org's clock",
  );
}

/** The instant a wall-clock time on `zone`'s clock names. */
function onClock(zone: string, y: number, mo: number, d: number, h: number, mi: number, s: number) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = wall - offsetOf(zone, wall);
  return wall - offsetOf(zone, first); // once more, across a change of offset
}

/** How far `zone`'s clock runs ahead of UTC at `at`, in ms. */
function offsetOf(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  ) -
    Math.floor(at / 1000) * 1000;
}

/** The day an instant falls on, on `zone`'s clock: `2026-10-19`. */
export function dayOf(ts: string, zone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

/** Whether `text` holds `needle`, folding case; no needle holds everywhere. */
export function matches(text: string, needle?: string): boolean {
  return needle === undefined || text.toLowerCase().includes(needle.toLowerCase());
}

/* ── where a row stands ───────────────────────────────────────────────── */

/** The session a row belongs to: its author's, or — for a harness-authored row — the
 *  session room it was written in (`<session>@<agent>`). */
export function sessionOfRow(e: Event): { agent: string; session: string } | undefined {
  if (e.agent?.id && e.agent.session_id) return { agent: e.agent.id, session: e.agent.session_id };
  const room = e.envelope?.conversation?.address?.match(/^([a-z][a-z0-9_-]*)@([a-z][a-z0-9_-]*)$/);
  return room ? { agent: room[2], session: room[1] } : undefined;
}

/** The text of a tool's output, whatever its shape. */
export function outputText(output: Json | undefined): string {
  if (output === undefined || output === null) return "";
  return typeof output === "string" ? output : JSON.stringify(output);
}

/** The first line of a text that says something: a shell's exit footer is not it. */
export function headline(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) =>
    l !== "" && !/^Command exited with code \d+$/.test(l)
  ) ?? "";
}

/* ── errors ───────────────────────────────────────────────────────────── */

/** `tool` — a call that failed; `provider` — the model call itself; `system` — the
 *  harness's own failure; `proxy` — a host that refused the egress proxy's request. */
export type ErrorKind = "tool" | "provider" | "system" | "proxy";
export const ERROR_KINDS: readonly ErrorKind[] = ["tool", "provider", "system", "proxy"];

export interface ErrorGroup {
  kind: ErrorKind;
  /** The message with what varies between occurrences masked: ids, long numbers. */
  signature: string;
  count: number;
  first: string;
  last: string;
  /** The steps it happened in (`liquen log export --turn` takes any), oldest first. */
  steps: string[];
  /** One occurrence's first line as it was. */
  sample: string;
}

/** A message with what varies between occurrences masked, so occurrences group. */
export function signatureOf(line: string): string {
  return line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "‹id›")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, "‹id›")
    .replace(/\b\d{5,}\b/g, "‹n›")
    .slice(0, 200);
}

/** A request's path with its ids masked, the way `signatureOf` masks a message. */
function pathSignature(path: string): string {
  return path.split("/").map((seg) =>
    /^[0-9a-f-]{8,}$/i.test(seg) && /\d/.test(seg) || /^\d{5,}$/.test(seg) ? "‹id›" : seg
  ).join("/");
}

/** Every failure in the rows, grouped by kind and signature, the most frequent first. A
 *  tool result counts once — the latest a call has — and a refusal or a cut is no error. */
export function errorGroups(rows: {
  uses: ToolUseEvent[];
  results: ToolResultEvent[];
  errors: ErrorEvent[];
  requests: EgressRow[];
}): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  const add = (kind: ErrorKind, line: string, ts: string, step?: string) => {
    const signature = signatureOf(line);
    const key = `${kind}\u0000${signature}`;
    const g = groups.get(key) ??
      { kind, signature, count: 0, first: ts, last: ts, steps: [], sample: line.slice(0, 200) };
    g.count++;
    if (ts < g.first) g.first = ts;
    if (ts > g.last) g.last = ts;
    if (step !== undefined && !g.steps.includes(step)) g.steps.push(step);
    groups.set(key, g);
  };
  const named = new Map(rows.uses.map((u) => [u.id, u.parts[0].data.name]));
  for (const r of latestResults(rows.results).values()) {
    const { output, is_error, refused, cancelled } = r.parts[0].data;
    if (!is_error || refused || cancelled) continue;
    const name = named.get(r.payload.ref_id);
    add(
      "tool",
      `${name ? `${name}: ` : ""}${headline(outputText(output))}`,
      r.ts,
      r.payload.turn_id,
    );
  }
  for (const e of rows.errors) {
    const { error, origin } = e.parts[0].data;
    add(origin === "model" ? "provider" : "system", headline(String(error ?? "")), e.ts);
  }
  for (const q of rows.requests) {
    if (q.status < 400) continue;
    add("proxy", `${q.method} ${q.host}${pathSignature(q.path)} → ${q.status}`, q.created_at);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
}

/** Each call's latest result: a late update tells how a call that outlived its wait
 *  ended, so it supersedes the answer the model had then. */
export function latestResults(results: ToolResultEvent[]): Map<EventId, ToolResultEvent> {
  const out = new Map<EventId, ToolResultEvent>();
  for (const r of results) {
    const ref = r.payload.ref_id;
    const had = out.get(ref);
    if (!had || r.id > had.id) out.set(ref, r);
  }
  return out;
}

/* ── tool calls ───────────────────────────────────────────────────────── */

export type Outcome = "ok" | "error" | "refused" | "cancelled" | "pending";

export interface CallRow {
  ts: string;
  /** The step that made it — a key `liquen log export --turn` takes. */
  step: string;
  agent?: string;
  session?: string;
  /** The call as every surface describes it, in full. */
  call: string;
  name: string;
  input: Json;
  outcome: Outcome;
  exit_code?: number;
  /** The output's first line, for a call that did not end ok. */
  said?: string;
}

/** Every call in `uses`, oldest first, with how its latest result says it ended. */
export function callRows(uses: ToolUseEvent[], results: ToolResultEvent[]): CallRow[] {
  const latest = latestResults(results);
  return uses.map((u) => {
    const data = u.parts[0].data;
    const r = latest.get(u.id);
    const out = r?.parts[0].data;
    const run = r?.extra?.exec as ExecRecord | undefined;
    const outcome: Outcome = !out
      ? "pending"
      : out.cancelled
      ? "cancelled"
      : out.refused
      ? "refused"
      : out.is_error
      ? "error"
      : "ok";
    const where = sessionOfRow(u);
    return {
      ts: u.ts,
      step: String(u.payload.turn_id),
      ...(where ? { agent: where.agent, session: where.session } : {}),
      call: describeCall(data, { full: true }),
      name: data.name,
      input: data.input as Json,
      outcome,
      ...(run?.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
      ...(outcome !== "ok" && out ? { said: headline(outputText(out.output)).slice(0, 200) } : {}),
    };
  });
}

/* ── requests ─────────────────────────────────────────────────────────── */

const READS = new Set(["GET", "HEAD", "OPTIONS", "CONNECT"]);

/** A request that asks the host to change something. */
export function isWrite(r: EgressRow): boolean {
  return !READS.has(r.method.toUpperCase());
}

/** The turn each request was made in: its agent's turn whose span holds the request's
 *  time, by the turn's handle — a request carries no turn of its own, and an agent runs
 *  one turn per session at a time. */
export function turnsOfRequests(requests: EgressRow[], turns: Turn[]): (string | undefined)[] {
  return requests.map((q) =>
    turns.find((t) =>
      t.agent === q.agent_id && t.started <= q.created_at && q.created_at <= t.ended
    )?.id
  );
}

/* ── spend ────────────────────────────────────────────────────────────── */

export type SpendBy = "day" | "turn" | "session" | "model" | "agent";
export const SPEND_BY: readonly SpendBy[] = ["day", "turn", "session", "model", "agent"];

export interface SpendGroup {
  key: string;
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: Cost;
}

/** The usage rows summed per key, in the order the keys first appear. */
export function spendGroups(
  rows: UsageRow[],
  keyOf: (r: UsageRow) => string,
  prices: Price[] = [],
): SpendGroup[] {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const key = keyOf(r);
    groups.set(key, [...groups.get(key) ?? [], r]);
  }
  return [...groups].map(([key, of]) => ({ key, ...totals(of, prices) }));
}

/** What a set of calls spent, summed. */
export function totals(rows: UsageRow[], prices: Price[] = []): Omit<SpendGroup, "key"> {
  return {
    calls: rows.length,
    input: rows.reduce((n, r) => n + r.input_tokens, 0),
    output: rows.reduce((n, r) => n + r.output_tokens, 0),
    cache_read: rows.reduce((n, r) => n + (r.cache_read_tokens ?? 0), 0),
    cache_write: rows.reduce((n, r) => n + (r.cache_write_tokens ?? 0), 0),
    cost: costOfAll(rows, prices),
  };
}

/** Which session each step ran in, from the rows its model call wrote. */
export function sessionsOfSteps(rows: Event[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of rows) {
    const step = e.payload?.turn_id;
    if (typeof step !== "string" || out.has(step) || !e.agent?.session_id) continue;
    out.set(step, `${e.agent.session_id}@${e.agent.id}`);
  }
  return out;
}

/** The short handle a person reads a turn or a step by. */
export const handle = (id: string): string => shortId(id);
