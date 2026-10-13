/**
 * turns.ts — what a session's turns were, read off the log (§2, §5). A turn is never
 * tracked, so it is derived here the way render derives one: the steps (`payload.turn_id`,
 * one per model call) from the look that opened it to the closing that ended it — a
 * closing message (`end_turn`), a terminal error, or the principal's cut. One reading
 * serves the turn that just ended (main's line in `liquen.log`) and every turn before it
 * (`liquen turns`, `liquen log export`, `liquen status --json`), so the live line and the
 * history agree by construction.
 *
 * A turn's handle is its first step's `turn_id`. What opened it is the news the first
 * step's request read last (`extra.consumed`, the horizon it carries): a message, a fired
 * wake, a principal's verdict, a script's call through the door, a checkpoint's insert.
 * Its cost is the usage rows its steps metered (`price`), joined on the same key; the
 * checkpoint the idle gap wrote after it is its own call, priced on its own.
 */

import type { Event, EventId, SessionRef, ToolResultEvent } from "./types.ts";
import type { ReadQuery, UsageRow } from "./store/log.ts";
import { sessionAddress } from "./session.ts";
import { hhmm, ownVoice, shortId, textOf } from "./render.ts";
import { openStore } from "./store/mod.ts";
import { findRoot, orgFlag, readConfig } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { userInfo } from "node:os";

/** Token counts, summed over usage rows. */
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** What opened a turn — the news its first step read last. */
export interface Opener {
  kind: "message" | "wake" | "alarm" | "verdict" | "call" | "cancel" | "checkpoint" | "unknown";
  id?: EventId;
  ts?: string;
  /** Who said it: a message's or a verdict's sender. */
  who?: string;
  /** A wake's handle (`liquen schedule --name`). */
  name?: string;
  /** What it said: a message's words, an alarm's note, a call's tool. */
  text?: string;
}

/** How a turn ended: its closing's stop (`end_turn`, `refusal`, …), a terminal `error`,
 *  the principal's `cancel`, or `open` — no end in the log yet. */
export type TurnEnd = string;

export interface Turn {
  id: string; // the first step's turn_id
  agent: string;
  session: string;
  opener: Opener;
  started: string; // the opener's time, else the first step's
  ended: string; // the turn's last row's time
  duration_ms: number;
  steps: string[]; // each step's turn_id, in order
  calls: number;
  tool_errors: number; // results that failed — a refusal or a cut is neither
  tokens: Tokens;
  end: TurnEnd;
  error?: string; // a terminal error's sentence
  checkpoint?: { id: EventId; ts: string; turn_id?: string; tokens: Tokens };
  /** The turn's rows by id: the opener (or first step) through its last row. */
  span: { from: EventId; to: EventId };
}

const CONTINUING = new Set(["tool_use", "pause_turn", "max_tokens"]);
const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

/** A step row of this session's own model: its turn key, never a door call's (`job:`). */
function stepOf(e: Event, ref: SessionRef): string | undefined {
  const turn = e.payload?.turn_id;
  if (typeof turn !== "string" || turn.startsWith("job:")) return undefined;
  if (e.agent?.id !== ref.agentId || e.agent.session_id !== ref.id) return undefined;
  return turn;
}

/** The opener a row would be, or undefined when it is not news to this session. */
export function openerOf(e: Event, ref: SessionRef): Opener | undefined {
  const at = { id: e.id, ts: e.ts };
  const turn = e.payload?.turn_id;
  if (typeof turn === "string" && turn.startsWith("job:")) {
    if (e.type !== "tool_use") return undefined;
    return { kind: "call", ...at, text: String(e.parts?.[0]?.data?.name ?? "") };
  }
  switch (e.type) {
    case "message": {
      if (ownVoice(e, ref) || e.extra?.via !== undefined) return undefined;
      const who = e.envelope.sender?.name ?? e.envelope.sender?.address;
      return { kind: "message", ...at, ...(who ? { who } : {}), text: textOf(e) };
    }
    case "alarm": {
      const timer = (e.extra?.timer ?? {}) as { name?: string };
      const text = textOf(e);
      return timer.name
        ? { kind: "wake", ...at, name: timer.name, text }
        : { kind: "alarm", ...at, text };
    }
    case "permission_response": {
      if (turn !== undefined) return undefined; // the agent's own withdrawal
      const who = e.envelope.sender?.name ?? e.envelope.sender?.address;
      return { kind: "verdict", ...at, ...(who ? { who } : {}) };
    }
    case "control":
      return { kind: "cancel", ...at };
    case "summary":
      return { kind: "checkpoint", ...at };
    default:
      return undefined;
  }
}

