/**
 * render.ts — the pure transform: a log window → the Anthropic request `mu` sees (DESIGN §5).
 *
 * No I/O. nu resolves the inputs (log window, docs, tools) and feeds them; render just shapes
 * them into `{ system, messages }` using `@anthropic-ai/sdk` types, so `mu` passes them to the
 * Messages API untranslated.
 *
 * Two halves:
 *   (a) `renderSystem`   — the cacheable prefix: always-doc bodies inlined + a pull-index
 *       of the lazy ones.
 *   (b) `renderMessages` — the conversation: the session's own room bare, the world
 *       grouped, every step welded API-faithfully as its request held it, so each request
 *       is the one before plus new rows. Turns and the weld are DERIVED from the window's
 *       shape (§5), never tracked by nu.
 */

import { SENDER_EMAIL, senderEmail, senderSaved } from "./sender.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { INLINE_CAP, inlineable, isExternal, type MediaBlock, pathOf } from "./store/media.ts"; // pure helpers — no I/O
import { MIND, routedSession } from "./session.ts";
import { clipEnd } from "./exec/truncate.ts";
import { describeCall } from "./describe.ts";
import type { DocEntry, DocKind, DocScope, Where } from "./store/docs.ts";
import { MONTHS } from "./moment.ts";
import { DEFAULT_COMPACT_AT } from "./config.ts";
import type {
  AlarmEvent,
  BinDir,
  Conversation,
  DataPart,
  ErrorEvent as HarnessErrorEvent, // aliased: `ErrorEvent` is a DOM global in Deno's lib
  Event,
  EventId,
  FilePart,
  Json,
  MessageEvent,
  PermissionResponseEvent,
  PrefixEvent,
  PrefixSection,
  ReactionPart,
  Session,
  SessionRef,
  SummaryEvent,
  TextPart,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";

type TextBlockParam = Anthropic.TextBlockParam;
type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type Role = "user" | "assistant";

const KIND_ORDER: DocKind[] = ["instruction", "skill", "memory"];
const SCOPE_ORDER: DocScope[] = ["system", "shared", "agent"];

/**
 * Docs → the top-level `system` prefix (§5, §8).
 *
 * Three ruled sections: the bodies that were loaded (`load: always`) **inlined**, each under
 * its own `[handle]`; `# On-demand docs`, the index the agent pulls the rest from with
 * `aread`; and `# Environment`, the facts config owns — the agent, the roster, the surfaces,
 * the processors. Docs are ordered by kind, cascade
 * within kind (system → org → agent → conversation). One cache breakpoint at the end — the
 * whole prefix is one region, so the section order is reading order and nothing else.
 */
/** One member of the org as the environment names them: the id its `principal=`/`agent=`
 *  marks wear, and the handles the roster declares — a line from one of those addresses is
 *  that member speaking, which is what makes the handles worth stating. */
export interface Member {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
}

/** A surface the agent speaks through: the service, the account as it is SHOWN (its URL
 *  where the address is an opaque id), the name the service gives it, and whose voice it
 *  carries — the agent's own when it holds the grant, the org's when the org's credential
 *  is what opens it. */
export interface Surface {
  service: string;
  shown: string;
  name?: string;
  own: boolean;
}

/** The facts the harness owns about who and where the agent is (§5): its id — the roster
 *  entry, the unix user, the folder — the name it goes by and the handles its principal is
 *  known by, its home, the org's clock and locale (all from `config.jsonc`), the rest of
 *  the roster split by who steers it, and the surfaces it speaks through (from the
 *  connections map). Harness-authored — not a doc, so no edit can lose them. Every stamp
 *  the model sees is already on this clock; naming the zone is what lets it convert a
 *  contact's "5pm my time". */
export interface Env {
  self?: string;
  name?: string;
  email?: string;
  phone?: string;
  home?: string;
  timezone?: string;
  locale?: string;
  /** Who steers this agent — their word is an instruction, and their lines wear
   *  `principal`. */
  principals?: Member[];
  /** The rest of the roster, each listed once: a principal is not repeated here. */
  agents?: Member[];
  connections?: Surface[];
  /** The media kinds a processor makes readable (`audio`): the model is told the words
   *  follow on their own, so it waits for the `<transcript>` instead of opening the file. */
  processors?: string[];
  /** What a doc's handle opens with: `aread` from the shell on files, the `read` tool on
   *  the table (§9). Absent: files. */
  docs?: "filesystem" | "database";
  /** The programs the org's folder puts on PATH, by directory. */
  bins?: BinDir[];
}

/** What the programs listing says above the directories: they were put there for this
 *  org's work, so one that does the job is the tool for it. */
const BINS_NOTE = "These programs are on your PATH.";

/** A directory in an inlined doc's shape: its path in brackets, then one line per program,
 *  its usage where it ships one, else its name. */
const binLines = (b: BinDir): string =>
  [`[${b.dir}]`, ...b.programs.map((p) => `- ${p.usage ?? p.name}`)].join("\n");

/** What a configured processor means to the model, said once above the kinds. */
const PROCESSORS_NOTE = "Media of these kinds is made readable for you automatically, as a " +
  "<transcript> that follows the message; it can take a couple of minutes to arrive.";

const facts = (fields: (string | undefined | false)[]): string =>
  fields.filter((f): f is string => !!f).join(" · ");

/** A member's line: the id bare — the word its mark wears — then the declared handles.
 *  `self` and every member read the same way, so the section is one register. */
const memberLine = (m: Member): string =>
  facts([
    m.id,
    m.name && `name: ${m.name}`,
    m.email && `email: ${m.email}`,
    m.phone && `phone: ${m.phone}`,
  ]);

/** A surface's line: the service, what the account is called and shown as, and whose voice
 *  it is — stated on every line, because speaking as the org and speaking as oneself are
 *  different acts and neither is the quiet default. */
const surfaceLine = (c: Surface): string =>
  `${facts([c.service, c.name, c.shown])} (${c.own ? "yours" : "org"})`;

const listing = (title: string, lines: string[]): string =>
  `## ${title}\n\n${lines.map((l) => `- ${l}`).join("\n")}`;

/** The `# Environment` body: the agent's own two lines — who it is, where it stands — then
 *  a listing per company it keeps. A section with nothing in it is absent. */
function envBody(env: Env): string | undefined {
  const who = facts([
    env.self && `self: ${env.self}`,
    env.name && `name: ${env.name}`,
    env.email && `email: ${env.email}`,
    env.phone && `phone: ${env.phone}`,
  ]);
  const where = facts([
    env.home && `workspace: ${env.home}`,
    env.timezone && `timezone: ${env.timezone}`,
    env.locale && `locale: ${env.locale}`,
  ]);
  const sections = [
    [who, where].filter(Boolean).join("\n"),
    env.principals?.length && listing("Principals", env.principals.map(memberLine)),
    env.agents?.length && listing("Agents", env.agents.map(memberLine)),
    env.connections?.length && listing("Connections", env.connections.map(surfaceLine)),
    env.processors?.length &&
    `## Processors\n\n${PROCESSORS_NOTE}\n\n${env.processors.map((k) => `- ${k}`).join("\n")}`,
  ].filter((s): s is string => !!s);
  return sections.length ? sections.join("\n\n") : undefined;
}

/** The rule that opens every section after the first. The blank line above it is
 *  load-bearing: a `---` under a line of text is a setext heading, not a rule — and each
 *  section is its own block, so a section closes its text tight and the next one spaces
 *  itself. */
const RULE = "\n\n---\n\n";

export function renderSystem(docs: DocEntry[], env: Env = {}): TextBlockParam[] {
  return systemBlocks(systemSections(docs, env));
}

/** The prefix's sections in reading order: the always-docs' bodies, each under its handle,
 *  then the harness's own. What a `prefix` event holds, and what its notice compares. */
export function systemSections(docs: DocEntry[], env: Env = {}): PrefixSection[] {
  // a tool doc is the tool's words, which the request's `tools` carry (tooldoc.ts)
  const ordered = docs.filter((d) => d.header.kind !== "tool").sort(byCascade);
  const out: PrefixSection[] = ordered.filter((d) => d.body !== undefined)
    .map((d) => ({ key: d.header.handle, text: section(d), doc: true as const }));

  const pointers = ordered.filter((d) => d.body === undefined);
  if (pointers.length > 0) {
    out.push({
      key: "On-demand docs",
      text: `# On-demand docs\n\n${renderIndex(pointers, env.docs)}`,
    });
  }

  if (env.bins?.length) {
    out.push({
      key: "Programs",
      text: `# Programs\n\n${BINS_NOTE}\n\n${env.bins.map(binLines).join("\n\n")}`,
    });
  }

  // the facts close the prefix, under the words that spend them
  const body = envBody(env);
  if (body) out.push({ key: "Environment", text: `# Environment\n\n${body}` });
  return out;
}

/** The sections as the request's `system`: the docs' bodies one block, each harness
 *  section its own under a rule, one cache mark at the end. */
export function systemBlocks(sections: PrefixSection[]): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];
  const add = (text: string) =>
    blocks.push({ type: "text", text: (blocks.length ? RULE : "") + text.trimEnd() });

  const bodies = sections.filter((s) => s.doc);
  if (bodies.length > 0) add(bodies.map((s) => s.text).join("\n\n"));
  for (const s of sections.filter((s) => !s.doc)) add(s.text);

  const last = blocks.at(-1);
  // caches tools + the full system prefix. The hour TTL, not the default five minutes: docs
  // change when a human edits one, and an agent that wakes every twenty minutes was paying
  // to re-write this block each time (a 1h write is 2x input against 1.25x, and reads at
  // 0.1x cover it after the first hit).
  if (last) last.cache_control = { type: "ephemeral", ttl: "1h" };
  return blocks;
}

/** kind-major, then cascade scope, then name — the reading order for the model (§5, decision B). */
function byCascade(a: DocEntry, b: DocEntry): number {
  return KIND_ORDER.indexOf(a.header.kind) - KIND_ORDER.indexOf(b.header.kind) ||
    SCOPE_ORDER.indexOf(a.header.scope) - SCOPE_ORDER.indexOf(b.header.scope) ||
    (a.header.name < b.header.name ? -1 : a.header.name > b.header.name ? 1 : 0);
}

/** What a memory doc's body holds before it is due a merge or a prune, in characters. The
 *  figure informs the agent, and nothing enforces it. */
export const MEMORY_CHARS = 2_200;

/** How full a memory is, as its heading and its index line show it: ` 20% of 2,200 chars`.
 *  Empty for any other doc. */
function fill(h: DocEntry["header"]): string {
  if (h.chars === undefined) return "";
  return ` ${Math.round(h.chars / MEMORY_CHARS * 100)}% of ${
    MEMORY_CHARS.toLocaleString("en-US")
  } chars`;
}

/** An inlined always-doc: a provenance header, then its body. The handle is the header's
 *  own — the same string the index prints and the read takes; a memory's adds how full it
 *  is. */
function section(d: DocEntry): string {
  return `[${d.header.handle}]${fill(d.header)}\n${d.body ?? ""}`;
}

/** The pull-index: one pointer line per doc not inlined — its handle in the brackets an
 *  inlined doc wears, then how full a memory is, its description and its keywords, each
 *  when it has one. The opening line says what the handle opens with, which is the
 *  substrate's. */
function renderIndex(pointers: DocEntry[], on: Env["docs"] = "filesystem"): string {
  const lines = pointers.map((d) => {
    const { description, keywords } = d.header;
    const tail = [
      fill(d.header).trim(),
      description,
      keywords?.length && `keywords: ${keywords.join(", ")}`,
    ].filter(Boolean).join(" · ");
    return `- [${d.header.handle}]${tail ? ` ${tail}` : ""}`;
  });
  const opener = on === "database"
    ? "The handle is the doc's own; `read` one to read it:"
    : "The path is the doc's own; `aread` one to read it:";
  return `${opener}\n\n${lines.join("\n")}`;
}

/* ─────────────────────── (b) the messages tail (§5) ─────────────────────── */

/** Raw bytes of media a single request may inline (base64 ≈ ×4/3; the API caps requests
 *  well above this) — the newest-first budget in `renderMessages`. */
const MEDIA_BUDGET = 12 * 1024 * 1024;

/** A checkpoint's span as its request draws it: the events it covers, the last of them —
 *  the cut every think marked — and the instruction that closes the request. */
export interface Archive {
  covered: ReadonlySet<EventId>;
  cut: EventId;
  instruction: string;
}

export interface RenderInput {
  events: Event[]; // the log window — render derives its turns and steps itself
  docs: DocEntry[];
  session: Session; // whose output is whose, and which conversation is the session's own
  env?: Env; // the prefix's closing section — who the agent is, and the company it keeps
  now: string; // ISO — the `now:` anchor
  /** IANA timezone for every rendered stamp (`at=`, `now:`) — org config's `timezone`.
   *  Unset ⇒ the deployment's own zone. Stored `ts` is UTC either way (§3). */
  zone?: string;
  /** Volatile environment lines (cwd · git · background jobs) composed by xi from the exec
   *  plane — joined into the request's anchor (§5). Deployment-specific: empty on edge (no
   *  persistent exec env). */
  ambient?: string[];
  /** The checkpoint's request (§5): the window drawn through the span it covers, closing
   *  on its instruction, with no anchor. Absent ⇒ a think's. */
  archive?: Archive;
  /** The pinned cut (compact.ts `pinnedCut`): the event whose block every think marks, so
   *  the checkpoint's request finds its span in the cache. Absent ⇒ none pinned yet. */
  cut?: EventId;
  /** The bytes behind the attachments this render inlines, by uri — the blocks for the
   *  uris `wantedMedia` names, fetched by xi through the media port (§5). A picture stays
   *  inlined until the checkpoint, beside its kind marker (`<image/>`), whose path is the
   *  durable re-viewable handle. A uri the table lacks keeps its marker. Absent ⇒ markers
   *  only. */
  media?: ReadonlyMap<string, MediaBlock>;
  /** What xi read below the checkpoint's floor for `<before>` (§5). Absent ⇒ none. */
  before?: BeforePool;
  /** Who is one of us (§4, §5): the roster's word for each member, and who steers this
   *  session's agent. Absent ⇒ every member is named by their username and nobody is a
   *  principal but the agent itself. */
  roster?: Roster;
  /** The account behind each connection, by address: the name the service shows for it
   *  (`extra.name` on the connection row — an org account's pushname, a workspace's
   *  title). Rides `<conn name>`, so the string the wire stamps on the account's own lines
   *  reads as the account and never as a person in the room. Absent ⇒ the address alone. */
  connections?: Record<string, string>;
  /** The checkpoint budget (§5), and the cap on what one WUM of world lines may weigh.
   *  Absent ⇒ the catalog's. */
  compactAt?: number;
}

export interface Roster {
  /** agentId → `identity.name`, else the username: the string `<principal name>` and the
   *  `principal`/`agent` marks wear. */
  names: Record<string, string>;
  /** The usernames of everyone who steers this session's agent. */
  principals: string[];
}

/** The Anthropic request halves render produces — the seam between render and `mu`. */
export interface RenderedRequest {
  system: TextBlockParam[];
  messages: MessageParam[];
}

/** DESIGN §5: a log window → the request `mu` sees. Pure — nu resolves the inputs. */
export function render(input: RenderInput): RenderedRequest {
  return { system: systemOf(input), messages: renderMessages(input) };
}

/** The request's `system` (§5): the prefix the first `prefix` since the checkpoint holds,
 *  else the live one, which nu then writes. Every request until the next checkpoint reads
 *  the same bytes, so the cache and every replayed signature hold through a doc edit. */
export function systemOf(input: Pick<RenderInput, "events" | "docs" | "env">): TextBlockParam[] {
  const [frozen] = prefixesOf(input.events);
  return systemBlocks(frozen?.parts[0].data.sections ?? systemSections(input.docs, input.env));
}

