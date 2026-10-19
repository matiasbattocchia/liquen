/**
 * log.ts — `liquen log <view>`: what the org's agents did, read off its log.
 *
 * One command, one set of filters, a view per question: the turns, an export of them, the
 * errors, the calls, the egress proxy's requests, the spend, and the live tail. Every view
 * but the tail reads the store, so it answers for history and for an org that is not
 * running; the tail watches one that is, through its door (`tail.ts`).
 */

import type { Event, SessionRef, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { ErrorEvent } from "./types.ts";
import type { Log, UsageRow } from "./store/log.ts";
import { openStore } from "./store/mod.ts";
import { findRoot, type OrgConfig, orgFlag, readConfig } from "./config.ts";
import { entry } from "./entry.ts";
import { hhmm } from "./render.ts";
import { MIND, sessionAddress } from "./session.ts";
import { count, defaultAgent, readTurns, type Turn, turnLine, turnsOf } from "./turns.ts";
import { exportSessions, exportTurn, findTurn, readAll, sessionsIn } from "./export.ts";
import { renderMarkdown } from "./md.ts";
import { runTail, USAGE as TAIL_USAGE } from "./tail.ts";
import { dollars } from "./prices.ts";
import {
  callRows,
  dayOf,
  ERROR_KINDS,
  errorGroups,
  type ErrorKind,
  handle,
  isWrite,
  matches,
  parseWhen,
  sessionOfRow,
  sessionsOfSteps,
  SPEND_BY,
  type SpendBy,
  spendGroups,
  totals,
  turnsOfRequests,
} from "./views.ts";

export const USAGE = `usage: liquen log <view> [filters] [--dir <org>]

  What the org's agents did, read off its log — so it answers for an org that is not
  running, too (tail watches one that is).

  turns       one line per turn: what opened it, steps, errors, tokens, cost, and a line
              where what it read changed. Start here.
  export      the log as markdown transcripts (--md, the default) or JSON lines (--jsonl):
              every session the filters keep, turn by turn. --turn <id> is one turn.
  errors      what went wrong, grouped by message, most frequent first: failed tool calls,
              failed model calls, the harness's own failures, and requests a host refused
              (--kind tool|provider|system|proxy).
  tool-calls  every call the agents made and how it ended, across turns. --match <text>
              follows one command over time.
  requests    the HTTP requests the egress proxy made for the agents, and what each host
              answered. --writes keeps the ones that change something.
  spend       tokens and dollars, by day (--by day|turn|session|model|agent).
  tail        a session live, as it happens; -f keeps watching.

  filters, for every view that reads history:
    --agent <name>    one agent (a roster name); default: every agent
    --session <name>  one session; default: every session (turns: the mind)
    --turn <id|last>  one turn: the handle a view prints, a step's id, or last
    --since <when>    from then on: an age (30m, 12h, 3d), a day (2026-10-19) or a time
                      (2026-10-19T09:00) on the org's clock
    --until <when>    up to then, the same forms
    --match <text>    only what contains it, case folded
    --json            one JSON object per line (export: --jsonl)

  liquen log <view> --help says a view's own flags.`;

/** Each view's own flags, beside the filters. */
const VIEWS: Record<string, { flags: string[]; usage: string }> = {
  turns: {
    flags: ["--limit"],
    usage: `usage: liquen log turns [filters] [--limit <n>]

  One line per turn of a session, oldest first: what opened it, its steps and calls, the
  tool errors, the tokens its steps metered and what they cost, how it ended, how long it
  took, and whether a checkpoint followed. A line \`── changed: …\` stands before a turn
  whose inputs — instructions, skills, tools, the programs on PATH, the agent's settings,
  liquen's version — differ from the turn before it.

  --session <name>  the session; default: the mind
  --limit <n>       how many turns, the most recent; default: 20 (every one in --since)`,
  },
  export: {
    flags: ["--md", "--jsonl"],
    usage: `usage: liquen log export [filters] [--md | --jsonl]

  The log as documents: each turn's transcript — what opened it, each step's thinking,
  words and calls with their full output, each step's tokens, how it ended, the totals,
  and the checkpoint that covers it — session by session, oldest first. Every session the
  filters keep; --turn <id> is one turn. On a terminal the markdown is shown styled.

  --md     the markdown itself, even on a terminal (the default format)
  --jsonl  one JSON object per row instead, each with its agent, session and turn, and
           one per metered call (type: "usage")`,
  },
  errors: {
    flags: ["--kind"],
    usage: `usage: liquen log errors [filters] [--kind <kind>]

  What went wrong, grouped by message — ids and long numbers masked so occurrences of one
  failure group — the most frequent first, with when it was first and last seen and the
  steps it happened in (export --turn takes any of them).

  --kind <kind>  one kind: tool (a call that failed), provider (a model call that failed),
                 system (the harness's own failure), proxy (a host that refused a request)`,
  },
  "tool-calls": {
    flags: [],
    usage: `usage: liquen log tool-calls [filters]

  Every call the agents made, oldest first: when, the step, the call, and how its latest
  result says it ended — ok, error (with its exit code and first line), refused,
  cancelled, or pending. --match <text> keeps the calls whose description holds it.`,
  },
  requests: {
    flags: ["--writes"],
    usage: `usage: liquen log requests [filters] [--writes]

  The requests the egress proxy made for the agents — method, host, path, and what the
  host answered — with the turn each was made in. Requests carry no session: --session
  narrows only the turns they are matched to.

  --writes  only requests that change something: not GET, HEAD, OPTIONS or CONNECT`,
  },
  spend: {
    flags: ["--by"],
    usage: `usage: liquen log spend [filters] [--by <key>]

  Tokens and dollars per group: calls, input, output, cache read and write, and the cost
  at the price in effect on each call's day (prices.ts, and the org's system.prices). A
  call no price covers counts as unpriced, never as $0.

  --by <key>  day (the default, on the org's clock), turn, session, model or agent`,
  },
  tail: { flags: [], usage: TAIL_USAGE },
};

export interface LogArgs {
  view: string;
  agent?: string;
  session?: string;
  turn?: string;
  since?: string;
  until?: string;
  match?: string;
  json: boolean;
  limit?: number;
  format: "md" | "jsonl";
  forcedMd: boolean;
  kind?: ErrorKind;
  writes: boolean;
  by: SpendBy;
}

/** A view's arguments: the filters every view shares and the view's own flags. `zone` is
 *  the org's clock, which the times are read on. */
export function parseLogArgs(
  view: string,
  args: string[],
  zone: string,
  now: number = Date.now(),
): LogArgs {
  const spec = VIEWS[view];
  if (!spec) throw new Error(`no view "${view}"\n${USAGE}`);
  const out: LogArgs = {
    view,
    json: false,
    format: "md",
    forcedMd: false,
    writes: false,
    by: "day",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const own = spec.flags.includes(a);
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${a} needs a value\n${spec.usage}`);
      }
      return v;
    };
    if (a === "--agent") out.agent = value();
    else if (a === "--session") out.session = value();
    else if (a === "--turn") out.turn = value();
    else if (a === "--since") out.since = parseWhen(value(), zone, now);
    else if (a === "--until") out.until = parseWhen(value(), zone, now);
    else if (a === "--match") out.match = value();
    else if (a === "--json") out.json = true;
    else if (own && a === "--limit") {
      out.limit = Number(value());
      if (!Number.isInteger(out.limit) || out.limit < 1) {
        throw new Error(`--limit is a positive whole number\n${spec.usage}`);
      }
    } else if (own && a === "--md") {
      out.format = "md";
      out.forcedMd = true;
    } else if (own && a === "--jsonl") out.format = "jsonl";
    else if (own && a === "--kind") {
      const k = value();
      if (!ERROR_KINDS.includes(k as ErrorKind)) {
        throw new Error(`--kind is one of ${ERROR_KINDS.join(", ")}\n${spec.usage}`);
      }
      out.kind = k as ErrorKind;
    } else if (own && a === "--writes") out.writes = true;
    else if (own && a === "--by") {
      const by = value();
      if (!SPEND_BY.includes(by as SpendBy)) {
        throw new Error(`--by is one of ${SPEND_BY.join(", ")}\n${spec.usage}`);
      }
      out.by = by as SpendBy;
    } else throw new Error(`unknown argument ${a}\n${spec.usage}`);
  }
  if (out.since && out.until && out.since >= out.until) {
    throw new Error("--since comes before --until");
  }
  return out;
}

/** What a view reads with: the store, the catalog, and the agents the filters keep. */
interface Ctx {
  log: Log;
  catalog: OrgConfig;
  zone: string;
  agents: string[];
  args: LogArgs;
  say: (line: string) => void;
}

/** The turn `--turn` names, in `--agent`'s (or the default agent's) `--session` (or the
 *  mind), or an error that says where it looked. */
async function namedTurn(c: Ctx): Promise<Turn> {
  const agentId = c.args.agent ?? defaultAgent(Object.keys(c.catalog.agents));
  const ref = { agentId, id: c.args.session ?? MIND };
  const turns = await readTurns(c.log, ref, undefined, undefined, { pages: 50 });
  const t = findTurn(turns, c.args.turn!);
  if (!t) {
    throw new Error(
      `no turn "${c.args.turn}" in ${sessionAddress(ref.agentId, ref.id)} — ` +
        "`liquen log turns` lists them",
    );
  }
  return t;
}

/** Whether a row stands where the filters look: its agent and session, the named turn's
 *  span. */
function kept(
  c: Ctx,
  where: { agent?: string; session?: string } | undefined,
  turn?: Turn,
  id?: string,
) {
  if (c.args.agent !== undefined && where?.agent !== c.args.agent) return false;
  if (where?.agent !== undefined && !c.agents.includes(where.agent)) return false;
  if (c.args.session !== undefined && where?.session !== c.args.session) return false;
  if (turn && id !== undefined && (id < turn.span.from || id > turn.span.to)) return false;
  return true;
}

/** The window a read covers: `--since`/`--until`, narrowed to the named turn's time. */
function windowOf(c: Ctx, turn?: Turn): { after?: string; before?: string } {
  const after = turn ? maxOf(c.args.since, beforeTs(turn.started)) : c.args.since;
  const before = turn ? minOf(c.args.until, afterTs(turn.ended)) : c.args.until;
  return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
}
const beforeTs = (ts: string) => new Date(Date.parse(ts) - 1).toISOString();
const afterTs = (ts: string) => new Date(Date.parse(ts) + 1).toISOString();
const maxOf = (a: string | undefined, b: string) => a === undefined || b > a ? b : a;
const minOf = (a: string | undefined, b: string) => a === undefined || b < a ? b : a;

/* ── the views ────────────────────────────────────────────────────────── */

async function turnsView(c: Ctx): Promise<void> {
  const session = c.args.session ?? MIND;
  const one = c.args.turn ? await namedTurn(c) : undefined;
  const limit = c.args.limit ?? (c.args.since ? undefined : 20);
  const all: Turn[] = [];
  for (const agentId of c.agents) {
    const turns = await readTurns(c.log, { agentId, id: session }, limit, undefined, {
      prices: c.catalog.system.prices,
      ...(c.args.since ? { pages: 50 } : {}),
    });
    all.push(...turns);
  }
  all.sort((a, b) => a.started < b.started ? -1 : a.started > b.started ? 1 : 0);
  const shown = all.filter((t) =>
    (one === undefined || t.id === one.id) &&
    (c.args.since === undefined || t.started >= c.args.since) &&
    (c.args.until === undefined || t.started < c.args.until) &&
    matches(turnLine(t), c.args.match)
  );
  for (const t of limit === undefined ? shown : shown.slice(Math.max(0, shown.length - limit))) {
    if (c.args.json) {
      c.say(JSON.stringify(t));
      continue;
    }
    if (t.changed?.length) c.say(`── changed: ${listed(t.changed)}`);
    c.say(`${hhmm(t.started, c.zone, true)}  ${turnLine(t)}`);
  }
}

/** A list of names as one line, the first eight and how many more. */
function listed(names: string[]): string {
  const head = names.slice(0, 8).join(", ");
  return names.length > 8 ? `${head} and ${names.length - 8} more` : head;
}

async function exportView(c: Ctx): Promise<void> {
  const styled = c.args.format === "md" && !c.args.forcedMd && Deno.stdout.isTerminal();
  const write = (text: string) =>
    Deno.stdout.write(new TextEncoder().encode(styled ? renderMarkdown(text) : text));
  const prices = c.catalog.system.prices;
  if (c.args.turn && c.args.format === "md") {
    const agentId = c.args.agent ?? defaultAgent(Object.keys(c.catalog.agents));
    await write(
      await exportTurn(c.log, { agentId, id: c.args.session ?? MIND }, c.args.turn, c.zone, prices),
    );
    return;
  }
  let sessions: SessionRef[];
  let rows: Event[] | undefined;
  if (c.args.agent !== undefined && c.args.session !== undefined) {
    sessions = [{ agentId: c.args.agent, id: c.args.session }];
  } else if (c.args.turn) {
    const agentId = c.args.agent ?? defaultAgent(Object.keys(c.catalog.agents));
    sessions = [{ agentId, id: c.args.session ?? MIND }];
  } else {
    rows = await readAll(c.log);
    sessions = sessionsIn(rows, c.agents).filter((s) =>
      c.args.session === undefined || s.id === c.args.session
    );
  }
  for await (
    const chunk of exportSessions(c.log, sessions, {
      format: c.args.format,
      scope: {
        ...(c.args.since ? { since: c.args.since } : {}),
        ...(c.args.until ? { until: c.args.until } : {}),
        ...(c.args.turn ? { turn: c.args.turn } : {}),
        ...(c.args.match ? { match: c.args.match } : {}),
      },
      zone: c.zone,
      prices,
      ...(rows ? { rows } : {}),
    })
  ) await write(chunk);
}

async function errorsView(c: Ctx): Promise<void> {
  const turn = c.args.turn ? await namedTurn(c) : undefined;
  const window = windowOf(c, turn);
  const rows = await c.log.read({ types: ["tool_use", "tool_result", "error"], ...window });
  const here = rows.filter((e) => kept(c, sessionOfRow(e), turn, e.id));
  const requests = c.args.session !== undefined || c.args.kind && c.args.kind !== "proxy"
    ? []
    : (await c.log.requests(window)).filter((q) =>
      (c.args.agent === undefined || q.agent_id === c.args.agent) &&
      (q.agent_id === undefined || c.agents.includes(q.agent_id))
    );
  const groups = errorGroups({
    uses: here.filter((e): e is ToolUseEvent => e.type === "tool_use"),
    results: here.filter((e): e is ToolResultEvent => e.type === "tool_result"),
    errors: here.filter((e): e is ErrorEvent => e.type === "error"),
    requests,
  }).filter((g) =>
    (c.args.kind === undefined || g.kind === c.args.kind) && matches(g.sample, c.args.match)
  );
  if (c.args.json) {
    for (const g of groups) c.say(JSON.stringify(g));
    return;
  }
  if (groups.length === 0) {
    c.say("no errors");
    return;
  }
  for (const g of groups) {
    const steps = g.steps.slice(-3).map(handle).join(" ");
    const more = g.steps.length > 3 ? ` +${g.steps.length - 3}` : "";
    c.say(
      `${String(g.count).padStart(4)}×  ${g.kind.padEnd(8)} ${g.signature}\n` +
        `        first ${hhmm(g.first, c.zone, true)} · last ${hhmm(g.last, c.zone, true)}` +
        (steps ? ` · in ${steps}${more}` : ""),
    );
  }
}

async function toolCallsView(c: Ctx): Promise<void> {
  const turn = c.args.turn ? await namedTurn(c) : undefined;
  const window = windowOf(c, turn);
  const uses = (await c.log.read({ types: ["tool_use"], ...window }))
    .filter((e): e is ToolUseEvent =>
      e.type === "tool_use" && kept(c, sessionOfRow(e), turn, e.id)
    );
  if (uses.length === 0) {
    if (!c.args.json) c.say("no calls");
    return;
  }
  // a result lands after its call, past the window's end as often as not
  const results = (await c.log.read({ types: ["tool_result"], afterId: uses[0].id }))
    .filter((e): e is ToolResultEvent => e.type === "tool_result");
  const calls = callRows(uses, results).filter((r) => matches(r.call, c.args.match));
  const tally = new Map<string, number>();
  for (const r of calls) {
    tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
    if (c.args.json) {
      c.say(JSON.stringify(r));
      continue;
    }
    const call = r.call.replace(/\s+/g, " ");
    const how = [
      r.outcome === "error" ? "ERROR" : r.outcome,
      ...(r.exit_code !== undefined && r.exit_code !== 0 ? [`exit ${r.exit_code}`] : []),
      ...(r.said ? [r.said] : []),
    ].join(" · ");
    c.say(
      `${hhmm(r.ts, c.zone, true)}  ${handle(r.step)}  ${
        call.length > 140 ? `${call.slice(0, 139)}…` : call
      }  ${how}`,
    );
  }
  if (!c.args.json) {
    c.say(
      `${calls.length} call${calls.length === 1 ? "" : "s"} · ${
        [...tally].map(([k, n]) => `${n} ${k}`).join(" · ")
      }`,
    );
  }
}

async function requestsView(c: Ctx): Promise<void> {
  const turn = c.args.turn ? await namedTurn(c) : undefined;
  const window = windowOf(c, turn);
  const rows =
    (await c.log.requests({ ...window, ...(c.args.agent ? { agentId: c.args.agent } : {}) }))
      .filter((q) =>
        (q.agent_id === undefined || c.agents.includes(q.agent_id)) &&
        (!c.args.writes || isWrite(q)) &&
        matches(`${q.method} ${q.host}${q.path} ${q.status}`, c.args.match)
      );
  // the turns the requests were made in: each agent's turns in the window
  const turns: Turn[] = [];
  for (const agentId of new Set(rows.flatMap((q) => q.agent_id ? [q.agent_id] : []))) {
    const all = await readTurns(
      c.log,
      { agentId, id: c.args.session ?? MIND },
      undefined,
      undefined,
      { pages: 50 },
    );
    turns.push(...all.filter((t) => !window.after || t.ended >= window.after));
  }
  const of = turnsOfRequests(rows, turns);
  const shown = rows.map((q, i) => ({ ...q, turn: of[i] })).filter((q) =>
    !turn || q.turn === turn.id
  );
  for (const q of shown) {
    c.say(
      c.args.json
        ? JSON.stringify(q)
        : `${hhmm(q.created_at, c.zone, true)}  ${q.turn ? handle(q.turn) : "-     "}  ${
          q.agent_id ?? "-"
        }  ` +
          `${q.method.padEnd(6)} ${q.host}${q.path}  ${q.status}`,
    );
  }
  if (!c.args.json) {
    const writes = shown.filter(isWrite).length;
    const refused = shown.filter((q) => q.status >= 400).length;
    c.say(
      `${shown.length} request${
        shown.length === 1 ? "" : "s"
      } · ${writes} writes · ${refused} refused`,
    );
  }
}

async function spendView(c: Ctx): Promise<void> {
  const turn = c.args.turn ? await namedTurn(c) : undefined;
  const window = windowOf(c, turn);
  let rows: UsageRow[] =
    (await c.log.spend({ ...window, ...(c.args.agent ? { agentId: c.args.agent } : {}) }))
      .filter((r) => r.agent_id === undefined || c.agents.includes(r.agent_id));
  if (turn) rows = rows.filter((r) => r.turn_id !== undefined && turn.steps.includes(r.turn_id));
  // a call's session and turn are the log's: the rows its step wrote
  let sessionOf = new Map<string, string>();
  let turnOf = new Map<string, string>();
  if (c.args.by === "session" || c.args.by === "turn" || c.args.session !== undefined) {
    const read = await c.log.read(window.after ? { after: beforeTs(window.after) } : {});
    const inWindow = window.before ? read.filter((e) => e.ts < window.before!) : read;
    sessionOf = sessionsOfSteps(inWindow);
    if (c.args.by === "turn") {
      turnOf = new Map();
      for (const room of new Set(sessionOf.values())) {
        const [session, agentId] = room.split("@");
        const roomRows = inWindow.filter((e) => e.envelope.conversation.address === room);
        for (const t of turnsOf(roomRows, { agentId, id: session })) {
          for (const s of t.steps) turnOf.set(s, t.id);
        }
      }
    }
    if (c.args.session !== undefined) {
      rows = rows.filter((r) =>
        r.turn_id && sessionOf.get(r.turn_id)?.split("@")[0] === c.args.session
      );
    }
  }
  const keyOf = (r: UsageRow): string => {
    switch (c.args.by) {
      case "day":
        return dayOf(r.created_at, c.zone);
      case "model":
        return r.model;
      case "agent":
        return r.agent_id ?? "-";
      case "session":
        return (r.turn_id && sessionOf.get(r.turn_id)) || "-";
      case "turn":
        return r.turn_id ? handle(turnOf.get(r.turn_id) ?? r.turn_id) : "-";
    }
  };
  const groups = spendGroups(rows, keyOf, c.catalog.system.prices)
    .filter((g) => matches(g.key, c.args.match));
  if (c.args.json) {
    for (const g of groups) c.say(JSON.stringify({ by: c.args.by, ...g }));
    return;
  }
  const width = Math.max(5, ...groups.map((g) => g.key.length));
  const line = (key: string, g: ReturnType<typeof totals>) =>
    `${key.padEnd(width)}  ${String(g.calls).padStart(6)}  ${count(g.input).padStart(7)}  ` +
    `${count(g.output).padStart(7)}  ${count(g.cache_read).padStart(7)}  ${
      count(g.cache_write).padStart(7)
    }  ` +
    dollars(g.cost);
  c.say(
    `${c.args.by.padEnd(width)}  ${"calls".padStart(6)}  ${"in".padStart(7)}  ${
      "out".padStart(7)
    }  ` +
      `${"c.read".padStart(7)}  ${"c.write".padStart(7)}  cost`,
  );
  for (const g of groups) c.say(line(g.key, g));
  if (groups.length > 1) {
    c.say(line(
      "total",
      totals(rows.filter((r) => matches(keyOf(r), c.args.match)), c.catalog.system.prices),
    ));
  }
}

const RUN: Record<string, (c: Ctx) => Promise<void>> = {
  turns: turnsView,
  export: exportView,
  errors: errorsView,
  "tool-calls": toolCallsView,
  requests: requestsView,
  spend: spendView,
};

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    const [view, ...rest] = org.args;
    if (view === undefined || view === "--help" || view === "-h" || view === "help") {
      console.log(USAGE);
      return;
    }
    const spec = VIEWS[view];
    if (!spec) throw new Error(`no view "${view}"\n${USAGE}`);
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(spec.usage);
      return;
    }
    if (view === "tail") return await runTail(rest, org.dir);
    const root = findRoot(org);
    const catalog = await readConfig(root);
    const zone = catalog.organization.timezone;
    const args = parseLogArgs(view, rest, zone);
    const roster = Object.keys(catalog.agents);
    if (args.agent !== undefined && !roster.includes(args.agent)) {
      throw new Error(`no agent "${args.agent}" in ${root}/config.jsonc`);
    }
    const log = await (await openStore(root)).log();
    try {
      await RUN[view]({
        log,
        catalog,
        zone,
        agents: args.agent !== undefined ? [args.agent] : roster,
        args,
        say: (line) => console.log(line),
      });
    } finally {
      await log.close();
    }
  });
}
