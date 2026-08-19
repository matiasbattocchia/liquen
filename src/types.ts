/**
 * types.ts — the domain vocabulary of the harness.
 *
 * Pure types, no logic. Everything here traces to DESIGN.md:
 *   §2 mu/nu/xi · §3 event schema · §4 identity · §5 render · §6 contexts · §9 tools.
 *
 * The spine: producers and handlers append `Event`s to the EventLog; `xi` turns each poke
 * into whatever the log owes; `mu` (the pure step) turns events into events. One long-running
 * `Session` per agent holds the principal-DM plus every peer conversation (§7).
 */

/* ───────────────────────────── primitives ───────────────────────────── */

/**
 * The log's spine: a sortable UUIDv7 minted by the STORE on insert (store/log.ts — Postgres
 * `DEFAULT uuidv7()`, and the same default in SQLite), so producers publish a `Draft` and
 * read the id back. Lexical order = append order (`ORDER BY id`, `after`/`before`, the tail
 * cursor). This is the *identity* job Slack's `ts` does — ours, since we own the merged log.
 * Distinct from `ts` below: `timeOf(id)` is *append* time; `ts` is *event* time.
 */
export type EventId = string;

/**
 * The event's real-world time: platform time inbound, append time internal. It orders the
 * WORLD — render re-sorts inbound messages by `ts` (§5), because a webhook lag or a backfill
 * can append 14:02 after 14:05. It does NOT order the log: storage and delivery order is
 * `id`, so the two never fight (§3).
 */
export type Timestamp = string;

export type AgentId = string;
export type SessionId = string;

/** JSON value — the payload type for data parts and tool io. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** A JSON Schema object — a tool's input contract. */
export type JsonSchema = { [key: string]: Json };

/* ─────────────────────────────── parts ──────────────────────────────── */
// The content model (open-bsp): text · file · data, each with a finer `kind`.
// `parts` is the uniform body of every event (§3).

export interface TextPart {
  type: "text";
  kind: "text" | "reaction";
  text: string;
}

/** File kinds (open-bsp MediaTypes): WhatsApp media + Instagram native/story types. */
export type MediaKind =
  | "audio"
  | "image"
  | "video"
  | "document"
  | "sticker"
  | "file" // Instagram native attachment (e.g. pdf)
  | "media" // Instagram generic media attachment
  | "story" // Instagram story (downloadable CDN url → modeled as a file)
  | "ig_story"
  | "story_mention"
  | "story_reply"; // synthetic: the story a user replied to

export interface FilePart {
  type: "file";
  kind: MediaKind;
  /** `uri` is a real URI: `file://` = local bytes (media shelf or workspace — the
   *  harness's canonical form; bare paths are tolerated on input), `http(s)://` =
   *  external link, passed through untouched — never downloaded or uploaded broker-side
   *  (connectors whose platform takes links send it as-is; the API reads it via a
   *  url-source block). `size` is unknowable for external uris. */
  file: { mime_type: string; uri: string; name?: string; size?: number };
  text?: string; // caption
}

/** Structured payload (tool io, permissions, alarms). `K` names the shape, `T` its data. */
export interface DataPart<K extends string = string, T = Json> {
  type: "data";
  kind: K;
  data: T;
  text?: string;
}

/**
 * Shared Instagram post/reel — a link card, not downloadable media: `url` is a
 * public instagram.com permalink (HTML page), so it's data, not a file (§4).
 */
export type SharePart = DataPart<"share", {
  type: "ig_post" | "ig_reel" | "reel";
  url: string;
  title?: string;
}>;

/** A reaction (open-bsp convention): the part an `action: add`/`remove` message adds to or
 *  removes from its referent. `name` is the platform's name (Slack `thumbsup`; WhatsApp
 *  the emoji itself), `unicode` the rendered glyph when the platform gives one. Whether it
 *  was added or removed is the EVENT's `payload.action`, not the part's business. */
export type ReactionPart = DataPart<"reaction", { name: string; unicode?: string }>;

export type Part = TextPart | FilePart | DataPart | SharePart;

/* ────────────────────────────── envelope ────────────────────────────── */
// WHICH CONVERSATION. Every event has a home — even internal ones (§3).

/** Known services; open set — new channels extend it. `local` = the harness's own channel. */
export type Service = "local" | "slack" | "whatsapp" | "instagram" | "email" | "teams" | "github";

/** Delivery bookkeeping — a mutable field, not events (§3). Render marks pending/failed only. */
export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

