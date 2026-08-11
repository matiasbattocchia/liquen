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
 *   (b) `renderMessages` — the volatile tail: home bare / world grouped; no turns anywhere —
 *       the closed/trailing boundary and the API-faithful weld are DERIVED from the window's
 *       shape (§5 "Trailing vs closed"), never tracked by nu.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { DocEntry, DocKind, DocScope } from "./store/docs.ts";
import type {
  Conversation,
  ErrorEvent as HarnessErrorEvent, // aliased: `ErrorEvent` is a DOM global in Deno's lib
  Event,
  MessageEvent,
  SessionId,
  TextPart,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";

type TextBlockParam = Anthropic.TextBlockParam;
type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type Role = "user" | "assistant";

const KIND_ORDER: DocKind[] = ["instruction", "skill", "memory", "tool"];
const SCOPE_ORDER: DocScope[] = ["system", "org", "agent", "conversation"];

/**
 * Docs → the top-level `system` prefix (§5, §8).
 *
 * Ordered by kind, cascade within kind (system → org → agent → conversation). Docs whose body
 * was loaded (`load: always`) are **inlined**; the rest become an **index** the agent pulls
 * from with `aread`. One cache breakpoint at the end — the whole prefix is the stable region.
 */
export function renderSystem(docs: DocEntry[]): TextBlockParam[] {
  const ordered = [...docs].sort(byCascade);
  const blocks: TextBlockParam[] = [];

  const bodies = ordered.filter((d) => d.body !== undefined);
  if (bodies.length > 0) {
    blocks.push({ type: "text", text: bodies.map(section).join("\n\n") });
  }

  const pointers = ordered.filter((d) => d.body === undefined);
  if (pointers.length > 0) {
    blocks.push({ type: "text", text: renderIndex(pointers) });
  }

  const last = blocks.at(-1);
  if (last) last.cache_control = { type: "ephemeral" }; // caches tools + the full system prefix
  return blocks;
}

/** kind-major, then cascade scope, then name — the reading order for the model (§5, decision B). */
function byCascade(a: DocEntry, b: DocEntry): number {
  return KIND_ORDER.indexOf(a.header.kind) - KIND_ORDER.indexOf(b.header.kind) ||
    SCOPE_ORDER.indexOf(a.header.scope) - SCOPE_ORDER.indexOf(b.header.scope) ||
    (a.header.name < b.header.name ? -1 : a.header.name > b.header.name ? 1 : 0);
}

function ref(d: DocEntry): string {
  return `${d.header.scope}/${d.header.kind}/${d.header.name}`;
}

/** An inlined always-doc: a provenance header, then its body. */
function section(d: DocEntry): string {
  return `[${ref(d)}]\n${d.body ?? ""}`;
}

/** The pull-index: one pointer line per lazy doc — description when it has one, and the
 *  doc's REAL substrate path (the ref alone isn't pullable: agent/conversation scopes add
 *  an id segment on disk, and bash runs in the workspace, not the docs root). */
function renderIndex(pointers: DocEntry[]): string {
  const lines = pointers.map((d) => {
    const desc = d.header.frontmatter.description;
    const tail = typeof desc === "string" && desc.length > 0 ? ` — ${desc}` : "";
    return `- ${ref(d)}${tail} → aread ${d.header.path}`;
  });
  return "Your on-demand docs — this index is COMPLETE (nothing else exists; never search " +
    `the docs tree). Pull a body with \`aread\`:\n${lines.join("\n")}`;
}

/* ─────────────────────── (b) the messages tail (§5) ─────────────────────── */

const GAP_MINUTES = 5; // elapsed-time separator threshold

export interface RenderInput {
  events: Event[]; // the log window — render derives what's closed vs trailing itself
  docs: DocEntry[];
  session: SessionId; // tells the agent's own output from the world
  home: string; // the principal-DM conversation id (home vs world)
  now: string; // ISO — the `now:` anchor
  /** Volatile environment lines (cwd · git · background jobs) composed by xi from the exec
   *  plane — joined into the trailing anchor block (§5). Deployment-specific: empty on edge
   *  (no persistent exec env). */
  ambient?: string[];
}

/** The Anthropic request halves render produces — the seam between render and `mu`. */
export interface RenderedRequest {
  system: TextBlockParam[];
  messages: MessageParam[];
}

/** DESIGN §5: a log window → the request `mu` sees. Pure — nu resolves the inputs. */
export function render(input: RenderInput): RenderedRequest {
  return { system: renderSystem(input.docs), messages: renderMessages(input) };
}

/** The last closing assistant home message — a step that emitted no tool_use (§5). Shared
 *  with compaction: only events at or before this index may ever be summarized away. */
export function closingBoundary(events: Event[], session: SessionId, home: string): number {
  const toolTurnIds = new Set(
    events.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => u.turnId),
  );
  return findLastIndex(
    events,
    (e) =>
      e.type === "message" && isSelf(e, session) && e.envelope.conversation.address === home &&
      !(typeof e.meta?.turnId === "string" && toolTurnIds.has(e.meta.turnId)),
  );
}

