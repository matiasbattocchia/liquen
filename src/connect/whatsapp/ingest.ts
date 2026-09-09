/**
 * connect/whatsapp/ingest.ts — the WhatsApp ingest: the OpenBSP-side of the whatsmeow BRIDGE.
 *
 * The bridge (open-bsp-whatsmeow, a Go sidecar wrapping whatsmeow) owns the wire — Signal
 * session, pairing, media crypto — and POSTs OpenBSP-shaped webhook batches at us. This
 * file is the `(Request) => Response` that satisfies the bridge's THREE inbound contracts
 * (openbsp.go):
 *
 *   POST …/whatsapp-web-webhook            — WebhookBatch: messages · statuses · contacts
 *                                            · groups · edits · revokes → map → publish
 *   POST …/whatsapp-web-webhook/media      — multipart bytes → media store → `{uri}`; the
 *                                            bridge then references that uri in a FilePart
 *                                            (media crosses BEFORE its message)
 *   POST …/whatsapp-web-management/sessions/events — connected | disconnected | logged_out
 *                                            → the connections map (the frontier event,
 *                                            §4; the state the anchor reports, §5)
 *
 * The entry adds a fourth route the bridge dials at the same address — `GET /m/<signed>`,
 * the outbound bytes the dispatch process minted a path for (`store/media.ts`). Inbound
 * media is PUSHED to us and outbound is PULLED from us, but both legs use this one door,
 * so the bridge is told where mu is exactly once (`OPENBSP_URL`) and mu is told nothing.
 *
 * Mapping (§3, §4): `external_id = whatsapp:<wmw-id>` — the bridge's own id
 * (`wmw.<own>.<chat>.<sender>.<id>`) already encodes direction and the group participant,
 * so retries, edits, revokes, receipts, and our own dispatched messages echoing back all
 * MERGE via the store's upsert. No author-based skip (§4): a bridge echo carries no
 * sender and explicit `status.sent` — it merges into the dispatched row; a phone-typed
 * message is the same shape on a NEW id and inserts as the account speaking (WA
 * coexistence is unattributable from the wire, §4).
 *
 * Ingest is a CLASSIFIER (§3): `conversation.kind` from the jid shape (`@g.us` → group,
 * `@broadcast` → broadcast, digits → direct); a sender resolves by point lookup of its
 * grant row on the connections map, else by the name the message carries. Names are
 * DENORMALIZED onto every row: the bridge stamps `sender_name`/`conversation_name` per
 * message (address book first — a directory mu has no table for), and the `contacts`/
 * `groups` feeds fill in for a bridge that doesn't. Either way a rename reaches rows from
 * the next message on, never retroactively (decided 2026-08-11).
 *
 * Edits are their OWN events (§3) — the original row stays sealed, the edit renders in a
 * later WUM; revokes are MERGE-ONLY drafts — no `parts` key, so `json_patch` leaves the stored
 * payload untouched and only `extra.whatsapp.revoked_at` lands: the log is append-only
 * and the content stays auditable (§3).
 */

import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Registry } from "../../store/agents.ts";
import { sameHandle } from "../../store/roster.ts";
import type {
  Conversation,
  DataPart,
  DeliveryStatus,
  Draft,
  FilePart,
  Lifecycle,
  MediaKind,
  MessageEvent,
  Part,
  Payload,
} from "../../types.ts";
import { findRoot, orgFlag } from "../../config.ts";

/* ── the bridge's wire shapes (openbsp.go is the source of truth — the bridge's own
 *    contract, not a platform API, so hand-rolled here is honest) ─────────────────── */

export interface WAContent {
  version?: string;
  type: "text" | "file" | "data";
  kind: string;
  text?: string;
  file?: { mime_type: string; uri: string; name?: string; size?: number };
  data?: unknown;
  re_message_id?: string;
  forwarded?: boolean;
  // addresses are canonical, and the inline "@digits" in `text` is in the SAME
  // namespace: the bridge owns wire-namespace translation both ways (a lid-addressed
  // group writes lids on the wire; we never see one)
  mentions?: { address?: string; agent_id?: string; name?: string }[];
}