/** The window's `prefix` events since the checkpoint: one written before it stands for a
 *  prefix the checkpoint already replaced. */
function prefixesOf(window: Event[]): PrefixEvent[] {
  const events = applySummary(window);
  const floor = events[0]?.type === "summary" ? events[0].id : "";
  return events.filter((e): e is PrefixEvent => e.type === "prefix" && e.id > floor);
}

/** Whether a step's request was made with a prefix of its own: none since the checkpoint,
 *  or the live sections differ from the last the window holds. nu writes one exactly when
 *  render reads it. */
export function prefixDue(window: Event[], live: PrefixSection[]): boolean {
  const last = prefixesOf(window).at(-1);
  return !last || !sameSections(last.parts[0].data.sections, live);
}

const sameSections = (a: PrefixSection[], b: PrefixSection[]) =>
  a.length === b.length && a.every((s, i) => s.key === b[i].key && s.text === b[i].text);

/** What a prefix says after the one before it: each section that changed as its key and
 *  the changed lines, each added one whole, each removed one by its key. A change whose
 *  every line the agent's own calls already wrote out (`said`) is named alone: the call
 *  above it is the change. */
export function prefixDelta(
  prev: PrefixSection[],
  next: PrefixSection[],
  said: ReadonlySet<string> = new Set(),
): string {
  const was = new Map(prev.map((s) => [s.key, s]));
  const is = new Set(next.map((s) => s.key));
  const told = (lines: string[]) => {
    const solid = lines.filter((l) => l.trim());
    return solid.length > 0 && solid.every((l) => said.has(l.trimEnd()));
  };
  return [
    ...next.flatMap((s) => {
      const now = framed(s);
      const old = was.get(s.key);
      if (old === undefined) {
        // a harness section's first line is its heading, which no call writes either
        const lines = now.body.split("\n").slice(s.doc ? 0 : 1);
        return [
          told(lines)
            ? `${s.key} — added by you${now.tag}`
            : `${s.key} — added${now.tag}\n${now.body}`,
        ];
      }
      if (old.text === s.text) return [];
      const ops = diffOps(framed(old).body, now.body);
      if (ops.every((o) => o.mark === " ")) return []; // the heading's figure alone
      return [
        told(ops.filter((o) => o.mark !== " ").map((o) => o.line))
          ? `${s.key} — edited by you${now.tag}`
          : `${s.key} — edited${now.tag}\n${lineDiff(ops)}`,
      ];
    }),
    ...prev.filter((s) => !is.has(s.key)).map((s) => `${s.key} — removed`),
  ].join("\n\n");
}

/** A section as a notice compares it. A doc's heading is set apart: no call writes it, and
 *  a memory's figure on it rides the notice's head (`· 97% of 2,200 chars`). A harness
 *  section is compared whole. */
function framed(s: PrefixSection): { tag: string; body: string } {
  if (!s.doc) return { tag: "", body: s.text };
  const nl = s.text.indexOf("\n");
  const head = nl === -1 ? s.text : s.text.slice(0, nl);
  const fig = head.slice(`[${s.key}]`.length).trim();
  return { tag: fig ? ` · ${fig}` : "", body: nl === -1 ? "" : s.text.slice(nl + 1) };
}

/** Every line a call's input holds, its strings split and right-trimmed: what the agent
 *  wrote out in it. */
function linesOf(input: Json, into: Set<string>): void {
  if (typeof input === "string") { for (const l of input.split("\n")) into.add(l.trimEnd()); }
  else if (Array.isArray(input)) { for (const v of input) linesOf(v, into); }
  else if (input && typeof input === "object") {
    for (const v of Object.values(input)) linesOf(v, into);
  }
}

/** Lines of context kept around each change. */
const DIFF_CONTEXT = 1;

type DiffOp = { mark: " " | "+" | "-"; line: string };

/** A line diff: `+ ` added, `- ` removed, two spaces for context, `…` between hunks. */
function lineDiff(ops: DiffOp[]): string {
  const near = ops.map((_, k) =>
    ops.slice(Math.max(0, k - DIFF_CONTEXT), k + DIFF_CONTEXT + 1).some((o) => o.mark !== " ")
  );
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (!near[k]) return;
    if (out.length > 0 && !near[k - 1]) out.push("…");
    out.push(`${o.mark} ${o.line}`);
  });
  return out.join("\n");
}

/** Each line of `a` and `b` kept, added or removed: the longest common subsequence. */
function diffOps(a: string, b: string): DiffOp[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // longest common subsequence, from the ends
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ mark: " ", line: x[i++] });
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push({ mark: "+", line: y[j++] });
    } else ops.push({ mark: "-", line: x[i++] });
  }
  return ops;
}

/** The last closing assistant message in the session's own conversation — a step that
 *  emitted no tool_use (§5). Shared with compaction: only events at or before this index
 *  may ever be summarized away. */
export function closingBoundary(events: Event[], session: Session): number {
  const toolTurnIds = new Set(
    events.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => u.payload.turn_id),
  );
  return findLastIndex(
    events,
    (e) =>
      e.type === "message" && isSelf(e, session) &&
      e.envelope.conversation.address === session.conversation &&
      !(typeof e.payload?.turn_id === "string" && toolTurnIds.has(e.payload.turn_id)),
  );
}

/** Non-self messages positioned at or before `boundary` that the boundary step never
 *  CONSUMED (per its `extra.consumed` horizon) — the race window: a message landing between
 *  the window-read and the closing's publish sits before the closing in the log yet is
 *  unprocessed INPUT, not history. Compaction reads it: never checkpoint these away. */
export function deferredInput(
  events: Event[],
  session: SessionRef,
  boundary: number,
): Set<Event> {
  const out = new Set<Event>();
  if (boundary < 0) return out;
  const horizon = events[boundary].extra?.consumed;
  const h = typeof horizon === "string" ? events.findIndex((e) => e.id === horizon) : boundary;
  const from = h === -1 ? boundary : h;
  for (let i = from + 1; i < boundary; i++) {
    const e = events[i];
    if (e.type === "message" && !isSelf(e, session)) out.add(e);
  }
  return out;
}

/** Apply the latest `summary`: drop everything it covers (id ≤ covers[1]) and every earlier
 *  summary (each one is folded into the next, so only the latest stands), and MOVE the
 *  summary to the front — it stands for the oldest content; its log position is merely its
 *  publication time (§5). Exported for compaction: the weight that decides "checkpoint
 *  now?" must be the VISIBLE window's, or a raw window that stays heavy after a checkpoint
 *  would re-compact forever. */
export function applySummary(events: Event[]): Event[] {
  const latest = [...events].reverse().find((e) => e.type === "summary");
  if (!latest || latest.type !== "summary") return events;
  const toId = latest.payload.covers[1];
  return [latest, ...events.filter((e) => e.type !== "summary" && e.id > toId)];
}

/** Re-sort inbound messages by `ts` — REAL-WORLD event time, which is what a conversation
 *  means; `id` is only the store's append order (§3), and a lagged webhook or a backfill
 *  appends 14:02 after 14:05. Then partition the run per CONVERSATION: a room's messages
 *  render adjacent — one element below — because cross-conversation interleaving is arrival
 *  noise, not meaning; within a conversation, `ts` order stands. A run is WORLD CONTENT:
 *  every voice but the model's own, in every conversation but the session's — the
 *  principal's phone-sent lines are lines of their rooms, part of the run like any peer's,
 *  and so are the agent's own sends. The harness's narration between them — rulings on
 *  asks, late results — is TRANSPARENT: the run flows across it and it stands before the
 *  WUM, one per turn, explaining what the WUM then shows (`→ sent`, then the line as it went
 *  out). What ends a run is a rendered block of the machine's own chain — the agent's
 *  voice, a tool cycle, a turn boundary —
 *  so the order the API constrains and the weld depends on is never touched. Nor is
 *  history rewritten: a straggler that arrives after the agent already answered stays
 *  where it landed, because the answer breaks the run. */
function byEventTime(
  events: Event[],
  session: SessionRef,
  here: string,
  budget: number,
  below: Map<string, MessageEvent[]> = new Map(),
): { events: Event[]; elisions: Elisions } {
  const out = [...events];
  const elisions: Elisions = { earlier: new Map(), rest: new Map(), before: new Map() };
  // the rooms a run already drew: a room's `<before>` is its first drawn appearance's alone.
  // What the cap hid of a room no run drew yet is its past too, beside its rows below the
  // floor; a line hidden in the window counts as the room saw it when the room speaks again
  const seen = new Set<string>();
  const hidden = new Map<string, MessageEvent[]>();
  const pastFor = (k: string, moment: string) =>
    lastTurns(
      [...below.get(k) ?? [], ...(hidden.get(k) ?? []).filter((e) => sawAt(e, moment))],
      session,
    );
  // a world line is any message in a world room — the agent's own send rows too — and
  // the principal's in the session's: everything but the agent's own words there
  const member = (e: Event) =>
    e.type === "message" && !(ownVoice(e, session) && e.envelope.conversation.address === here);
  const transparent = (e: Event) =>
    e.type === "permission_request" || e.type === "permission_response" ||
    (e.type === "tool_result" && isLate(e));
  for (let i = 0; i < out.length; i++) {
    if (!member(out[i])) continue;
    let j = i;
    while (j + 1 < out.length && (member(out[j + 1]) || transparent(out[j + 1]))) j++;
    // narration after the run's last line stands before it too: an errand writes the send's
    // row, then its outcome, and the outcome explains the line
    const seg = out.slice(i, j + 1);
    const pass = seg.filter((e) => !member(e));
    // stable sort ⇒ same-`ts` messages keep append order
    // the run IS one WUM (§5): sorted, grouped, then CAPPED — the burst does not get to
    // decide the prompt's size, and what the cap leaves out is stated where it was cut.
    // The session's own room is exempt: the principal's line is the one input that must
    // never be redacted, whatever the world was doing around it.
    const run = capRun(byConversation(seg.filter(member).sort(byTs)), budget, here);
    for (const [e, n] of run.elisions.earlier) elisions.earlier.set(e, n);
    for (const [e, r] of run.elisions.rest) elisions.rest.set(e, r);
    const lines = seg.filter(member);
    for (const [e, past] of beforeOf(lines, run.kept, budget, here, pastFor, seen, hidden)) {
      elisions.before.set(e, past);
    }
    out.splice(i, seg.length, ...pass, ...run.kept);
    i = i + pass.length + run.kept.length - 1;
  }
  return { events: out, elisions };
}

/** The events with every world run in event time and capped to `compactAt`, as the window
 *  lays them out — for a reader that walks the rows itself (the checkpoint's transcript). */
export function worldCapped(events: Event[], session: Session, compactAt: number): Event[] {
  return byEventTime(events, session, session.conversation, compactAt).events;
}

/* ── WUM cap (§5) ───────────────────────────────────────────────────────────────────
 *
 * A run of world messages between two agent turns is ONE world-user-message, and its size
 * is decided by the world, not by us: a busy hour, a group that wakes up, a history import
 * mid-conversation. Unbounded, the burst decides the prompt — and a burst is exactly when
 * the agent can least afford to be reading a thousand lines to find the one that matters.
 *
 * So a WUM is CAPPED and, past the cap, REDACTED — never silently truncated. What is left
 * out is stated in place, with its count, because the log still holds it and `search`
 * reaches it: the prompt carries the news, the log stays the record.
 *
 * The cap is the checkpoint's own unit, `compactAt` est. tokens of world lines, and it is
 * EQUITABLE: past it every conversation in the run gets an equal share, and the share a
 * quiet room leaves unused goes to the louder ones — one loud room cannot crowd out the
 * other nine, and ten rooms cannot crowd out the turn. Each room keeps its MOST RECENT
 * lines, which is what a burst means: the tail is the state. The cap is a pure function of
 * the run, so a WUM the agent has already answered renders byte-identically forever — the
 * property the cached prefix is built on.
 */

/** chars/4 over the event as stored, minus the wire sidecar (`extra`, where a connector
 *  keeps the raw delivery, which never reaches the prompt) — crude but monotone: the unit
 *  of `compactAt`, `keepRecent` and the WUM cap alike, all order-of-magnitude knobs. A
 *  `prefix` weighs nothing: the system holds it, and the window only what changed. */
export const estTokens = (events: Event[]): number =>
  Math.ceil(
    JSON.stringify(
      events.filter((e) => e.type !== "prefix"),
      (k, v) => k === "extra" ? undefined : v,
    ).length / 4,
  );

/** What an inlined image weighs to the model at most, est. tokens: one per 28×28 patch,
 *  which the API caps at 4,784 on the high-resolution tier the current models read at
 *  (1,568 on the standard one), scaling a larger picture down to fit. */
export const IMAGE_TOKENS = 4784;
/** The side of a 28×28 patch, in pixels. */
const PATCH = 28;
/** A sticker's side, in pixels, when its part carries no size: WhatsApp's are 512×512. */
const STICKER_SIDE = 512;

/** One image's weight: its patches when the part knows its pixels, the cap when not. */
function imageTokens(p: FilePart): number {
  const side = p.kind === "sticker" ? STICKER_SIDE : undefined;
  const width = p.file.width ?? side;
  const height = p.file.height ?? side;
  if (width === undefined || height === undefined) return IMAGE_TOKENS;
  return Math.min(IMAGE_TOKENS, Math.ceil(width / PATCH) * Math.ceil(height / PATCH));
}
/** A PDF page reads as its text, 1,500 to 3,000 tokens, and as an image of the page… */
export const PDF_PAGE_TOKENS = 3000 + IMAGE_TOKENS;
/** …and the page count, which the part does not carry either, is guessed from its size. */
export const PDF_PAGE_BYTES = 100 * 1024;

/** What the attachments render inlines weigh, est. tokens (§5): they stay until the
 *  checkpoint like the rows, so the checkpoint counts them beside the rows, and a window
 *  heavy with pictures reaches `compactAt` sooner. The agent's own are never re-shown. */
export function mediaTokens(events: Event[], session: SessionRef): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "tool_result" && (e.type !== "message" || ownVoice(e, session))) continue;
    for (const p of filesOf(e)) {
      if (!inlineable(p.file.mime_type)) continue;
      n += p.file.mime_type === "application/pdf"
        ? Math.max(1, Math.ceil((p.file.size ?? 0) / PDF_PAGE_BYTES)) * PDF_PAGE_TOKENS
        : imageTokens(p);
    }
  }
  return n;
}

/** What a cap left out, addressed to the events that survived it. `earlier` hangs on the
 *  first kept message of a conversation ("what came before this one"); `rest` on the first
 *  kept message of the whole run ("conversations you are not seeing at all"). `before`
 *  hangs a room's last turns from below the floor on its first kept message, at its first
 *  appearance after the floor. */
export interface Elisions {
  earlier: Map<Event, number>;
  rest: Map<Event, { conversations: number; messages: number }>;
  before: Map<Event, MessageEvent[]>;
}

/** Bound one run to `budget` est. tokens of world lines. `run` arrives ts-sorted and
 *  conversation-partitioned, so a room's "most recent" is its tail. Under the budget it is
 *  the identity. Over it, the rooms are served lightest first, each to an equal share of
 *  what is left: a room that fits its share goes whole, and its unused share is split among
 *  the rooms after it; a room that does not keeps the newest lines its share buys, and one
 *  whose share buys not even its newest line is left out whole. `exempt` names one
 *  conversation the cap passes over and does not count — the session's own room, whose
 *  lines are the principal's and are never redacted. */