/** The delivery LIFECYCLE (§3): one mutable, `json_patch`-merged column beside the event —
 *  receipts and revocations move it, never new events. `state` is the furthest stage
 *  (`envelope.status` is its shorthand view); the stamps are scalars in a direct chat and
 *  per-participant maps in groups (`{reader: ts}` accumulates reader by reader). */
export interface Lifecycle {
  state?: DeliveryStatus;
  delivered_at?: string | Record<string, string>;
  read_at?: string | Record<string, string>;
  deleted_at?: string;
}

// Naming rule (§3): `address` = a WIRE address (what the platform calls the thing);
// `id` is reserved for store pkeys (event ids, future conversations-row ids).

export interface Conversation {
  address: string;
  name?: string;
  thread?: string;
  /** direct = member-defined identity (im AND mpim: the member set IS the address — our
   *  `dm:<sorted names>` makes that literal) · group = private room · channel = public
   *  room · broadcast = fan-out, not a room anyone is in (WA broadcast lists — open-bsp
   *  carries them in production). Stamped by ingest from platform facts (Slack types,
   *  WA jid shape) — never derived from counting members (§3). */
  kind?: "direct" | "group" | "channel" | "broadcast";
}

/** External identity on the wire. */
export interface Sender {
  address: string;
  name?: string;
}

export interface Envelope {
  service: Service;
  connection_address: string; // org account id / workspace
  conversation: Conversation;
  sender?: Sender; // external identity on the wire
  external_id?: string; // platform id, backfilled by the dispatcher on send (echo-dedup, §4)
  status?: DeliveryStatus;
}

/* ─────────────────── authorship · payload · extra (§3) ───────────────── */

/**
 * Internal authorship — presence, not equality (§3, §4):
 *
 *   `id`          which MIND-COMPLEX authored the event — the model *or its principal*
 *                 (the classifier stamps a principal's rows from their grant: the sender's
 *                 owned connection names the mind). It answers *whose*, never *which half*.
 *   `session_id`  entered THROUGH THE HARNESS: turn output, a repl line, an alias copy.
 *                 A principal typing into the live session carries it too — so it cannot
 *                 discriminate the halves. Absent on a principal's wire echo (phone in
 *                 hand). Deterministic in v0 (session ≈ agent), so it stamps at append.
 *
 * The half-discriminator is `payload.turn_id`: only rows PRODUCED BY a model turn carry
 * one. `render.ownVoice` is the predicate — it assigns the LLM role (§5), the xi verdict
 * (§2), and the render labels (self(you) vs self(principal)).
 */
export interface Authorship {
  id: AgentId;
  session_id?: SessionId;
}

/** What a message DOES to its referent's parts — absent = create. `edit` replaces them ·
 *  `add`/`remove` add or remove some (a reaction is a part somebody added to someone
 *  else's message) · `delete` removes them all · `reply`/`forward` are relational, not
 *  mutational. */
export type Action = "edit" | "add" | "remove" | "delete" | "reply" | "forward";

/**
 * What the event MEANS beside its parts (§3): the action, the reference, and the turn
 * machinery's keys. The reference rule: `ref_external_id` when the referent lives on a
 * wire (the platform id is the only stable name at ingest time), `ref_id` when both ends
 * are ours (the log id exists before the effect does — a reference always crosses an
 * invocation boundary, so the referent is stored by construction).
 */
export interface Payload {
  action?: Action;
  ref_external_id?: string;
  ref_id?: EventId;
  /** Groups one step's emissions (thinking · tool_use · the assistant message · the sends
   *  its tools dispatch): render's boundary rule (§5) and the tool barrier (§2) read it.
   *  Minted, not an event id. Presence is AUTHORSHIP's half-discriminator (§3): only rows
   *  a model turn produced carry one — a principal's rows never do, however stamped. */
  turn_id?: string;
  /** On the LAST event of a turn: the provider's stop reason verbatim. `pause_turn` and
   *  `max_tokens` are continuations, not endings — `decide` reads this to re-enter (§2). */
  stop_reason?: string;
  /** On a summary: the id range the checkpoint stands for (§5 compaction). */
  covers?: [EventId, EventId];
  /** On a tool_result: this outcome arrived AFTER its `tool_use` was already answered — a
   *  gated call the principal approved later (§9). It is the record of what the tool did,
   *  but it can never be a `tool_result` block: its pair is spent. Render narrates it in
   *  the harness's voice instead, and the weld skips it (§5). */
  deferred?: true;
  /** Wire mentions: canonical address + the display name the stored text uses for it
   *  (absent when the text fell back to the bare address). `type` is the sigil the text
   *  wears: `@` a person (the default when absent), `#` a conversation. Unordered —
   *  pair by name, not position. */
  mentions?: { address: string; name?: string; type?: "@" | "#" }[];
  /** Ingest-classified reserved word from the agent's principal (§3 classifier). */
  control?: ControlKind;
}