/**
 * The turns in a session's rows, oldest first — `events` in append order, as `read` hands
 * them. Rows of other sessions pass through untouched. A turn whose opener the rows do not
 * hold names it by id alone (`opener.kind: "unknown"`), for the caller to look up; tokens
 * are zero until `price` fills them.
 */
export function turnsOf(events: Event[], ref: SessionRef): Turn[] {
  const home = sessionAddress(ref.agentId, ref.id);
  const turns: Turn[] = [];
  const byStep = new Map<string, Turn>();
  let open: Turn | undefined;
  let erred: Event | undefined; // the open turn's last row was an error
  let news: Opener | undefined; // the freshest news since the last turn ended
  let lastNewsBefore = new Map<EventId, Opener>(); // news by id, for the consumed horizon

  const close = (t: Turn, end: TurnEnd, at: Event) => {
    t.end = end;
    touch(t, at);
    open = undefined;
    erred = undefined;
  };
  const touch = (t: Turn, e: Event) => {
    t.ended = e.ts;
    t.span.to = e.id;
    t.duration_ms = Math.max(0, Date.parse(t.ended) - Date.parse(t.started));
  };

  for (const e of events) {
    const step = stepOf(e, ref);
    if (step !== undefined) {
      if (e.type === "summary") {
        // a checkpoint is written in the idle gap: it follows the turn that just ended
        const last = turns.at(-1);
        if (last && last !== open) {
          last.checkpoint = { id: e.id, ts: e.ts, turn_id: step, tokens: zero() };
        }
        continue;
      }
      const owner = byStep.get(step);
      if (owner) {
        // a step's later rows: its tools' results, a withdrawal
        if (e.type === "tool_result") {
          const { is_error, refused, cancelled } = (e as ToolResultEvent).parts[0].data;
          if (is_error && !refused && !cancelled) owner.tool_errors++;
        }
        if (e.type === "tool_use") owner.calls++;
        if (owner === open) erred = undefined;
        touch(owner, e);
        if (owner === open) closeOnStop(owner, e);
        continue;
      }
      if (e.type === "tool_result" || e.type === "permission_response") continue; // a stray
      if (!open) {
        const consumed = typeof e.extra?.consumed === "string" ? e.extra.consumed : undefined;
        const opener = (consumed !== undefined ? horizon(lastNewsBefore, consumed) : news) ??
          (consumed !== undefined ? { kind: "unknown" as const, id: consumed } : undefined) ??
          { kind: "unknown" as const };
        open = {
          id: step,
          agent: ref.agentId,
          session: ref.id,
          opener,
          started: opener.ts ?? e.ts,
          ended: e.ts,
          duration_ms: 0,
          steps: [],
          calls: 0,
          tool_errors: 0,
          tokens: zero(),
          end: "open",
          span: { from: opener.ts !== undefined && opener.id ? opener.id : e.id, to: e.id },
        };
        turns.push(open);
        news = undefined;
        lastNewsBefore = new Map();
      }
      const t = open;
      if (!t.steps.includes(step)) t.steps.push(step);
      byStep.set(step, t);
      if (e.type === "tool_use") t.calls++;
      erred = undefined;
      touch(t, e);
      closeOnStop(t, e);
      continue;
    }
    if (e.type === "error" && e.envelope.conversation.address === home) {
      const said = String(e.parts?.[0]?.data?.error ?? "");
      if (open) {
        erred = e;
        open.error = said;
        touch(open, e);
      } else if (news) {
        // a first think that failed: the look happened, and no step came of it — a turn
        // all the same, handled by the error's own id
        turns.push({
          id: e.id,
          agent: ref.agentId,
          session: ref.id,
          opener: news,
          started: news.ts ?? e.ts,
          ended: e.ts,
          duration_ms: Math.max(0, Date.parse(e.ts) - Date.parse(news.ts ?? e.ts)),
          steps: [],
          calls: 0,
          tool_errors: 0,
          tokens: zero(),
          end: "error",
          error: said,
          span: { from: news.id ?? e.id, to: e.id },
        });
        news = undefined;
        lastNewsBefore = new Map();
      }
      continue;
    }
    const o = openerOf(e, ref);
    if (o === undefined) continue;
    if (open && o.kind === "cancel" && e.envelope.conversation.address === home) {
      close(open, "cancel", e);
      continue;
    }
    if (open && erred) close(open, "error", erred);
    if (open) continue; // news mid-turn: steering, read by a later step
    news = o;
    lastNewsBefore.set(e.id, o);
  }
  if (open && erred) close(open, "error", erred);
  return turns;

  function closeOnStop(t: Turn, e: Event) {
    const stop = e.payload?.stop_reason;
    if (typeof stop === "string" && !CONTINUING.has(stop)) close(t, stop, e);
  }
}