export function capRun(
  run: Event[],
  budget: number,
  exempt?: string,
): { kept: Event[]; elisions: Elisions } {
  const elisions: Elisions = { earlier: new Map(), rest: new Map(), before: new Map() };
  const rooms = new Map<string, { lines: Event[]; weights: number[]; from: number }>();
  for (const e of run) {
    const key = (e as MessageEvent).envelope.conversation.address;
    let room = rooms.get(key);
    if (!room) rooms.set(key, room = { lines: [], weights: [], from: 0 });
    room.lines.push(e);
    room.weights.push(estTokens([e]));
  }
  const sum = (ws: number[]) => ws.reduce((n, w) => n + w, 0);
  const world = [...rooms].filter(([key]) => key !== exempt).map(([, room]) => room);
  if (sum(world.flatMap((r) => r.weights)) <= budget) return { kept: run, elisions };

  // lightest first, ties in arrival order (a stable sort): what a light room leaves unused
  // is split among the heavier ones still to come — the choice is total and stable
  const order = [...world].sort((a, b) => sum(a.weights) - sum(b.weights));
  let left = budget;
  order.forEach((room, i) => {
    const share = left / (order.length - i);
    let used = 0;
    room.from = room.lines.length;
    while (room.from > 0 && used + room.weights[room.from - 1] <= share) {
      used += room.weights[--room.from];
    }
    left -= used;
  });
  // never render an EMPTY WUM: a budget too small for any room's newest line still lets the
  // newest room's newest line through — silence would read as "the world said nothing",
  // which is the one thing that is certainly false here
  if (world.every((r) => r.from === r.lines.length)) {
    const newest = world.reduce((a, b) => b.lines.at(-1)!.ts > a.lines.at(-1)!.ts ? b : a);
    newest.from = newest.lines.length - 1;
  }

  // re-emit in the run's own order, so the cap never reorders what survives it
  const kept = [...rooms.values()].flatMap((room) => {
    const lines = room.lines.slice(room.from);
    if (lines.length > 0 && room.from > 0) elisions.earlier.set(lines[0], room.from);
    return lines;
  });

  // the rest-marker anchors on the first surviving WORLD line — world() is what prints it,
  // and the exempt room's lines render outside any cluster
  const out = world.filter((r) => r.from === r.lines.length);
  const anchor = kept.find((e) => (e as MessageEvent).envelope.conversation.address !== exempt);
  if (out.length > 0 && anchor) {
    elisions.rest.set(anchor, {
      conversations: out.length,
      messages: out.reduce((n, r) => n + r.lines.length, 0),
    });
  }
  return { kept, elisions };
}

/* ── <before> (§5) ──────────────────────────────────────────────────────────────────
 *
 * A room's first drawn `<conv>` since the checkpoint opens on its last turns the model has
 * not seen drawn, word for word: what the reply is a reply to. They come from below the
 * floor (a checkpoint folded them into prose) and from what an earlier WUM's cap left out
 * whole. A room drawn in an earlier WUM has its past in view already. Rows are chosen by id
 * and filtered on write-once stamps against a fixed moment, so a room's `<before>` is a pure
 * function of the floor and the log, and renders the same bytes on every step.
 */

/** A room's `<before>`: its last turns, at most this many, whole… */
export const BEFORE_TURNS = 2;
/** …while they fit this many lines; a newest turn longer alone keeps its newest lines. */
export const BEFORE_LINES = 12;
/** The newest rows xi reads of each room below the floor: past `BEFORE_LINES`, so a turn
 *  that would fit is read whole, and the one before it shows where it starts. */
export const BEFORE_READ = 40;

/** What xi read beyond the window for `<before>` and `re` (§5). */
export interface BeforePool {
  /** Each room in view's newest rows below the checkpoint's floor; none before one. */
  rows: MessageEvent[];
  /** The rows a line points at that the window lacks, wherever the log holds them. */
  refs: MessageEvent[];
  /** The rows of the session's own room that a principal's line there acts on
   *  (`actedOn`) and the window lacks: a line, or a call with its answer. */
  home: Event[];
  /** For a referent older than every row of its room the window and `rows` hold: how many
   *  rows lie between them (`GAP_READ` at most). */
  between: Record<EventId, number>;
}

/** A room, as `<before>` keys it: service, account, address. */
export const roomKey = (e: Event): string =>
  `${e.envelope.service}\u0000${e.envelope.connection_address}\u0000${e.envelope.conversation.address}`;

/** A row the room saw, as of the floor's moment: one taken back or given up before it,
 *  and not delivered after all by then, reached nobody. Write-once stamps only, so the
 *  answer never moves. */
export function sawAt(e: Event, floor: string): boolean {
  const s = e.status ?? {};
  const by = (t?: string) => t !== undefined && t < floor;
  return !((by(s.withdrawn_at) || by(s.reported_at)) && !by(s.corrected_at));
}

/** The account's side of a room — this agent from any session, its principal, the account
 *  itself — against everyone else. */
function accountSide(e: MessageEvent, session: SessionRef): boolean {
  return e.agent === undefined ? ownSide(e) : e.agent.id === session.agentId;
}

/** A room's last turns, newest first, from its rows in log order: runs of one side, as the
 *  room saw them. At most `BEFORE_TURNS`, whole, while they fit `BEFORE_LINES`; a newest
 *  turn longer than that alone keeps its newest lines. */
function lastTurns(rows: MessageEvent[], session: SessionRef): MessageEvent[][] {
  if (rows.length === 0) return [];
  // one turn past the last kept, so the last kept is known whole
  const turns: MessageEvent[][] = [];
  for (let i = rows.length - 1; i >= 0 && turns.length <= BEFORE_TURNS; i--) {
    const t = turns.at(-1);
    if (t && accountSide(t[0], session) === accountSide(rows[i], session)) t.unshift(rows[i]);
    else turns.push([rows[i]]);
  }
  const [newest, ...older] = turns.slice(0, BEFORE_TURNS);
  if (newest.length > BEFORE_LINES) return [newest.slice(-BEFORE_LINES)];
  const kept = [newest];
  let n = newest.length;
  for (const t of older) {
    if (n + t.length > BEFORE_LINES) break;
    kept.push(t);
    n += t.length;
  }
  return kept;
}

/** Each room's newest rows below the floor, as of the floor's moment, in log order — the
 *  pool's, without the far referents it carries beside them. */
function belowByRoom(pool: BeforePool | undefined, floor: string): Map<string, MessageEvent[]> {
  const rooms = new Map<string, MessageEvent[]>();
  for (const e of [...pool?.rows ?? []].sort((a, b) => a.id < b.id ? -1 : 1)) {
    if (sawAt(e, floor)) rooms.set(roomKey(e), [...rooms.get(roomKey(e)) ?? [], e]);
  }
  return rooms;
}

/** Pass 2 of a WUM's budget (§5): what pass 1, the cap, left unused buys each room it did
 *  not cut its last turns — below the floor, or hidden by an earlier cap — at the room's
 *  first drawn appearance: lightest room first, whole turns, newest first, while they fit.
 *  In a flood the past gives way first, and the run's own lines render the bytes the cap
 *  alone would. A room the cap leaves out whole stays undrawn: its lines join what it hid. */
function beforeOf(
  run: Event[],
  kept: Event[],
  budget: number,
  exempt: string,
  pastFor: (room: string, moment: string) => MessageEvent[][],
  seen: Set<string>,
  hidden: Map<string, MessageEvent[]>,
): Map<Event, MessageEvent[]> {
  const shown = new Set(kept);
  const rooms = new Map<string, { first?: Event; lines: Event[]; weight: number; cut: boolean }>();
  let left = budget;
  for (const e of run) {
    if ((e as MessageEvent).envelope.conversation.address === exempt) continue;
    const k = roomKey(e);
    let room = rooms.get(k);
    if (!room) rooms.set(k, room = { lines: [], weight: 0, cut: false });
    const w = estTokens([e]);
    room.lines.push(e);
    room.weight += w;
    if (shown.has(e)) left -= w;
    else room.cut = true;
  }
  for (const e of kept) {
    const room = rooms.get(roomKey(e));
    if (room && !room.first) room.first = e;
  }
  const out = new Map<Event, MessageEvent[]>();
  const fresh = [...rooms].filter(([k, r]) => !seen.has(k) && !r.cut)
    .sort(([, a], [, b]) => a.weight - b.weight);
  for (const [k, room] of fresh) {
    const taken: MessageEvent[][] = [];
    for (const turn of pastFor(k, room.first!.ts)) {
      const w = estTokens(turn);
      if (w > left) break;
      taken.unshift(turn);
      left -= w;
    }
    if (taken.length > 0) out.set(room.first!, taken.flat());
  }
  for (const [k, room] of rooms) {
    if (room.first) seen.add(k);
    else if (!seen.has(k)) hidden.set(k, [...hidden.get(k) ?? [], ...room.lines as MessageEvent[]]);
  }
  return out;
}

/**
 * A SILENCED row: real history — readable, searchable, part of the log — that is not NEWS,
 * and so appears in no prompt: not as a wake (the gates in xi ask this too), and not in a
 * WUM. `search` is the door. Connectors stamp the marks service-neutrally, beside the
 * per-service sidecar, so one predicate serves every frontier:
 *
 * `backfill` — history a connector imported (WhatsApp's post-pairing sync), not something
 * that just happened. The deciding reason is determinism, not size: an import streams in
 * over minutes, and an OPEN WUM that carried it would be rewritten on every batch — its
 * elision count walking 4 → 812 → 8,512 — churning the prompt's tail exactly when there is
 * most of it.
 *
 * `muted` · `archived` — the chat's state ON ARRIVAL, as the platform synced it (the
 * phone's own mute/archive, whatsmeow app state). The principal silenced that conversation
 * and the agent honors it — a mention in a muted group stays silent (WhatsApp's own
 * semantics), and an unmute wakes only what arrives after it: the stamp is per message,
 * never retroactive, the same denormalization as names.
 */
export function silenced(event: Event): boolean {
  return event.extra?.backfill === true || event.extra?.muted === true ||
    event.extra?.archived === true;
}

/**
 * The one word the model can say to say NOTHING. A turn has to close with a message in the
 * session's own conversation —
 * that message is what ends the chain and carries the horizon (`extra.consumed`, §2) — so
 * until now the model had no way to look at the world and not speak: every idle digest
 * cost a "(nothing new)" paragraph, addressed to a principal who did not ask, and that
 * paragraph then sat in the window being re-read for days. Most of what an always-on agent
 * writes is that sentence.
 *
 * `SILENCE` is the answer that closes the turn without speaking. The event is logged
 * verbatim (the log stays honest about what the model said, and the horizon hangs off it
 * exactly as before), and nothing crosses: the mirror carries nothing to any surface. The
 * window draws it as it was said — a response like any other, which the next request
 * replays — so every turn ends on an assistant message.
 */
export const SILENCE = "<|SILENCE|>";

/** The model said nothing (`SILENCE`). NOT `silenced`: a silence note stays in the window
 *  READ — it is ours, it closes the turn, and the horizon is stamped on it. Its body crosses
 *  to no surface. */
export function silent(event: Event): boolean {
  return event.extra?.silence === true;
}

/** Partition a run by conversation id, groups ordered by their LAST message's `ts` — the
 *  room that spoke most recently renders last, adjacent to the point the model answers
 *  from. Ties keep first-arrival order (stable sort over insertion order). */
function byConversation(run: Event[]): Event[] {
  const groups = new Map<string, Event[]>();
  for (const e of run) {
    const key = (e as MessageEvent).envelope.conversation.address;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(e);
  }
  return [...groups.values()].sort((a, b) => byTs(a.at(-1)!, b.at(-1)!)).flat();
}

/** The glyph a reaction carries, on either wire shape (data: open-bsp · text: legacy). */
export function reactionOf(e: MessageEvent): string | undefined {
  const p = e.parts.find((p) => p.kind === "reaction");
  if (!p) return undefined;
  if (p.type === "data") {
    const d = p.data as { unicode?: string; name?: string } | null;
    return d?.unicode ?? d?.name ?? "";
  }
  return p.type === "text" ? p.text : "";
}
const byTs = (a: Event, b: Event) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;

/** The window laid out (§5): the visible rows, each world line where its turn reads it
 *  (`afterTurns`), then every run in event time and capped, with its elisions. */
function regions(window: Event[], session: Session, compactAt: number, pool?: BeforePool) {
  const here = session.conversation; // the session's own room — everything else is world
  const visible = applySummary(window.filter((e) => !silenced(e)));
  // a room's rows below the floor, as of the floor's moment: the checkpoint's own
  const floor = visible[0]?.type === "summary" ? visible[0].ts : "";
  const rows = afterTurns(visible, session);
  return {
    rows,
    ...byEventTime(rows, session, here, compactAt, belowByRoom(floor ? pool : undefined, floor)),
  };
}

/**
 * A turn reads the world once (§5): its opener holds what its first step read, and only
 * the principal steers it between steps. So a world line that lands while a turn is open —
 * past what its first step read, before the turn ends — renders after that end, in the next
 * turn's WUM, and nowhere while the turn is still open. A send's own row is a world line
 * like any other: written during its call, it waits; written by an errand between turns
 * (whose outcome is quiet, so it opens none), it opens the next turn's WUM. Decided on the
 * log's own order, so a line never moves once drawn.
 */
function afterTurns(events: Event[], session: Session): Event[] {
  const here = session.conversation;
  const steps = new Set<string>();
  const tools = new Set<string>();
  const horizon = new Map<string, string>(); // step → the last row its request read
  for (const e of events) {
    const step = stepOf(e, session);
    if (step === undefined) continue;
    steps.add(step);
    if (e.type === "tool_use") tools.add(step);
    const seen = e.extra?.consumed;
    if (typeof seen === "string" && !horizon.has(step)) horizon.set(step, seen);
  }
  // A turn ends at its closing, at the principal's cut, or at an error that is no
  // continuation (a cut at the output ceiling, the server's pacing, go on).
  const ends = (e: Event) =>
    (e.type === "message" && isSelf(e, session) && e.envelope.conversation.address === here &&
      !tools.has(e.payload!.turn_id as string)) ||
    e.type === "control" ||
    (e.type === "error" && !["max_tokens", "pause_turn"].includes(e.payload?.stop_reason ?? ""));
  const turns: { from: string; to?: Event }[] = [];
  let open: { from: string } | undefined;
  for (const e of events) {
    const step = stepOf(e, session);
    if (step !== undefined && !open) open = { from: horizon.get(step) ?? e.id };
    if (open && ends(e)) {
      turns.push({ ...open, to: e });
      open = undefined;
    }
  }
  if (open) turns.push(open);
  // the end each held row waits for (undefined: its turn is open — it renders nowhere yet)
  const held = new Map<Event, Event | undefined>();
  for (const e of events) {
    if (e.type !== "message" || e.envelope.conversation.address === here) continue;
    const turn = turns.find((t) => e.id > t.from && (!t.to || e.id < t.to.id));
    if (turn) held.set(e, turn.to);
  }
  if (held.size === 0) return events;
  const out: Event[] = [];
  for (const e of events) {
    if (!held.has(e)) out.push(e);
    for (const [line, end] of held) if (end === e) out.push(line);
  }
  return out;
}

/** The step a row of this session's own chain belongs to (`turnOf`), or undefined. A chain
 *  is written in the session's own room; a line of ours elsewhere is a world line. */
function stepOf(e: Event, session: Session): string | undefined {
  const step = turnOf(e);
  return step !== undefined && ownComplex(e, session) &&
      e.envelope.conversation.address === session.conversation
    ? step
    : undefined;
}

/** The window's media budget (§5): which attachments inline, NEWEST first — a burst of
 *  images can't stack base64 past the API's request cap; past it the oldest keep their
 *  markers (the path is re-viewable). An inlined picture stays until the checkpoint like
 *  the rest of the window; the one that falls back to its marker when the budget is spent
 *  is a rewrite, accepted as rare. Sized on the KNOWN raw size: no bytes are read here.
 *  Pure — what xi asks the media port for, and what `render` inlines from the table it
 *  gets back. `compactAt` is the WUM cap the render will apply: a line it caps out asks
 *  for nothing. */