/** Non-self messages positioned at or before `boundary` that the boundary step never
 *  CONSUMED (per its `meta.consumed` horizon) — the race window: a message landing between
 *  the window-read and the closing's publish sits before the closing in the log yet is
 *  unprocessed INPUT, not history. Shared with compaction (never checkpoint these away). */
export function deferredInput(
  events: Event[],
  session: SessionId,
  boundary: number,
): Set<Event> {
  const out = new Set<Event>();
  if (boundary < 0) return out;
  const horizon = events[boundary].meta?.consumed;
  const h = typeof horizon === "string" ? events.findIndex((e) => e.id === horizon) : boundary;
  const from = h === -1 ? boundary : h;
  for (let i = from + 1; i < boundary; i++) {
    const e = events[i];
    if (e.type === "message" && !isSelf(e, session)) out.add(e);
  }
  return out;
}

/** Apply the latest `summary`: drop everything it covers (id ≤ covers[1] — superseded
 *  summaries fall in that range too) and MOVE the summary to the front — it stands for the
 *  oldest content; its log position is merely its publication time (§5). Exported for
 *  compaction: the weight that decides "checkpoint now?" must be the VISIBLE window's, or a
 *  raw window that stays heavy after a checkpoint would re-compact forever. */
export function applySummary(events: Event[]): Event[] {
  const latest = [...events].reverse().find((e) => e.type === "summary");
  if (!latest || latest.type !== "summary") return events;
  const toId = latest.meta.covers[1];
  return [latest, ...events.filter((e) => e !== latest && e.id > toId)];
}

/** Re-sort inbound messages by `ts` — REAL-WORLD event time, which is what a conversation
 *  means; `id` is only the store's append order (§3), and a lagged webhook or a backfill
 *  appends 14:02 after 14:05. Then partition the run per CONVERSATION (first-arrival
 *  order): a room's messages render adjacent — one element below — because
 *  cross-conversation interleaving is arrival noise, not meaning; within a conversation,
 *  `ts` order stands. Scoped to contiguous runs of world-authored messages: a run
 *  can't span a tool cycle, an agent message, or a turn boundary, so the machine's order —
 *  which the API constrains and the weld depends on — is never touched. Nor is history
 *  rewritten: a straggler that arrives after the agent already answered stays where it
 *  landed, because the answer breaks the run. */
function byEventTime(events: Event[]): Event[] {
  const out = [...events];
  const inbound = (e: Event) => e.type === "message" && !e.agent;
  for (let i = 0; i < out.length; i++) {
    if (!inbound(out[i])) continue;
    let j = i;
    while (j + 1 < out.length && inbound(out[j + 1])) j++;
    // stable sort ⇒ same-`ts` messages keep append order
    if (j > i) {
      out.splice(i, j - i + 1, ...byConversation(out.slice(i, j + 1).sort(byTs)));
    }
    i = j;
  }
  return out;
}

