/**
 * turns.ts — what a session's turns were, read off the log (§2, §5). A turn is never
 * tracked, so it is derived here the way render derives one: the steps (`payload.turn_id`,
 * one per model call) from the look that opened it to the closing that ended it — a
 * closing message (`end_turn`), a terminal error, or the principal's cut. One reading
 * serves the turn that just ended (main's line in `liquen.log`) and every turn before it
 * (`liquen log turns`, `liquen log export`, `liquen status --json`), so the live line and the
 * history agree by construction.
 *
 * A turn's handle is its first step's `turn_id`. What opened it is the news the first
 * step's request read last (`extra.consumed`, the horizon it carries): a message, a fired
 * wake, a principal's verdict, a script's call through the door, a checkpoint's insert.
 * Its cost is the usage rows its steps metered (`price`), joined on the same key; the
 * checkpoints written after it (or inside it, when it ran away) are calls of their own,
 * priced beside the turn's.
 */

import type { Event, EventId, SessionRef, ToolResultEvent } from "./types.ts";
import type { ReadQuery, UsageRow } from "./store/log.ts";
import { changedInputs, type Inputs } from "./inputs.ts";
import { type Cost, costOfAll, dollars, type Price } from "./prices.ts";
import { sessionAddress } from "./session.ts";
import { ownComplex, ownVoice, scripted, shortId, textOf, unloadOf } from "./render.ts";
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
  kind:
    | "message"
    | "reminder"
    | "alarm"
    | "update"
    | "verdict"
    | "call"
    | "cancel"
    | "checkpoint"
    | "unload"
    | "unknown";
  id?: EventId;
  ts?: string;
  /** Who said it: a message's or a verdict's sender. */
  who?: string;
  /** The surface a principal's line came in through, for a mirror's copy of it. */
  via?: string;
  /** The doc a reminder's lines stand in. */
  name?: string;
  /** What it said: a message's words, an alarm's note, a call's tool, the call an update
   *  tells about. */
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
  /** The checkpoints written after it or inside it, by the latest record's id and time,
   *  with what their calls (`turn_ids`, oldest first) metered and, priced, cost: apart from
   *  the turn's own `tokens` and `cost`, which are its steps'. */
  checkpoint?: { id: EventId; ts: string; turn_ids: string[]; tokens: Tokens; cost?: Cost };
  /** What its first stamped step was made of (inputs.ts), when a step of it stamped one. */
  inputs?: Inputs;
  /** The inputs that differ from the session's previous stamp in the rows read: absent when
   *  no stamp came before it there. */
  changed?: string[];
  /** What its steps' calls cost (prices.ts), when `price` was handed prices. */
  cost?: Cost;
  /** The turn's rows by id: the opener (or first step) through its last row. */
  span: { from: EventId; to: EventId };
}

const CONTINUING = new Set(["tool_use", "pause_turn", "max_tokens"]);
const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

/** A step row of this session's own model: its turn key, never a door call's (`job:`), and
 *  never an update's — it names the step of the call it tells about, but it is news that
 *  came after (late.ts). */
function stepOf(e: Event, ref: SessionRef): string | undefined {
  const turn = e.payload?.turn_id;
  if (typeof turn !== "string" || turn.startsWith("job:")) return undefined;
  if (e.type === "tool_result" && e.payload?.update) return undefined;
  if (e.agent?.id !== ref.agentId || e.agent.session_id !== ref.id) return undefined;
  return turn;
}