export function wantedMedia(
  window: Event[],
  session: Session,
  compactAt = DEFAULT_COMPACT_AT,
): string[] {
  const wanted: string[] = [];
  let budget = MEDIA_BUDGET;
  for (const e of [...regions(window, session, compactAt).events].reverse()) {
    // world and own-room attachments, and tool-result attachments (the model asked to see those)
    if (e.type !== "message" && e.type !== "tool_result") continue;
    if (e.type === "message" && isSelf(e, session)) continue;
    for (const p of filesOf(e)) {
      // local bytes only — external links inline as url-source blocks, budget-free
      if (isExternal(p.file.uri) || p.file.size === undefined) continue;
      // what the loader would refuse spends nothing: an oversize file keeps its marker
      if (!inlineable(p.file.mime_type) || p.file.size > INLINE_CAP) continue;
      if (p.file.size > budget) continue;
      budget -= p.file.size;
      wanted.push(p.file.uri);
    }
  }
  return wanted;
}

/** The attachment bytes an event carries itself (§5): a tool_result pins each inlineable
 *  attachment's block under its uri in `extra.media` the moment it lands, because the
 *  path is the agent's workspace and moves on. Two results naming one path, before and
 *  after a rewrite, each keep the picture the model saw; the closing that makes them
 *  history sheds the bytes (`PublishOptions.shed`). Empty for everything else. */
export function pinnedMedia(e: Event): Record<string, MediaBlock> {
  const m = e.extra?.media;
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  const out: Record<string, MediaBlock> = {};
  for (const [uri, b] of Object.entries(m as Record<string, unknown>)) {
    if (
      b && typeof b === "object" && typeof (b as MediaBlock).media_type === "string" &&
      typeof (b as MediaBlock).data === "string"
    ) out[uri] = b as MediaBlock;
  }
  return out;
}

function renderMessages(
  {
    events: window,
    docs,
    env,
    session,
    now,
    zone,
    ambient,
    archive,
    cut: pinned,
    media,
    roster,
    connections,
    compactAt = DEFAULT_COMPACT_AT,
    before: pool,
  }: RenderInput,
): MessageParam[] {
  const me = session; // whose voice — the (agent, session) pair
  const who: Roster = roster ?? { names: {}, principals: [session.agentId] };
  const accounts = connections ?? {};
  const here = session.conversation; // the session's own room — everything else is world
  const { rows, events, elisions } = regions(window, session, compactAt, pool);
  // room names from the WHOLE window, silenced rows included — a name is a fact about the
  // room, and the row that carried it need not be one the model reads. A line wears the
  // name its room had at or before it, so a rename later never redraws it
  const names = roomNamesAt(window);
  const out: MessageParam[] = [];

  // ref resolution (§5): the WHOLE window, silenced rows included — a delete or a reply often
  // lands long after its referent, and the referent being history doesn't unsay it. Only
  // the RENDERED events wear an `id` though, so `re` can point at a line the model can
  // actually read; a resolvable-but-unrendered referent is a reference to elsewhere (`?`).
  // A referent the window has not drawn — one the cap hid, one below the floor, one
  // anywhere the log holds it — is pulled into the `<before>` of the room the referring
  // line stands in, once across the window: so `re` points at a line here, and `re="?"`
  // means only an event that cannot be found. A referent drawn already is pointed at.
  const byExternal = new Map<string, Event>();
  for (const e of [...pool?.rows ?? [], ...pool?.refs ?? [], ...window]) {
    if (e.envelope.external_id) byExternal.set(e.envelope.external_id, e);
  }
  const rendered = new Set(events.map((e) => e.id));
  // a world line its turn still holds (`afterTurns`) is drawn where it lands, not pulled
  const coming = new Set(rows.map((e) => e.id));
  const inWindow = new Set(window.map((e) => e.id));
  const pullable = (target: Event) =>
    target.type === "message" && !rendered.has(target.id) &&
    (coming.has(target.id) || !inWindow.has(target.id));
  const pulled = new Set([...elisions.before.values()].flat().map((e) => e.id));
  // `pull`: the referent is pulled when it is not drawn yet; a pulled line's own `re` pulls
  // nothing, one step is the reach
  const refOf = (e: Event, pull = true): Ref => {
    const id = e.payload?.ref_external_id;
    if (!id) return { attr: "" };
    const target = byExternal.get(id);
    const shown = target !== undefined &&
      (rendered.has(target.id) || pulled.has(target.id) || (pull && pullable(target)));
    return { attr: ` re="${shown ? shortId(target.id) : "?"}"`, target, shown };
  };
  const rank = ranksOf(pool, rows);
  const pastLine = (e: MessageEvent, pull: boolean): PastLine => ({
    line: msgLine(e, me, who, zone, { ref: refOf(e, pull), marks: false }),
    ...rank.get(e.id),
  });
  /** A run's `<before>`: the lines given, then what a line there or in the run points at
   *  that nothing drew yet. */
  const pullFor = (run: ConvRun, e: Event) => {
    const target = refOf(e).target;
    if (!target || !pullable(target) || pulled.has(target.id)) return;
    pulled.add(target.id);
    (run.past ??= []).push(pastLine(target as MessageEvent, false));
  };
  // the room's own references: a principal's line points by `ref_id`, at a row of the room.
  // The room's lines wear no ids, so a row the window holds is quoted (`on`); one it lacks
  // is drawn in a `<before>` ahead of the line, which points at it by `re`
  const byId = new Map(window.map((e) => [e.id, e]));
  const far = new Map((pool?.home ?? []).map((e) => [e.id, e]));
  const answers = new Map(
    (pool?.home ?? []).filter((e): e is ToolResultEvent => e.type === "tool_result")
      .map((r) => [r.payload.ref_id, r]),
  );
  const farLine = (e: Event) =>
    e.type === "tool_use"
      ? callLine(e, answers.get(e.id), zone, { clip: CALL_CLIP })
      : msgLine(e as MessageEvent, me, who, zone, { marks: false });
  const principalLine = (e: MessageEvent) => {
    const id = actedOn(e);
    const near = id ? byId.get(id) : undefined;
    if (near || !id) return principalEl(e, who, zone, near ? onAttr(near) : "");
    const target = far.get(id);
    if (!target) return principalEl(e, who, zone, "");
    return `${beforeEl([{ line: farLine(target) }])}\n${
      principalEl(e, who, zone, ` re="${shortId(target.id)}"`)
    }`;
  };
  let cur: { role: Role; content: ContentBlockParam[] } | null = null;

  // a message's inlineable attachments → real API blocks. Local bytes become base64
  // (budget-gated below); external links become url-source blocks — the API
  // fetches them itself, no broker download, no budget spent.
  const mediaBlocks = (e: Event): ContentBlockParam[] => {
    const blocks: ContentBlockParam[] = [];
    for (const p of filesOf(e)) {
      if (isExternal(p.file.uri) && inlineable(p.file.mime_type)) {
        blocks.push(
          p.file.mime_type === "application/pdf"
            ? { type: "document", source: { type: "url", url: p.file.uri } }
            : { type: "image", source: { type: "url", url: p.file.uri } },
        );
        continue;
      }
      if (!inlineBudget.has(p.file.uri)) continue;
      // the bytes pinned on the event first (a tool's attachment: what the model saw when
      // it asked, §5), the port's table for the rest (received media, content-named)
      const b = pinnedMedia(e)[p.file.uri] ?? media?.get(p.file.uri);
      if (!b) continue; // not inlineable / over the cap / gone — the marker stands alone
      blocks.push(
        b.media_type === "application/pdf"
          ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: b.data },
          }
          : {
            type: "image",
            source: {
              type: "base64",
              media_type: b.media_type as Anthropic.Base64ImageSource["media_type"],
              data: b.data,
            },
          },
      );
    }
    return blocks;
  };

  const flush = () => {
    if (cur) out.push({ role: cur.role, content: cur.content });
    cur = null;
  };
  const emit = (role: Role, ...blocks: ContentBlockParam[]) => {
    if (cur && cur.role !== role) flush();
    if (!cur) cur = { role, content: [] };
    // the API takes `mid_conv_system` only last in its message: a notice or an anchor that
    // more user content follows (its step drew nothing of its own, an error alone) reads
    // as text
    for (let i = cur.content.length - 1; i >= 0; i--) {
      const b = cur.content[i];
      if (b.type !== "mid_conv_system") break;
      cur.content[i] = { type: "text", text: b.content[0].text };
    }
    cur.content.push(...blocks);
  };

  // world cluster (§5): consecutive same-connection world messages render as ONE `<conn>`
  // element, each run of same-conversation lines inside it as one `<conv>`. Any other
  // emission closes the open element first — `place` is emit-with-that-guarantee, and
  // every non-world site uses it.
  let cluster: ConnectionCluster | null = null;
  const closeCluster = () => {
    if (!cluster) return;
    const el = connectionEl(cluster);
    cluster = null;
    emit("user", { type: "text", text: el });
  };
  const place = (role: Role, ...blocks: ContentBlockParam[]) => {
    closeCluster();
    emit(role, ...blocks);
  };
  /** The agent's own words, bare. A body that is only whitespace draws nothing: the API
   *  refuses an empty text block, and the message still closes what it closes. */
  const placeOwn = (body: string) => {
    if (body.trim().length > 0) place("assistant", { type: "text", text: body });
  };

  /** Set an hour's cache breakpoint on a block. It is metadata, not content: the cached
   *  prefix is the blocks themselves, so moving the mark forward never invalidates what it
   *  covered. */
  const mark = (b: ContentBlockParam | undefined) => {
    if (b) (b as { cache_control?: object }).cache_control = { type: "ephemeral", ttl: "1h" };
  };
  const world = (e: MessageEvent) => {
    // what the WUM caps left out, said where it was cut — the count is the useful part:
    // it tells the agent whether `search` is worth a call before it answers
    const rest = elisions.rest.get(e);
    if (rest) {
      place("user", {
        type: "text",
        text: `— ${rest.messages} more message${rest.messages === 1 ? "" : "s"} in ` +
          `${rest.conversations} other conversation${rest.conversations === 1 ? "" : "s"} ` +
          `not shown — search to read them —`,
      });
    }
    const connection = e.envelope.connection_address;
    if (cluster && (cluster.service !== e.envelope.service || cluster.address !== connection)) {
      closeCluster();
    }
    if (!cluster) {
      cluster = {
        service: e.envelope.service,
        address: connection,
        ...(accounts[connection] ? { name: accounts[connection] } : {}),
        convs: [],
      };
    }
    let run = cluster.convs.at(-1);
    // a run is one conversation: a thread's replies are its lines, tied to their root by `re`
    if (!run || run.conv.address !== e.envelope.conversation.address) {
      const name = e.envelope.conversation.name ?? names.get(e.id);
      const conv = name ? { ...e.envelope.conversation, name } : e.envelope.conversation;
      const opened: ConvRun = { conv, lines: [] };
      run = opened;
      cluster.convs.push(run);
      const past = elisions.before.get(e) ?? [];
      if (past.length > 0) opened.past = past.map((p) => pastLine(p, true));
      for (const p of past) pullFor(opened, p);
      const earlier = elisions.earlier.get(e);
      if (earlier) run.lines.push(`… ${earlier} earlier, not shown`);
    }
    // no delivery state: a failure or a withdrawal lands late, and the line is drawn once
    // (the sending session hears of both by update; a search page keeps the marks)
    run.lines.push(msgLine(e, me, who, zone, { ref: refOf(e), marks: false }));
    pullFor(run, e);
  };

  // No separators (§5). They went through `place()`, so every date break and gap marker
  // CLOSED the open cluster — one room came out as four `<conv>` elements the moment its
  // messages spanned any time at all. And they were measured in render order, which after
  // the per-conversation partition is not a timeline: a gap computed across two different
  // rooms said `— 680 min later —` about a message that had just arrived, while a jump
  // backwards printed nothing. Each `<msg>` now carries its own absolute stamp instead:
  // one fact per line, no cross-message state to get wrong, clusters intact.

  // Weld sets — pairing is per *use* (a result's `ref_id` = its tool_use id), so parallel
  // tools weld order-independently and a half-filled barrier never leaves an unpaired block
  // for the API to reject. The whole window is welded API-faithfully, as each step's
  // request held it: every request is the one before plus new rows (§5).
  const useById = new Map(
    events.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => [u.id, u]),
  );
  // a LATE result never welds (§9): its `tool_use` was answered already, so the pair is
  // spent — a second `tool_result` block against the same id is not a thing the API has.
  // It renders as harness narration instead.
  const resultRefs = new Set(
    events.filter((e): e is ToolResultEvent => e.type === "tool_result" && !isLate(e))
      .map((r) => r.payload.ref_id),
  );
  const welded = new Set([...useById.keys()].filter((id) => resultRefs.has(id)));
  // a script's calls draw nothing of their own: their answers went to the script, and they
  // fold into the bash call that ran it (`foldsOf`)
  const folds = foldsOf(events, useById);
  // a step still waiting on a result draws nothing yet: its call is being made
  const unanswered = new Set(
    [...useById.values()].filter((u) => !welded.has(u.id)).map((u) => u.payload.turn_id),
  );
  // A thinking block's signature binds everything before it. The checkpoint replaced what
  // came before the turns it kept, so their thinking is bound to a prefix that is gone: it
  // goes, and their tool pairs, which carry no signature, stay.
  const checkpoint = events[0]?.type === "summary" ? events[0] : undefined;
  const signed = (e: Event) => !checkpoint || e.id > checkpoint.id;

  // the request-level media budget (`wantedMedia`): the table may hold more, the budget
  // decides what inlines
  const inlineBudget = new Set(wantedMedia(window, session, compactAt));

  // the anchor as the model read it: what moved since the anchor before it (§5)
  let anchored: string | undefined;
  const placeAnchor = (text: string) => {
    closeCluster();
    // the API takes `mid_conv_system` only after other content in a user turn; a turn that
    // would hold nothing else carries the anchor as plain text (same info)
    const turn = cur as { role: Role; content: ContentBlockParam[] } | null;
    if (turn?.role === "user" && turn.content.some((b) => b.type !== "mid_conv_system")) {
      turn.content.push(sys(text));
    } else emit("user", { type: "text", text });
  };

  // Weld faithfully. `weldOrder` makes each step contiguous (its uses, then its results)
  // and floats what landed in flight after it, so a tool_result is always FIRST in its user
  // message (openbsp's sortToolMessages rule); the emit builder handles role alternation.
  // the prefix as the model read it (§5): the first since the checkpoint is the system,
  // each later one is drawn where it was read, as what changed
  const prefixes = new Set(prefixesOf(window).map((e) => e.id));
  let prefixed: PrefixSection[] | undefined;
  // the lines the agent's calls that ran wrote out since the last prefix
  let said = new Set<string>();
  const ran = (e: ToolResultEvent) => {
    const use = useById.get(e.payload.ref_id);
    const out = e.parts[0].data;
    const asked = (out.output as { status?: unknown } | null)?.status === "pending_approval";
    if (use && !out.is_error && !out.cancelled && !out.refused && !asked) {
      linesOf(use.parts[0].data.input, said);
    }
  };
  // the cut's block (§5): a checkpoint's request ends on it, and every think marks it
  const cut = archive?.cut ?? pinned;
  let cutBlock: ContentBlockParam | undefined;
  const drawn = events.filter((e) =>
    scripted(e) === undefined && (archive === undefined || archive.covered.has(e.id))
  );
  for (const e of weldOrder(drawn)) {
    if (e.type === "prefix") {
      if (!prefixes.has(e.id)) continue;
      const sections = e.parts[0].data.sections;
      if (prefixed) placeAnchor(prefixDelta(prefixed, sections, said));
      prefixed = sections;
      said = new Set();
    } else if (e.type === "anchor") {
      placeAnchor(anchorDelta(anchored, e.parts[0].text));
      anchored = e.parts[0].text;
    } else if (e.type === "summary") {
      place("user", { type: "text", text: checkpointEl(e, window) });
    } else if (e.type === "error") {
      place("user", { type: "text", text: systemEl("error", errorTextOf(e)) });
    } else if (e.type === "control") {
      // nothing failed: it was stopped. A tool it cut welds above it, its result included
      place("user", { type: "text", text: systemEl("control", CANCELLED) });
    } else if (e.type === "alarm") {
      place("user", { type: "text", text: alarmLine(e) });
    } else if (e.type === "permission_response") {
      if (e.envelope.conversation.address === here) {
        place("user", { type: "text", text: permissionEl(e, who, zone) });
      }
    } else if (e.type === "thinking") {
      if (signed(e) && !unanswered.has(e.payload.turn_id)) place("assistant", thinkingBlock(e));
    } else if (e.type === "tool_use" && welded.has(e.id)) place("assistant", toolUseBlock(e));
    else if (e.type === "tool_result" && isLate(e)) {
      // a call's outcome after its answer (§9): the principal ruled and the harness ran
      // it, or what it set in motion went on — told in the harness's own voice, because
      // the tool_use it answers is spent. Narration, so it can stand alone in any position.
      if (e.payload.gated) ran(e);
      place("user", { type: "text", text: lateLine(e, folds.get(e.id)) });
    } else if (e.type === "tool_result" && welded.has(e.payload.ref_id)) {
      ran(e);
      place(
        "user",
        toolResultBlock(e, useById.get(e.payload.ref_id)!, mediaBlocks(e), folds.get(e.id)),
      );
    } else if (e.type === "message") {
      if (isSelf(e, me) && e.envelope.conversation.address === here) {
        // the agent's own words, a silent closing's included: it was a response like any
        // other, and the next request replays it (an empty one said the word)
        placeOwn(silent(e) && !bodyOf(e, zone).trim() ? SILENCE : bodyOf(e, zone));
      } else if (e.envelope.conversation.address === here) {
        place("user", { type: "text", text: principalLine(e) });
      } else {
        world(e);
      }
      // media (§5): after the marker, the picture itself — a real base64 image/document
      // block in a user turn (which also closes any open cluster), kept until the
      // checkpoint like the rest. The agent's own attachments aren't re-shown.
      if (!isSelf(e, me)) {
        const blocks = mediaBlocks(e);
        if (blocks.length) place("user", ...blocks);
      }
    }
    // uses of a step still waiting on a result, orphan results, other types: skipped
    // the cut is a turn's end, which draws its own block, never into an open cluster
    if (e.id === cut && cur) cutBlock = markable((cur as { content: ContentBlockParam[] }).content);
  }
  closeCluster();

  if (archive) {
    // the checkpoint's request ends where the span does (§5): the position is the
    // boundary. Its one mark is the cut, the entry every think kept warm. The API takes a
    // `mid_conv_system` block only after other content in a user turn, so after the
    // agent's own words the instruction is a user turn of text
    mark(cutBlock);
    const turn = cur as { role: Role; content: ContentBlockParam[] } | null;
    if (turn?.role === "user" && turn.content.some((b) => b.type !== "mid_conv_system")) {
      turn.content.push(sys(archive.instruction));
    } else {
      emit("user", {
        type: "text",
        text: `<system kind="checkpoint">\n${archive.instruction}\n</system>`,
      });
    }
    flush();
    return out;
  }

  // the request's own prefix and anchor, each when it moved since the last the window
  // holds — nu writes them with the step, where they render from then on
  const live = systemSections(docs, env);
  if (prefixed && !sameSections(prefixed, live)) placeAnchor(prefixDelta(prefixed, live, said));
  const text = anchorText(now, zone, ambient);
  if (text !== anchored) placeAnchor(anchorDelta(anchored, text));

  // The cache breakpoints (§5), every one an hour: the request only ever grows, so the
  // last request's tail is what this one reads back, and this one's is what the next
  // reads — often more than five minutes on, after a wake. The previous request ended
  // where the latest step began: the block before the last assistant message. The tail's
  // mark rides the anchor when the request closes on one, so the next request reads the
  // anchor back too; the pinned cut takes the fourth mark.
  const all = cur ? [...out, cur as MessageParam] : out;
  const previous = all.findLastIndex((m) => m.role === "assistant");
  if (previous > 0) mark(markable(all[previous - 1].content as ContentBlockParam[]));
  if (cur) mark(markable((cur as { content: ContentBlockParam[] }).content));
  mark(cutBlock);
  flush();
  return out;
}

