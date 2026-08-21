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
import { isExternal, pathOf } from "./store/media.ts"; // pure uri helpers — no I/O
import type { DocEntry, DocKind, DocScope } from "./store/docs.ts";
import type {
  Conversation,
  ErrorEvent as HarnessErrorEvent, // aliased: `ErrorEvent` is a DOM global in Deno's lib
  Event,
  EventId,
  FilePart,
  MessageEvent,
  ReactionPart,
  SessionId,
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

/** Raw bytes of media a single request may inline (base64 ≈ ×4/3; the API caps requests
 *  well above this) — the newest-first budget in `renderMessages`. */
const MEDIA_BUDGET = 12 * 1024 * 1024;

/** What the model can SEE inline (§5): images (not svg) and PDFs — same rule the loader
 *  enforces on bytes; render applies it to the KNOWN mime to budget without reading. */
const inlineable = (mime: string): boolean =>
  mime.startsWith("image/") && mime !== "image/svg+xml" || mime === "application/pdf";

export interface RenderInput {
  events: Event[]; // the log window — render derives what's closed vs trailing itself
  docs: DocEntry[];
  session: SessionId; // tells the agent's own output from the world
  home: string; // the principal-DM conversation id (home vs world)
  now: string; // ISO — the `now:` anchor
  /** IANA timezone for every rendered stamp (`at=`, `now:`) — org config's `timezone`.
   *  Unset ⇒ the deployment's own zone. Stored `ts` is UTC either way (§3). */
  zone?: string;
  /** Volatile environment lines (cwd · git · background jobs) composed by xi from the exec
   *  plane — joined into the trailing anchor block (§5). Deployment-specific: empty on edge
   *  (no persistent exec env). */
  ambient?: string[];
  /** Base64 payload for a stored media file (images/PDFs, size-capped) — xi injects
   *  `store/media.loadMediaBlock`. Only TRAILING-region messages resolve through it: the
   *  model sees the picture while it's current, the `<media/>` marker once it's history
   *  (§5 — the tool-pair collapse pattern; the path is the durable re-viewable handle).
   *  Absent ⇒ markers only. */
  loadMedia?: (uri: string) => { media_type: string; data: string } | null;
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
    events.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => u.payload.turn_id),
  );
  return findLastIndex(
    events,
    (e) =>
      e.type === "message" && isSelf(e, session) && e.envelope.conversation.address === home &&
      !(typeof e.payload?.turn_id === "string" && toolTurnIds.has(e.payload.turn_id)),
  );
}

/** Non-self messages positioned at or before `boundary` that the boundary step never
 *  CONSUMED (per its `extra.consumed` horizon) — the race window: a message landing between
 *  the window-read and the closing's publish sits before the closing in the log yet is
 *  unprocessed INPUT, not history. Shared with compaction (never checkpoint these away). */