/** The event's SIDECAR (§3): auditable, droppable, `json_patch`-merged on echo-merge —
 *  the machine never branches on service keys. Known keys: `backfill` (imported history —
 *  wakes nothing, renders nowhere, §2), `consumed` (on the agent's home messages: the last
 *  event id the step's window read — the coalescing horizon `unanswered` measures against,
 *  §2), `via` (mirror provenance, §4), and per-service provenance under the service name —
 *  how the wire said it, not what the event means (`slack: {subtype, authorizations}`,
 *  `raw`). */
export type Extra = Record<string, unknown>;

/* ─────────────────────────────── events ─────────────────────────────── */
// The log is a flat, append-only stream of these (§3). `mu` emits exactly two —
// `message` (a self-targeted monologue) and `tool_use`; everything else is written
// by the world (producers) or the runtime (nu).

/** Known event types. Open set: an unknown type routes to `ignore` (xi safety default, §2). */
export type EventType =
  | "message"
  | "control"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "permission_request"
  | "permission_response"
  | "summary"
  | "alarm"
  | "error";

export interface EventBase {
  id: EventId;
  ts: Timestamp;
  type: EventType;
  envelope: Envelope;
  agent?: Authorship; // present iff a handler authored it
  payload?: Payload;
  extra?: Extra;
  status?: Lifecycle; // the mutable delivery column, exposed on read; drafts may seed it
}

/* payloads carried as a single data part */

export interface ToolCall {
  name: string;
  input: Json;
}

export interface ToolOutput {
  output: Json;
  is_error?: boolean;
  cancelled?: boolean;
}

export type PermissionBehavior = "allow" | "deny";
export type PermissionScope = "once" | "always";

export interface PermissionAsk {
  tool: string;
  /** The call as a person reads it, one line: `send(to: Vivian)` — the tool's own rendering
   *  (§9 `describeCall`). What the anchor lists a waiting ask under. */
  call: string;
  /** The same call in FULL — approving is judging what will actually be said or run, so the
   *  card carries the arguments themselves, not a preview of them. */
  detail: string;
}

export interface PermissionVerdict {
  behavior: PermissionBehavior;
  scope: PermissionScope;
  reason?: string; // on deny
}

/** ingest-classified reserved word from the agent's principal (§3 classifier). */
export type ControlKind = "stop" | "cancel";

/** World text, or the agent's own monologue/send. (`visibility` parked — returns with
 *  the subagent tree, §10; until then every message is simply a message.) */
export interface MessageEvent extends EventBase {
  type: "message";
  parts: Part[];
}

/** A principal reserved word reclassified at ingest → nu hard-stop (§2, §3). */
export interface ControlEvent extends EventBase {
  type: "control";
  parts: Part[];
  payload: Payload & { control: ControlKind };
}

/** mu's tool request. `turn_id` groups a parallel batch for the barrier (§2). */
export interface ToolUseEvent extends EventBase {
  type: "tool_use";
  payload: Payload & { turn_id: string };
  parts: [DataPart<"tool_use", ToolCall>];
}

/** nu's tool outcome — `ref_id` names the tool_use it answers, so parallel tools weld
 *  order-independently; the barrier completes when results === uses for a `turn_id` (§2).
 *  FileParts after the data part are the tool's ATTACHMENTS (§5 media — `aread` on an
 *  image): generic here; the TRANSPORT shapes them into provider blocks (Anthropic:
 *  image/document blocks inside the tool_result content) — switching providers touches
 *  render, never the log. */
export interface ToolResultEvent extends EventBase {
  type: "tool_result";
  payload: Payload & { turn_id: string; ref_id: EventId };
  parts: [DataPart<"tool_result", ToolOutput>, ...FilePart[]];
}

/**
 * mu's extended-thinking block — logged **with its signature** so the unrolled next step can
 * replay it verbatim, which the API requires within a tool cycle (§2, §5). `turn_id` ties it
 * to the assistant response it belongs to. Rendered inline in the live turn, dropped once the
 * turn closes; only the streaming *deltas* go to the Stream.
 */
export interface ThinkingEvent extends EventBase {
  type: "thinking";
  payload: Payload & { turn_id: string };
  parts: [DataPart<"thinking", { thinking: string; signature: string }>];
}