/** Stable-partition a run by conversation id, groups in first-arrival order. */
function byConversation(run: Event[]): Event[] {
  const groups = new Map<string, Event[]>();
  for (const e of run) {
    const key = (e as MessageEvent).envelope.conversation.address;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(e);
  }
  return [...groups.values()].flat();
}
const byTs = (a: Event, b: Event) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;

function renderMessages(
  { events: window, session, home, now, ambient }: RenderInput,
): MessageParam[] {
  const events = byEventTime(applySummary(window));
  const out: MessageParam[] = [];
  let cur: { role: Role; content: ContentBlockParam[] } | null = null;

  const flush = () => {
    if (cur) out.push({ role: cur.role, content: cur.content });
    cur = null;
  };
  const emit = (role: Role, ...blocks: ContentBlockParam[]) => {
    if (cur && cur.role !== role) flush();
    if (!cur) cur = { role, content: [] };
    cur.content.push(...blocks);
  };

  // world cluster (§5): consecutive same-conversation world messages render as ONE
  // `<conv>` element. Any other emission closes the open element first — `place`
  // is emit-with-that-guarantee, and every non-world site uses it.
  let cluster: { service: string; connection: string; conv: Conversation; lines: string[] } | null =
    null;
  const closeCluster = () => {
    if (!cluster) return;
    const el = conversationEl(cluster);
    cluster = null;
    emit("user", { type: "text", text: el });
  };
  const place = (role: Role, ...blocks: ContentBlockParam[]) => {
    closeCluster();
    emit(role, ...blocks);
  };
  const world = (e: MessageEvent) => {
    if (cluster && cluster.conv.address !== e.envelope.conversation.address) closeCluster();
    if (!cluster) {
      cluster = {
        service: e.envelope.service,
        connection: e.envelope.connection_address,
        conv: e.envelope.conversation,
        lines: [],
      };
    }
    cluster.lines.push(msgLine(e, session));
  };

  // separators: a date break on day-change, else an elapsed-gap marker (§5). Plain text —
  // the API allows `mid_conv_system` blocks only in TRAILING position within a turn, and
  // separators precede what they separate; timestamps carry no authority anyway.
  let prevTs: string | undefined;
  const separate = (ts: string) => {
    if (prevTs === undefined || dayOf(ts) !== dayOf(prevTs)) {
      place("user", { type: "text", text: `— ${dayOf(ts)} —` });
    } else if (gapMinutes(prevTs, ts) >= GAP_MINUTES) {
      place("user", { type: "text", text: `— ${gapMinutes(prevTs, ts)} min later —` });
    }
    prevTs = ts;
  };

  // No turns, no nu state (§2 unrolled): render derives everything from the window's shape.
  // Everything the boundary step CONSUMED is CLOSED (collapsed); after it — including
  // horizon-deferred messages the step never saw — the TRAILING chain, welded API-faithfully.
  const boundary = closingBoundary(events, session, home);
  const deferred = deferredInput(events, session, boundary);

  // Trailing weld sets — pairing is per *use* (a result's `cause` = its tool_use id), so
  // parallel tools weld order-independently and a half-filled barrier never leaves an
  // unpaired block for the API to reject.
  const trailing = [...deferred, ...events.slice(boundary + 1)];
  const usePresent = new Set(
    trailing.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => u.id),
  );
  const resultCauses = new Set(
    trailing.filter((e): e is ToolResultEvent => e.type === "tool_result")
      .map((r) => r.cause).filter((c): c is string => c !== undefined),
  );
  const welded = new Set([...usePresent].filter((id) => resultCauses.has(id)));
  const weldedTurns = new Set(
    trailing.filter((e): e is ToolUseEvent => e.type === "tool_use" && welded.has(e.id))
      .map((u) => u.turnId),
  );

  // CLOSED — collapse: messages survive; errors stay visible as system blocks (§2);
  // thinking + tool pairs drop (§5).
  for (const e of events.slice(0, boundary + 1)) {
    if (deferred.has(e)) continue; // unconsumed input — renders in the trailing region
    if (e.type === "summary") {
      place("user", {
        type: "text",
        text: `[checkpoint — earlier messages summarized]\n${textOf(e)}`,
      });
      continue;
    }
    if (e.type === "error") {
      place("user", { type: "text", text: `[harness] error: ${errorTextOf(e)}` });
      continue;
    }
    if (e.type !== "message") continue;
    separate(e.ts);
    if (e.envelope.conversation.address === home) {
      // home: the plain user/assistant chat every LLM API means (§5)
      place(isSelf(e, session) ? "assistant" : "user", { type: "text", text: textOf(e) });
    } else {
      world(e);
    }
  }

  // TRAILING — weld faithfully. `weldOrder` makes each group contiguous (uses, then results)
  // and floats intervening events after it, so a tool_result is always FIRST in its user
  // message (openbsp's sortToolMessages rule); the emit builder handles role alternation.
  for (const e of weldOrder(trailing, weldedTurns)) {
    if (e.type === "summary") { // boundary may be -1 — the leading summary lands here
      place("user", {
        type: "text",
        text: `[checkpoint — earlier messages summarized]\n${textOf(e)}`,
      });
    } else if (e.type === "error") {
      place("user", { type: "text", text: `[harness] error: ${errorTextOf(e)}` });
    } else if (e.type === "thinking" && weldedTurns.has(e.turnId)) {
      place("assistant", thinkingBlock(e));
    } else if (e.type === "tool_use" && welded.has(e.id)) place("assistant", toolUseBlock(e));
    else if (e.type === "tool_result" && e.cause && welded.has(e.cause)) {
      place("user", toolResultBlock(e));
    } else if (e.type === "message") {
      // a directed send caused by a welded tool_use is already in the block — skip it
      if (e.cause && welded.has(e.cause)) continue;
      if (isSelf(e, session) && e.envelope.conversation.address === home) {
        place("assistant", { type: "text", text: textOf(e) }); // mid-chain assistant text
      } else if (e.envelope.conversation.address === home) {
        separate(e.ts);
        place("user", { type: "text", text: textOf(e) });
      } else {
        separate(e.ts);
        world(e);
      }
    }
    // thinking/uses of incomplete groups, orphan results, other types: skipped defensively
  }

  // the trailing anchor: `now:` + the volatile environment lines (cwd · git · bg jobs).
  // Kept as ONE block, last, so the whole prefix stays cache-stable (§5).
  const anchor = [`now: ${now}`, ...(ambient ?? [])].join("\n");
  place("user", sys(anchor));
  // the API rejects a user turn whose content is ONLY system blocks — if nothing else
  // landed in this turn, carry the anchor as plain text instead (valid content, same info)
  if (cur !== null) {
    const turn = cur as { role: Role; content: ContentBlockParam[] };
    if (turn.role === "user" && turn.content.every((b) => b.type === "mid_conv_system")) {
      turn.content = [{ type: "text", text: anchor }];
    }
  }
  flush();
  return out;
}