/** The last block a cache mark can name: thinking takes none, and a `mid_conv_system`
 *  block takes it on the text inside. */
function markable(blocks: ContentBlockParam[]): ContentBlockParam | undefined {
  const b = blocks.findLast((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  return b?.type === "mid_conv_system" ? b.content.at(-1) as ContentBlockParam : b;
}

/** The anchor's text: `now:` to the minute and the live environment lines (§5). */
export function anchorText(now: string, zone?: string, ambient?: string[]): string {
  return [`now: ${nowStamp(now, zone)}`, ...(ambient ?? [])].join("\n");
}

/** An anchor's sections, by key: a header line (`now: …`, `background — 1 job:`) and the
 *  `·` and `—` lines under it. */
function sectionsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | undefined;
  for (const line of text.split("\n")) {
    if (key !== undefined && (line.startsWith("· ") || line.startsWith("— "))) {
      out.set(key, `${out.get(key)}\n${line}`);
    } else {
      key = line.split(/:| — /)[0];
      out.set(key, line);
    }
  }
  return out;
}

/** What an anchor says after the one before it (§5): the sections that moved, and each
 *  that emptied as `<key> — none`, or the last listing would stand. The first says all. */
export function anchorDelta(prev: string | undefined, next: string): string {
  if (prev === undefined) return next;
  const was = sectionsOf(prev);
  const is = sectionsOf(next);
  return [
    ...[...is].filter(([k, s]) => was.get(k) !== s).map(([, s]) => s),
    ...[...was.keys()].filter((k) => !is.has(k)).map((k) => `${k} — none`),
  ].join("\n");
}

/** Whether a step's request ends on an anchor of its own: the state's text differs from
 *  the last anchor the window holds. nu writes one exactly when render draws it. */
export function anchorDue(window: Event[], text: string): boolean {
  const last = applySummary(window).findLast((e) => e.type === "anchor");
  return last?.type !== "anchor" || last.parts[0].text !== text;
}

/**
 * Order the window so each step is contiguous at the position of its first event — its
 * non-results in log order, then its results — and anything that interleaved (a message
 * landing between a use and its result) floats to after it.
 *
 * And anything that landed while the step's call was in flight floats after it too: such an
 * event has a log id older than the step's own (those are appended when the call returns)
 * yet was not in the request that produced the step, and the step's thinking is signed over
 * what that request held. nu records the request's horizon on the step (`extra.consumed`,
 * its first event); an event newer than the horizon and older than the step is placed after
 * the step — the first request that could carry it, and where every later request keeps it
 * (§5). The step's own prefix and anchor are no such events: nu writes them with the step,
 * as the last things its request held.
 */
function weldOrder(events: Event[]): Event[] {
  const groups = new Map<string, Event[]>();
  const sequence: (Event | { group: string })[] = [];
  // per step: the horizon its request read, and its own first id
  const horizons = new Map<string, { seen: string; first: string }>();
  for (const e of events) {
    const turn = turnOf(e);
    if (turn !== undefined) {
      let g = groups.get(turn);
      if (!g) {
        g = [];
        groups.set(turn, g);
        sequence.push({ group: turn }); // the group renders where it first appeared
        horizons.set(turn, { seen: "", first: e.id });
      }
      const seen = e.extra?.consumed;
      const h = horizons.get(turn)!;
      if (typeof seen === "string" && !h.seen) h.seen = seen;
      g.push(e);
    } else {
      sequence.push(e);
    }
  }
  // what landed in flight, by the step it must follow
  const late = new Map<string, Event[]>();
  const inFlight = (e: Event): string | undefined => {
    if (e.type === "anchor" || e.type === "prefix") return undefined;
    for (const [turn, h] of horizons) {
      if (h.seen && e.id > h.seen && e.id < h.first) return turn;
    }
    return undefined;
  };
  const out: Event[] = [];
  for (const item of sequence) {
    if ("group" in item) {
      const g = groups.get(item.group)!;
      out.push(...g.filter((e) => e.type !== "tool_result"));
      out.push(...g.filter((e) => e.type === "tool_result"));
      out.push(...(late.get(item.group) ?? []));
    } else {
      const after = inFlight(item);
      if (after !== undefined && !out.some((e) => turnOf(e) === after)) {
        // the step is still to come in the sequence: hold the event for after it
        late.set(after, [...(late.get(after) ?? []), item]);
      } else {
        out.push(item);
      }
    }
  }
  return out;
}

/** The step an event belongs to: `payload.turn_id`, on every emission that carries one.
 *  A send's row (ref_id→tool_use) stays outside — it is a world line, drawn after its turn
 *  (`afterTurns`) — and so does a late result: it names the step of the call it tells
 *  about, but it was written after that step's request, which its thinking is signed over,
 *  so it stands where it landed. */
function turnOf(e: Event): string | undefined {
  if (e.type === "tool_result" && isLate(e)) return undefined;
  if (e.type === "thinking" || e.type === "tool_use" || e.type === "tool_result") {
    return e.payload.turn_id;
  }
  if (e.type === "message" && !e.payload?.ref_id && typeof e.payload?.turn_id === "string") {
    return e.payload.turn_id;
  }
  return undefined;
}

function findLastIndex(events: Event[], pred: (e: Event) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (pred(events[i])) return i;
  }
  return -1;
}

/** A world cluster: one connection's run of traffic, each conversation's run within it. */
interface ConnectionCluster {
  service: string;
  address: string;
  name?: string;
  convs: ConvRun[];
}

/** One `<conv>` element's worth of a run: its lines, and its `<before>`. */
interface ConvRun {
  conv: Conversation;
  lines: string[];
  past?: PastLine[];
}

/** A `<before>` line, with how many of its room's rows below the floor are newer than it:
 *  what orders the block and counts its gaps. `capped`: that count stopped at `GAP_READ`. */
interface PastLine {
  line: string;
  rank?: number;
  capped?: boolean;
}

/** The most rows xi counts between a far referent and its room's newest rows: past it, the
 *  gap says "+". */
export const GAP_READ = 1000;

/** Each row's rank in its room: how many of the room's rows the window and the pool know
 *  are newer. The gap between two lines is the difference of their ranks, so it holds as
 *  rows arrive. A referent older than every known row adds the rows xi counted between;
 *  one xi could not place has no rank, and no gap is counted beside it. */
function ranksOf(
  pool: BeforePool | undefined,
  rows: Event[],
): Map<EventId, Omit<PastLine, "line">> {
  const known = new Map<string, MessageEvent[]>();
  for (const e of [...rows.filter((r) => r.type === "message"), ...pool?.rows ?? []]) {
    known.set(roomKey(e), [...known.get(roomKey(e)) ?? [], e as MessageEvent]);
  }
  const out = new Map<EventId, Omit<PastLine, "line">>();
  for (const list of known.values()) {
    list.sort((a, b) => a.id < b.id ? 1 : -1).forEach((e, i) => out.set(e.id, { rank: i }));
  }
  for (const e of pool?.refs ?? []) {
    const list = known.get(roomKey(e)) ?? [];
    const newer = list.filter((r) => r.id > e.id).length;
    const n = pool!.between[e.id];
    if (newer < list.length) out.set(e.id, { rank: newer });
    else if (n !== undefined) {
      out.set(e.id, { rank: list.length + n, ...(n >= GAP_READ ? { capped: true } : {}) });
    }
  }
  return out;
}

/** A `<before>` block: oldest first, and between two lines that are not neighbours, how
 *  many rows lie between them. */
function beforeEl(past: PastLine[]): string {
  // a line with no rank is a referent xi could not place: older than all the rest
  const rank = (p: PastLine) => p.rank ?? Infinity;
  const sorted = [...past].sort((a, b) => rank(b) - rank(a));
  const lines = sorted.flatMap((p, i) => {
    const next = sorted[i + 1]?.rank;
    const gap = p.rank !== undefined && next !== undefined ? p.rank - next - 1 : 0;
    return gap > 0 ? [p.line, `… ${gap}${p.capped ? "+" : ""} not shown`] : [p.line];
  });
  return `<before>\n${lines.join("\n")}\n</before>`;
}

/** A world cluster → its `<conn>` element (§5): the account the lines arrived through —
 *  service, the name the service shows for it, address — wrapping one `<conv>` per run of
 *  same-conversation lines. Said once per run of traffic instead of on every `<conv>`,
 *  and NAMED: the account's own name is what the wire stamps on its own outbound lines,
 *  and read here it is the account, not a person in the room. Untrusted strings (names,
 *  ids) are attribute-escaped. */
function connectionEl(c: ConnectionCluster): string {
  const attrs = [
    `service="${escAttr(c.service)}"`,
    ...(c.name ? [`name="${escAttr(c.name)}"`] : []),
    `address="${escAttr(c.address)}"`,
  ];
  const convs = c.convs.map(conversationEl);
  return `<conn ${attrs.join(" ")}>\n${convs.join("\n")}\n</conn>`;
}

/** The best name the window knows for each room (§5): `conversation.name` is a per-row
 *  fact — what the wire stamped on THAT message — and a row can lack it (a bridge restart,
 *  a feed that never came) while its neighbours carry it. Read per row, one room printed
 *  both named and bare in the same prompt, and the anchor's newest-row sample went bare
 *  most often of all. Keyed service + address; the LATEST named row wins, since a contact
 *  can change theirs. */
export function roomNames(events: Event[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "message") continue;
    const conv = e.envelope.conversation;
    if (conv.name) names.set(`${e.envelope.service}\u0000${conv.address}`, conv.name);
  }
  return names;
}

/** Each message's room name as of that row (§5): the latest the room was named at or
 *  before it, in the log's order. What `roomNames` reads off the whole window, held to the
 *  row's moment, so a line once drawn never takes a later name. */
export function roomNamesAt(events: Event[]): Map<EventId, string> {
  const latest = new Map<string, string>();
  const out = new Map<EventId, string>();
  for (const e of events) {
    if (e.type !== "message") continue;
    const conv = e.envelope.conversation;
    const key = `${e.envelope.service}\u0000${conv.address}`;
    if (conv.name) latest.set(key, conv.name);
    const name = latest.get(key);
    if (name !== undefined) out.set(e.id, name);
  }
  return out;
}

/** A conversation as the window names it: the row's own name, else the best one seen. */
export function namedRoom(
  e: MessageEvent,
  names: Map<string, string>,
): Conversation {
  const conv = e.envelope.conversation;
  if (conv.name) return conv;
  const name = names.get(`${e.envelope.service}\u0000${conv.address}`);
  return name ? { ...conv, name } : conv;
}

/** One conversation's run → its `<conv>` element. The attributes are the envelope facts
 *  the agent acts on: `kind` tells a public channel from a DM, `name` is the handle it
 *  reads, `address` the one `send` takes back (and the stable one — a name is the
 *  service's word, and a contact can change theirs). */