/** The freshest news at or before the horizon a step read. */
function horizon(news: Map<EventId, Opener>, consumed: EventId): Opener | undefined {
  let best: Opener | undefined;
  for (const [id, o] of news) if (id <= consumed && (!best || id > best.id!)) best = o;
  return best;
}

/** Fill each turn's tokens (and its checkpoint's) from the usage rows its steps metered. */
export function price(turns: Turn[], spend: UsageRow[]): Turn[] {
  const rows = new Map<string, UsageRow[]>();
  for (const r of spend) {
    if (r.turn_id === undefined) continue;
    rows.set(r.turn_id, [...rows.get(r.turn_id) ?? [], r]);
  }
  const add = (into: Tokens, r: UsageRow) => {
    into.input += r.input_tokens;
    into.output += r.output_tokens;
    into.cache_read += r.cache_read_tokens ?? 0;
    into.cache_write += r.cache_write_tokens ?? 0;
  };
  for (const t of turns) {
    t.tokens = zero();
    for (const s of t.steps) for (const r of rows.get(s) ?? []) add(t.tokens, r);
    if (t.checkpoint?.turn_id !== undefined) {
      t.checkpoint.tokens = zero();
      for (const r of rows.get(t.checkpoint.turn_id) ?? []) add(t.checkpoint.tokens, r);
    }
  }
  return turns;
}

/** What `readTurns` reads through: a log's two reads, scoped or not. */
export interface TurnReader {
  read(query?: ReadQuery): Promise<Event[]>;
  spend(query?: { agentId?: string; turns?: string[] }): Promise<UsageRow[]>;
}

/** How many rows one page of the session's room is. */
const PAGE = 2_000;
/** How many pages a read walks back before it settles for what it has. */
const PAGES = 10;

/**
 * A session's last `want` turns (all of them when `want` is omitted, as far back as the
 * walk reaches), priced, their openers looked up where the room does not hold them. The
 * session's own room is read a page at a time, newest first; a turn the oldest page
 * starts in the middle of is left out, since its first steps are on a page not read.
 */
export async function readTurns(
  log: TurnReader,
  ref: SessionRef,
  want?: number,
  page = PAGE,
): Promise<Turn[]> {
  const conversation = sessionAddress(ref.agentId, ref.id);
  let rows: Event[] = [];
  let whole = false;
  let turns: Turn[] = [];
  for (let n = 0; n < PAGES; n++) {
    const older = await log.read({
      conversation,
      limit: page,
      ...(rows.length ? { beforeId: rows[0].id } : {}),
    });
    rows = [...older, ...rows];
    whole = older.length < page;
    turns = turnsOf(rows, ref);
    if (whole) break;
    turns = turns.slice(1); // the oldest may have begun on a page not read
    if (want !== undefined && turns.length >= want) break;
  }
  if (want !== undefined) turns = turns.slice(Math.max(0, turns.length - want));
  for (const t of turns) {
    if (t.opener.kind !== "unknown" || t.opener.id === undefined) continue;
    const seen = await rowById(log, t.opener.id);
    const o = seen && openerOf(seen, ref);
    if (o) {
      t.opener = o;
      t.started = o.ts ?? t.started;
      t.duration_ms = Math.max(0, Date.parse(t.ended) - Date.parse(t.started));
    }
  }
  const keys = turns.flatMap((t) => [
    ...t.steps,
    ...(t.checkpoint?.turn_id ? [t.checkpoint.turn_id] : []),
  ]);
  if (keys.length === 0) return turns;
  return price(turns, await log.spend({ agentId: ref.agentId, turns: keys }));
}

/** One row by its id, through the reader's law: the newest row at or below it — ids are
 *  one length, so nothing but the row itself sorts between it and the bound. */
export async function rowById(
  log: Pick<TurnReader, "read">,
  id: EventId,
): Promise<Event | undefined> {
  const [row] = await log.read({ beforeId: `${id}0`, limit: 1 });
  return row?.id === id ? row : undefined;
}

/** The agent a command means when none is named: the roster's only one, else the one
 *  sharing the OS username — the attach clients' rule. */
