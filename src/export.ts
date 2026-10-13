/**
 * export.ts — `liquen log export`: one turn of the log as a document a person reads (§9 —
 * readability is an export, never the on-disk format).
 *
 *   liquen log export --turn <id|last> [--agent <name>] [--session <name>] [--md]
 *
 * The turn is the one `liquen turns` lists (`turns.ts`): its opener, then each step in
 * order — the thinking it showed, the words it said, every call with its full output and
 * the run's facts (`extra.exec`), the step's own spend — the lines that reached the room
 * while it ran, how it ended, the totals, and the checkpoint text that covers any of it.
 * Read off the store like `liquen turns`, so it answers for an org that is not running.
 * On a terminal the document is shown styled; `--md`, or a pipe, gets the markdown itself.
 */

import type { Event, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { UsageRow } from "./store/log.ts";
import type { ExecRecord } from "./xi.ts";
import { describeCall, lineOf } from "./describe.ts";
import { errorTextOf, hhmm, ownVoice, shortId, textOf } from "./render.ts";
import { sessionAddress } from "./session.ts";
import {
  count,
  defaultAgent,
  openedBy,
  parseTurnsArgs,
  readTurns,
  rowById,
  took,
  type Turn,
  type TurnReader,
} from "./turns.ts";
import { renderMarkdown } from "./md.ts";
import { openStore } from "./store/mod.ts";
import { findRoot, orgFlag, readConfig } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = `usage: liquen log export --turn <id|last> [--dir <org>] [--agent <name>]
                         [--session <name>] [--md]

  One turn as a transcript: what opened it, each step's thinking, words and calls with
  their full output, each step's tokens, how it ended, the totals, and the checkpoint
  that covers it.

  --turn <id|last>  the turn — the handle \`liquen turns\` prints or any of its steps'
                    ids (whole, or their last six characters), the id of any row in it,
                    or \`last\`
  --agent <name>    whose turn (a roster name); default: the only agent, or your username
  --session <name>  the session; default: the mind
  --md              the markdown itself, even on a terminal`;

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

/** The turn `key` names, as markdown, read through `log`. */
export async function exportTurn(
  log: TurnReader,
  ref: { agentId: string; id: string },
  key: string,
  zone?: string,
): Promise<string> {
  const turns = await readTurns(log, ref);
  const turn = findTurn(turns, key);
  if (!turn) {
    throw new Error(
      `no turn "${key}" in ${sessionAddress(ref.agentId, ref.id)} — \`liquen turns\` lists them`,
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
    .find((s) => {
      const [from, to] = (s.payload?.covers ?? []) as string[];
      return from !== undefined && from <= turn.span.to && to >= turn.span.from;
    });
  return transcript(turn, rows, spend, checkpoint, zone);
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const [verb, ...rest] = org.args;
    if (verb !== "export") throw new Error(USAGE);
    const args = parseTurnsArgs(rest);
    let key: string | undefined;
    let md = false;
    for (let i = 0; i < args.rest.length; i++) {
      const a = args.rest[i];
      if (a === "--turn") key = args.rest[++i];
      else if (a === "--md") md = true;
      else throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
    if (!key) throw new Error(`--turn names the turn\n${USAGE}`);
    const root = findRoot(org);
    const catalog = await readConfig(root);
    const agentId = args.agent ?? defaultAgent(Object.keys(catalog.agents));
    if (!(agentId in catalog.agents)) {
      throw new Error(`no agent "${agentId}" in ${root}/config.jsonc`);
    }
    const log = await (await openStore(root)).log();
    try {
      const doc = await exportTurn(
        log,
        { agentId, id: args.session },
        key,
        catalog.organization.timezone,
      );
      const styled = !md && Deno.stdout.isTerminal();
      await Deno.stdout.write(new TextEncoder().encode(styled ? renderMarkdown(doc) : doc));
    } finally {
      await log.close();
    }
  });
}
