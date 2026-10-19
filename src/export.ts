/**
 * export.ts — `liquen log export`: the log as documents a person reads (§9 — readability is
 * an export, never the on-disk format), or as JSON lines a program reads.
 *
 * A turn is the one `liquen log turns` lists (`turns.ts`): its opener, then each step in
 * order — the thinking it showed, the words it said, every call with its full output and
 * the run's facts (`extra.exec`), the step's own spend — the lines that reached the room
 * while it ran, how it ended, the totals, and the checkpoint text that covers any of it.
 * An export is every turn of every session the filters keep, session by session, oldest
 * first. Read off the store, so it answers for an org that is not running. On a terminal
 * the markdown is shown styled; `--md`, or a pipe, gets the markdown itself.
 */

import type { Event, Json, SessionRef, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { UsageRow } from "./store/log.ts";
import type { ExecRecord } from "./xi.ts";
import { describeCall, lineOf } from "./describe.ts";
import { errorTextOf, hhmm, ownVoice, shortId, textOf } from "./render.ts";
import { sessionAddress } from "./session.ts";
import {
  count,
  openedBy,
  openerOf,
  price,
  readTurns,
  rowById,
  took,
  type Turn,
  type TurnReader,
  turnsOf,
} from "./turns.ts";
import { jsonRecap } from "./tail.ts";
import type { Price } from "./prices.ts";
import { matches } from "./views.ts";

/** A turn found by what a reader has to hand: its handle or a step's, in full or by the six
 *  characters every surface shows; the id of one of its rows; or `last`. */
export function findTurn(turns: Turn[], key: string): Turn | undefined {
  if (key === "last") return turns.at(-1);
  const is = (id: string) => id === key || shortId(id) === key;
  return turns.findLast((t) =>
    is(t.id) || t.steps.some(is) || (key >= t.span.from && key <= t.span.to)
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The model's own headings, two levels under the document's, so its `# Plan` never reads
 *  as a section of the transcript. */
const demoted = (text: string) => text.replace(/^(#{1,4}) /gm, "$1## ");

/** A fence that no run of backticks in `text` can close. */
function fenced(text: string, lang = "text"): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

const tokensOf = (rows: UsageRow[]) =>
  rows.reduce(
    (t, r) => ({
      input: t.input + r.input_tokens,
      output: t.output + r.output_tokens,
      cache_read: t.cache_read + (r.cache_read_tokens ?? 0),
    }),
    { input: 0, output: 0, cache_read: 0 },
  );

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} kB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** One turn as markdown: `rows` are its room's rows over its span (append order), plus
 *  the opener where it was said elsewhere; `spend` its steps' usage rows; `checkpoint`
 *  the summary that covers it, if one does. */
export function transcript(
  turn: Turn,
  rows: Event[],
  spend: UsageRow[],
  checkpoint: Event | undefined,
  zone?: string,
): string {
  const ref = { agentId: turn.agent, id: turn.session };
  const steps = new Set(turn.steps);
  const out: string[] = [];
  const k = turn.tokens;
  out.push(
    `# Turn ${shortId(turn.id)} — ${sessionAddress(turn.agent, turn.session)}`,
    "",
    `- **opened by** ${openedBy(turn.opener)}`,
    `- **started** ${hhmm(turn.started, zone, true)} (${turn.started}) · **took** ${
      took(turn.duration_ms)
    }`,
    `- **${plural(turn.steps.length, "step")}** · ${plural(turn.calls, "call")} · ` +
      `${plural(turn.tool_errors, "tool error")} · ` +
      `**ended** ${turn.end}${turn.error ? ` — ${turn.error}` : ""}`,
    `- **tokens** ${k.input} in · ${k.output} out · ${k.cache_read} cache-read · ` +
      `${k.cache_write} cache-write`,
    ...(turn.changed?.length ? [`- **inputs changed** ${turn.changed.join(", ")}`] : []),
    ...(turn.checkpoint
      ? [
        `- **checkpoint** ${
          shortId(turn.checkpoint.id)
        } followed it (${turn.checkpoint.tokens.input} in · ` +
        `${turn.checkpoint.tokens.output} out)`,
      ]
      : []),
    `- **id** \`${turn.id}\``,
  );
  const results = new Map<string, ToolResultEvent>();
  for (const e of rows) {
    if (e.type === "tool_result") results.set(String(e.payload?.ref_id), e as ToolResultEvent);
  }
  let n = 0;
  let current: string | undefined;
  for (const e of rows) {
    const step = typeof e.payload?.turn_id === "string" && steps.has(e.payload.turn_id)
      ? e.payload.turn_id
      : undefined;
    if (step !== undefined && e.type !== "tool_result") {
      if (step !== current) {
        current = step;
        const t = tokensOf(spend.filter((r) => r.turn_id === step));
        out.push(
          "",
          `## Step ${++n} · ${hhmm(e.ts, zone)} · ${count(t.input)} in / ${count(t.output)} out / ${
            count(t.cache_read)
          } cache-read`,
        );
      }
      if (e.type === "thinking") {
        const said = String((e.parts?.[0]?.data as { thinking?: string })?.thinking ?? "").trim();
        if (said) out.push("", said.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
      } else if (e.type === "message") {
        const said = textOf(e).trim();
        if (said) out.push("", demoted(said));
      } else if (e.type === "tool_use") {
        const use = e as ToolUseEvent;
        out.push("", `### ⚙ ${describeCall(use.parts[0].data, { full: true })}`);
        const r = results.get(use.id);
        if (!r) {
          out.push("", "_no result in the log_");
          continue;
        }
        const { output, is_error, cancelled, refused } = r.parts[0].data;
        const run = r.extra?.exec as ExecRecord | undefined;
        const marks = [
          is_error ? (cancelled ? "cancelled" : refused ? "refused" : "**error**") : "ok",
          ...(run?.exit_code !== undefined ? [`exit ${run.exit_code}`] : []),
          ...(run ? [`${run.duration_ms} ms`, bytes(run.bytes)] : []),
        ];
        const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        out.push("", `${marks.join(" · ")}`, "", fenced(text ?? ""));
      }
      continue;
    }
    if (e.type === "error") {
      out.push("", `> **error** ${errorTextOf(e)}`);
      continue;
    }
    if (e.type === "control") {
      out.push("", `**${hhmm(e.ts, zone)} ${e.envelope.sender?.name ?? ""} ${textOf(e)}**`);
      continue;
    }
    if (e.type === "alarm") {
      out.push("", `## ⏰ ${hhmm(e.ts, zone)} wake`, "", textOf(e));
      continue;
    }
    if (e.type === "message" && !ownVoice(e, ref)) {
      const who = e.envelope.sender?.name ?? e.envelope.sender?.address ?? "someone";
      const said = lineOf(e);
      if (said) out.push("", `## ${hhmm(e.ts, zone)} ${who}`, "", said);
    }
  }
  if (checkpoint) {
    const covers = (checkpoint.payload?.covers ?? []) as string[];
    out.push(
      "",
      `## Checkpoint ${shortId(checkpoint.id)} · ${hhmm(checkpoint.ts, zone)}`,
      "",
      `_covers ${covers.map(shortId).join(" → ")}_`,
      "",
      demoted(textOf(checkpoint)),
    );
  }
  return out.join("\n") + "\n";
}

/** How many of a turn's rows one export reads at most. */
const ROWS = 20_000;

/** How many rows one page of a read is. */
const PAGE = 2_000;

/** Every row a read reaches, oldest first: a room's when `conversation` is named, the whole
 *  log's otherwise. */
export async function readAll(
  log: Pick<TurnReader, "read">,
  conversation?: string,
): Promise<Event[]> {
  let rows: Event[] = [];
  for (;;) {
    const older = await log.read({
      ...(conversation ? { conversation } : {}),
      limit: PAGE,
      ...(rows.length ? { beforeId: rows[0].id } : {}),
    });
    rows = [...older, ...rows];
    if (older.length < PAGE) return rows;
  }
}

/** The sessions whose rooms hold rows — a session's room is where its steps speak. */
export function sessionsIn(rows: Event[], agents: string[]): SessionRef[] {
  const seen = new Map<string, SessionRef>();
  for (const e of rows) {
    const a = e.agent;
    if (!a?.id || !a.session_id || !agents.includes(a.id)) continue;
    if (e.envelope.conversation.address !== sessionAddress(a.id, a.session_id)) continue;
    seen.set(`${a.id}\u0000${a.session_id}`, { agentId: a.id, id: a.session_id });
  }
  const mindFirst = (r: SessionRef) => `${r.agentId}\u0000${r.id === "mind" ? "" : r.id}`;
  return [...seen.values()].sort((a, b) => mindFirst(a) < mindFirst(b) ? -1 : 1);
}

/** What keeps a turn in an export: its start inside the window, the turn named, words in
 *  its transcript. */
export interface ExportScope {
  since?: string;
  until?: string;
  turn?: string;
  match?: string;
}

/** One session's turns, read off `rows` (its room, oldest first) and `byId` (every row in
 *  hand, for openers said elsewhere), priced, each with the rows its transcript covers. */
export async function sessionTurns(
  log: TurnReader,
  ref: SessionRef,
  rows: Event[],
  byId: Map<string, Event>,
  prices?: Price[],
): Promise<{ turn: Turn; rows: Event[]; spend: UsageRow[]; checkpoint?: Event }[]> {
  const turns = turnsOf(rows, ref);
  for (const t of turns) {
    if (t.opener.kind !== "unknown" || t.opener.id === undefined) continue;
    const seen = byId.get(t.opener.id) ?? await rowById(log, t.opener.id);
    const o = seen && openerOf(seen, ref);
    if (o) {
      t.opener = o;
      t.started = o.ts ?? t.started;
      t.duration_ms = Math.max(0, Date.parse(t.ended) - Date.parse(t.started));
    }
  }
  const steps = turns.flatMap((
    t,
  ) => [...t.steps, ...(t.checkpoint?.turn_id ? [t.checkpoint.turn_id] : [])]);
  const spend = steps.length ? await log.spend({ agentId: ref.agentId, turns: steps }) : [];
  price(turns, spend, prices);
  const summaries = rows.filter((e) => e.type === "summary");
  return turns.map((turn) => {
    const own = rows.filter((e) => e.id >= turn.span.from && e.id <= turn.span.to);
    if (turn.opener.id && !own.some((e) => e.id === turn.opener.id)) {
      const opener = byId.get(turn.opener.id);
      if (opener) own.unshift(opener);
    }
    const checkpoint = summaries.find((c) => {
      const [from, to] = (c.payload?.covers ?? []) as string[];
      return from !== undefined && from <= turn.span.to && to >= turn.span.from;
    });
    const mine = new Set(turn.steps);
    return {
      turn,
      rows: own,
      spend: spend.filter((r) => r.turn_id !== undefined && mine.has(r.turn_id)),
      ...(checkpoint ? { checkpoint } : {}),
    };
  });
}

/** The sessions as an export, turn by turn: markdown transcripts between rules, or one JSON
 *  object per row (each with its `agent`, `session` and `turn`) and per metered call. */
export async function* exportSessions(
  log: TurnReader,
  sessions: SessionRef[],
  opts: {
    format: "md" | "jsonl";
    scope?: ExportScope;
    zone?: string;
    prices?: Price[];
    /** Every row in hand, when the caller read the whole log already. */
    rows?: Event[];
  },
): AsyncGenerator<string> {
  const scope = opts.scope ?? {};
  const all = opts.rows;
  const byId = new Map((all ?? []).map((e) => [e.id, e]));
  let first = true;
  for (const ref of sessions) {
    const room = sessionAddress(ref.agentId, ref.id);
    const rows = all
      ? all.filter((e) => e.envelope.conversation.address === room)
      : await readAll(log, room);
    for (const t of await sessionTurns(log, ref, rows, byId, opts.prices)) {
      if (scope.since !== undefined && t.turn.started < scope.since) continue;
      if (scope.until !== undefined && t.turn.started >= scope.until) continue;
      if (scope.turn !== undefined && !isTurn(t.turn, scope.turn)) continue;
      if (opts.format === "md") {
        const doc = transcript(t.turn, t.rows, t.spend, t.checkpoint, opts.zone);
        if (!matches(doc, scope.match)) continue;
        yield `${first ? "" : "\n---\n\n"}${doc}`;
      } else {
        const lines = jsonRecap(t.rows, t.spend).map((o) => ({
          ...o,
          agent: ref.agentId,
          session: ref.id,
          turn: t.turn.id,
        } as Record<string, Json>));
        const text = lines.map((o) => JSON.stringify(o)).join("\n");
        if (!matches(text, scope.match)) continue;
        yield `${text}\n`;
      }
      first = false;
    }
  }
}

/** Whether `key` names this turn, the way `findTurn` reads a key. */
function isTurn(t: Turn, key: string): boolean {
  return findTurn([t], key) === t;
}

/** One turn as markdown, found by `key` through `readTurns`. */
export async function exportTurn(
  log: TurnReader,
  ref: { agentId: string; id: string },
  key: string,
  zone?: string,
  prices?: Price[],
): Promise<string> {
  const turns = await readTurns(log, ref, undefined, undefined, { prices });
  const turn = findTurn(turns, key);
  if (!turn) {
    throw new Error(
      `no turn "${key}" in ${
        sessionAddress(ref.agentId, ref.id)
      } — \`liquen log turns\` lists them`,
    );
  }
  const conversation = sessionAddress(ref.agentId, ref.id);
  const rows = (await log.read({ conversation, beforeId: `${turn.span.to}0`, limit: ROWS }))
    .filter((e) => e.id >= turn.span.from);
  if (turn.opener.id && !rows.some((e) => e.id === turn.opener.id)) {
    const opener = await rowById(log, turn.opener.id);
    if (opener) rows.unshift(opener);
  }
  const spend = await log.spend({ agentId: ref.agentId, turns: turn.steps });
  // the checkpoint that covers it: the first whose range reaches into the turn's rows
  const checkpoint = (await log.read({ conversation, types: ["summary"], afterId: turn.span.from }))
    .find((c) => {
      const [from, to] = (c.payload?.covers ?? []) as string[];
      return from !== undefined && from <= turn.span.to && to >= turn.span.from;
    });
  return transcript(turn, rows, spend, checkpoint, zone);
}