export function deferredInput(
  events: Event[],
  session: SessionId,
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

/** Apply the latest `summary`: drop everything it covers (id ≤ covers[1] — superseded
 *  summaries fall in that range too) and MOVE the summary to the front — it stands for the
 *  oldest content; its log position is merely its publication time (§5). Exported for
 *  compaction: the weight that decides "checkpoint now?" must be the VISIBLE window's, or a
 *  raw window that stays heavy after a checkpoint would re-compact forever. */
export function applySummary(events: Event[]): Event[] {
  const latest = [...events].reverse().find((e) => e.type === "summary");
  if (!latest || latest.type !== "summary") return events;
  const toId = latest.payload.covers[1];
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
function byEventTime(events: Event[]): { events: Event[]; elisions: Elisions } {
  const out = [...events];
  const elisions: Elisions = { earlier: new Map(), rest: new Map() };
  const inbound = (e: Event) => e.type === "message" && !e.agent;
  for (let i = 0; i < out.length; i++) {
    if (!inbound(out[i])) continue;
    let j = i;
    while (j + 1 < out.length && inbound(out[j + 1])) j++;
    // stable sort ⇒ same-`ts` messages keep append order
    // the run IS one WUM (§5): sorted, grouped, then CAPPED — the burst does not get to
    // decide the prompt's size, and what the caps leave out is stated where it was cut
    const run = capRun(byConversation(out.slice(i, j + 1).sort(byTs)));
    for (const [e, n] of run.elisions.earlier) elisions.earlier.set(e, n);
    for (const [e, r] of run.elisions.rest) elisions.rest.set(e, r);
    out.splice(i, j - i + 1, ...run.kept);
    i = i + run.kept.length - 1;
  }
  return { events: out, elisions };
}

/* ── WUM caps (§5) ──────────────────────────────────────────────────────────────────
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
 * Two caps, in this order, because they fail differently:
 *   per conversation — one loud room cannot crowd out the other nine
 *   per WUM          — and ten rooms cannot crowd out the turn
 *
 * Both keep the MOST RECENT, which is what a burst means: the tail is the state. And both
 * are pure functions of the run, so a WUM the agent has already answered renders
 * byte-identically forever — the property the cached prefix is built on.
 */

/** Most recent messages kept per conversation inside one WUM. */
export const WUM_PER_CONVERSATION = 8;
/** Most recent messages kept per WUM, across all conversations. */
export const WUM_TOTAL = 50;

/** What a cap left out, addressed to the events that survived it. `earlier` hangs on the
 *  first kept message of a conversation ("what came before this one"); `rest` on the first
 *  kept message of the whole run ("conversations you are not seeing at all"). */
export interface Elisions {
  earlier: Map<Event, number>;
  rest: Map<Event, { conversations: number; messages: number }>;
}

/** Bound one run to the caps. `run` arrives ts-sorted and conversation-partitioned, so
 *  "most recent" is its tail — per group for the first cap, per group-recency for the
 *  second (whole conversations, never half a cluster: a room cut in the middle reads as if
 *  that IS the conversation). */
export function capRun(
  run: Event[],
  perConversation = WUM_PER_CONVERSATION,
  total = WUM_TOTAL,
): { kept: Event[]; elisions: Elisions } {
  const elisions: Elisions = { earlier: new Map(), rest: new Map() };
  if (run.length <= perConversation && run.length <= total) return { kept: run, elisions };

  const groups = new Map<string, Event[]>();
  for (const e of run) {
    const key = (e as MessageEvent).envelope.conversation.address;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(e);
  }

  // cap 1: the tail of each conversation
  const trimmed = [...groups.values()].map((g) => ({
    kept: g.slice(-perConversation),
    dropped: Math.max(0, g.length - perConversation),
  }));

  // cap 2: whole conversations, most recently active first — the budget buys the rooms
  // that just spoke. Ties keep arrival order (`groups` is insertion-ordered), so the
  // choice is total and stable.
  const byRecency = [...trimmed].sort((a, b) => {
    const at = a.kept.at(-1)!.ts, bt = b.kept.at(-1)!.ts;
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  const chosen = new Set<typeof trimmed[number]>();
  let budget = total;
  for (const g of byRecency) {
    if (g.kept.length > budget) continue; // a room that doesn't fit is left whole, not split
    chosen.add(g);
    budget -= g.kept.length;
  }
  // never render an EMPTY WUM: if the caps are set so that not even one conversation fits,
  // the newest one still gets through (trimmed to the total) — silence would read as "the
  // world said nothing", which is the one thing that is certainly false here
  if (chosen.size === 0 && byRecency.length > 0) {
    const first = byRecency[0];
    first.dropped += Math.max(0, first.kept.length - total);
    first.kept = first.kept.slice(-total);
    chosen.add(first);
  }

  const dropped = trimmed.filter((g) => !chosen.has(g));
  // re-emit in the run's own order, so the caps never reorder what survives them
  const kept = trimmed.filter((g) => chosen.has(g)).flatMap((g) => {
    if (g.dropped > 0) elisions.earlier.set(g.kept[0], g.dropped);
    return g.kept;
  });

  if (dropped.length > 0 && kept.length > 0) {
    elisions.rest.set(kept[0], {
      conversations: dropped.length,
      messages: dropped.reduce((n, g) => n + g.kept.length + g.dropped, 0),
    });
  }
  return { kept, elisions };
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
 * The one word the model can say to say NOTHING. A turn has to close with a home message —
 * that message is what ends the chain and carries the horizon (`extra.consumed`, §2) — so
 * until now the model had no way to look at the world and not speak: every idle digest
 * cost a "(nothing new)" paragraph, addressed to a principal who did not ask, and that
 * paragraph then sat in the window being re-read for days. Most of what an always-on agent
 * writes is that sentence.
 *
 * `SILENCE` is the answer that closes the turn without speaking. The event is logged
 * verbatim (the log stays honest about what the model said, and the horizon hangs off it
 * exactly as before), and everything downstream treats it as bodiless: the mirror carries
 * nothing to any surface, and render draws nothing — so tomorrow's window holds no record
 * of the times we had nothing to say.
 */
export const SILENCE = "<|SILENCE|>";

/** The model said nothing (`SILENCE`). NOT `silenced`: a silence note stays in the window
 *  READ — it is ours, it closes the turn, and the horizon is stamped on it. It is only the
 *  BODY that goes nowhere. */
export function silent(event: Event): boolean {
  return event.extra?.silence === true;
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
  { events: window, session, home, now, zone, ambient, loadMedia }: RenderInput,
): MessageParam[] {
  const { events, elisions } = byEventTime(applySummary(window.filter((e) => !silenced(e))));
  const out: MessageParam[] = [];

  // ref resolution (§5): the WHOLE window, silenced rows included — a delete or a reply often
  // lands long after its referent, and the referent being history doesn't unsay it. Only
  // the RENDERED events wear an `id` though, so `re` can point at a line the model can
  // actually read; a resolvable-but-unrendered referent is a reference to elsewhere (`?`).
  const byExternal = new Map<string, Event>();
  for (const e of window) {
    if (e.envelope.external_id) byExternal.set(e.envelope.external_id, e);
  }
  const rendered = new Set(events.map((e) => e.id));
  const refOf = (e: Event): Ref => {
    const id = e.payload?.ref_external_id;
    if (!id) return { attr: "" };
    const target = byExternal.get(id);
    const shown = target !== undefined && rendered.has(target.id);
    return { attr: ` re="${shown ? shortId(target.id) : "?"}"`, target, shown };
  };
  let cur: { role: Role; content: ContentBlockParam[] } | null = null;

  // a trailing message's inlineable attachments → real API blocks. Local bytes become
  // base64 (budget-gated below); external links become url-source blocks — the API
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
      if (!loadMedia || !inlineBudget.has(p.file.uri)) continue;
      const b = loadMedia(p.file.uri);
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

  /** Set a cache breakpoint on a block. It is metadata, not content: the cached prefix is
   *  the blocks themselves, so moving the mark forward never invalidates what it covered. */
  const mark = (b: ContentBlockParam | undefined, ttl?: "1h") => {
    if (b && b.type !== "mid_conv_system") {
      (b as { cache_control?: { type: "ephemeral"; ttl?: "1h" } }).cache_control = {
        type: "ephemeral",
        ...(ttl ? { ttl } : {}),
      };
    }
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
    if (cluster && cluster.conv.address !== e.envelope.conversation.address) closeCluster();
    if (!cluster) {
      cluster = {
        service: e.envelope.service,
        connection: e.envelope.connection_address,
        conv: e.envelope.conversation,
        lines: [],
      };
      const earlier = elisions.earlier.get(e);
      if (earlier) cluster.lines.push(`… ${earlier} earlier, not shown`);
    }
    cluster.lines.push(msgLine(e, session, zone, refOf(e)));
  };

  // No separators (§5). They went through `place()`, so every date break and gap marker
  // CLOSED the open cluster — one room came out as four `<conv>` elements the moment its
  // messages spanned any time at all. And they were measured in render order, which after
  // the per-conversation partition is not a timeline: a gap computed across two different
  // rooms said `— 680 min later —` about a message that had just arrived, while a jump
  // backwards printed nothing. Each `<msg>` now carries its own absolute stamp instead:
  // one fact per line, no cross-message state to get wrong, clusters intact.

  // No turns, no nu state (§2 unrolled): render derives everything from the window's shape.
  // Everything the boundary step CONSUMED is CLOSED (collapsed); after it — including
  // horizon-deferred messages the step never saw — the TRAILING chain, welded API-faithfully.
  const boundary = closingBoundary(events, session, home);
  const deferred = deferredInput(events, session, boundary);

  // Trailing weld sets — pairing is per *use* (a result's `ref_id` = its tool_use id), so
  // parallel tools weld order-independently and a half-filled barrier never leaves an
  // unpaired block for the API to reject.
  const trailing = [...deferred, ...events.slice(boundary + 1)];
  const usePresent = new Set(
    trailing.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => u.id),
  );
  // a DEFERRED outcome never welds (§9): its `tool_use` was answered long ago, with
  // `pending_approval`, so the pair is spent — a second `tool_result` block against the same
  // id is not a thing the API has. It renders as harness narration instead.
  const resultRefs = new Set(
    trailing.filter((e): e is ToolResultEvent => e.type === "tool_result" && !e.payload.deferred)
      .map((r) => r.payload.ref_id),
  );
  const welded = new Set([...usePresent].filter((id) => resultRefs.has(id)));
  const weldedTurns = new Set(
    trailing.filter((e): e is ToolUseEvent => e.type === "tool_use" && welded.has(e.id))
      .map((u) => u.payload.turn_id),
  );

  // The request-level media budget: which trailing attachments inline, NEWEST first — a
  // burst of images can't stack base64 past the API's request cap; older ones keep their
  // markers (the path is re-viewable, §5). Sized on the KNOWN raw size, no reads here.
  const inlineBudget = new Set<string>();
  {
    let budget = MEDIA_BUDGET;
    for (const e of [...trailing].reverse()) {
      // world/home attachments, and tool-result attachments (the model asked to see those)
      if (e.type !== "message" && e.type !== "tool_result") continue;
      if (e.type === "message" && isSelf(e, session)) continue;
      for (const p of filesOf(e)) {
        // local bytes only — external links inline as url-source blocks, budget-free
        if (isExternal(p.file.uri) || p.file.size === undefined) continue;
        if (!inlineable(p.file.mime_type) || p.file.size > budget) continue;
        budget -= p.file.size;
        inlineBudget.add(p.file.uri);
      }
    }
  }

  // CLOSED — collapse: messages survive; errors stay visible as system blocks (§2);
  // thinking and ALL tool traffic drop (§5) — pairs, and the deferred outcomes a gate
  // produced: once the turn that cared about them has closed, they are noise like the rest.
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
      place("user", { type: "text", text: `[system] error: ${errorTextOf(e)}` });
      continue;
    }
    if (e.type !== "message") continue;
    if (silent(e)) continue; // said nothing — it closed the turn, it draws no block
    if (e.envelope.conversation.address === home) {
      // home: the plain user/assistant chat every LLM API means (§5)
      place(isSelf(e, session) ? "assistant" : "user", { type: "text", text: bodyOf(e) });
    } else {
      world(e);
    }
  }

  // The cache breakpoint (§5): the closed region is the stable prefix — collapsed once and
  // then byte-identical on every later turn, since the boundary only ever moves FORWARD and
  // all volatility (now, cwd, jobs, inlined media) lives after it. Marking it makes the whole
  // history a cache READ (0.1x input) with only the turn's delta written, which is what the
  // tool loop needs: every tool round-trip re-sends this same prefix seconds apart.
  // The cluster must close here — a `<conv>` element spanning the boundary would absorb
  // trailing messages and rewrite the prefix's last block on every turn.
  // The hour TTL: this prefix survives as long as the window's anchor does (xi), which is
  // far longer than a five-minute idle gap — and it is the expensive block, so a hit that
  // spans the gaps between an agent's wakes is worth the 2x write.
  closeCluster();
  mark((cur as { content: ContentBlockParam[] } | null)?.content.at(-1), "1h");

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
      place("user", { type: "text", text: `[system] error: ${errorTextOf(e)}` });
    } else if (e.type === "thinking" && weldedTurns.has(e.payload.turn_id)) {
      place("assistant", thinkingBlock(e));
    } else if (e.type === "tool_use" && welded.has(e.id)) place("assistant", toolUseBlock(e));
    else if (e.type === "tool_result" && e.payload.deferred) {
      // the second half of a non-blocking gate (§9): the principal ruled, the harness ran
      // the call for us, and this is it reporting back — in its own voice, because the
      // tool_use it answers is spent. Narration, so it can stand alone in any position.
      place("user", { type: "text", text: `[system] ${outcomeLine(e)}` });
    } else if (e.type === "tool_result" && welded.has(e.payload.ref_id)) {
      place("user", toolResultBlock(e, mediaBlocks(e)));
    } else if (e.type === "message") {
      // a directed send dispatched by a welded tool_use is already in the block — skip it
      if (e.payload?.ref_id && welded.has(e.payload.ref_id)) continue;
      if (silent(e)) continue; // said nothing — here too, so the last block stays the world's
      if (isSelf(e, session) && e.envelope.conversation.address === home) {
        place("assistant", { type: "text", text: bodyOf(e) }); // mid-chain assistant text
      } else if (e.envelope.conversation.address === home) {
        place("user", { type: "text", text: bodyOf(e) });
      } else {
        world(e);
      }
      // TRAILING media (§5): after the marker, the picture itself — a real base64
      // image/document block in a user turn (which also closes any open cluster). The
      // agent's own attachments aren't re-shown; the closed region keeps markers only.
      if (!isSelf(e, session)) {
        const blocks = mediaBlocks(e);
        if (blocks.length) place("user", ...blocks);
      }
    }
    // thinking/uses of incomplete groups, orphan results, other types: skipped defensively
  }

  // The within-turn breakpoint: while a turn runs there is no closing yet, so its whole tool
  // chain is TRAILING — and it only ever grows (each request appends the last use/result
  // pair). Marking here lets the next round-trip read back everything it already paid for;
  // without it a 19-call turn re-sends its own accumulated tool output 19 times. Across
  // turns the chain collapses and this entry dies — the boundary mark above is the durable
  // one, and this one keeps the default five minutes, which outlives any tool chain. A miss
  // (a message landing mid-turn reorders the tail) costs only a normal write.
  closeCluster();
  mark((cur as { content: ContentBlockParam[] } | null)?.content.at(-1));

  // the trailing anchor: `now:` + the volatile environment lines (cwd · git · bg jobs).
  // Kept as ONE block, last, so the whole prefix stays cache-stable (§5).
  const anchor = [`now: ${nowStamp(now, zone)}`, ...(ambient ?? [])].join("\n");
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

/** The step a trailing event belongs to: `payload.turn_id`, on every emission that carries
 *  one. Directed sends (ref_id→tool_use) stay outside — they're skipped anyway. */
function turnOf(e: Event): string | undefined {
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

/** One world message line — two elements, the deviation marked (§3, §5): `<msg>` carries
 *  text (`action="edit"` = replacement content, `action="delete"` = the removed content),
 *  `<react>` carries the glyph (`action="remove"` = an un-react). Bare defaults: create and
 *  add wear no attribute. `from="self"` = the agent's own send (its author label inside a
 *  user turn); `status="failed"` = the dispatcher gave up on delivery (§5).
 *
 *  **References** (§5): every `<msg>` wears an `id` — the handle a reply, a reaction or a
 *  delete points back at with `re`, and the one `send` takes to author them. It is derived
 *  from the event id, so it names the same message in every render; `re="?"` = the referent
 *  is outside this window. Nothing can point at a `<react>`, so reactions spend no id.
 *
 *  Body and sender name are attacker-controlled — escaped, so no message can close its own
 *  element or forge a mark. */
function msgLine(
  e: MessageEvent,
  session: SessionId,
  zone?: string,
  ref: Ref = { attr: "" },
): string {
  const re = ref.attr;
  // `self` for both hands, because on the wire there IS only one: the account — the halves
  // are told apart by AUTHORSHIP (§3): turn_id ⇒ the model's voice; the classifier's
  // `agent.id` stamp without one ⇒ the principal (their grant named the mind, whichever
  // device they typed on). A DIFFERENT agent.id is a peer agent's voice (team chat). The
  // sender-less fallback keeps pre-classifier coexistence rows labelled: no sender means
  // the account spoke and it did not come through us — the principal, on their own phone.
  const from = isSelf(e, session)
    ? "self (you)"
    : ownComplex(e, session)
    ? "self (principal)"
    : e.agent !== undefined
    ? e.agent.id
    : e.envelope.sender === undefined
    ? "self (principal)"
    : (e.envelope.sender.name ?? e.envelope.sender.address ?? "peer");
  const head = `id="${shortId(e.id)}" from="${escAttr(from)}" at="${hhmm(e.ts, zone)}"`;

  const action = e.payload?.action;
  if (action === "edit") {
    return `<msg ${head}${re} action="edit">${escText(textOf(e))}</msg>`;
  }
  if (action === "delete") {
    // the removed content, spelled out only when the original is NOT a line the model can
    // read: `re` already points there when it is, and a delete says nothing twice
    const body = ref.target && !ref.shown ? escText(textOf(ref.target)) : "";
    return `<msg ${head}${re} action="delete">${body}</msg>`;
  }
  if (action === "add" || action === "remove") {
    const r = e.parts.find((p): p is ReactionPart => p.type === "data" && p.kind === "reaction");
    // `?? ""`: a glyphless reaction (a removal) renders empty — one malformed event must
    // never kill the window render
    const glyph = r ? (r.data.unicode ?? r.data.name ?? "") : textOf(e);
    const removed = action === "remove" ? ' action="remove"' : "";
    // no `id`: a reaction is a leaf — nothing in the vocabulary can point back at one
    const react = `from="${escAttr(from)}" at="${hhmm(e.ts, zone)}"`;
    return `<react ${react}${re}${removed}>${escText(glyph)}</react>`;
  }

  const failed = e.envelope.status === "failed" ? ' status="failed"' : "";
  // canonical addresses (the text wears the display form) — `#` keeps its sigil,
  // a person's address rides bare
  const mentions = e.payload?.mentions?.length
    ? ` mentions="${
      escAttr(
        e.payload.mentions.map((m) => m.type === "#" ? `#${m.address}` : m.address).join(" "),
      )
    }"`
    : "";
  // body text is escaped (untrusted); the media markers are render's own, appended after
  const body = [escText(textOf(e)), ...filesOf(e).map(mediaMarker)]
    .filter((s) => s.length > 0).join(" ");
  return `<msg ${head}${re}${failed}${mentions}>${body}</msg>`;
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

/** `media` = the result's rendered attachments (§5) — image/document blocks INSIDE the
 *  tool_result content (the API allows text · image · document · search_result there),
 *  so an `aread` on a picture answers with the picture. Empty ⇒ plain string content. */
function toolResultBlock(
  e: ToolResultEvent,
  media: ContentBlockParam[],
): Anthropic.ToolResultBlockParam {
  const { output, is_error } = e.parts[0].data;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    type: "tool_result",
    tool_use_id: e.payload.ref_id, // the specific tool_use this result answers — REQUIRED:
    // the old `?? turnId` fallback emitted an id matching no tool_use block (a certain 400)
    content: media.length
      ? [{ type: "text", text }, ...media as Anthropic.ImageBlockParam[]]
      : text,
    ...(is_error ? { is_error: true } : {}),
  };
}