function conversationEl(c: ConvRun): string {
  const attrs = [
    ...(c.conv.kind ? [`kind="${c.conv.kind}"`] : []),
    ...(c.conv.name ? [`name="${escAttr(c.conv.name)}"`] : []),
    `address="${escAttr(c.conv.address)}"`,
  ];
  const lines = c.past?.length ? [beforeEl(c.past), ...c.lines] : c.lines;
  return `<conv ${attrs.join(" ")}>\n${lines.join("\n")}\n</conv>`;
}

/** An account's address-book entries on a search page (§6): the account's own `<conn>`
 *  element — the same one its traffic wears — holding one `<contact>` per entry, name and
 *  the address `send(to:)` takes. `contact` is already the window's word for a saved
 *  sender (`authorOf`); here it is the entry itself. Untrusted strings attribute-escaped. */
export function bookEl(
  account: { service: string; address: string; name?: string },
  entries: { name: string; address: string }[],
): string {
  const lines = entries.map((e) =>
    `<contact name="${escAttr(e.name)}" address="${escAttr(e.address)}"/>`
  );
  return connWith(account, lines);
}

/** Who an address nobody here knows reaches, as an account's wire answers it (§6): the
 *  account's own `<conn>` holding one `<profile>` per address — `exists` whether the
 *  address is an account on that wire at all, and `name` the one it shows when it has
 *  one. Untrusted strings attribute-escaped. */
export function profileEl(
  account: { service: string; address: string; name?: string },
  entries: { address: string; exists: boolean; name?: string }[],
): string {
  const lines = entries.map((e) =>
    `<profile address="${escAttr(e.address)}" exists="${e.exists}"${
      e.name ? ` name="${escAttr(e.name)}"` : ""
    }/>`
  );
  return connWith(account, lines);
}

/** A doc a search's `in` or `from` named by one of its keywords (§6): its handle, the one
 *  the index prints and the read takes, its keywords and the conversations it names, each
 *  `service:address` as its header writes it. */
export function docEl(
  doc: { handle: string; keywords?: string[]; conversations?: Where[] },
): string {
  const where = (doc.conversations ?? []).map((w) => `${w.service}:${w.address}`);
  const attrs = [
    `handle="${escAttr(doc.handle)}"`,
    ...(doc.keywords?.length ? [`keywords="${escAttr(doc.keywords.join(", "))}"`] : []),
    ...(where.length ? [`conversations="${escAttr(where.join(", "))}"`] : []),
  ];
  return `<doc ${attrs.join(" ")}/>`;
}

function connWith(account: { service: string; address: string; name?: string }, lines: string[]) {
  const attrs = [
    `service="${escAttr(account.service)}"`,
    ...(account.name ? [`name="${escAttr(account.name)}"`] : []),
    `address="${escAttr(account.address)}"`,
  ];
  return `<conn ${attrs.join(" ")}>\n${lines.join("\n")}\n</conn>`;
}

/** What an account could not be asked (its address book, by default), said in the
 *  harness's own voice — the account named the way the window's `connections:` line names
 *  it, so "not asked" never reads as "nobody by that name". */
export function unreachedLine(
  account: { service: string; address: string; name?: string },
  what = "address book",
): string {
  const name = account.name ? ` "${escText(account.name)}"` : "";
  return `— ${escText(account.service)} ${escText(account.address)}${name}: ${
    escText(what)
  } not reached —`;
}

/**
 * A `search` page (§6), in the window's own grammar: the hits are world lines, grouped the
 * way the window groups them — one `<conn>` per account, one `<conv>` per room, rooms
 * ordered by their latest hit so the freshest ends nearest the model — and each line is
 * `msgLine`, so an author reads `self` / `principal="…"` / `external="…" address="…"`
 * exactly as in the window, a lone attachment hoists onto its own element, and a reply's
 * `re` points at a hit on the same page (`?` beyond it). Every stamp carries its year:
 * search reaches where a bare `16 Sep` is ambiguous. Nothing here is new to a model that
 * reads its window; that is the point. The session's own room renders as a room like any
 * other — a hit there wears `self` or its principal's mark on a `<msg>`, not a
 * `<principal>` element, because a search result is a list of lines, not a transcript.
 *
 * With context (`search around`): `match` names the hits among the lines around them,
 * each wearing the bare `match` attribute after its stamp, and `adjacent` says whether two
 * consecutive lines of a room stand side by side in the log — where they do not, a `…`
 * line says lines were left out, the way the window's own elisions do.
 */
export interface HitsOpts {
  match?: Set<EventId>;
  adjacent?: (a: MessageEvent, b: MessageEvent) => boolean;
  /** Where the asking session holds each line (`Seen`), worn as `seen="…"`. */
  seen?: Map<EventId, Seen>;
}

/** Where a session holds a row (§5): its window draws it now (`window`), its checkpoint
 *  stands for it (`checkpoint`), or neither (`never`): a silenced row, one from before the
 *  session's boot floor or the cap, one in a room only another session reads. */
export type Seen = "window" | "checkpoint" | "never";

/** The rows a session's window draws now (§5): past the checkpoint and the caps, a
 *  script's calls aside, which the window folds into their bash call. */
export function drawnIn(
  window: Event[],
  session: Session,
  compactAt = DEFAULT_COMPACT_AT,
): Set<EventId> {
  return new Set(
    regions(window, session, compactAt).events.filter((e) => scripted(e) === undefined)
      .map((e) => e.id),
  );
}

export const GAP = "… lines between, not shown";

export function renderHits(
  hits: MessageEvent[],
  session: SessionRef,
  roster: Roster,
  zone?: string,
  connections: Record<string, string> = {},
  { match, adjacent, seen }: HitsOpts = {},
): string {
  const events = byConversation([...hits].sort(byTs)) as MessageEvent[];
  const names = roomNames(events);
  const byExternal = new Map<string, Event>();
  for (const e of events) if (e.envelope.external_id) byExternal.set(e.envelope.external_id, e);
  const refOf = (e: Event): Ref => {
    const id = e.payload?.ref_external_id;
    if (!id) return { attr: "" };
    const target = byExternal.get(id);
    return { attr: ` re="${target ? shortId(target.id) : "?"}"`, target, shown: !!target };
  };
  const clusters: ConnectionCluster[] = [];
  let last: MessageEvent | undefined;
  for (const e of events) {
    const connection = e.envelope.connection_address;
    let cluster = clusters.at(-1);
    if (!cluster || cluster.service !== e.envelope.service || cluster.address !== connection) {
      cluster = {
        service: e.envelope.service,
        address: connection,
        ...(connections[connection] ? { name: connections[connection] } : {}),
        convs: [],
      };
      clusters.push(cluster);
    }
    let run = cluster.convs.at(-1);
    if (!run || run.conv.address !== e.envelope.conversation.address) {
      run = { conv: namedRoom(e, names), lines: [] };
      cluster.convs.push(run);
    } else if (adjacent && last && !adjacent(last, e)) run.lines.push(GAP);
    const held = seen?.get(e.id);
    const mark = [
      ...(match?.has(e.id) ? ["match"] : []),
      ...(held ? [`seen="${held}"`] : []),
    ].join(" ") || undefined;
    run.lines.push(msgLine(e, session, roster, zone, { ref: refOf(e), dated: true, mark }));
    last = e;
  }
  return clusters.map(connectionEl).join("\n");
}

/** One world message line — the deviation marked (§3, §5): `<msg>` carries text
 *  (`action="edit"` = replacement content, `action="delete"` = the removed content),
 *  `<reaction>` carries the glyph (`action="remove"` = an un-react), `<transcript>` carries
 *  the derived words of the audio its `re` points at, in that audio's author's name. A DATA
 *  part renders as its kind's own
 *  element — `<location>`, `<contacts>`, `<calendar>`, whatever a connector ships — the
 *  pruned object riding a `data` attribute as a TS literal; a message that IS one data part
 *  hoists the envelope attributes onto that element and spends no `<msg>` wrapper (`<reaction>`
 *  is this rule's oldest instance). Bare defaults: create and add wear no attribute.
 *  `status="failed"` = the dispatcher gave up on delivery (§5); `status="withdrawn"` = the
 *  agent took it back before it went out.
 *
 *  **References** (§5): every `<msg>` wears an `id` — the handle a reply, a reaction or a
 *  delete points back at with `re`, and the one `send` takes to author them. It is derived
 *  from the event id, so it names the same message in every render; `re="?"` = the referent
 *  is outside this window. Nothing can point at a `<reaction>`, so reactions spend no id.
 *
 *  Body and sender name are attacker-controlled — escaped, so no message can close its own
 *  element; and who is speaking is the author attribute's KEY (`authorOf`), which no name
 *  can spell. */
/** The author attribute (§5): ONE attribute per line whose key says who among us wrote it
 *  and whose value is their name — never a name in one slot and a role in another, which
 *  read as two facts and let the louder one win (an org account's pushname on a
 *  principal's phone-typed line read as the account's owner speaking, not the principal).
 *
 *    `self`             this agent's own voice, any session of it (authorship, §3: `turn_id`)
 *    `principal="Ana"`  a principal of this agent, whichever device they typed on (the
 *                       classifier's `agent.id` stamp without a turn_id)
 *    `agent="Robo"`     any other roster member, human or alter-ego alike, one complex
 *    `org`              the account itself spoke and nobody among us is stamped on it: an
 *                       org-wide account has companion devices, and which member held one
 *                       is a fact the wire never carries — so the org has spoken, and no
 *                       member is invented for it
 *    `contact="Sol"`    nobody among us, saved: the ACCOUNT's word for them, then their
 *                       `address`
 *    `external="Sol"`   nobody among us — the wire's word for them, then their `address`
 *
 *  The value is the ROSTER's word for one of us (an identity, never a session — which
 *  conversation a line is in already says which hands are talking; on the local service
 *  the session address, `build@matias`, composed by hand so render never throws on an odd
 *  stored name); `self` and `org` carry none, the key is the whole fact. An outsider's
 *  line is the only one whose name is not the roster's — the principal's, when they saved
 *  it (`sender_saved`), else the sender's own to choose — so it is the only one that also
 *  wears the address: the stable handle, and what `send` takes back. The key set is
 *  closed and every line wears exactly one, so an unclassified sender lands on `external`:
 *  unknown reads as untrusted, never as one of us. */
function authorOf(e: MessageEvent, session: SessionRef, roster: Roster): string {
  const key = authorKeyOf(e, session, roster);
  const id = e.agent?.id;
  if (id === undefined) {
    if (key === "org") return " org";
    const sender = e.envelope.sender!; // not own side ⇒ the wire named someone
    const name = sender.name ? ` ${key}="${escAttr(sender.name)}"` : " external";
    const address = sender.address ? ` address="${escAttr(sender.address)}"` : "";
    // a wire that knows their email says it (Slack, Teams); a mailbox's address is one
    const mail = e.extra?.[SENDER_EMAIL];
    const email = typeof mail === "string" ? ` email="${escAttr(mail)}"` : "";
    return `${name}${address}${email}`;
  }
  if (key === "self") return " self";
  let value = roster.names[id] ?? id;
  if (e.envelope.service === "local") {
    const s = e.agent?.session_id ?? routedSession(e.envelope);
    value = s === MIND ? id : `${s}@${id}`;
  }
  return ` ${key}="${escAttr(value)}"`;
}

export const AUTHOR_KEYS = ["self", "principal", "agent", "org", "contact", "external"] as const;
export type AuthorKey = typeof AUTHOR_KEYS[number];

/** Who among us wrote a line, as the key of its author attribute (`authorOf`). */
export function authorKeyOf(e: MessageEvent, session: SessionRef, roster: Roster): AuthorKey {
  const id = e.agent?.id;
  if (id === undefined) {
    if (ownSide(e)) return "org";
    const sender = e.envelope.sender!; // not own side ⇒ the wire named someone
    return senderSaved(e) && sender.name ? "contact" : "external";
  }
  const voice = e.payload?.turn_id !== undefined || isSelf(e, session);
  if (voice && id === session.agentId) return "self";
  return !voice && roster.principals.includes(id) ? "principal" : "agent";
}

/** The account itself is the sender: the wire named its own address as the author (the
 *  echo of anything sent from any device), or named nobody at all. Shared with xi: a line
 *  the account spoke is our side's word, whoever held the device. */
export function ownSide(e: MessageEvent): boolean {
  const sender = e.envelope.sender;
  return sender === undefined || sender.address === e.envelope.connection_address;
}

/** How a line is drawn beyond its own facts: `ref` is the window's resolution of its
 *  `re`; `dated` puts the year on the stamp (a search page); `mark` is a bare attribute the
 *  line wears after its stamp — `match`, on a search hit shown among its context.
 *  `marks: false` draws no delivery state: a `<before>` line is one the room saw, and the
 *  state a row wears now may have moved since the floor. */
interface LineOpts {
  ref?: Ref;
  dated?: boolean;
  mark?: string;
  marks?: boolean;
}

/** The states of a message that went out. */
const OUT = new Set(["dispatched", "delivered", "read"]);

/** Whether a line wears no `id`: an add or a remove (a reaction, a transcript) is a leaf,
 *  and nothing in the vocabulary points back at one. */
export function isLeaf(e: MessageEvent): boolean {
  const action = e.payload?.action;
  return action === "add" || action === "remove";
}

function msgLine(
  e: MessageEvent,
  session: SessionRef,
  roster: Roster,
  zone?: string,
  { ref = { attr: "" }, dated = false, mark, marks = true }: LineOpts = {},
): string {
  const re = ref.attr;
  const author = authorOf(e, session, roster);
  const flag = mark ? ` ${mark}` : "";
  const head = `id="${shortId(e.id)}"${author} at="${hhmm(e.ts, zone, dated)}"${flag}`;

  const action = e.payload?.action;
  // the hoisting rule: a message that IS one data part wears the envelope on its own element
  // (reactions keep `<reaction>` via the add/remove branch below)
  const solo = e.parts?.length === 1 && e.parts[0].type === "data" &&
      e.parts[0].kind !== "reaction" && action !== "add" && action !== "remove"
    ? e.parts[0]
    : undefined;
  if (solo) return dataLine(solo, e, author, re, zone, dated, flag);
  if (action === "edit") {
    return `<msg ${head}${re} action="edit">${escText(textOf(e))}</msg>`;
  }
  if (action === "delete") {
    // the removed content, spelled out only when the original is NOT a line the model can
    // read: `re` already points there when it is, and a delete says nothing twice
    const body = ref.target && !ref.shown ? escText(textOf(ref.target)) : "";
    return `<msg ${head}${re} action="delete">${body}</msg>`;
  }
  if (isLeaf(e)) {
    // agnostic over WHAT was added — the part names itself (§3). A transcript is the
    // harness's derived words for the audio its `re` points at: no `id` (nothing in the
    // vocabulary points at one), and it wears the AUTHOR OF THAT AUDIO — the words are the
    // only line of the two that reads as speech, so the speaker must be on this line, not
    // on a marker that may sit a turn away or outside the caps. The transcript row itself
    // names no sender (the harness wrote it), so the referent's author is the only one there
    // is: unresolved, the line wears none.
    const t = e.parts.find((p): p is TextPart => p.type === "text" && p.kind === "transcript");
    if (t) {
      const spoke = ref.target?.type === "message" ? authorOf(ref.target, session, roster) : "";
      return `<transcript${spoke}${re}>${escText(t.text)}</transcript>`;
    }
    const r = e.parts.find((p): p is ReactionPart => p.type === "data" && p.kind === "reaction");
    // `?? ""`: a glyphless reaction (a removal) renders empty — one malformed event must
    // never kill the window render
    const glyph = r ? (r.data.unicode ?? r.data.name ?? "") : textOf(e);
    const removed = action === "remove" ? ' action="remove"' : "";
    // no `id`: a reaction is a leaf — nothing in the vocabulary can point back at one
    const react = `${author.slice(1)} at="${hhmm(e.ts, zone, dated)}"${flag}`;
    return `<reaction ${react}${re}${removed}>${escText(glyph)}</reaction>`;
  }

  // a failure says why, in the dispatcher's words: what the service refused is what to fix
  // one taken back is withdrawn, whatever a post already in flight stamped after
  const why = e.status?.error?.replace(/^\w*Error: /, "");
  const failed = !marks
    ? ""
    : e.status?.withdrawn_at && !OUT.has(e.envelope.status ?? "")
    ? ` status="withdrawn"`
    : e.envelope.status !== "failed"
    ? ""
    : ` status="failed"${why ? ` error="${escAttr(why)}"` : ""}`;
  // the hoisting rule again, for attachments: a message that IS one file part — a bare
  // voice note, a lone photo — wears the envelope on the marker itself and spends no
  // `<msg>` wrapper. A caption keeps the wrapper: the words are the message's body.
  const file = e.parts?.length === 1 && e.parts[0].type === "file" && textOf(e) === ""
    ? e.parts[0]
    : undefined;
  if (file) return mediaMarker(file, `${head}${re}${failed}`);
  // canonical addresses (the text wears the display form) — `#` keeps its sigil,
  // a person's address rides bare
  const mentions = e.payload?.mentions?.length
    ? ` mentions="${
      escAttr(
        e.payload.mentions.map((m) => m.type === "#" ? `#${m.address}` : m.address).join(" "),
      )
    }"`
    : "";
  // body text is escaped (untrusted); the media and data markers are render's own, appended
  // after (a data part beside text rides inline, attribute-escaped inside its own element)
  const body = [
    escText(textOf(e)),
    ...filesOf(e).map((p) => mediaMarker(p)),
    ...datasOf(e).map((p) => dataEl(p, "", zone)),
  ].filter((s) => s.length > 0).join(" ");
  return `<msg ${head}${re}${failed}${mentions}>${body}</msg>`;
}