export interface WAMessage {
  external_id: string;
  conversation_address: string;
  sender_address?: string; // if the wire knows it, it stamps it — newer bridges name their
  // own account too; absent/empty only where the platform can't name its own side
  /** WHO those addresses are, denormalized per message: the account's own name for the
   *  author (address book first, pushname otherwise) and for the room (a group's subject,
   *  or the peer, since a DM is its peer). Absent on the account's own messages, and on
   *  anyone nobody has ever named. This is where names come from — the batch feeds below
   *  are a first-sight courtesy, and a name only they carry is lost on restart. */
  sender_name?: string;
  conversation_name?: string;
  content: WAContent;
  status?: Record<string, unknown>; // explicit on echoes/history; absent on live inbound
  timestamp: string;
  /** The chat's state when this message arrived, from the phone-synced settings store
   *  (whatsmeow app state — the principal's own mute/archive). Stamped per message, the
   *  same denormalization as names: an unmute reaches rows from the next message on,
   *  never retroactively. Either mark SILENCES the row (§5) — it wakes nothing and
   *  renders nowhere; `search` is the door. */
  muted?: boolean;
  archived?: boolean;
}

export interface WABatch {
  organization_address: string;
  /** True on history-import batches (pairing backfill) — never on live traffic. */
  history?: boolean;
  messages?: WAMessage[];
  statuses?: {
    external_id: string;
    conversation_address: string;
    status: Record<string, unknown>;
  }[];
  contacts?: { address: string; extra?: { name?: string } }[];
  groups?: { address: string; name?: string }[];
  edits?: {
    external_id?: string; // the edit's OWN protocol-message id (newer bridges)
    original_message_id: string;
    conversation_address?: string;
    sender_address?: string;
    text: string;
    timestamp: string;
    muted?: boolean; // an edit is its own event, so it carries the chat state too —
    archived?: boolean; //   else an edit in a muted chat would wake what the chat can't
  }[];
  revokes?: {
    external_id?: string;
    original_message_id: string;
    conversation_address?: string;
    sender_address?: string;
    timestamp: string;
  }[];
}

export interface WASessionEvent {
  /** `connected` on every (re)connect of a paired number, `disconnected` when its socket
   *  drops (whatsmeow reconnects by itself; the pair brackets the outage), `logged_out`
   *  when the phone unpairs it. */
  event: "connected" | "disconnected" | "logged_out";
  organization_id: string;
  address: string;
  /** Set for a personal session: the member the pairing bound (bridge SessionMapping). */
  agent_id?: string;
  extra?: Record<string, unknown>;
}

/** The media seam (§5, §9): land decrypted bytes (the bridge already fetched and
 *  decrypted them) in the media store, scoped to the CONNECTION's shelf — at upload time
 *  the bridge doesn't say which conversation the file is for. Returns the `FilePart.file`
 *  shape whose `uri` goes back to the bridge. */
export type WAMedia = (
  bytes: Uint8Array,
  meta: { connection: string; name?: string; mime_type?: string },
) => Promise<FilePart["file"]>;