/** A DEFERRED tool outcome as one sentence (§9): `send(to: Vivian) → sent`. The call was
 *  rendered when the outcome was written — xi is where the tool registry and the address
 *  book are — so this reads it off the event rather than re-deriving it from a `tool_use`
 *  that may already have collapsed. `→` carries what happened, `—` what didn't. Shared with
 *  the mirror, so the model and the principal are told the same thing. */
export function outcomeLine(e: ToolResultEvent, max = 0): string {
  const { output, is_error } = e.parts[0].data;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const bounded = max > 0 && text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `${e.parts[0].text ?? "the approved call"} ${is_error ? "—" : "→"} ${bounded}`;
}

/** An `error` event's message — rendered as a plain `[system] error:` text block: it
 *  PRECEDES what it marks, and the API takes `mid_conv_system` only in trailing position
 *  (§5, live-smoke finding). */
function errorTextOf(e: HarnessErrorEvent): string {
  return e.parts[0]?.data?.error ?? "unknown error";
}

/** OUR SIDE produced this row (§3 authorship — presence, not equality): the model's turn
 *  output (`payload.turn_id`), or a mirror CC replaying mind content outward
 *  (`extra.via.service === "local"`). A principal's rows carry `agent.id` — and, typed
 *  through the harness, `session_id` — yet never a turn_id: they are input, not voice.
 *  THE predicate for the LLM role here, the xi verdict (§2), and the self labels; v0
 *  session ≈ agent, so `session` matches `agent.id` (§7). */