export function defaultAgent(roster: string[]): string {
  if (roster.length === 1) return roster[0];
  try {
    return userInfo().username;
  } catch {
    return roster[0] ?? "";
  }
}

/** A count as people read one: 9306 → 9.3k. */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A duration as people read one: 3m55s, 41s, 1h02m. */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** What opened a turn, in a few words. */
export function openedBy(o: Opener): string {
  const quote = (s?: string) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t === "" ? "" : ` "${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`;
  };
  switch (o.kind) {
    case "message":
      return `message${o.who ? ` from ${o.who}` : ""}${quote(o.text)}`;
    case "wake":
      return `wake ${o.name}`;
    case "alarm":
      return `alarm${quote(o.text)}`;
    case "verdict":
      return `verdict${o.who ? ` from ${o.who}` : ""}`;
    case "call":
      return `script call ${o.text ?? ""}`.trimEnd();
    case "cancel":
      return "cancel";
    case "checkpoint":
      return "checkpoint";
    default:
      return o.id ? `unknown (${shortId(o.id)})` : "unknown";
  }
}

/** The turn as one line — what `liquen.log` carries at every turn's end, and `liquen turns`
 *  prints per row. */
export function turnLine(t: Turn): string {
  const k = t.tokens;
  return [
    `${t.session}@${t.agent} ${shortId(t.id)}`,
    `opened by ${openedBy(t.opener)}`,
    `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`,
    `${t.calls} call${t.calls === 1 ? "" : "s"}`,
    `${t.tool_errors} tool error${t.tool_errors === 1 ? "" : "s"}`,
    `tokens ${count(k.input)} in / ${count(k.output)} out / ${count(k.cache_read)} cache-read`,
    `${t.end}${t.end === "error" && t.error ? `: ${oneLine(t.error)}` : ""}`,
    took(t.duration_ms),
    t.checkpoint ? `checkpoint ${shortId(t.checkpoint.id)}` : "no checkpoint",
  ].join(" · ");
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

export const USAGE =
  `usage: liquen turns [--dir <org>] [--agent <name>] [--session <name>] [--limit <n>]
                    [--json]

  The last turns of each agent's session, oldest first, one line each: what opened it,
  its steps and calls, the tool errors, the tokens its steps metered, how it ended, how
  long it took, and whether a checkpoint followed. Read off the log and the usage table,
  so it answers for history and for an org that is not running.

  --agent <name>    one agent (a roster name); default: every agent
  --session <name>  the session; default: the mind
  --limit <n>       how many turns, the most recent; default: 20
  --json            one JSON object per turn, a line each`;

/** The flags `turns` takes, and the export's `--agent`/`--session` alike. */
export function parseTurnsArgs(args: string[]): {
  agent?: string;
  session: string;
  limit: number;
  json: boolean;
  rest: string[];
} {
  const out = { session: "mind", limit: 20, json: false } as {
    agent?: string;
    session: string;
    limit: number;
    json: boolean;
    rest: string[];
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--agent") out.agent = value();
    else if (a === "--session") out.session = value();
    else if (a === "--limit") {
      out.limit = Number(value());
      if (!Number.isInteger(out.limit) || out.limit < 1) {
        throw new Error(`--limit is a positive whole number\n${USAGE}`);
      }
    } else if (a === "--json") out.json = true;
    else rest.push(a);
  }
  out.rest = rest;
  return out;
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const args = parseTurnsArgs(org.args);
    if (args.rest.length) throw new Error(`unknown argument ${args.rest[0]}\n${USAGE}`);
    const root = findRoot(org);
    const catalog = await readConfig(root);
    const agents = args.agent !== undefined ? [args.agent] : Object.keys(catalog.agents);
    if (args.agent !== undefined && !(args.agent in catalog.agents)) {
      throw new Error(`no agent "${args.agent}" in ${root}/config.jsonc`);
    }
    const log = await (await openStore(root)).log();
    try {
      const all: Turn[] = [];
      for (const agentId of agents) {
        all.push(...await readTurns(log, { agentId, id: args.session }, args.limit));
      }
      all.sort((a, b) => a.started < b.started ? -1 : a.started > b.started ? 1 : 0);
      for (const t of all.slice(Math.max(0, all.length - args.limit))) {
        console.log(
          args.json
            ? JSON.stringify(t)
            : `${hhmm(t.started, catalog.organization.timezone, true)}  ${turnLine(t)}`,
        );
      }
    } finally {
      await log.close();
    }
  });
}
