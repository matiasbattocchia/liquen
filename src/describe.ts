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

/** A wire address → the name a human knows it by. Resolution needs a directory (the log,
 *  the window), so it is supplied by the caller; unresolved ⇒ the address stands. */
export type Resolve = (address: string) => string | undefined;

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
  if (args.length === 1 && typeof args[0][1] === "string") return value(args[0][1], opts);
  return args.map(([k, v]) => `${k}: ${value(v, opts)}`).join(", ");
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