export function ownVoice(e: Event, session: SessionId): boolean {
  if (!ownComplex(e, session)) return false;
  if (e.payload?.turn_id !== undefined) return true;
  const via = e.extra?.via;
  return typeof via === "object" && via !== null &&
    (via as { service?: string }).service === "local";
}

/** OUR COMPLEX authored it — either half. Matched on `session_id` when stamped (harness
 *  rows), else `agent.id` (the classifier's echo stamp carries no session — and v0
 *  session ≈ agent, §7, so the id answers the same question). */
export function ownComplex(e: Event, session: SessionId): boolean {
  return e.agent !== undefined && (e.agent.session_id ?? e.agent.id) === session;
}

function isSelf(e: Event, session: SessionId): boolean {
  return ownVoice(e, session);
}

/** Every part's `text`, not only a TextPart's — a caption rides `FilePart.text`. Filtering
 *  on `type === "text"` meant the model never saw a single caption: the picture arrived as
 *  a bare `<media/>` marker and the words that came with it were dropped on the floor. */
export function textOf(e: Event): string {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.map((p) => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join(" ");
}

function filesOf(e: Event): FilePart[] {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p): p is FilePart => p.type === "file");
}

/** A file part's `<media/>` marker (§5) — the durable face of an attachment in every
 *  region: kind + name + the handle. Local uris show the PLAIN path (what `aread`/bash
 *  take); external links show the url itself. Untrusted strings (a wire filename) are
 *  attribute-escaped like everything else. */
