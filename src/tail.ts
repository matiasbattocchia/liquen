/**
 * tail.ts — `liquen log tail`: watch an agent work, saying nothing.
 *
 *   liquen log tail [--dir <org>] [--agent <name>] [--session <name>] [--recall <n>]
 *                   [--follow] [--json]
 *
 * An ATTACH client like the REPL and the CLI (§9), and the door's plainest one: it opens
 * the session's tail as an observer and publishes nothing — no line, no verdict, no cut,
 * no place to stand, no model to think with — so it is no principal, and nothing it does
 * reaches the agent. What it shows is what the door discloses: the room's recent history
 * first, the calls with their outcomes and the run's facts, the thinking, each model
 * call's spend under the step it paid for, the checkpoints, the errors; then, with
 * `--follow`, the same as it happens. Without `--follow` it prints the history and exits.
 *
 * It never raises a daemon: a daemon's boot answers whatever the log owes, and watching
 * must not be what set the agent working. With nothing running there is nothing to watch,
 * and it says so — `liquen log turns` and `liquen log export` read the history off the store.
 *
 * The human view is the painter's (`paint.ts`, `watch`), the transcript every attach
 * client prints. `--json` is one object per line, written as it arrives: every row has
 * `id`, `turn_id`, `type` and `ts` (null where the row has none) beside its decoded
 * content; spend is `type: "usage"`, a turn edge `type: "status"`.
 */

import { attach, resolveAgent, wire } from "./attach.ts";
import { DIM, painter, RED, RESET, spendAfter } from "./paint.ts";
import { tailOf } from "./line.ts";
import { describeCall, lineOf } from "./describe.ts";
import { textOf } from "./render.ts";
import { findRoot, readConfig } from "./config.ts";
import { MIND, sessionAddress } from "./session.ts";
import { defaultAgent } from "./turns.ts";
import type { Status } from "./door.ts";
import type { UsageRow } from "./store/log.ts";
import type { Event, Json } from "./types.ts";

export const USAGE =
  `usage: liquen log tail [--dir <org>] [--agent <name>] [--session <name>] [--recall <n>]
                       [--follow] [--json]

  Watch an agent's session through its door without speaking: the recent history — its
  messages, every call with its outcome, the thinking, each model call's tokens, the
  checkpoints and errors — then, with --follow, the same as it happens. Nothing is
  published: no message, no verdict, no cancel. Needs the org running; it never starts it.

  --agent <name>    whose session (a roster name); default: the only agent, or your username
  --session <name>  the session; default: the mind
  --recall <n>      how many recent rows of the room to print first; default: ${50}
  --follow, -f      keep watching until interrupted
  --json            one JSON object per line: id, turn_id, type, ts and the decoded content`;

const RECALL = 50;

/** A row as one JSON object: the stable four, where it was, and what it says, decoded. */
export function jsonOf(e: Event): Record<string, Json> {
  const turn = e.payload?.turn_id;
  const base: Record<string, Json> = {
    id: e.id,
    turn_id: typeof turn === "string" ? turn : null,
    type: e.type,
    ts: e.ts,
    session: e.agent?.session_id ?? null,
    conversation: e.envelope.conversation.address,
  };
  const data = (e.parts?.[0] as { data?: Record<string, Json> } | undefined)?.data ?? {};
  switch (e.type) {
    case "message":
      return {
        ...base,
        from: typeof turn === "string" && e.agent
          ? e.agent.id
          : e.envelope.sender?.name ?? e.envelope.sender?.address ?? null,
        text: lineOf(e),
        ...(typeof e.payload?.stop_reason === "string"
          ? { stop_reason: e.payload.stop_reason }
          : {}),
      };
    case "thinking":
      return { ...base, text: typeof data.thinking === "string" ? data.thinking : "" };
    case "tool_use": {
      const call = e.parts[0].data;
      return {
        ...base,
        name: call.name,
        input: call.input,
        call: describeCall(call, { full: true }),
      };
    }
    case "tool_result":
      return {
        ...base,
        ref_id: e.payload.ref_id,
        ...data,
        ...(e.extra?.exec !== undefined ? { exec: e.extra.exec as Json } : {}),
        ...(e.payload.gated ? { gated: true } : {}),
        ...(e.payload.async ? { async: true } : {}),
        ...(e.payload.update ? { update: true } : {}),
        ...(e.payload.final ? { final: true } : {}),
      };
    case "permission_request":
      return {
        ...base,
        ref_id: e.payload.ref_id,
        tool: data.tool ?? null,
        call: data.call ?? null,
      };
    case "permission_response":
      return { ...base, ref_id: e.payload.ref_id, ...data };
    case "summary":
      return { ...base, covers: e.payload.covers, text: textOf(e) };
    case "alarm": {
      const timer = (e.extra?.timer ?? {}) as { name?: string };
      return { ...base, text: textOf(e), ...(timer.name ? { wake: timer.name } : {}) };
    }
    case "control":
      return { ...base, control: e.payload.control };
    case "error":
      return { ...base, error: typeof data.error === "string" ? data.error : "" };
    default:
      return base;
  }
}