/**
 * Reorder the trailing chain so each welded group is contiguous at the position of its first
 * event — non-results in log order, then its results — and anything that interleaved (a world
 * message landing between a use and its result) floats to after the group.
 */
function weldOrder(trailing: Event[], weldedTurns: Set<string>): Event[] {
  const groups = new Map<string, Event[]>();
  const sequence: (Event | { group: string })[] = [];
  for (const e of trailing) {
    const turn = turnOf(e);
    if (turn !== undefined && weldedTurns.has(turn)) {
      let g = groups.get(turn);
      if (!g) {
        g = [];
        groups.set(turn, g);
        sequence.push({ group: turn }); // the group renders where it first appeared
      }
      g.push(e);
    } else {
      sequence.push(e);
    }
  }
  const out: Event[] = [];
  for (const item of sequence) {
    if ("group" in item) {
      const g = groups.get(item.group)!;
      out.push(...g.filter((e) => e.type !== "tool_result"));
      out.push(...g.filter((e) => e.type === "tool_result"));
    } else {
      out.push(item);
    }
  }
  return out;
}

/** The step a trailing event belongs to: `turnId` on tool/thinking events, `meta.turnId` on
 *  mu-emitted messages. Directed sends (cause→tool_use) stay outside — they're skipped anyway. */