function mediaMarker(p: FilePart): string {
  const name = p.file.name ? ` name="${escAttr(p.file.name)}"` : "";
  const handle = isExternal(p.file.uri) ? p.file.uri : pathOf(p.file.uri);
  return `<media kind="${p.kind}"${name} path="${escAttr(handle)}"/>`;
}

/** A message's body for HOME rendering (plain text turns): text, then one marker per
 *  attachment. World lines compose the same pieces inside `msgLine` (escaped there). */
function bodyOf(e: Event): string {
  return [textOf(e), ...filesOf(e).map(mediaMarker)].filter((s) => s.length > 0).join("\n");
}

/* ── clocks (§5) ────────────────────────────────────────────────────────────────────
 *
 * Stored `ts` is UTC — ONE clock in the column (store/log.ts normalizes on insert), which
 * is what makes lexical `byTs` real time across services. Render is where wall-clock
 * returns: `zone` (IANA, org config's `timezone`) formats every stamp in the org's local
 * time, so `at=` reads as the hour the humans experienced; unset ⇒ the deployment's own
 * zone. `Intl` does the zone math — no timezone database of our own.
 */
// English until there is an i18n seam: the `locale` slot already sits beside `timezone`
// in org config; these constants are what it will replace.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

interface Clock {
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
function clockOf(ts: string, zone?: string): Clock | null {
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
export function hhmm(ts: string, zone?: string): string {
  const c = clockOf(ts, zone);
  if (!c) return ts;
  return `${c.day} ${MONTHS[c.month]} ${c.hour}:${pad(c.minute)}`;
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