export interface WhatsAppWebhookDeps {
  /** → the EventLog (the connection's only write). A batch publishes as ONE transaction. */
  publish: Appender["publish"];
  /** The classifier + map-writer seam (§4): grant rows and the registry's declared handles
   *  resolve senders; session events write the connection row (the frontier gate publish
   *  checks). Absent ⇒ pure mapping. */
  store?: Pick<Connections, "connection" | "upsertConnections"> & Partial<Pick<Registry, "agents">>;
  /** The /media route's storage (absent ⇒ the route answers 501; messages still flow). */
  media?: WAMedia;
  /** Shared bearer token (the bridge's BRIDGE_TOKEN). Set ⇒ REQUIRED on every route. */
  bridgeToken?: string;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

export const SERVICE = "whatsapp" as const;

/** `whatsapp:` + the bridge's wmw id — the log-wide merge key (§4). Dispatch stamps the
 *  SAME prefix on its backfill, so the echo converges. */
export const externalId = (wmwId: string): string => `whatsapp:${wmwId}`;

/** Build the ingest handler. Pure over its deps — call once, serve anywhere. Group-name
 *  and pushname caches live in the closure: batch-fed, process-lifetime (denormalization
 *  is per-message; a restart re-learns them from traffic). */
export function createWhatsAppWebhook(deps: WhatsAppWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const groupNames = new Map<string, string>(); // conversation address → subject
  const pushnames = new Map<string, string>(); // sender address → display name

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    if (deps.bridgeToken) {
      if (req.headers.get("authorization") !== `Bearer ${deps.bridgeToken}`) {
        return text(401, "unauthorized");
      }
    }
    const path = new URL(req.url).pathname;

    if (path.endsWith("/media")) return media(req, deps);
    if (path.endsWith("/sessions/events")) return session(req, deps, now);

    let batch: WABatch;
    try {
      batch = await req.json() as WABatch;
    } catch {
      return text(400, "invalid json");
    }
    const connection = batch.organization_address;
    if (!connection) return text(400, "missing organization_address");

    // caches BEFORE messages: a first-sight group subject or pushname arrives in the same
    // batch as the message it should stamp
    for (const g of batch.groups ?? []) if (g.name) groupNames.set(g.address, g.name);
    for (const c of batch.contacts ?? []) {
      if (c.extra?.name) pushnames.set(c.address, c.extra.name);
    }

    const drafts: Draft<MessageEvent>[] = [
      ...(batch.messages ?? []).map((m) =>
        mapMessage(m, connection, groupNames, pushnames, now, batch.history === true)
      ),
      ...(batch.edits ?? []).map((e) => mapEdit(e, connection, now)),
      ...(batch.revokes ?? []).flatMap((r) => mapRevoke(r, connection, now)),
      ...(batch.statuses ?? []).map((s) => mapStatus(s, connection, now)),
    ].filter((d): d is Draft<MessageEvent> => d !== null);

    // the classifier (§3): a sender whose GRANT row names a mind, or whose number is a
    // member's declared handle (§4), is that member — stamp `agent.id` (whose complex
    // authored it; no session_id — a phone is not the harness). Presence-not-equality:
    // turn_id, never this stamp, marks the model's voice.
    if (deps.store) {
      const store = deps.store;
      const members = store.agents?.() ?? [];
      for (const d of drafts) {
        const s = d.envelope.sender?.address;
        if (!s || d.agent) continue;
        const owner = store.connection(SERVICE, s)?.agentId ??
          members.find((a) => sameHandle(a.phone, s))?.agentId;
        if (owner) d.agent = { id: owner };
      }
    }

    if (drafts.length) {
      try {
        await deps.publish(drafts); // one transaction: the whole batch lands, or none
      } catch (err) {
        return text(500, `publish failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return json(200, {});
  };
}

/* ── mapping: bridge shapes → mu drafts ──────────────────────────────────────────── */

type Store = NonNullable<WhatsAppWebhookDeps["store"]>;

/** The jid shape IS the platform fact (§3): group jids are `…@g.us`, broadcast lists
 *  `…@broadcast`, direct chats bare canonical digits. */
export function kindOf(address: string): NonNullable<Conversation["kind"]> {
  if (address.endsWith("@g.us")) return "group";
  if (address.endsWith("@broadcast")) return "broadcast";
  return "direct";
}

/** The bridge's file kinds are already mu's `MediaKind` vocabulary (both open-bsp's). */
const MEDIA = new Set<string>(["audio", "image", "video", "document", "sticker"]);

function partOf(c: WAContent): Part | null {
  switch (c.type) {
    case "text":
      return {
        type: "text",
        kind: c.kind === "reaction" ? "reaction" : "text",
        text: c.text ?? "",
      };
    case "file": {
      if (!c.file) return null;
      const kind = (MEDIA.has(c.kind) ? c.kind : "document") as MediaKind;
      return {
        type: "file",
        kind,
        file: {
          mime_type: c.file.mime_type,
          uri: c.file.uri, // already local: the bridge landed the bytes via /media first
          ...(c.file.name ? { name: c.file.name } : {}),
          ...(c.file.size !== undefined ? { size: c.file.size } : {}),
        },
        ...(c.text ? { text: c.text } : {}), // caption
      };
    }
    case "data":
      return { type: "data", kind: c.kind, data: (c.data ?? null) as DataPart["data"] };
    default:
      return null;
  }
}

/** What the message MEANS beyond its parts (§3 payload): the wire reference and the
 *  action. A quoted reply and a reaction both carry their target in `re_message_id`; the
 *  reaction's part names it a reaction, and openbsp's `data.action` (added/removed) is
 *  really the EVENT's action — lifted to `add`/`remove`, the data keeps {name, unicode}.
 *  With ref, action and mentions typed, the whatsapp sidecar has nothing left to say. */
function payloadOf(c: WAContent, part: Part): Payload | undefined {
  const p: Payload = {};
  if (c.re_message_id) p.ref_external_id = externalId(c.re_message_id);
  if (part.kind === "reaction") {
    // WhatsApp spells "un-react" as an empty reaction, so no glyph ⇒ remove — on both wire
    // shapes (data: openbsp, action rides data · text: legacy), whatever the label says
    const data = part.type === "data"
      ? part.data as { action?: string; name?: string; unicode?: string } | null
      : null;
    const bare = data !== null && !data.name && !data.unicode;
    const removed = data ? data.action === "removed" || bare : !(part as { text?: string }).text;
    p.action = removed ? "remove" : "add";
    if (data) delete data.action;
  } else if (p.ref_external_id) p.action = "reply";
  else if (c.forwarded) p.action = "forward";
  const mentioned = (c.mentions ?? [])
    .filter((m): m is { address: string; name?: string } => !!m.address)
    .map((m) => ({ address: m.address, ...(m.name ? { name: m.name } : {}) }));
  if (mentioned.length) p.mentions = mentioned;
  return Object.keys(p).length ? p : undefined;
}

/** Name the inline mention tokens (§3): the wire writes `@<digits>`, we read `@<display>`
 *  — batch pushname, else the mention's own name, else the digits, when nobody has named
 *  them yet. The exact mirror of outbound, where the agent writes `@Name` and the frontier
 *  encodes it back; identity is ours, wire namespace is the connector's. */
function nameMentionTokens(
  text: string,
  mentions: NonNullable<WAContent["mentions"]>,
  pushnames: Map<string, string>,
): string {
  let out = text;
  for (const m of mentions) {
    if (!m.address) continue;
    const display = pushnames.get(m.address) ?? m.name;
    if (display) out = out.replaceAll(`@${m.address}`, `@${display}`);
  }
  return out;
}

/** The delivery state a bridge status map amounts to: the FURTHEST stage present. The
 *  bridge's `sent` names what the dispatch stamp already said (`dispatched`) and moves
 *  nothing. */
function stateOf(status: Record<string, unknown>): DeliveryStatus | undefined {
  for (const key of ["failed", "read", "delivered"] as const) {
    if (status[key] !== undefined) return key;
  }
  return undefined;
}

function mapMessage(
  m: WAMessage,
  connection: string,
  groupNames: Map<string, string>,
  pushnames: Map<string, string>,
  now: () => string,
  backfill = false,
): Draft<MessageEvent> | null {
  const part = partOf(m.content);
  if (!part || !m.external_id || !m.conversation_address) return null;
  if (m.content.mentions?.length && part.type !== "data" && part.text) {
    part.text = nameMentionTokens(part.text, m.content.mentions, pushnames);
  }

  const address = m.conversation_address;
  // the message's own names first, the batch caches after: a per-message name is a fact
  // the row keeps forever, while a cache only knows whoever has spoken since this process
  // started — which is why a restart used to leave whole conversations anonymous
  const name = m.conversation_name || groupNames.get(address);
  const sender = m.sender_address || undefined; // "" = the wire couldn't name the account side
  // sender.name is the SERVICE's display fact — what the account calls this person, nothing
  // of ours: identity resolution (who a grant binds) is the classifier's business (§3)
  const who = m.sender_name || (sender ? pushnames.get(sender) : undefined);
  const state = m.status ? stateOf(m.status) : undefined;
  // the SERVICE-NEUTRAL silencing marks (§3 extra, §5): a consumer skipping history or a
  // muted chat reads the same keys across every connector
  const marks = {
    ...(backfill ? { backfill: true } : {}),
    ...(m.muted ? { muted: true } : {}),
    ...(m.archived ? { archived: true } : {}),
  };

  return {
    ts: m.timestamp || now(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: connection,
      conversation: {
        address,
        kind: kindOf(address),
        ...(name ? { name } : {}),
      },
      ...(sender ? { sender: { address: sender, ...(who ? { name: who } : {}) } } : {}),
      external_id: externalId(m.external_id),
      ...(state ? { status: state } : {}),
    },
    parts: [part],
    ...(payloadOf(m.content, part) ? { payload: payloadOf(m.content, part) } : {}),
    ...(Object.keys(marks).length ? { extra: marks } : {}),
  };
}

/** An edit is its OWN event (§3): `action: "edit"` + the original's wire id in
 *  `ref_external_id`, parts carrying the new content in the original's part types. The
 *  original row is never touched — sealed WUMs stay invariant, and the edit renders in a
 *  LATER one. Its identity is the edit's own protocol-message id; an older bridge that
 *  doesn't send one gets a deterministic synthetic id so retries still dedupe. */
function mapEdit(
  e: NonNullable<WABatch["edits"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent> | null {
  if (!e.original_message_id) return null;
  const ts = e.timestamp || now();
  const marks = { ...(e.muted ? { muted: true } : {}), ...(e.archived ? { archived: true } : {}) };
  return {
    ts,
    type: "message",
    payload: { action: "edit", ref_external_id: externalId(e.original_message_id) },
    ...(Object.keys(marks).length ? { extra: marks } : {}),
    envelope: {
      service: SERVICE,
      connection_address: connection,
      conversation: {
        address: e.conversation_address ?? "",
        ...(e.conversation_address ? { kind: kindOf(e.conversation_address) } : {}),
      },
      ...(e.sender_address ? { sender: { address: e.sender_address } } : {}),
      external_id: externalId(e.external_id ?? `edit.${e.original_message_id}.${ts}`),
    },
    parts: [{ type: "text", kind: "text", text: e.text }],
  };
}

/** MERGE-ONLY draft: no `parts` key at all, so the upsert's `json_patch` finds an empty
 *  payload and leaves the stored parts untouched (an array in a patch REPLACES; absence
 *  is the no-op). Out-of-order tolerant like open-bsp's soft references: a revoke or
 *  receipt for a message the log never saw inserts a stub the message later fills. */
function mergeOnly(
  connection: string,
  wmwId: string,
  ts: string,
  over: { extra?: Record<string, unknown>; status?: Lifecycle },
): Draft<MessageEvent> {
  return {
    ts,
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: connection,
      conversation: { address: "" },
      external_id: externalId(wmwId),
    },
    ...(over.status ? { status: over.status } : {}),
    ...(over.extra ? { extra: over.extra } : {}),
  } as unknown as Draft<MessageEvent>; // partless by design — see above
}

/** A revoke marks, never deletes — two drafts (§3): the delete EVENT (`action: "delete"`,
 *  empty parts, the original in ref_external_id — what a later WUM renders), and the
 *  merge-only `status.deleted_at` stamp on the original row (the lifecycle fact; the
 *  content itself survives, auditable). */
function mapRevoke(
  r: NonNullable<WABatch["revokes"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent>[] {
  if (!r.original_message_id) return [];
  const ts = r.timestamp || now();
  return [
    {
      ts,
      type: "message",
      payload: { action: "delete", ref_external_id: externalId(r.original_message_id) },
      envelope: {
        service: SERVICE,
        connection_address: connection,
        conversation: {
          address: r.conversation_address ?? "",
          ...(r.conversation_address ? { kind: kindOf(r.conversation_address) } : {}),
        },
        ...(r.sender_address ? { sender: { address: r.sender_address } } : {}),
        external_id: externalId(r.external_id ?? `del.${r.original_message_id}.${ts}`),
      },
      parts: [],
    },
    mergeOnly(connection, r.original_message_id, ts, {
      status: { state: "deleted", deleted_at: ts },
    }),
  ];
}

/** Delivery/read receipts → the row's `status` lifecycle (§3): `state` takes the furthest
 *  stage, and every stage present lands on its own stamp (`delivered_at`, `read_at`,
 *  `failed_at`) — scalars in a direct chat, and in groups per-participant maps that
 *  `json_patch` accumulates reader by reader. */
function mapStatus(
  s: NonNullable<WABatch["statuses"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent> | null {
  if (!s.external_id) return null;
  const st: Lifecycle = {};
  const state = stateOf(s.status);
  if (state) st.state = state;
  if (s.status.failed !== undefined) st.failed_at = String(s.status.failed);
  if (s.status.delivered !== undefined) {
    st.delivered_at = s.status.delivered as Lifecycle["delivered_at"];
  }
  if (s.status.read !== undefined) st.read_at = s.status.read as Lifecycle["read_at"];
  return mergeOnly(connection, s.external_id, now(), { status: st });
}

/* ── the /media route: multipart bytes → the media store → {uri} ─────────────────── */

async function media(req: Request, deps: WhatsAppWebhookDeps): Promise<Response> {
  if (!deps.media) return text(501, "no media store");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text(400, "invalid multipart form");
  }
  const file = form.get("file");
  const connection = form.get("organization_address");
  if (!(file instanceof File) || typeof connection !== "string" || !connection) {
    return text(400, "missing file or organization_address");
  }
  const name = typeof form.get("name") === "string" ? form.get("name") as string : file.name;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await deps.media(bytes, {
    connection,
    ...(name ? { name } : {}),
    ...(file.type ? { mime_type: file.type } : {}),
  });
  return json(200, { uri: stored.uri });
}

/* ── the sessions/events route: the bridge's lifecycle → the connections map (§4) ── */

function session(
  req: Request,
  deps: WhatsAppWebhookDeps,
  now: () => string,
): Promise<Response> {
  return req.json().then((e: WASessionEvent) => {
    if (!e.address || !e.event) return text(400, "missing address or event");
    // `connected` is the moment the paired number becomes KNOWN — the row it writes is
    // the frontier gate the very next publish checks (§4). The other events only record
    // state, stamped `<state>_at` — what the anchor reads to say a surface is down (§5):
    // the gate stays open (history stays readable), and a reconnect or re-pairing
    // revives by upsert.
    deps.store?.upsertConnections([{
      service: SERVICE,
      address: e.address,
      ...(e.agent_id ? { agentId: e.agent_id } : {}), // personal session ⇒ owned grant (§6)
      extra: {
        state: e.event,
        [`${e.event}_at`]: now(),
        organization_id: e.organization_id,
        ...(e.extra ?? {}),
      },
    }]);
    return json(200, {});
  }).catch(() => text(400, "invalid json"));
}

/* ── plumbing ────────────────────────────────────────────────────────────────────── */

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ── local entry: HTTP server the bridge's OPENBSP_URL points at ───────────────────
 *
 *   deno task run:whatsapp        # serves :8793; bridge env → OPENBSP_URL=http://localhost:8793
 *
 * Env: WA_BRIDGE_TOKEN (must equal the bridge's BRIDGE_TOKEN; required); the port is
 * connections.whatsapp.ingestPort. */
/** The bridge token the served ingest requires — unset is a refusal to bind: an open
 *  route would take any POST as the bridge's word. */
export function bridgeTokenOf(env: string | undefined): string {
  if (!env) {
    throw new Error("WA_BRIDGE_TOKEN unset — the ingest serves only the bridge that holds it");
  }
  return env;
}

/** Wire the inbound half over the org's log — resident once it returns (serving).
 *  Returns stop: refuse new deliveries, finish the ones in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { mediaSecret, saveMedia, serveMedia } = await import("../../store/media.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);

  const handler = createWhatsAppWebhook({
    publish: log.publish,
    store: log, // connections live on the Log (§4) — session events write the map
    media: (bytes, meta) =>
      saveMedia(dir, meta.connection, bytes, {
        ...(meta.mime_type ? { mime_type: meta.mime_type } : {}),
        ...(meta.name ? { name: meta.name } : {}),
      }),
    bridgeToken: bridgeTokenOf(Deno.env.get("WA_BRIDGE_TOKEN")),
  });
  const { whatsappConfig } = await import("./config.ts");
  const { serveIngest } = await import("../serve.ts");
  const port = (await whatsappConfig(root)).ingestPort;
  // One door in: the bridge's own address serves the outbound bytes too. `/m/<signed>` is
  // minted by the dispatch process and verified here from the vault's key — the signature
  // IS the authorization, so the route sits BEFORE the bridge-token check.
  const server = serveIngest(
    "connections.whatsapp.ingestPort",
    port,
    async (req) => await serveMedia(req, dir, () => mediaSecret(creds)) ?? await handler(req),
    (bound) => console.error(`[ingest] bridge on :${bound} → ${dir}/log`),
  );
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await runIngest();