function turnOf(e: Event): string | undefined {
  if (e.type === "thinking" || e.type === "tool_use" || e.type === "tool_result") return e.turnId;
  if (e.type === "message" && !e.cause && typeof e.meta?.turnId === "string") return e.meta.turnId;
  return undefined;
}

function findLastIndex(events: Event[], pred: (e: Event) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (pred(events[i])) return i;
  }
  return -1;
}

/** A world cluster → its `<conv>` element (§5). The attributes are the envelope
 *  facts the agent acts on: `id` is what `send` targets, `kind` is what tells a public
 *  channel from a DM. Untrusted strings (names, ids) are attribute-escaped. */
function conversationEl(
  c: { service: string; connection: string; conv: Conversation; lines: string[] },
): string {
  const attrs = [
    `service="${escAttr(c.service)}"`,
    `connection="${escAttr(c.connection)}"`,
    `address="${escAttr(c.conv.address)}"`,
    ...(c.conv.kind ? [`kind="${c.conv.kind}"`] : []),
    ...(c.conv.name ? [`name="${escAttr(c.conv.name)}"`] : []),
    ...(c.conv.thread ? [`thread="${escAttr(c.conv.thread)}"`] : []),
  ];
  return `<conv ${attrs.join(" ")}>\n${c.lines.join("\n")}\n</conv>`;
}

/** One world message line. `from="self"` = the agent's own send (its author label inside a
 *  user turn); `status="failed"` = the dispatcher gave up on delivery (§5). Body and
 *  sender name are attacker-controlled — escaped, so no message can close its own element
 *  or forge a mark. */
function msgLine(e: MessageEvent, session: SessionId): string {
  const from = isSelf(e, session)
    ? "self"
    : (e.envelope.sender?.name ?? e.envelope.sender?.address ?? "peer");
  const failed = e.envelope.status === "failed" ? ' status="failed"' : "";
  return `<msg from="${escAttr(from)}" at="${hhmm(e.ts)}"${failed}>${escText(textOf(e))}</msg>`;
}

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

/** The API accepts `mid_conv_system` only as the TRAILING block(s) of a turn — so this is
 *  reserved for the `now:` anchor (always the last block before the model answers). */
function sys(text: string): Anthropic.MidConversationSystemBlockParam {
  return { type: "mid_conv_system", content: [{ type: "text", text }] };
}

function thinkingBlock(e: ThinkingEvent): Anthropic.ThinkingBlockParam {
  const { thinking, signature } = e.parts[0].data;
  return { type: "thinking", thinking, signature };
}

function toolUseBlock(e: ToolUseEvent): Anthropic.ToolUseBlockParam {
  const { name, input } = e.parts[0].data;
  return { type: "tool_use", id: e.id, name, input };
}

function toolResultBlock(e: ToolResultEvent): Anthropic.ToolResultBlockParam {
  const { output, is_error } = e.parts[0].data;
  return {
    type: "tool_result",
    tool_use_id: e.cause ?? e.turnId, // `cause` = the specific tool_use this result answers
    content: typeof output === "string" ? output : JSON.stringify(output),
    ...(is_error ? { is_error: true } : {}),
  };
}

/** An `error` event's message — rendered as a system block so the model knows (§2). */
function errorTextOf(e: HarnessErrorEvent): string {
  return e.parts[0]?.data?.error ?? "unknown error";
}

function isSelf(e: Event, session: SessionId): boolean {
  return e.agent?.session_id === session;
}

function textOf(e: Event): string {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join(" ");
}

function hhmm(ts: string): string {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function dayOf(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function gapMinutes(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
