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
 *   (b) `renderMessages` — the volatile tail: the session's own room bare, the world
 *       grouped; no turns anywhere —
 *       the closed/trailing boundary and the API-faithful weld are DERIVED from the window's
 *       shape (§5 "Trailing vs closed"), never tracked by nu.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { INLINE_CAP, inlineable, isExternal, type MediaBlock, pathOf } from "./store/media.ts"; // pure helpers — no I/O
import { MIND, routedSession } from "./session.ts";
import type { DocEntry, DocKind, DocScope } from "./store/docs.ts";
import type {
  AlarmEvent,
  ControlEvent,
  Conversation,
  DataPart,
  Draft,
  Envelope,
  ErrorEvent as HarnessErrorEvent, // aliased: `ErrorEvent` is a DOM global in Deno's lib
  Event,
  EventId,
  FilePart,
  Json,
  MessageEvent,
  PermissionVerdict,
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

const KIND_ORDER: DocKind[] = ["instruction", "skill", "memory", "tool"];
const SCOPE_ORDER: DocScope[] = ["system", "organization", "agent", "conversation"];

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
}

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
    env.home && `home: ${env.home}`,
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
  const ordered = [...docs].sort(byCascade);
  const blocks: TextBlockParam[] = [];
  const add = (text: string) =>
    blocks.push({ type: "text", text: (blocks.length ? RULE : "") + text.trimEnd() });

  const bodies = ordered.filter((d) => d.body !== undefined);
  if (bodies.length > 0) add(bodies.map((d) => section(d, env.home)).join("\n\n"));

  const pointers = ordered.filter((d) => d.body === undefined);
  if (pointers.length > 0) add(`# On-demand docs\n\n${renderIndex(pointers, env.home)}`);

  // the facts close the prefix, under the words that spend them
  const body = envBody(env);
  if (body) add(`# Environment\n\n${body}`);

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

/** A doc's rendered handle: the way to it from the agent's home, which is where its
 *  shell stands — `instructions/agent.md` for its own, `../../system/instructions/base.md`
 *  for a scope above. One handle, and it is also the argument that opens the file: nothing
 *  to translate between what a doc is called and how it is read. The substrate path stands
 *  in when there is no home to count from (an env line without `home`). */
function ref(d: DocEntry, home?: string): string {
  return home ? from(home, d.header.path) : d.header.path;
}