/** The harness asks an approver, from INSIDE the gated call (§2, §9) — `ref_id` = the
 *  tool_use, which is answered in the same breath with `pending_approval`, so asking never
 *  wedges the turn. Invisible to the model: what is still waiting reaches it through the
 *  anchor (§5), because a pending gate is state, not history. */
export interface PermissionRequestEvent extends EventBase {
  type: "permission_request";
  payload: Payload & { ref_id: EventId };
  parts: [DataPart<"permission_request", PermissionAsk>];
}

/** The approver's structured verdict — auto (nu) or human (ingest id-match) (§3).
 *  `ref_id` = the tool_use it settles (the star's center, not a chain: request and
 *  response both point at the use, one hop for the barrier query). */
export interface PermissionResponseEvent extends EventBase {
  type: "permission_response";
  payload: Payload & { ref_id: EventId };
  parts: [DataPart<"permission_response", PermissionVerdict>];
}

/** Ages out old messages; note-as-compaction already handles tool noise continuously (§5). */
export interface SummaryEvent extends EventBase {
  type: "summary";
  parts: TextPart[];
  payload: Payload & { covers: [EventId, EventId] };
}

/** A delayed, harness-delivered effect the agent scheduled — system-authored, so it wakes (§2). */
export interface AlarmEvent extends EventBase {
  type: "alarm";
  parts: [DataPart<"alarm", Json>];
}

/** Permanent mu failure — rendered `system` (model awareness) + Stream (operator) (§2). */
export interface ErrorEvent extends EventBase {
  type: "error";
  parts: [DataPart<"error", { error: string }>];
}

export type Event =
  | MessageEvent
  | ControlEvent
  | ToolUseEvent
  | ToolResultEvent
  | ThinkingEvent
  | PermissionRequestEvent
  | PermissionResponseEvent
  | SummaryEvent
  | AlarmEvent
  | ErrorEvent;

/**
 * An event as PRODUCERS build it: everything but the id. The id belongs to the STORE —
 * `id uuid DEFAULT uuidv7()` in Postgres, the same default in SQLite (store/log.ts binds
 * `uuidv7()`), so it's minted at INSERT and `publish` returns the authoritative event (§3).
 * An explicit id is still accepted, exactly as a Postgres INSERT naming the column is —
 * the store defaults it, it doesn't forbid it.
 */
export type Draft<E extends Event = Event> = E extends unknown ? Omit<E, "id"> & { id?: EventId }
  : never;

/** The agent's long-running unified session (§7). v0 = one per agent, cross-labeled. */
export interface Session {
  id: SessionId;
  agentId: AgentId;
}

/* ── xi — the consumer. Its verdict types live in xi.ts beside the table (§2). ── */

/* ─────────────────── tools — the whole surface is three (§9) ─────────── */

/** Anthropic-native tool declaration handed to mu. MCP domain tools take this shape too. */
export interface Tool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** `send(to?, parts)` — the only dispatch path, and the only tool nu gates (§9). */
export interface SendArgs {
  to?: { service: Service; connection: string; conversation: string }; // defaults to the trigger
  parts: Part[];
}
export interface SendResult {
  queued: boolean;
  event_id: EventId;
}

/** `search({...})` — raw message events, RLS-scoped; Slack-search semantics (§6). */
export interface SearchArgs {
  in?: string; // conversation
  from?: string; // sender
  before?: Timestamp;
  after?: Timestamp;
  text?: string;
}
export type SearchResult = MessageEvent[];

/** `bash(cmd)` — the sandbox's one primitive; everything exec-y is bash + a skill (§9). */
export interface BashArgs {
  cmd: string;
}
export interface BashResult {
  stdout: string;
  stderr: string;
  exit: number;
}

/* ─────────────────────── mu — the pure step (§2) ─────────────────────── */
// mu's concrete contract lives in `mu.ts` (it's the model boundary — it takes render's
// output and produces emissions). These are the SDK-free pieces it shares.

/** Telemetry → a usage table, NOT the log (§2). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Ephemeral broadcast — stream the in-progress; never stored. Correctness never depends on it. */
export interface Delta {
  kind: "text" | "thinking" | "tool" | "error";
  text?: string;
}
export type Emit = (delta: Delta) => void;

/* ── the cast (§2): mu = the step (mu.ts) · nu = the turn (nu.ts) · xi = the consumer
 *    that owns the log on both sides (xi.ts) · main = the process hosting one xi per
 *    principal. A rich principal interface is a connection process like any other (§9). ── */
