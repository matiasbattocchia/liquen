/**
 * describe.ts — one tool call, one line, for humans (DESIGN §9).
 *
 * A tool call is shown in four places — the approval card, the anchor's pending list, the
 * harness's report of a deferred outcome, and the mirror's `[agent tool]` line — and until
 * now each of them wrote its own version (a JSON slice here, a hand-rolled `→ to` there).
 * So the rendering belongs to the TOOL, not to the consumer: `describeCall` is the one
 * function, and a tool that wants better than the default supplies its own `describe`
 * (`ExecTool.describe`, §9) instead of a consumer learning its name.
 *
 * The default is `name(k: v, …)`, with one refinement that removes most of the need for an
 * override: a call with a SINGLE string argument prints it bare — `bash(git status)`,
 * `aread(/etc/hosts)` — because for those tools the argument IS the call. No tool name
 * appears in this file's logic; `send` is the one built-in with a rendering of its own,
 * and what it adds is a NAME where the wire has an address.
 *
 * Two verbosities, because the consumers genuinely differ: the LINE form (truncated — a
 * pending entry, a tool trace) and the FULL form (the card: approving is judging exactly
 * what will be said, and a 200-character JSON slice is the wrong thing to judge).
 */

import type { Json, ToolCall } from "./types.ts";
import type { Reader } from "./store/log.ts";

/** A wire address → the name a human knows it by. Resolution needs a directory (the log,
 *  the window), so it is supplied by the caller; unresolved ⇒ the address stands. */
export type Resolve = (address: string) => string | undefined;

/** The arguments that carry a wire address, and so are offered to `resolve`: `send(to:)` —
 *  the one a human weighs before approving — and `search(in:/from:)`, which name the
 *  conversation searched and the voice searched for. An argument under any other key is
 *  prose and prints as written. */
const ADDRESSED = new Set(["to", "in", "from"]);

export interface DescribeOpts {
  resolve?: Resolve;
  /** Judgment form: no truncation, no elision — the card's. Default: one line. */
  full?: boolean;
  /** Renderings the tools themselves supplied (`ExecTool.describe`), by tool name. */
  tools?: Record<string, Describe>;
}

/** A tool's own rendering of its arguments — the inside of the parentheses. */
export type Describe = (input: Json, opts: DescribeOpts) => string;

const LINE = 120; // one rendered call
const VALUE = 60; // one argument inside it

/** `send(to: Vivian, text: hola)` — the tool's own rendering when it has one, else the
 *  default. The name and parentheses are this function's; everything inside is the tool's. */
export function describeCall(call: ToolCall, opts: DescribeOpts = {}): string {
  const own = opts.tools?.[call.name] ?? BUILTIN[call.name];
  const line = `${call.name}(${(own ?? generic)(call.input, opts)})`;
  return opts.full || line.length <= LINE ? line : `${line.slice(0, LINE - 1)}…`;
}

/** The harness's own tools. `search`, like most, is served by the default. */
const BUILTIN: Record<string, Describe> = {
  send: (input, opts) => {
    const a = argsOf(input);
    const to = a.to === undefined ? "" : String(a.to);
    const bits = [`to: ${opts.resolve?.(to) ?? to}`];
    // what the send DOES, when it is not a plain create (§3) — the part a human weighs
    if (a.action !== undefined) bits.push(`action: ${a.action}`);
    if (a.react !== undefined) bits.push(`react: ${a.react}`);
    if (a.re !== undefined) bits.push(`re: ${a.re}`);
    if (typeof a.text === "string" && a.text !== "") bits.push(`text: ${value(a.text, opts)}`);
    const files = Array.isArray(a.files) ? a.files.length : 0;
    if (files > 0) bits.push(`files: ${files}`);
    return bits.join(", ");
  },
};

/** `k: v, k: v` over the arguments that carry something — except when there is exactly one
 *  string argument, which prints bare: for a one-argument tool the value IS the call, and
 *  `bash(git status)` reads the way a person would say it. */
function generic(input: Json, opts: DescribeOpts): string {
  const args = Object.entries(argsOf(input)).filter(([, v]) => carries(v));
  if (args.length === 1 && typeof args[0][1] === "string") {
    return value(named(args[0][0], args[0][1], opts), opts);
  }
  return args.map(([k, v]) => `${k}: ${value(named(k, v, opts), opts)}`).join(", ");
}

/** An addressed argument prints as the name a human knows it by — `in: Sprinters Friends`,
 *  not `in: 1203…@g.us`. Anything unresolved (or unaddressed) stands as written: these keys
 *  take a name as readily as an address, and a name needs no resolving. */
function named(key: string, v: Json, opts: DescribeOpts): Json {
  return typeof v === "string" && ADDRESSED.has(key) ? opts.resolve?.(v) ?? v : v;
}

/** How far back a name is looked for — a conversation names itself within a page or two. */
const NAME_REACH = 200;

/** The directory `resolve` needs, built from the log: every addressed argument in `calls`
 *  looked up once. A conversation's own name wins (a group's title); a direct chat carries
 *  none, so the other side's sender name is the name it goes by. An address nothing is
 *  known about is simply absent — the address then stands, which is what it is for. */
export async function nameResolver(read: Reader["read"], calls: ToolCall[]): Promise<Resolve> {
  const names = new Map<string, string>();
  for (const { input } of calls) {
    for (const [k, v] of Object.entries(argsOf(input))) {
      if (!ADDRESSED.has(k) || typeof v !== "string" || v === "" || names.has(v)) continue;
      const rows = await read({ conversation: v, limit: NAME_REACH });
      const named = rows.find((r) => r.envelope.conversation.name)?.envelope.conversation.name ??
        (rows.some((r) => r.envelope.conversation.kind === "direct")
          ? rows.find((r) => r.envelope.sender?.name)?.envelope.sender?.name
          : undefined);
      if (named) names.set(v, named);
    }
  }
  return (address) => names.get(address);
}

function argsOf(input: Json): Record<string, Json> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, Json>
    : {};
}

function carries(v: Json): boolean {
  return v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
}

/** One argument, flattened to a line and (unless this is the card) bounded. */
function value(v: Json, opts: DescribeOpts): string {
  const raw = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return opts.full || flat.length <= VALUE ? flat : `${flat.slice(0, VALUE - 1)}…`;
}