/** A data part's element (§5): the part's KIND names the tag — `<location>`, `<contacts>`,
 *  `<calendar>` — one code path for every kind a connector ships, present or future. The
 *  connector already pruned `data` at ingest (it is the only party that knows the wire), so
 *  the whole object rides a `data` attribute as a compact TS literal, a `diff` the connector
 *  wrote (an edit's moves, in `data`'s shape) ahead of it in the same literal; the part's own `text`
 *  (genuinely human words, a caption) is the body, and no text means self-closing. `head`
 *  carries hoisted envelope attributes when the part IS the whole message, empty when it
 *  rides inline as a marker beside text. Every part shape makes `kind` mandatory (types.ts);
 *  a malformed row without one falls back to the part's `type`. */
function dataEl(p: DataPart, head: string, zone?: string): string {
  const tag = p.kind || p.type;
  // what an edit changed comes first: the reader learns the move, then the whole it left
  const attrs = [
    ...(head ? [head] : []),
    ...(p.diff !== undefined ? [`diff="${escAttr(tsLiteral(p.diff, zone))}"`] : []),
    ...(p.data !== undefined ? [`data="${escAttr(tsLiteral(p.data, zone))}"`] : []),
  ].join(" ");
  const text = typeof p.text === "string" && p.text.length ? p.text : "";
  return text ? `<${tag} ${attrs}>${escText(text)}</${tag}>` : `<${tag} ${attrs}/>`;
}

/** A hoisted data line: a message that is EXACTLY one data part spends no `<msg>` wrapper —
 *  the part's element wears the envelope attributes itself. A sender wears the author
 *  attribute the usual way (a calendar event's creator, mapped to `envelope.sender` by the
 *  connector); a SENDERLESS line in a `broadcast` conversation wears none — fan-out is not
 *  a room anyone is in, so the account-spoke fallback must not mislabel a world fact (a
 *  cancellation tombstone has no creator). A delete spends no `id` (nothing points at one)
 *  and its `data` is whatever minimal handle the connector kept — e.g. a calendar
 *  tombstone's `{gid}`, the service-side id that stays actionable after the `re` referent
 *  scrolls out of the window. */
function dataLine(
  p: DataPart,
  e: MessageEvent,
  author: string,
  re: string,
  zone?: string,
  dated = false,
  flag = "",
): string {
  const action = e.payload?.action;
  const act = action === "edit" || action === "delete" ? ` action="${action}"` : "";
  const voiceless = e.envelope.conversation.kind === "broadcast" &&
    e.envelope.sender === undefined;
  const voice = voiceless ? "" : author;
  const id = action === "delete" ? "" : `id="${shortId(e.id)}" `;
  const head = `${id}${voice ? voice.slice(1) + " " : ""}at="${
    hhmm(e.ts, zone, dated)
  }"${flag}${re}${act}`;
  return dataEl(p, head, zone);
}

/** `data` as a compact TS literal — fewer tokens than JSON and the model reads it natively.
 *  Unquoted keys where legal, single quotes, no whitespace; nulls dropped in objects (ingest
 *  prunes, this is the belt to that suspenders). The one rewrite: a string VALUE that is a
 *  full ISO datetime renders as the org-zone clock (`hhmm`) — same vocabulary as `at=`,
 *  applied per value so bare dates (all-day events) and prose merely mentioning a timestamp
 *  pass through untouched. Display loses the offset; wire precision stays in the log. */
function tsLiteral(v: Json, zone?: string): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    const s = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? hhmm(v, zone) : v;
    return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => tsLiteral(x, zone)).join(",")}]`;
  const entries = Object.entries(v).filter(([, x]) => x !== undefined && x !== null);
  return `{${entries.map(([k, x]) => `${keyLiteral(k)}:${tsLiteral(x, zone)}`).join(",")}}`;
}

function keyLiteral(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k.replaceAll("'", "\\'")}'`;
}

/** What a line's `ref_external_id` resolved to against the window (§5): the attribute to
 *  print, and the referent itself when the window holds it — `shown` says whether it is a
 *  line the model can actually read, which is what makes `re` a pointer instead of a name. */
interface Ref {
  attr: string;
  target?: Event;
  shown?: boolean;
}

/** The public handle for an event (§5): the tail of its uuidv7. Derived, so it is the same
 *  string in every render of the same message — the model can carry it across turns — and
 *  short enough to spend on every line. uuidv7's tail is the random block: six hex is one
 *  chance in ~17M per pair, and `xi` refuses an ambiguous match rather than guessing. */
export function shortId(id: EventId): string {
  return id.replaceAll("-", "").slice(-6);
}

/** A handle as a line names it: `shortId`'s six hex digits. */
export const HANDLE = /^[0-9a-f]{6}$/;

/** XML escaping — THE injection boundary (§5): every untrusted string that lands in a text
 *  block passes through here, so plain text in the user role is by construction the
 *  narrator or the principal. Closed rule, unlike Markdown: two substitutions (+quote in
 *  attributes) make forged tags inert. */
function escText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function escAttr(s: string): string {
  return escText(s).replaceAll('"', "&quot;");
}

/** The API accepts `mid_conv_system` only as the TRAILING block(s) of a user message — so
 *  this is reserved for the prefix notice and the anchor, the last blocks of the request
 *  that read them. */
function sys(text: string): Anthropic.MidConversationSystemBlockParam {
  return { type: "mid_conv_system", content: [{ type: "text", text }] };
}

function thinkingBlock(
  e: ThinkingEvent,
): Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam {
  const d = e.parts[0].data;
  return "data" in d
    ? { type: "redacted_thinking", data: d.data }
    : { type: "thinking", thinking: d.thinking, signature: d.signature };
}

/** The checkpoint as the model reads it: its body is a transcript's worth of WORLD text —
 *  escaped like any world body, so a mark typed by a peer and carried into the summary
 *  stays text, and the element is render's own. `before` names the first row it does not
 *  cover, so `search before=<id>` reads back exactly what it summarizes. That row is the
 *  first past what it covers — the checkpoint's own row at the latest, since it lands
 *  after everything it covers — and nothing lands before it later: the attribute never
 *  moves. */
function checkpointEl(e: SummaryEvent, window: Event[]): string {
  const end = e.payload.covers[1];
  const next = window.reduce<Event>((a, r) => r.id > end && r.id < a.id ? r : a, e);
  return `<checkpoint before="${shortId(next.id)}">\n${escText(textOf(e))}\n</checkpoint>`;
}

/** The harness's own word to the model — an element, and its body escaped, so the tag is
 *  render's to write and nobody else's: a peer who types one into a message renders it as
 *  text, since every world body is escaped on the way in. `kind` is the type of the event
 *  it renders, so the four read apart without the sentence having to announce itself. */
function systemEl(
  kind: "error" | "control" | "alarm" | "unload" | "tool_result",
  text: string,
  flags: string[] = [],
): string {
  return `<system kind="${kind}"${flags.map((f) => ` ${f}`).join("")}>${escText(text)}</system>`;
}

/** Said of a call after its answer (§9): a gated outcome, or an update. */
export function isLate(e: ToolResultEvent): boolean {
  return e.payload.gated === true || e.payload.update === true;
}

/** An update on one of this session's calls (`Payload.update`): news (§2). */
export function isUpdate(e: Event, session: SessionRef): e is ToolResultEvent {
  return e.type === "tool_result" && e.payload.update === true && ownComplex(e, session);
}

/** A late result as the model reads it: the outcome line, wearing the flags that place it
 *  in its call's life (`Payload`) — `gated`, `async`, `update`, `final`, the ones it has —
 *  and the calls its script made since the call's answer, folded (`foldsOf`). */
function lateLine(e: ToolResultEvent, fold?: string): string {
  const flags = (["gated", "async", "update", "final"] as const).filter((f) => e.payload[f]);
  return systemEl("tool_result", fold ? `${outcomeLine(e)}\n${fold}` : outcomeLine(e), flags);
}

/** A script's call, or its answer (`Extra.bash`): the id of the bash call whose script made
 *  it through the door (§9). */
export function scripted(e: Event): EventId | undefined {
  if (e.type !== "tool_use" && e.type !== "tool_result") return undefined;
  const bash = e.extra?.bash;
  return typeof bash === "string" ? bash : undefined;
}

/** How much of one failure a fold quotes, and of one answer a search page's call line. */
export const CALL_CLIP = 300;

/** `s` within `n` characters, a cut one ending on `…`. */
function clipped(s: string, n: number): string {
  return s.length > n ? `${clipEnd(s, n - 1)}…` : s;
}

/**
 * A call as a search page shows it (§6): its handle, its stamp, the call as a card names it
 * and its answer, `→` what happened and `—` what didn't — clipped to `clip` characters, or
 * whole when it is 0. `mark` is a bare attribute after the stamp; `session` names the
 * session that made the call when it is not the one asking.
 */
export function callLine(
  use: ToolUseEvent,
  answer: ToolResultEvent | undefined,
  zone?: string,
  { mark, clip = 0, session }: { mark?: string; clip?: number; session?: string } = {},
): string {
  const call = describeCall(use.parts[0].data, { full: true });
  const output = answer?.parts[0].data.output;
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  const said = answer === undefined
    ? "— no answer yet"
    : `${answer.parts[0].data.is_error ? "—" : "→"} ${clip > 0 ? clipped(text, clip) : text}`;
  const where = session ? ` session="${escAttr(session)}"` : "";
  const flag = mark ? ` ${mark}` : "";
  return `<call id="${shortId(use.id)}" at="${hhmm(use.ts, zone, true)}"${where}${flag}>${
    escText(`${call} ${said}`)
  }</call>`;
}

/**
 * A script's calls, folded into the bash call that ran it (§9), keyed by the result they
 * fold under. The script read every answer itself, and what it printed is the bash call's
 * own output, so the window holds the count and the failures, each named by its call. A
 * fold sits under the bash call's answer for the
 * calls made before it, and under the job's final word for those a script that outlived
 * the answer made after it; each counts only what the log held before the row it sits
 * under, so a request never redraws a line an earlier one held. Calls with neither row in
 * the window draw nothing.
 */
function foldsOf(events: Event[], uses: Map<EventId, ToolUseEvent>): Map<EventId, string> {
  const answers = events.filter((e): e is ToolResultEvent =>
    e.type === "tool_result" && scripted(e) !== undefined
  );
  const out = new Map<EventId, string>();
  if (answers.length === 0) return out;
  // the rows a fold sits under, per bash call: its answer, and the job's final word
  const under = new Map<EventId, ToolResultEvent[]>();
  for (const e of events) {
    if (e.type !== "tool_result" || scripted(e) !== undefined) continue;
    if (isLate(e) && !(e.payload.update && e.payload.final)) continue;
    under.set(e.payload.ref_id, [...under.get(e.payload.ref_id) ?? [], e]);
  }
  for (const [bash, rows] of under) {
    let from = "";
    for (const row of rows) {
      const mine = answers.filter((a) => scripted(a) === bash && a.id > from && a.id < row.id);
      from = row.id;
      if (mine.length > 0) out.set(row.id, foldLine(mine, uses));
    }
  }
  return out;
}

/** One fold: how many calls, of which tools, how many failed or wait on the principal, and
 *  each failure in the tool's own words. */
function foldLine(answers: ToolResultEvent[], uses: Map<EventId, ToolUseEvent>): string {
  const tools = new Map<string, number>();
  let asked = 0;
  const failed: string[] = [];
  for (const a of answers) {
    const use = uses.get(a.payload.ref_id);
    const name = use?.parts[0].data.name ?? "call";
    tools.set(name, (tools.get(name) ?? 0) + 1);
    const { output, is_error } = a.parts[0].data;
    if (is_error) {
      const call = use ? describeCall(use.parts[0].data) : name;
      failed.push(`· ${call} — ${clipped(failureOf(a), CALL_CLIP)}`);
    } else if (
      typeof output === "object" && output !== null && !Array.isArray(output) &&
      output.status === "pending_approval"
    ) asked++;
  }
  const n = answers.length;
  const each = [...tools].map(([t, k]) => `${t} ${k}`).join(", ");
  const how = [
    ...(failed.length ? [`${failed.length} failed`] : []),
    ...(asked ? [`${asked} asked your principal`] : []),
  ];
  return [
    `the script made ${n} call${n === 1 ? "" : "s"} (${each})${
      how.length ? `: ${how.join(", ")}` : ""
    }`,
    ...failed,
  ].join("\n");
}

/** The call's wire id is the provider's when the row kept one (`call_id`, §5): a tool cycle
 *  replays the id the model was answered under. A row without one replays the event id. */
function wireId(e: ToolUseEvent): string {
  return e.parts[0].data.call_id ?? e.id;
}

function toolUseBlock(e: ToolUseEvent): Anthropic.ToolUseBlockParam {
  const { name, input } = e.parts[0].data;
  return { type: "tool_use", id: wireId(e), name, input };
}

/** `media` = the result's rendered attachments (§5) — image/document blocks INSIDE the
 *  tool_result content (the API allows text · image · document · search_result there),
 *  so an `aread` on a picture answers with the picture. Empty ⇒ plain string content. */
function toolResultBlock(
  e: ToolResultEvent,
  use: ToolUseEvent,
  media: ContentBlockParam[],
  fold?: string,
): Anthropic.ToolResultBlockParam {
  const { output, is_error } = e.parts[0].data;
  const said = typeof output === "string" ? output : JSON.stringify(output);
  const text = fold ? `${said}\n\n${fold}` : said;
  return {
    type: "tool_result",
    tool_use_id: wireId(use), // the specific tool_use this result answers, by ITS wire id
    content: media.length
      ? [{ type: "text", text }, ...media as Anthropic.ImageBlockParam[]]
      : text,
    ...(is_error ? { is_error: true } : {}),
  };
}

/** A LATE tool outcome as one sentence (§9): `send(to: Vivian) → sent`. The call was
 *  rendered when the outcome was written — where the tool registry and the address book
 *  are — so this reads it off the event rather than re-deriving it from a `tool_use`
 *  a checkpoint may have covered. `→` carries what happened, `—` what didn't. Shared with
 *  the mirror, so the model and the principal are told the same thing. */