/** A usage row as one JSON object, in the same four-field frame. */
export function jsonOfUsage(r: UsageRow): Record<string, Json> {
  return {
    id: null,
    turn_id: r.turn_id ?? null,
    type: "usage",
    ts: r.created_at,
    kind: r.kind ?? null,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    cache_write_tokens: r.cache_write_tokens ?? 0,
  };
}

/** A turn edge as one JSON object: the time is the moment it crossed. */
export function jsonOfStatus(s: Status, now: Date = new Date()): Record<string, Json> {
  return {
    id: null,
    turn_id: null,
    type: "status",
    ts: now.toISOString(),
    status: s.status,
    ...(s.after !== undefined ? { after: s.after } : {}),
  };
}

/** The recall, as the JSON stream prints it: each row, and a step's spend after its last. */
export function jsonRecap(events: Event[], spend: UsageRow[]): Record<string, Json>[] {
  const paid = spendAfter(events, spend);
  return events.flatMap((e) => [jsonOf(e), ...(paid.get(e.id) ?? []).map(jsonOfUsage)]);
}

/** The flags `tail` takes. */
export function parseTailArgs(args: string[]): {
  agent?: string;
  session: string;
  recall: number;
  follow: boolean;
  json: boolean;
} {
  const out = { session: MIND, recall: RECALL, follow: false, json: false } as {
    agent?: string;
    session: string;
    recall: number;
    follow: boolean;
    json: boolean;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--agent") out.agent = value();
    else if (a === "--session") out.session = value();
    else if (a === "--recall") {
      out.recall = Number(value());
      if (!Number.isInteger(out.recall) || out.recall < 1) {
        throw new Error(`--recall is a positive whole number\n${USAGE}`);
      }
    } else if (a === "--follow" || a === "-f") out.follow = true;
    else if (a === "--json") out.json = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

/** Watch a session through its door, as `args` say (`parseTailArgs`); `dir` is the org's
 *  `--dir`. It exits the process: on hangup, at the recap's end without `--follow`. */
export async function runTail(args: string[], dir?: string): Promise<void> {
  {
    const org = { dir, args };
    const flags = parseTailArgs(org.args);
    const root = findRoot(org);
    const roster = Object.keys((await readConfig(root)).agents);
    const a = await resolveAgent(flags.agent ?? defaultAgent(roster), org.dir);
    const home = sessionAddress(a.target, flags.session); // refuses a malformed name
    let conn: Deno.UnixConn;
    try {
      conn = await attach(a, { raise: false });
    } catch (err) {
      console.error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          "`liquen log turns` and `liquen log export --turn last` read what it did",
      );
      Deno.exit(1);
    }
    let leaving = false;
    const encoder = new TextEncoder();
    const line = (o: Record<string, Json>) =>
      Deno.stdout.writeSync(encoder.encode(JSON.stringify(o) + "\n"));

    // the screen is stdout's tail, as the CLI keeps one: the painter asks for shapes
    const tail = tailOf();
    const say = (s: string) => {
      tail.note(s);
      Deno.stdout.writeSync(encoder.encode(s));
    };
    const p = painter({
      session: { agentId: a.target, id: flags.session },
      home,
      zone: a.timezone,
      write: say,
      error: (t) => say(`${tail.owed(1)}${RED}! ${t}${RESET}\n`),
      prompt: () => say(tail.owed(1)),
      gap: () => say(tail.owed(2)),
      thinking: true,
      watch: true,
      typed: () => false, // a watcher typed nothing: every principal line is news to it
    });

    const w = wire(
      conn,
      flags.json
        ? {
          event: (e) => line(jsonOf(e)),
          delta: () => {}, // the in-progress: the rows it becomes are what a JSON reader takes
          status: (s) => line(jsonOfStatus(s)),
          usage: (r) => line(jsonOfUsage(r)),
        }
        : {
          event: p.event,
          delta: p.delta,
          usage: p.usage,
        },
    );
    void w.hangup.then(() => {
      if (leaving) return;
      console.error("the daemon hung up");
      Deno.exit(1);
    });
    const t = await w.request({
      op: "tail",
      session: flags.session,
      recall: flags.recall,
      observe: true,
    });
    if (!t.ok) {
      console.error(String(t.error));
      leaving = true;
      conn.close();
      Deno.exit(1);
    }
    if (flags.json) { for (const o of jsonRecap(t.recalled ?? [], t.spend ?? [])) line(o); }
    else {
      say(`${DIM}watching ${home} — nothing typed here reaches it${RESET}\n`);
      p.recap(t.recalled ?? [], t.spend ?? []);
    }
    if (!flags.follow) {
      leaving = true;
      conn.close();
      Deno.exit(0);
    }
    Deno.addSignalListener("SIGINT", () => {
      leaving = true;
      try {
        conn.close();
      } catch { /* already closed */ }
      Deno.exit(0);
    });
    await w.hangup;
  }
}