/** The opener a row would be, or undefined when it is not news to this session. */
export function openerOf(e: Event, ref: SessionRef): Opener | undefined {
  const at = { id: e.id, ts: e.ts };
  const turn = e.payload?.turn_id;
  if (typeof turn === "string" && turn.startsWith("job:")) {
    // a script's call inside a bash call opens nothing: its answer wakes nobody
    if (e.type !== "tool_use" || scripted(e) !== undefined) return undefined;
    return { kind: "call", ...at, text: String(e.parts?.[0]?.data?.name ?? "") };
  }
  switch (e.type) {
    case "message": {
      // a mirror's copy of a principal's line (`extra.via`) is input, like a REPL line
      if (ownVoice(e, ref)) return undefined;
      const who = e.envelope.sender?.name ?? e.envelope.sender?.address;
      const via = (e.extra?.via as { service?: string } | undefined)?.service;
      return {
        kind: "message",
        ...at,
        ...(who ? { who } : {}),
        ...(via ? { via } : {}),
        text: textOf(e),
      };
    }
    case "alarm": {
      if (unloadOf(e)) return { kind: "unload", ...at };
      const reminder = (e.extra?.reminder ?? {}) as { doc?: string };
      const text = textOf(e);
      return reminder.doc
        ? { kind: "reminder", ...at, name: reminder.doc, text }
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
    case "tool_result":
      if (!e.payload.update || !ownComplex(e, ref)) return undefined;
      return { kind: "update", ...at, text: e.parts[0].text ?? "" };
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
  let steering = new Map<EventId, Opener>(); // news that landed while the open turn ran
  let read: EventId | undefined; // the furthest the open turn's steps read
  let stamp: Inputs | undefined; // the last input set a step stamped, in the rows so far
  const noteInputs = (t: Turn, e: Event) => {
    const inputs = e.extra?.inputs as Inputs | undefined;
    if (inputs === undefined || typeof inputs !== "object") return;
    if (t.inputs === undefined) {
      t.inputs = inputs;
      if (stamp !== undefined) t.changed = changedInputs(stamp, inputs);
    }
    stamp = inputs;
  };

  const noteRead = (e: Event) => {
    const consumed = e.extra?.consumed;
    if (typeof consumed === "string" && (read === undefined || consumed > read)) read = consumed;
  };
  const close = (t: Turn, end: TurnEnd, at: Event) => {
    t.end = end;
    touch(t, at);
    open = undefined;
    erred = undefined;
    // news past the turn's horizon reached none of its steps: a wake that fired while the
    // last call was in flight is the next turn's to open, not this one's steering (a turn
    // with no horizon in its rows says nothing either way, and keeps none)
    for (const [id, o] of steering) {
      if (read === undefined || id <= read) continue;
      news = o;
      lastNewsBefore.set(id, o);
    }
    steering = new Map();
    read = undefined;
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
        // a checkpoint is written in the idle gap, and follows the turn that just ended; one
        // written inside a turn that ran away is that turn's. A gap may write more than one,
        // until the window weighs under the threshold
        const last = turns.at(-1);
        if (last && (last !== open || e.payload.running === true)) {
          last.checkpoint = {
            id: e.id,
            ts: e.ts,
            turn_ids: [...last.checkpoint?.turn_ids ?? [], step],
            tokens: zero(),
          };
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
        noteInputs(owner, e);
        if (owner === open) noteRead(e);
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
      noteInputs(t, e);
      noteRead(e);
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
    if (open) {
      steering.set(e.id, o); // news mid-turn: steering, if a later step reads it
      continue;
    }
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

/** Fill each turn's tokens (and its checkpoint's) from the usage rows its steps metered,
 *  and, handed the org's prices, what those calls cost. */
export function price(turns: Turn[], spend: UsageRow[], prices?: Price[]): Turn[] {
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
    if (prices !== undefined) t.cost = costOfAll(t.steps.flatMap((s) => rows.get(s) ?? []), prices);
    if (t.checkpoint) {
      const of = t.checkpoint.turn_ids.flatMap((k) => rows.get(k) ?? []);
      t.checkpoint.tokens = zero();
      for (const r of of) add(t.checkpoint.tokens, r);
      if (prices !== undefined) t.checkpoint.cost = costOfAll(of, prices);
    }
  }
  return turns;
}

/** The keys a turn's usage rows are metered under: its steps', then its checkpoints'. */
export function spendKeys(t: Turn): string[] {
  return [...t.steps, ...t.checkpoint?.turn_ids ?? []];
}

/** What `readTurns` reads through: a log's two reads, scoped or not. */
export interface TurnReader {
  read(query?: ReadQuery): Promise<Event[]>;
  spend(query?: { agentId?: string; turns?: string[] }): Promise<UsageRow[]>;
}

/** How many rows one page of the session's room is. */
const PAGE = 2_000;

/**
 * A session's turns, newest first, priced, their openers looked up where the room does not
 * hold them. The room is read back by id a page at a time, and a turn is emitted once the
 * rows before it are read: the oldest turn in hand may have begun on a page not read yet,
 * so it waits for the next. The rows of the turns emitted are let go from the first step
 * of the oldest of them on, which keeps every row the turns before it are read off (a
 * checkpoint lands before the next turn's first step). What a walk holds is the turn
 * being assembled and a page; it reaches as far back as the room goes, and the caller
 * stops it by stopping to ask.
 */
export async function* walkTurns(
  log: TurnReader,
  ref: SessionRef,
  opts: { page?: number; prices?: Price[] } = {},
): AsyncGenerator<Turn> {
  const conversation = sessionAddress(ref.agentId, ref.id);
  const page = opts.page ?? PAGE;
  let rows: Event[] = []; // the rows in hand, oldest first
  let before: EventId | undefined; // the oldest row read
  for (;;) {
    const older = await log.read({
      conversation,
      limit: page,
      ...(before ? { beforeId: before } : {}),
    });
    if (older.length) before = older[0].id;
    rows = [...older, ...rows];
    const whole = older.length < page;
    const turns = turnsOf(rows, ref);
    const done = whole ? turns : turns.slice(1);
    if (done.length) {
      await settle(log, ref, done, opts.prices);
      for (const t of done.toReversed()) yield t;
      const first = done[0];
      const at = rows.findIndex((e) => e.id === first.id || stepOf(e, ref) === first.steps[0]);
      rows = rows.slice(0, Math.max(0, at));
    }
    if (whole) return;
  }
}

/** Openers the room does not hold, looked up by id; then the turns priced in one read. */
async function settle(
  log: TurnReader,
  ref: SessionRef,
  turns: Turn[],
  prices?: Price[],
): Promise<void> {
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
  const keys = turns.flatMap(spendKeys);
  if (keys.length) price(turns, await log.spend({ agentId: ref.agentId, turns: keys }), prices);
}

/**
 * A session's last `want` turns, oldest first (all of them when `want` is omitted), back to
 * the first that ended before `since` when one is given.
 */
export async function readTurns(
  log: TurnReader,
  ref: SessionRef,
  want?: number,
  page = PAGE,
  opts: { prices?: Price[]; since?: string } = {},
): Promise<Turn[]> {
  const turns: Turn[] = [];
  if (want === 0) return turns;
  for await (const t of walkTurns(log, ref, { page, prices: opts.prices })) {
    if (opts.since !== undefined && t.ended < opts.since) break;
    turns.unshift(t);
    if (want !== undefined && turns.length >= want) break;
  }
  return turns;
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
      return `message${o.who ? ` from ${o.who}` : ""}${o.via ? ` via ${o.via}` : ""}${
        quote(o.text)
      }`;
    case "reminder":
      return `reminder ${o.name}${quote(o.text)}`;
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
    case "unload":
      return "unload";
    case "update":
      return `update on ${o.text || "a call"}`;
    default:
      return o.id ? `unknown (${shortId(o.id)})` : "unknown";
  }
}

/** The turn as one line — what `liquen.log` carries at every turn's end, and `liquen log
 *  turns` prints per row. */
export function turnLine(t: Turn): string {
  const k = t.tokens;
  return [
    `${t.session}@${t.agent} ${shortId(t.id)}`,
    `opened by ${openedBy(t.opener)}`,
    `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`,
    `${t.calls} call${t.calls === 1 ? "" : "s"}`,
    `${t.tool_errors} tool error${t.tool_errors === 1 ? "" : "s"}`,
    `tokens ${tokens(k)}`,
    ...(t.cost ? [dollars(t.cost)] : []),
    `${t.end}${t.end === "error" && t.error ? `: ${oneLine(t.error)}` : ""}`,
    took(t.duration_ms),
    t.checkpoint ? checkpointed(t.checkpoint) : "no checkpoint",
  ].join(" · ");
}

const tokens = (k: Tokens) =>
  `${count(k.input)} in / ${count(k.output)} out / ${count(k.cache_read)} cache-read`;

/** A checkpoint by its id (more than one by how many, then the latest's id), then what
 *  their calls metered and cost, once priced. */
const checkpointed = (c: NonNullable<Turn["checkpoint"]>) =>
  [
    c.turn_ids.length === 1
      ? `checkpoint ${shortId(c.id)}`
      : `${c.turn_ids.length} checkpoints, the last ${shortId(c.id)}`,
    tokens(c.tokens),
    ...(c.cost ? [dollars(c.cost)] : []),
  ].join(" ");

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};
