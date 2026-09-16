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

import type { Event, Json, ToolCall } from "./types.ts";
import type { Reader } from "./store/log.ts";
import { clipEnd } from "./exec/truncate.ts";

/** An addressed argument → who it reaches: the name a human knows them by and the address
 *  the call will actually land on. Resolution needs a directory (the log, the window), so it
 *  is supplied by the caller; unresolved ⇒ the argument stands as written. */
export type Resolve = (addressed: string) => { name: string; address: string } | undefined;

/** The arguments that carry a wire address, and so are offered to `resolve`: `send(to:)` —
 *  the one a human weighs before approving — `search(in:/from:)`, which name the
 *  conversation searched and the voice searched for, and `contact(who:)`, the person an
 *  address book entry is written for. An argument under any other key is prose and
 *  prints as written. */
const ADDRESSED = new Set(["to", "in", "from", "who"]);

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
  return opts.full || line.length <= LINE ? line : `${clipEnd(line, LINE - 1)}…`;
}

/** The harness's own tools. `search`, like most, is served by the default. */
const BUILTIN: Record<string, Describe> = {
  send: (input, opts) => {
    const a = argsOf(input);
    const to = a.to === undefined ? "" : String(a.to);
    const bits = [`to: ${named("to", to, opts)}`];
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
 *  not `in: 1203…@g.us`. The CARD adds the address, because approving is choosing a person
 *  and two Verónicas read alike until the number is there; a glance (the tool trace, the
 *  pending line) is not deciding anything and keeps the name alone. Anything unresolved or
 *  unaddressed stands as written: a name nothing answers to is still what the model asked
 *  for. */
function named(key: string, v: Json, opts: DescribeOpts): Json {
  if (typeof v !== "string" || !ADDRESSED.has(key)) return v;
  const who = opts.resolve?.(v);
  if (who === undefined) return v;
  return opts.full ? `${who.name} (${who.address})` : who.name;
}

/** How far back a name is looked for — a conversation names itself within a page or two. */
const NAME_REACH = 200;

/** The directory `resolve` needs, built from the log: every addressed argument in `calls`
 *  looked up once, and answered with BOTH halves — the name to know them by, the address
 *  the call lands on — so the consumer decides which its reader needs. An argument nothing
 *  is known about is simply absent; it then stands as written, which is what it is for.
 *
 *  `to` takes a name as readily as an address (§5), so a name is looked up as one too and
 *  answers with the address it resolves to: the card then says where the call will LAND
 *  rather than what was typed, and two calls that behave the same can no longer read
 *  differently — nor two that differ read the same, which is how a name that reached
 *  nobody once passed for an address that reached someone (live, 2026-09-15). A name
 *  several conversations answer to resolves to none of them: the send refuses it with the
 *  list, and the card has nothing to promise. */
export async function nameResolver(read: Reader["read"], calls: ToolCall[]): Promise<Resolve> {
  const shown = new Map<string, { name: string; address: string }>();
  for (const { input } of calls) {
    for (const [k, v] of Object.entries(argsOf(input))) {
      if (!ADDRESSED.has(k) || typeof v !== "string" || v === "" || shown.has(v)) continue;
      const rows = await read({ conversation: v, limit: NAME_REACH });
      if (rows.length > 0) {
        const name = nameIn(rows);
        if (name) shown.set(v, { name, address: v });
        continue;
      }
      const named = await read({ conversationName: v, limit: NAME_REACH });
      const at = [...new Set(named.map((r) => r.envelope.conversation.address))];
      if (at.length === 1 && at[0] !== undefined) {
        shown.set(v, { name: nameIn(named) ?? v, address: at[0] });
      }
    }
  }
  return (value) => shown.get(value);
}

/** What a conversation goes by: its own name wins (a group's title); a direct chat carries
 *  none, so the other side's sender name is the name it is known by. */
function nameIn(rows: Event[]): string | undefined {
  return rows.find((r) => r.envelope.conversation.name)?.envelope.conversation.name ??
    (rows.some((r) => r.envelope.conversation.kind === "direct")
      ? rows.find((r) => r.envelope.sender?.name)?.envelope.sender?.name
      : undefined);
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
  return opts.full || flat.length <= VALUE ? flat : `${clipEnd(flat, VALUE - 1)}…`;
}