export function outcomeLine(e: ToolResultEvent, max = 0): string {
  const { output, is_error } = e.parts[0].data;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const bounded = max > 0 && text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `${e.parts[0].text ?? "the approved call"} ${is_error ? "—" : "→"} ${bounded}`;
}

/** Why a call failed: the tool's own words, whole and as it wrote them — rows and all. A
 *  failure is the one outcome a principal has to act on, and the reason is already bounded
 *  where output is bounded (`exec/truncate.ts`); a screen that clipped it again would put
 *  the reader back in the terminal, running the call by hand to see what it had said. */
export function failureOf(e: ToolResultEvent): string {
  const { output } = e.parts[0].data;
  const said = (typeof output === "string" ? output : JSON.stringify(output) ?? "").trimEnd();
  return said === "" ? "failed, saying nothing" : said;
}

/** A late failure, the call named: it lands long after the call's own row. */
export function failedCallOf(e: ToolResultEvent): string {
  return `${e.parts[0].text ?? "the approved call"} — ${failureOf(e)}`;
}

/** An `error` event's message — rendered as a `<system>` text block rather than a real
 *  `mid_conv_system` one: it PRECEDES what it marks, and the API takes `mid_conv_system`
 *  only in trailing position (§5, live-smoke finding). */
export function errorTextOf(e: HarnessErrorEvent): string {
  return e.parts[0]?.data?.error ?? "unknown error";
}

/** A fired wake (§10), as the agent reads it: its own note handed back at the moment it
 *  asked for. `<system>` because the harness is the one speaking — the note is quoted, not
 *  ventriloquized as the principal. No room to name: an alarm fires in the session that
 *  armed it, which is the session reading it. */
function alarmLine(e: AlarmEvent): string {
  const span = unloadOf(e);
  if (span) return systemEl("unload", "", [`since="${shortId(span.since)}"`]);
  return systemEl("alarm", e.parts[0]?.text ?? "");
}

/** The span an unload notice covers (unload.ts): an alarm the harness raises for itself,
 *  naming the first line it asks to be written down and the last event it reads through.
 *  Undefined for any other row. */
export function unloadOf(e: Event): { since: EventId; through: EventId } | undefined {
  if (e.type !== "alarm") return undefined;
  const u = e.extra?.unload as { since?: unknown; through?: unknown } | undefined;
  return typeof u?.since === "string" && typeof u.through === "string"
    ? { since: u.since, through: u.through }
    : undefined;
}

/** A ruling on an ask (§9), in the session's room where it happened, kept like any line
 *  until the checkpoint: the same record whichever surface the principal answered from.
 *  The ask itself draws nothing: its `tool_use` shows the draft, and its `pending_approval`
 *  result carries the handle the ruling's `re`, the pending list and `cancel` name it by.
 *  The ruling names who gave it — the principal by the roster's word, `self` for the
 *  agent's own withdrawal, nobody for a lapse — the verdict, how long it stands, and the
 *  reason when one was given. An event, never changed: no lifecycle reaches it. */
function permissionEl(e: PermissionResponseEvent, roster: Roster, zone?: string): string {
  const handle = shortId(e.payload.ref_id);
  const at = ` at="${hhmm(e.ts, zone)}"`;
  const v = e.parts[0].data;
  const own = e.payload.turn_id !== undefined;
  const verdict = own ? "withdrawn" : v.lapsed ? "lapsed" : v.behavior;
  const sender = e.envelope.sender;
  const who = own
    ? " self"
    : !v.lapsed && sender
    ? ` principal="${
      escAttr((sender.address && roster.names[sender.address]) ?? sender.name ?? sender.address)
    }"`
    : "";
  const scope = verdict === "allow" || verdict === "deny" ? ` scope="${v.scope}"` : "";
  const body = own ? "" : escText(v.reason ?? "");
  return `<permission_response re="${handle}"${who} verdict="${verdict}"${scope}${at}>` +
    `${body}</permission_response>`;
}

/** OUR SIDE produced this row (§3 authorship — presence, not equality): the model's turn
 *  output (`payload.turn_id`), or a mirror CC replaying mind content outward
 *  (`extra.via.service === "local"`). A principal's rows carry `agent.id` — and, typed
 *  through the harness, `session_id` — yet never a turn_id: they are input, not voice.
 *  THE predicate for the LLM role here, the xi verdict (§2), and the self labels. */
export function ownVoice(e: Event, session: SessionRef): boolean {
  if (!ownComplex(e, session)) return false;
  if (e.payload?.turn_id !== undefined) return true;
  const via = e.extra?.via;
  return typeof via === "object" && via !== null &&
    (via as { service?: string }).service === "local";
}

/** OUR COMPLEX authored it — either half. The identity is the PAIR (§4): bare session
 *  names collide across agents, so `agent.id` must match too. A stamped row names its
 *  session; an unstamped one (the classifier's echo stamp carries none) is a wire row,
 *  and it reads as the session its connection ROUTES to — the same single decision
 *  policy and enrollment consult. */
export function ownComplex(e: Event, session: SessionRef): boolean {
  return e.agent !== undefined && e.agent.id === session.agentId &&
    (e.agent.session_id ?? routedSession(e.envelope)) === session.id;
}

function isSelf(e: Event, session: SessionRef): boolean {
  return ownVoice(e, session);
}

/** Every part's `text` EXCEPT a data part's — a caption rides `FilePart.text` and belongs
 *  in the message body, but a data part's text renders inside its own `<kind>` element
 *  (`dataEl`), and joining it here would say it twice. Filtering on `type === "text"` meant
 *  the model never saw a single caption: the picture arrived as a bare `<image/>` marker and
 *  the words that came with it were dropped on the floor. */
export function textOf(e: Event): string {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p) => p.type !== "data")
    .map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join(" ");
}

/** What the model reads where the principal's hard stop stands (§2): the harness's
 *  `<system>` line — not an error, nothing failed. */
export const CANCELLED = "cancelled by your principal — the turn stopped here";

/** The principal's hard stop STANDS (§2): their last `control` row, and nothing since it
 *  that is news — only what the turn it cut still wrote (its tools' cancelled results, a
 *  failure, a checkpoint). The work it cut is still unanswered, and answering it would be
 *  narrating what they said to drop, so the mind idles on it. News is what would wake a
 *  turn of its own: a line from anyone but us, a fired wake, an update on a call, a
 *  principal's ruling. */
export function cutStands(events: Event[], session: SessionRef): boolean {
  const at = findLastIndex(events, (e) => e.type === "control");
  return at !== -1 &&
    !events.slice(at + 1).some((e) =>
      e.type === "alarm" || isUpdate(e, session) ||
      (e.type === "permission_response" && e.payload.turn_id === undefined) ||
      (e.type === "message" && !ownVoice(e, session) && !silenced(e))
    );
}

function filesOf(e: Event): FilePart[] {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p): p is FilePart => p.type === "file");
}

/** The data parts a body renders as `<kind>` markers — reactions excluded, they are
 *  `<reaction>`'s business (msgLine's add/remove branch). */
function datasOf(e: Event): DataPart[] {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p): p is DataPart => p.type === "data" && p.kind !== "reaction");
}

/** A file part's marker (§5): the element IS the part's kind — `<image/>`, `<audio/>`,
 *  `<document/>` — the same rule data parts follow, the durable face of an attachment in
 *  every region: name + the handle. Local uris show the PLAIN path (what `aread`/bash
 *  take); external links show the url itself. Untrusted strings (a wire filename) are
 *  attribute-escaped like everything else. `head` carries hoisted envelope attributes when
 *  the part IS the whole message (msgLine's hoisting rule), empty when it rides inline as
 *  a marker beside text. */
function mediaMarker(p: FilePart, head = ""): string {
  const tag = p.kind || p.type;
  const name = p.file.name ? ` name="${escAttr(p.file.name)}"` : "";
  const handle = isExternal(p.file.uri) ? p.file.uri : pathOf(p.file.uri);
  return `<${tag}${head ? ` ${head}` : ""}${name} path="${escAttr(handle)}"/>`;
}

/** The row a principal's line in the session's own room acts on: the line or call it
 *  replies to, edits, deletes or reacts to. A copy that quoted nothing names its own
 *  surface row as `ref_id`: provenance, no line. */
export function actedOn(e: MessageEvent): EventId | undefined {
  const action = e.payload?.action;
  const acts = action === "reply" || action === "edit" || action === "delete" ||
    e.parts.some((p) => p.type === "data" && p.kind === "reaction");
  const id = e.payload?.ref_id;
  return acts && typeof id === "string" && id !== e.id ? id : undefined;
}

/** The principal's own line in the session's room (§5): a `<principal>` element, never
 *  bare text. Every voice in the user role wears a tag render writes and escapes — the
 *  world, the harness, the summary, the principal — so the model reads who is speaking off
 *  the element's shape, and bare text is the model's own voice alone. Composed like a
 *  world line (escaped text, then markers), stamped with the org clock, and handled by its
 *  `id` as a world line is, so what the principal says can ground a memory. A line that acts on
 *  another names it in `on`: the quote (`onAttr`) of a row the window holds, or ` re="…"`
 *  for one drawn just ahead in a `<before>`, empty when nothing names it. An edit, a
 *  deletion or a reply wears `action` and `on` on the element (an edit's words are the new
 *  ones, a deletion says nothing), a reaction is a `<reaction on>` inside it. A line
 *  another roster member wrote on a surface of the mind, who does not steer this agent,
 *  is theirs: an `<agent>` element of the same shape. */
function principalEl(
  e: MessageEvent,
  roster: Roster,
  zone: string | undefined,
  on: string,
): string {
  const action = e.payload?.action;
  const r = e.parts.find((p): p is ReactionPart => p.type === "data" && p.kind === "reaction");
  const body = action === "delete" ? "" : [
    escText(textOf(e)),
    ...filesOf(e).map((p) => mediaMarker(p)),
    ...datasOf(e).map((p) => dataEl(p, "", zone)),
    ...(r ? [reactionEl(r, action === "remove", on)] : []),
  ].filter((s) => s.length > 0).join("\n");
  const acts = action === "edit" || action === "delete" || (action === "reply" && on)
    ? ` action="${action}"${on}`
    : "";
  // another roster member wrote it on a surface of the mind, and they are not among who
  // steers: an agent's line, drawn as one, by the roster's word for them (§4)
  const peer = (e.extra?.via as { agent?: string } | undefined)?.agent;
  if (peer !== undefined && !roster.principals.includes(peer)) {
    return `<agent id="${shortId(e.id)}" name="${escAttr(roster.names[peer] ?? peer)}" at="${
      hhmm(e.ts, zone)
    }"${acts}>${body}</agent>`;
  }
  // `name` is the roster's word for them (§4): the sender's address is a username — the
  // door's, or the one the mirror wrote from the binding — and the roster names it. With
  // one principal it is a courtesy, with several it is the identity — the element's
  // shape does not change. Trusted position: only a grant-classified row renders here.
  const who = e.envelope.sender;
  const name = who
    ? ` name="${
      escAttr((who.address && roster.names[who.address]) ?? who.name ?? who.address ?? "")
    }"`
    : "";
  // a steering room's writer is on no roster, so their name alone may be a nickname: the
  // email is who they are — the wire's, or the address itself where it is one
  const mail = senderEmail(e);
  const email = mail ? ` email="${escAttr(mail)}"` : "";
  return `<principal id="${shortId(e.id)}"${name}${email} at="${
    hhmm(e.ts, zone)
  }"${acts}>${body}</principal>`;
}

/** How much of the line a principal's line acts on `on` quotes — enough to tell two
 *  reports apart. */
const ON_QUOTE = 80;

/** ` on="…"`: the line acted on, quoted, or the call as its notice named it; empty when it
 *  says nothing. */
function onAttr(target: Event): string {
  const text = target.type === "tool_use"
    ? describeCall((target as ToolUseEvent).parts[0].data)
    : textOf(target);
  const said = text.replace(/\s+/g, " ").trim();
  const quote = said.length > ON_QUOTE ? `${clipEnd(said, ON_QUOTE - 1)}…` : said;
  return quote ? ` on="${escAttr(quote)}"` : "";
}

function reactionEl(r: ReactionPart, removed: boolean, on: string): string {
  const glyph = r.data.unicode ?? r.data.name ?? "";
  return `<reaction${on}${removed ? ' action="remove"' : ""}>${escText(glyph)}</reaction>`;
}

/** A message's body as plain text: its words, then one marker per attachment, then one
 *  element per data part. HOME turns place it bare, and a `search` hit carries it — the same
 *  line in the result as in the window, markers included, so a path read in one place
 *  works in the other. World lines compose the same pieces inside `msgLine` (escaped
 *  there). Every part shape yields a piece, so a location- or contacts-only message never
 *  renders as an empty text block — the API rejects those (400). */
export function bodyOf(e: Event, zone?: string): string {
  return [
    textOf(e),
    ...filesOf(e).map((p) => mediaMarker(p)),
    ...datasOf(e).map((p) => dataEl(p, "", zone)),
  ]
    .filter((s) => s.length > 0).join("\n");
}

/* ── clocks (§5) ────────────────────────────────────────────────────────────────────
 *
 * Stored `ts` is UTC — ONE clock in the column (store/log.ts normalizes on insert), which
 * is what makes lexical `byTs` real time across services. Render is where wall-clock
 * returns: `zone` (IANA, org config's `timezone`) formats every stamp in the org's local
 * time, so `at=` reads as the hour the humans experienced; unset ⇒ the deployment's own
 * zone. `Intl` does the zone math — no timezone database of our own.
 */
// English on purpose: these stamps face the MODEL, which reads them fine in any tongue. The
// org's `locale` translates the harness's human-facing words (the mirror's tags, §4), not
// what the model is shown. `MONTHS` is shared with `momentOf`, which reads a stamp back.
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface Clock {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

/** One formatter per zone for the whole process — construction is the expensive part. */
const fmts = new Map<string, Intl.DateTimeFormat>();
function fmtFor(zone?: string): Intl.DateTimeFormat {
  const key = zone ?? "";
  let f = fmts.get(key);
  if (!f) {
    fmts.set(
      key,
      f = new Intl.DateTimeFormat("en-US", {
        ...(zone ? { timeZone: zone } : {}),
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
        weekday: "long",
      }),
    );
  }
  return f;
}

/** The stamp's wall-clock fields IN `zone`. Unparseable ⇒ null (callers print the raw ts). */
export function clockOf(ts: string, zone?: string): Clock | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of fmtFor(zone).formatToParts(d)) p[part.type] = part.value;
  return {
    year: +p.year!,
    month: +p.month! - 1,
    day: +p.day!,
    hour: +p.hour!,
    minute: +p.minute!,
    weekday: p.weekday!,
  };
}

/** A message's stamp: `12 Aug 9:50`. Absolute on every line — separators are gone, so the
 *  line itself has to say when, and a bare `HH:mm` under a `now:` anchor reads as today.
 *  Shared with xi's anchor lines, so one clock formats everything the model reads (§5). */
export function hhmm(ts: string, zone?: string, dated = false): string {
  const c = clockOf(ts, zone);
  if (!c) return ts;
  const year = dated ? ` ${c.year}` : "";
  return `${c.day} ${MONTHS[c.month]}${year} ${c.hour}:${pad(c.minute)}`;
}

/** The `now:` anchor, spelled out — the one place a full date is worth its width. */
function nowStamp(ts: string, zone?: string): string {
  const c = clockOf(ts, zone);
  if (!c) return ts;
  return `${c.weekday} ${c.day} ${MONTHS_LONG[c.month]}, ${c.year} - ${c.hour}:${pad(c.minute)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
