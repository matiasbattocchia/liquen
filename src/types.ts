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
// The content model (open-bsp): text · file · data, each with a finer `kind`, and
// optional nested `artifacts` (e.g. a voice note carrying its transcription).
// `parts` is the uniform body of every event (§3).

export interface TextPart {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
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
  artifacts?: Part[];
}

/** Structured payload (tool io, permissions, alarms). `K` names the shape, `T` its data. */
export interface DataPart<K extends string = string, T = Json> {
  type: "data";
  kind: K;
  data: T;
  text?: string;
  artifacts?: Part[];
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

export type Part = TextPart | FilePart | DataPart | SharePart;

/* ────────────────────────────── envelope ────────────────────────────── */
// WHICH CONVERSATION. Every event has a home — even internal ones (§3).

/** Known services; open set — new channels extend it. `local` = the harness's own channel. */
export type Service = "local" | "slack" | "whatsapp" | "instagram" | "email" | "teams" | "github";

/** Delivery bookkeeping — a mutable field, not events (§3). Render marks pending/failed only. */
export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

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

/* ─────────────────── authorship · meta (§3) ──────────────────────────── */

/**
 * Internal authorship — present iff a handler (mu/nu) authored the event.
 * `session_id === this session` is THE bit: it assigns the LLM role (§5) *and* the
 * xi verdict (§2). One bit, two derivations.
 */
export interface Authorship {
  id: AgentId;
  session_id: SessionId;
}

/** HARNESS correlation sidecar (§3): keys the turn machinery mints and reads — never
 *  wire-derived (that's `extra`). Known keys documented, open for growth. */
export interface Meta {
  turnId?: string; // on mu-emitted messages: the step that produced it (render's boundary rule, §5)
  /** On the LAST event of a turn: how that turn ended (`Anthropic.StopReason`). `pause_turn`
   *  and `max_tokens` are continuations, not endings — `decide` reads this to re-enter (§2). */
  stop?: string;
  /** On the agent's home messages: the last event id in the window its step consumed — the
   *  coalescing horizon. `unanswered` compares against THIS, not log position: a message
   *  landing between the window-read and the closing's publish must still count as owed. */
  consumed?: EventId;
  [key: string]: unknown;
}

/** WIRE-derived sidecar (§3): what the frontier yielded beyond the envelope — auditable,
 *  droppable, shallow-merged on echo-merge. Known keys: `raw` (original wire text, so a
 *  misclassification stays reversible), `via` (alias original wire envelope, §4), `edits`
 *  (edit history), `inferred_sender` (soft attribution), per-service provenance under the
 *  service name (`slack: {subtype, authorizations}`). */
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
  cause?: EventId; // provenance (openhands-style)
  agent?: Authorship; // present iff a handler authored it
  meta?: Meta;
  extra?: Extra;
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
  args_preview: string;
  request_id: string;
}

export interface PermissionVerdict {
  behavior: PermissionBehavior;
  scope: PermissionScope;
  reason?: string; // on deny
  request_id: string;
}

/** ingest-classified reserved word from the agent's principal (§3 classifier). */
export type ControlKind = "stop" | "cancel";

/** World text, or the agent's own monologue/send. (`visibility` parked — returns with
 *  the subagent tree, §10; until then every message is simply a message.) */
export interface MessageEvent extends EventBase {
  type: "message";
  parts: Part[];
  re?: EventId;
}

/** A principal reserved word reclassified at ingest → nu hard-stop (§2, §3). */
export interface ControlEvent extends EventBase {
  type: "control";
  parts: Part[];
  meta: Meta & { control: ControlKind };
}

/** mu's tool request. `turnId` groups a parallel batch for the barrier (§2). */
export interface ToolUseEvent extends EventBase {
  type: "tool_use";
  turnId: string;
  parts: [DataPart<"tool_use", ToolCall>];
}

/** nu's tool outcome. The barrier completes when results === uses for a `turnId` (§2).
 *  FileParts after the data part are the tool's ATTACHMENTS (§5 media — `aread` on an
 *  image): generic here; the TRANSPORT shapes them into provider blocks (Anthropic:
 *  image/document blocks inside the tool_result content) — switching providers touches
 *  render, never the log. */
export interface ToolResultEvent extends EventBase {
  type: "tool_result";
  turnId: string;
  parts: [DataPart<"tool_result", ToolOutput>, ...FilePart[]];
}

/**
 * mu's extended-thinking block — logged **with its signature** so the unrolled next step can
 * replay it verbatim, which the API requires within a tool cycle (§2, §5). `turnId` ties it
 * to the assistant response it belongs to. Rendered inline in the live turn, dropped once the
 * turn closes; only the streaming *deltas* go to the Stream.
 */
export interface ThinkingEvent extends EventBase {
  type: "thinking";
  turnId: string;
  parts: [DataPart<"thinking", { thinking: string; signature: string }>];
}

/** nu asks an approver before running a gated tool (§2, §9). n/a to the model. */
export interface PermissionRequestEvent extends EventBase {
  type: "permission_request";
  parts: [DataPart<"permission_request", PermissionAsk>];
}

/** The approver's structured verdict — auto (nu) or human (ingest id-match) (§3). */
export interface PermissionResponseEvent extends EventBase {
  type: "permission_response";
  parts: [DataPart<"permission_response", PermissionVerdict>];
}

/** Ages out old messages; note-as-compaction already handles tool noise continuously (§5). */
export interface SummaryEvent extends EventBase {
  type: "summary";
  parts: TextPart[];
  meta: Meta & { covers: [EventId, EventId] };
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