/** The path to `to` as walked from `from` — the shell's own arithmetic, no dependency. */
function from(here: string, there: string): string {
  const a = here.split("/").filter(Boolean);
  const b = there.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** An inlined always-doc: a provenance header, then its body. */
function section(d: DocEntry, home?: string): string {
  return `[${ref(d, home)}]\n${d.body ?? ""}`;
}

/** The pull-index: one pointer line per lazy doc — its handle in the brackets an inlined
 *  doc wears, and its description when it has one. */
function renderIndex(pointers: DocEntry[], home?: string): string {
  const lines = pointers.map((d) => {
    const desc = d.header.frontmatter.description;
    const tail = typeof desc === "string" && desc.length > 0 ? ` ${desc}` : "";
    return `- [${ref(d, home)}]${tail}`;
  });
  return "The path is the doc's own, from your home; `aread` one to read it:\n\n" +
    lines.join("\n");
}

/* ─────────────────────── (b) the messages tail (§5) ─────────────────────── */

/** Raw bytes of media a single request may inline (base64 ≈ ×4/3; the API caps requests
 *  well above this) — the newest-first budget in `renderMessages`. */
const MEDIA_BUDGET = 12 * 1024 * 1024;

export interface RenderInput {
  events: Event[]; // the log window — render derives what's closed vs trailing itself
  docs: DocEntry[];
  session: Session; // whose output is whose, and which conversation is the session's own
  env?: Env; // the prefix's closing section — who the agent is, and the company it keeps
  now: string; // ISO — the `now:` anchor
  /** IANA timezone for every rendered stamp (`at=`, `now:`) — org config's `timezone`.
   *  Unset ⇒ the deployment's own zone. Stored `ts` is UTC either way (§3). */
  zone?: string;
  /** Volatile environment lines (cwd · git · background jobs) composed by xi from the exec
   *  plane — joined into the trailing anchor block (§5). Deployment-specific: empty on edge
   *  (no persistent exec env). */
  ambient?: string[];
  /** The bytes behind the attachments this render inlines, by uri — the blocks for the
   *  uris `wantedMedia` names, fetched by xi through the media port (§5). Only
   *  TRAILING-region messages inline: the model sees the picture while it's current, the
   *  kind marker (`<image/>`) once it's history (the tool-pair collapse pattern; the path
   *  is the durable re-viewable handle). A uri the table lacks keeps its marker. Absent ⇒
   *  markers only. */
  media?: ReadonlyMap<string, MediaBlock>;
  /** Who is one of us (§4, §5): the roster's word for each member, and who steers this
   *  session's agent. Absent ⇒ every member is named by their username and nobody is a
   *  principal but the agent itself. */
  roster?: Roster;
  /** The account behind each connection, by address: the name the service shows for it
   *  (`extra.name` on the connection row — an org account's pushname, a workspace's
   *  title). Rides `<conn name>`, so the string the wire stamps on the account's own lines
   *  reads as the account and never as a person in the room. Absent ⇒ the address alone. */
  connections?: Record<string, string>;
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
  return { system: renderSystem(input.docs, input.env), messages: renderMessages(input) };
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
 *  unprocessed INPUT, not history. Shared with compaction (never checkpoint these away). */
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
 *  principal's phone-sent lines are lines of their rooms, part of the run like any peer's.
 *  Rows that render nowhere no matter the region (gate cards, their verdicts, the `/y`
 *  line itself, a `/cancel`) are TRANSPARENT: the run flows across them. What ends a run is a rendered
 *  block of the machine's own chain — the agent's voice, a tool cycle, a turn boundary —
 *  so the order the API constrains and the weld depends on is never touched. Nor is
 *  history rewritten: a straggler that arrives after the agent already answered stays
 *  where it landed, because the answer breaks the run. */
function byEventTime(
  events: Event[],
  session: SessionRef,
  here: string,
): { events: Event[]; elisions: Elisions } {
  const out = [...events];
  const elisions: Elisions = { earlier: new Map(), rest: new Map() };
  const isCard = cardsIn(events);
  const member = (e: Event) => e.type === "message" && !ownVoice(e, session);
  const transparent = (e: Event) =>
    e.type === "permission_request" || e.type === "permission_response" ||
    (e.type === "control" && !isCancelled(e)) ||
    (e.type === "message" && !ownVoice(e, session) &&
      e.envelope.conversation.address === here && saidVerdict(e, isCard) !== undefined);
  for (let i = 0; i < out.length; i++) {
    if (!member(out[i])) continue;
    let j = i;
    while (j + 1 < out.length && (member(out[j + 1]) || transparent(out[j + 1]))) j++;
    while (!member(out[j])) j--; // a run ends on content, not on a card
    const seg = out.slice(i, j + 1);
    const pass = seg.filter((e) => !member(e));
    // stable sort ⇒ same-`ts` messages keep append order
    // the run IS one WUM (§5): sorted, grouped, then CAPPED — the burst does not get to
    // decide the prompt's size, and what the caps leave out is stated where it was cut.
    // The session's own room is exempt: the principal's line is the one input that must
    // never be redacted, whatever the world was doing around it.
    const run = capRun(byConversation(seg.filter(member).sort(byTs)), undefined, undefined, here);
    for (const [e, n] of run.elisions.earlier) elisions.earlier.set(e, n);
    for (const [e, r] of run.elisions.rest) elisions.rest.set(e, r);
    out.splice(i, seg.length, ...pass, ...run.kept);
    i = i + pass.length + run.kept.length - 1;
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
 *  that IS the conversation). `exempt` names one conversation both caps pass over — the
 *  session's own room, whose lines are the principal's and are never redacted. */
export function capRun(
  run: Event[],
  perConversation = WUM_PER_CONVERSATION,
  total = WUM_TOTAL,
  exempt?: string,
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
  const trimmed = [...groups.entries()].map(([key, g]) => ({
    exempt: key === exempt,
    kept: key === exempt ? g : g.slice(-perConversation),
    dropped: key === exempt ? 0 : Math.max(0, g.length - perConversation),
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
    if (g.exempt) {
      chosen.add(g); // outside the budget entirely — never dropped, never counted
      continue;
    }
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

  // the rest-marker anchors on the first surviving WORLD line — world() is what prints it,
  // and the exempt room's lines render outside any cluster
  const anchor = kept.find((e) => (e as MessageEvent).envelope.conversation.address !== exempt);
  if (dropped.length > 0 && anchor) {
    elisions.rest.set(anchor, {
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

/* ── the principal's steering vocabulary (§9) ─────────────────────────── */

const VERDICT = /^\/(y|n)\b(?:\s+(all|once|conv|conn|always)(?=\s|$))?\s*(.*)$/s;

const SCOPES = {
  once: "once",
  conv: "conversation",
  conn: "connection",
  always: "always",
} as const;

/** Parse a principal's line into a verdict, or nothing if it isn't one. Lives here because
 *  the two consumers are render (a verdict line is steering, never conversation — it draws
 *  no block) and xi (the gate it answers), and xi already imports render's predicates. */
export function parseVerdict(text: string): PermissionVerdict | undefined {
  const said = VERDICT.exec(text.trim());
  if (!said) return undefined;
  const reason = said[3].trim();
  const every = said[2] === "all";
  return {
    behavior: said[1] === "y" ? "allow" : "deny",
    scope: every || !said[2] ? "once" : SCOPES[said[2] as keyof typeof SCOPES],
    ...(reason ? { reason } : {}),
    ...(every ? { every: true } : {}),
  };
}

/** The verdict a REACTION spells (§9): a thumb or a heart on the card is `/y`, a thumb
 *  down or a gasp is `/n` — WhatsApp's quick-reaction bar, plus Slack's names for the same
 *  glyphs. Always `once`: a reaction has no words for a scope or a reason. */
const REACTIONS: Record<string, PermissionVerdict["behavior"]> = {
  "👍": "allow",
  "❤": "allow",
  "+1": "allow",
  "thumbsup": "allow",
  "heart": "allow",
  "👎": "deny",
  "😮": "deny",
  "-1": "deny",
  "thumbsdown": "deny",
  "open_mouth": "deny",
};

/** A glyph as the table keys it: no variation selector (`❤️` is `❤` + VS16), no skin tone
 *  (`👍🏻` is `👍` + a modifier) — the phone's spelling of the same reaction. */
export function reactionVerdict(glyph: string): PermissionVerdict | undefined {
  const bare = glyph.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
  const behavior = REACTIONS[bare];
  return behavior ? { behavior, scope: "once" } : undefined;
}

/** What a principal's row says as a verdict, if anything: a `/y` line, or a reaction ON A
 *  CARD from the table above. A reaction elsewhere (a thumb on the agent's own line) is
 *  conversation, not steering — `isCard` says what the row points at; an un-react says
 *  nothing. One predicate for the gate (xi) and for the window (a verdict draws no block). */
export function saidVerdict(
  e: Event,
  isCard: (ref: EventId | undefined) => boolean,
): PermissionVerdict | undefined {
  if (e.type !== "message") return undefined;
  const glyph = reactionOf(e);
  if (glyph === undefined) return parseVerdict(textOf(e));
  if (e.payload?.action === "remove" || !isCard(e.payload?.ref_id)) return undefined;
  return reactionVerdict(glyph);
}

/** The cards in a window, as the predicate `saidVerdict` asks for: is this ref one of them? */
export function cardsIn(events: Event[]): (ref: EventId | undefined) => boolean {
  const cards = new Set<EventId>();
  for (const e of events) if (e.type === "permission_request") cards.add(e.id);
  return (ref) => ref !== undefined && cards.has(ref);
}

/** The glyph a reaction carries, on either wire shape (data: open-bsp · text: legacy). */
function reactionOf(e: MessageEvent): string | undefined {
  const p = e.parts.find((p) => p.kind === "reaction");
  if (!p) return undefined;
  if (p.type === "data") {
    const d = p.data as { unicode?: string; name?: string } | null;
    return d?.unicode ?? d?.name ?? "";
  }
  return p.type === "text" ? p.text : "";
}
const byTs = (a: Event, b: Event) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;

/** The window's regions (§2 unrolled): render derives everything from the window's shape.
 *  Everything the boundary step CONSUMED is CLOSED (collapsed); after it — including
 *  horizon-deferred messages the step never saw — the TRAILING chain. `events` is the
 *  visible window in event-time order with its elisions; `boundary` indexes the closing
 *  step in it; `deferred` travels by identity. */
function regions(window: Event[], session: Session) {
  const me = session;
  const here = session.conversation; // the session's own room — everything else is world
  const visible = applySummary(window.filter((e) => !silenced(e)));
  // the horizon is a LOG position (§5): what the boundary step consumed is what its read
  // returned, in append order — so the unconsumed set is taken here, before event time
  // reorders the runs, and travels by identity
  const deferred = deferredInput(visible, me, closingBoundary(visible, session));
  const { events, elisions } = byEventTime(visible, me, here);
  const boundary = closingBoundary(events, session);
  const trailing = [...deferred, ...events.slice(boundary + 1)];
  return { deferred, events, elisions, boundary, trailing };
}

/** The request-level media budget (§5): which trailing attachments inline, NEWEST first — a
 *  burst of images can't stack base64 past the API's request cap; older ones keep their
 *  markers (the path is re-viewable). Sized on the KNOWN raw size: no bytes are read here.
 *  Pure — what xi asks the media port for, and what `render` inlines from the table it
 *  gets back. */
export function wantedMedia(window: Event[], session: Session): string[] {
  const wanted: string[] = [];
  let budget = MEDIA_BUDGET;
  for (const e of [...regions(window, session).trailing].reverse()) {
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

function renderMessages(
  { events: window, session, now, zone, ambient, media, roster, connections }: RenderInput,
): MessageParam[] {
  const me = session; // whose voice — the (agent, session) pair
  const who: Roster = roster ?? { names: {}, principals: [session.agentId] };
  const accounts = connections ?? {};
  const here = session.conversation; // the session's own room — everything else is world
  const isCard = cardsIn(window);
  const { deferred, events, elisions, boundary, trailing } = regions(window, session);
  // room names from the WHOLE window, silenced rows included — a name is a fact about the
  // room, and the row that carried it need not be one the model reads
  const names = roomNames(window);
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
      if (!inlineBudget.has(p.file.uri)) continue;
      const b = media?.get(p.file.uri);
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
    // a run is one conversation, one thread: a room's threads (a mailbox's subjects)
    // print each under its own `<conv thread="…">`
    if (
      !run || run.conv.address !== e.envelope.conversation.address ||
      (run.conv.thread ?? "") !== (e.envelope.conversation.thread ?? "")
    ) {
      run = { conv: namedRoom(e, names), lines: [] };
      cluster.convs.push(run);
      const earlier = elisions.earlier.get(e);
      if (earlier) run.lines.push(`… ${earlier} earlier, not shown`);
    }
    run.lines.push(msgLine(e, me, who, zone, { ref: refOf(e) }));
  };

  // No separators (§5). They went through `place()`, so every date break and gap marker
  // CLOSED the open cluster — one room came out as four `<conv>` elements the moment its
  // messages spanned any time at all. And they were measured in render order, which after
  // the per-conversation partition is not a timeline: a gap computed across two different
  // rooms said `— 680 min later —` about a message that had just arrived, while a jump
  // backwards printed nothing. Each `<msg>` now carries its own absolute stamp instead:
  // one fact per line, no cross-message state to get wrong, clusters intact.

  // Trailing weld sets — pairing is per *use* (a result's `ref_id` = its tool_use id), so
  // parallel tools weld order-independently and a half-filled barrier never leaves an
  // unpaired block for the API to reject. The trailing chain is welded API-faithfully.
  const useById = new Map(
    trailing.filter((e): e is ToolUseEvent => e.type === "tool_use").map((u) => [u.id, u]),
  );
  const usePresent = new Set(useById.keys());
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

  // the request-level media budget (`wantedMedia`): the table may hold more, the budget
  // decides what inlines
  const inlineBudget = new Set(wantedMedia(window, session));

  // CLOSED — collapse: messages survive; errors stay visible as system blocks (§2);
  // thinking and ALL tool traffic drop (§5) — pairs, and the deferred outcomes a gate
  // produced: once the turn that cared about them has closed, they are noise like the rest.
  for (const e of events.slice(0, boundary + 1)) {
    if (deferred.has(e)) continue; // unconsumed input — renders in the trailing region
    if (e.type === "summary") {
      place("user", { type: "text", text: checkpointEl(e) });
      continue;
    }
    if (e.type === "error") {
      place("user", { type: "text", text: systemEl("error", errorTextOf(e)) });
      continue;
    }
    if (isCancelled(e)) {
      place("user", { type: "text", text: systemEl("cancelled", textOf(e)) });
      continue;
    }
    if (e.type === "alarm") {
      place("user", { type: "text", text: alarmLine(e) });
      continue;
    }
    if (e.type !== "message") continue;
    if (silent(e)) continue; // said nothing — it closed the turn, it draws no block
    if (e.envelope.conversation.address === here) {
      if (isSelf(e, me)) {
        placeOwn(bodyOf(e, zone)); // bare: the agent's own voice
      } else if (saidVerdict(e, isCard) === undefined) {
        place("user", { type: "text", text: principalEl(e, who, zone) }); // a verdict line is
        // steering, not conversation — the gate consumed it, so it draws no block
      }
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

  // A step's anchor, where its request carried it (nu records it on the step): a thinking
  // block's signature binds everything the request held before it, so while a turn's
  // chain replays its thinking, every earlier step's anchor stands where that step read it.
  const anchors = new Map<string, string>();
  for (const e of trailing) {
    const turn = turnOf(e);
    const read = e.extra?.anchor;
    if (turn !== undefined && weldedTurns.has(turn) && typeof read === "string") {
      anchors.set(turn, read);
    }
  }
  const placeAnchor = (text: string) => {
    closeCluster();
    // the API takes `mid_conv_system` only after other content in a user turn; a turn that
    // would hold nothing else carries the anchor as plain text (same info)
    const turn = cur as { role: Role; content: ContentBlockParam[] } | null;
    if (turn?.role === "user" && turn.content.some((b) => b.type !== "mid_conv_system")) {
      turn.content.push(sys(text));
    } else emit("user", { type: "text", text });
  };

  // TRAILING — weld faithfully. `weldOrder` makes each group contiguous (uses, then results)
  // and floats intervening events after it, so a tool_result is always FIRST in its user
  // message (openbsp's sortToolMessages rule); the emit builder handles role alternation.
  for (const e of weldOrder(trailing, weldedTurns)) {
    const turn = turnOf(e);
    const read = turn === undefined ? undefined : anchors.get(turn);
    if (read !== undefined) {
      placeAnchor(read);
      anchors.delete(turn!);
    }
    if (e.type === "summary") { // boundary may be -1 — the leading summary lands here
      place("user", { type: "text", text: checkpointEl(e) });
    } else if (e.type === "error") {
      place("user", { type: "text", text: systemEl("error", errorTextOf(e)) });
    } else if (isCancelled(e)) {
      place("user", { type: "text", text: systemEl("cancelled", textOf(e)) }); // nothing failed: it was stopped
    } else if (e.type === "alarm") {
      place("user", { type: "text", text: alarmLine(e) });
    } else if (e.type === "thinking" && weldedTurns.has(e.payload.turn_id)) {
      place("assistant", thinkingBlock(e));
    } else if (e.type === "tool_use" && welded.has(e.id)) place("assistant", toolUseBlock(e));
    else if (e.type === "tool_result" && e.payload.deferred) {
      // the second half of a non-blocking gate (§9): the principal ruled, the harness ran
      // the call for us, and this is it reporting back — in its own voice, because the
      // tool_use it answers is spent. Narration, so it can stand alone in any position.
      place("user", { type: "text", text: systemEl("outcome", outcomeLine(e)) });
    } else if (e.type === "tool_result" && welded.has(e.payload.ref_id)) {
      place("user", toolResultBlock(e, useById.get(e.payload.ref_id)!, mediaBlocks(e)));
    } else if (e.type === "message") {
      // a directed send dispatched by a welded tool_use is already in the block — skip it
      if (e.payload?.ref_id && welded.has(e.payload.ref_id)) continue;
      if (silent(e)) continue; // said nothing — here too, so the last block stays the world's
      if (isSelf(e, me) && e.envelope.conversation.address === here) {
        placeOwn(bodyOf(e, zone)); // mid-chain assistant text
      } else if (e.envelope.conversation.address === here) {
        if (parseVerdict(textOf(e)) === undefined) {
          place("user", { type: "text", text: principalEl(e, who, zone) });
        }
      } else {
        world(e);
      }
      // TRAILING media (§5): after the marker, the picture itself — a real base64
      // image/document block in a user turn (which also closes any open cluster). The
      // agent's own attachments aren't re-shown; the closed region keeps markers only.
      if (!isSelf(e, me)) {
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

  // the trailing anchor: `now:` + the volatile environment lines (cwd · git · bg jobs),
  // ONE block after everything the prefix holds (§5)
  placeAnchor(anchorText(now, zone, ambient));
  flush();
  return out;
}

/** The anchor's text: `now:` and the live environment lines. nu records it on the step
 *  that read it, and render places it again from that record while the step is trailing. */
export function anchorText(now: string, zone?: string, ambient?: string[]): string {
  return [`now: ${nowStamp(now, zone)}`, ...(ambient ?? [])].join("\n");
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

/** A world cluster: one connection's run of traffic, each conversation's run within it. */
interface ConnectionCluster {
  service: string;
  address: string;
  name?: string;
  convs: { conv: Conversation; lines: string[] }[];
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
function conversationEl(c: { conv: Conversation; lines: string[] }): string {
  const attrs = [
    ...(c.conv.kind ? [`kind="${c.conv.kind}"`] : []),
    ...(c.conv.name ? [`name="${escAttr(c.conv.name)}"`] : []),
    `address="${escAttr(c.conv.address)}"`,
    ...(c.conv.thread ? [`thread="${escAttr(c.conv.thread)}"`] : []),
  ];
  return `<conv ${attrs.join(" ")}>\n${c.lines.join("\n")}\n</conv>`;
}

/** An account's address-book entries on a search page (§6): the account's own `<conn>`
 *  element — the same one its traffic wears — holding one `<contact>` per entry, name and
 *  the address `send(to:)` takes. `contact` is already the window's word for a saved
 *  sender (`authorOf`); here it is the entry itself. Untrusted strings attribute-escaped. */
export function bookEl(
  account: { service: string; address: string; name?: string },
  entries: { name: string; address: string }[],
): string {
  const attrs = [
    `service="${escAttr(account.service)}"`,
    ...(account.name ? [`name="${escAttr(account.name)}"`] : []),
    `address="${escAttr(account.address)}"`,
  ];
  const lines = entries.map((e) =>
    `<contact name="${escAttr(e.name)}" address="${escAttr(e.address)}"/>`
  );
  return `<conn ${attrs.join(" ")}>\n${lines.join("\n")}\n</conn>`;
}

/** A book that could not be asked, said in the harness's own voice — the account named
 *  the way the window's `connections:` line names it, so "not asked" never reads as
 *  "nobody by that name". */
export function unreachedLine(
  account: { service: string; address: string; name?: string },
): string {
  const name = account.name ? ` "${escText(account.name)}"` : "";
  return `— ${escText(account.service)} ${
    escText(account.address)
  }${name}: address book not reached —`;
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
}

export const GAP = "… lines between, not shown";

export function renderHits(
  hits: MessageEvent[],
  session: SessionRef,
  roster: Roster,
  zone?: string,
  connections: Record<string, string> = {},
  { match, adjacent }: HitsOpts = {},
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
    if (
      !run || run.conv.address !== e.envelope.conversation.address ||
      (run.conv.thread ?? "") !== (e.envelope.conversation.thread ?? "")
    ) {
      run = { conv: namedRoom(e, names), lines: [] };
      cluster.convs.push(run);
    } else if (adjacent && last && !adjacent(last, e)) run.lines.push(GAP);
    const mark = match?.has(e.id) ? "match" : undefined;
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
 *  `status="failed"` = the dispatcher gave up on delivery (§5).
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
 *  it (`sender.saved`), else the sender's own to choose — so it is the only one that also
 *  wears the address: the stable handle, and what `send` takes back. The key set is
 *  closed and every line wears exactly one, so an unclassified sender lands on `external`:
 *  unknown reads as untrusted, never as one of us. */
function authorOf(e: MessageEvent, session: SessionRef, roster: Roster): string {
  const id = e.agent?.id;
  if (id === undefined) {
    if (ownSide(e)) return " org";
    const sender = e.envelope.sender!; // not own side ⇒ the wire named someone
    const key = sender.saved && sender.name ? "contact" : "external";
    const name = sender.name ? ` ${key}="${escAttr(sender.name)}"` : " external";
    const address = sender.address ? ` address="${escAttr(sender.address)}"` : "";
    return `${name}${address}`;
  }
  const voice = e.payload?.turn_id !== undefined || isSelf(e, session);
  if (voice && id === session.agentId) return " self";
  const key = !voice && roster.principals.includes(id) ? "principal" : "agent";
  let value = roster.names[id] ?? id;
  if (e.envelope.service === "local") {
    const s = e.agent?.session_id ?? routedSession(e.envelope);
    value = s === MIND ? id : `${s}@${id}`;
  }
  return ` ${key}="${escAttr(value)}"`;
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
 *  line wears after its stamp — `match`, on a search hit shown among its context. */
interface LineOpts {
  ref?: Ref;
  dated?: boolean;
  mark?: string;
}

function msgLine(
  e: MessageEvent,
  session: SessionRef,
  roster: Roster,
  zone?: string,
  { ref = { attr: "" }, dated = false, mark }: LineOpts = {},
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
  if (action === "add" || action === "remove") {
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

  const failed = e.envelope.status === "failed" ? ' status="failed"' : "";
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
 *  the whole object rides a `data` attribute as a compact TS literal; the part's own `text`
 *  (genuinely human words, a caption) is the body, and no text means self-closing. `head`
 *  carries hoisted envelope attributes when the part IS the whole message, empty when it
 *  rides inline as a marker beside text. Every part shape makes `kind` mandatory (types.ts);
 *  a malformed row without one falls back to the part's `type`. */
function dataEl(p: DataPart, head: string, zone?: string): string {
  const tag = p.kind || p.type;
  const attrs = [
    ...(head ? [head] : []),
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
 *  stays text, and the element is render's own. */
function checkpointEl(e: SummaryEvent): string {
  return `<checkpoint>\n${escText(textOf(e))}\n</checkpoint>`;
}

/** The harness's own word to the model — an element, and its body escaped, so the tag is
 *  render's to write and nobody else's: a peer who types one into a message renders it as
 *  text, since every world body is escaped on the way in. `kind` says which word it is,
 *  so the four read apart without the sentence having to announce itself. */
function systemEl(kind: "error" | "cancelled" | "wake" | "outcome", text: string): string {
  return `<system kind="${kind}">${escText(text)}</system>`;
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
): Anthropic.ToolResultBlockParam {
  const { output, is_error } = e.parts[0].data;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    type: "tool_result",
    tool_use_id: wireId(use), // the specific tool_use this result answers, by ITS wire id
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

/** An `error` event's message — rendered as a `<system>` text block rather than a real
 *  `mid_conv_system` one: it PRECEDES what it marks, and the API takes `mid_conv_system`
 *  only in trailing position (§5, live-smoke finding). */
function errorTextOf(e: HarnessErrorEvent): string {
  return e.parts[0]?.data?.error ?? "unknown error";
}

/** A fired wake (§10), as the agent reads it: its own note handed back at the moment it
 *  asked for. `<system>` because the harness is the one speaking — the note is quoted, not
 *  ventriloquized as the principal. No room to name: an alarm fires in the session that
 *  armed it, which is the session reading it. */
function alarmLine(e: AlarmEvent): string {
  return systemEl("wake", e.parts[0]?.text ?? "");
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

/** The harness's word for a turn the principal cut short (§2). The row is unstamped and
 *  closes the turn: `decide` idles on it until something new arrives, and the model reads
 *  it as a `<system>` line — not an error, nothing failed. */
export const CANCELLED = "cancelled by your principal — the turn stopped here";

export function cancelled(envelope: Envelope): Draft<ControlEvent> {
  return {
    ts: new Date().toISOString(),
    type: "control",
    envelope,
    payload: { control: "cancelled" },
    parts: [{ type: "text", kind: "text", text: CANCELLED }],
  };
}

export function isCancelled(e: Event): boolean {
  return e.type === "control" && e.payload.control === "cancelled";
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

/** The principal's own line in the session's room (§5): a `<principal>` element, never
 *  bare text. Every voice in the user role wears a tag render writes and escapes — the
 *  world, the harness, the summary, the principal — so the model reads who is speaking off
 *  the element's shape, and bare text is the model's own voice alone. Composed like a
 *  world line (escaped text, then markers), stamped with the org clock. */
function principalEl(e: MessageEvent, roster: Roster, zone?: string): string {
  const body = [
    escText(textOf(e)),
    ...filesOf(e).map((p) => mediaMarker(p)),
    ...datasOf(e).map((p) => dataEl(p, "", zone)),
  ].filter((s) => s.length > 0).join("\n");
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
  return `<principal${name} at="${hhmm(e.ts, zone)}">${body}</principal>`;
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
// what the model is shown.
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
