/**
 * connect/whatsapp.ts — the WhatsApp ingest: the OpenBSP-side of the whatsmeow BRIDGE.
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
 *   POST …/whatsapp-web-management/sessions/events — connected | logged_out → the
 *                                            connections map (the frontier event, §4)
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
 * grant row on the connections map, else by pushname. Group subjects and pushnames are
 * DENORMALIZED onto messages from batch-fed caches — a rename reaches rows from the next
 * message on, never retroactively (decided 2026-08-11).
 *
 * Edits REPLACE parts on the original row (same policy as Slack's `message_changed`);
 * revokes are MERGE-ONLY drafts — no `parts` key, so `json_patch` leaves the stored
 * payload untouched and only `extra.whatsapp.revoked_at` lands: the log is append-only
 * and the content stays auditable (§3).
 */

import type { Appender } from "../store/log.ts";
import type { Connections } from "../store/connections.ts";
import type {
  Conversation,
  DataPart,
  DeliveryStatus,
  Draft,
  FilePart,
  MediaKind,
  MessageEvent,
  Part,
} from "../types.ts";

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
  mentions?: { address?: string; agent_id?: string; name?: string }[];
}

export interface WAMessage {
  external_id: string;
  conversation_address: string;
  sender_address?: string; // absent/empty = the account itself spoke (echo, history)
  content: WAContent;
  status?: Record<string, unknown>; // explicit on echoes/history; absent on live inbound
  timestamp: string;
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
  edits?: { original_message_id: string; text: string; timestamp: string }[];
  revokes?: { original_message_id: string; timestamp: string }[];
}

export interface WASessionEvent {
  event: "connected" | "logged_out";
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
  /** The classifier + map-writer seam (§4): grant rows resolve senders; session events
   *  write the connection row (the frontier gate publish checks). Absent ⇒ pure mapping. */
  store?: Pick<Connections, "connection" | "upsertConnections">;
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
        mapMessage(m, connection, deps.store, groupNames, pushnames, now, batch.history === true)
      ),
      ...(batch.edits ?? []).map((e) => mapEdit(e, connection, now)),
      ...(batch.revokes ?? []).map((r) => mapRevoke(r, connection, now)),
      ...(batch.statuses ?? []).map((s) => mapStatus(s, connection, now)),
    ].filter((d): d is Draft<MessageEvent> => d !== null);

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

/** The wire-derived sidecar (§3): only what the envelope has no slot for. */
function extraOf(c: WAContent): Record<string, unknown> | undefined {
  const wa: Record<string, unknown> = {};
  if (c.re_message_id) wa.re = externalId(c.re_message_id); // external ref — resolution deferred
  if (c.forwarded) wa.forwarded = true;
  if (c.mentions?.length) wa.mentions = c.mentions;
  return Object.keys(wa).length ? { whatsapp: wa } : undefined;
}

/** The delivery state a bridge status map amounts to: the FURTHEST stage present. */
function stateOf(status: Record<string, unknown>): DeliveryStatus | undefined {
  for (const key of ["failed", "read", "delivered", "sent"] as const) {
    if (status[key] !== undefined) return key;
  }
  return undefined;
}

function mapMessage(
  m: WAMessage,
  connection: string,
  store: Store | undefined,
  groupNames: Map<string, string>,
  pushnames: Map<string, string>,
  now: () => string,
  backfill = false,
): Draft<MessageEvent> | null {
  const part = partOf(m.content);
  if (!part || !m.external_id || !m.conversation_address) return null;

  const address = m.conversation_address;
  const name = groupNames.get(address);
  const sender = m.sender_address || undefined; // "" = the account spoke (echo/history)
  // the classifier (§3): a bound grant row names the owner; else the wire's pushname
  const who = sender
    ? store?.connection(SERVICE, sender)?.agentId ?? pushnames.get(sender)
    : undefined;
  const state = m.status ? stateOf(m.status) : undefined;

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
    // `backfill` is SERVICE-NEUTRAL, so it sits beside the `whatsapp` sidecar, not in
    // it: a consumer skipping history (the wake/automation gate) reads one key across
    // every connector instead of per-service paths
    ...((extraOf(m.content) || backfill)
      ? { extra: { ...(extraOf(m.content) ?? {}), ...(backfill ? { backfill: true } : {}) } }
      : {}),
  };
}

/** An edit REPLACES parts on the original row (a `json_patch` array replaces — the same
 *  row semantics as Slack's `message_changed`); the mark rides `extra`. */
function mapEdit(
  e: NonNullable<WABatch["edits"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent> | null {
  if (!e.original_message_id) return null;
  return {
    ts: e.timestamp || now(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: connection,
      conversation: { address: "" }, // merge-keyed on external_id; the row keeps its own
      external_id: externalId(e.original_message_id),
    },
    parts: [{ type: "text", kind: "text", text: e.text }],
    extra: { whatsapp: { edited_at: e.timestamp || now() } },
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
  over: { extra?: Record<string, unknown>; status?: DeliveryStatus },
): Draft<MessageEvent> {
  return {
    ts,
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: connection,
      conversation: { address: "" },
      external_id: externalId(wmwId),
      ...(over.status ? { status: over.status } : {}),
    },
    ...(over.extra ? { extra: over.extra } : {}),
  } as unknown as Draft<MessageEvent>; // partless by design — see above
}

/** A revoke marks, never deletes: the log is append-only, the content stays auditable. */
function mapRevoke(
  r: NonNullable<WABatch["revokes"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent> | null {
  if (!r.original_message_id) return null;
  const ts = r.timestamp || now();
  return mergeOnly(connection, r.original_message_id, ts, {
    extra: { whatsapp: { revoked_at: ts } },
  });
}

/** Delivery/read receipts (and typing) → the row's status: `state` takes the furthest
 *  stage; the RAW map (per-participant in groups) accumulates under `extra.whatsapp.
 *  status`, where `json_patch` merges reader by reader. */
function mapStatus(
  s: NonNullable<WABatch["statuses"]>[number],
  connection: string,
  now: () => string,
): Draft<MessageEvent> | null {
  if (!s.external_id) return null;
  return mergeOnly(connection, s.external_id, now(), {
    status: stateOf(s.status),
    extra: { whatsapp: { status: s.status } },
  });
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
    // the frontier gate the very next publish checks (§4). `logged_out` only records
    // state: the gate stays open (nothing more will arrive; history stays readable), and
    // re-pairing revives by upsert.
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
 *   deno task ingest:whatsapp     # serves :8791; bridge env → OPENBSP_URL=http://localhost:8791
 *
 * Env: MU_DIR · WA_BRIDGE_TOKEN (must equal the bridge's BRIDGE_TOKEN) · PORT. */
if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const { saveMedia } = await import("../store/media.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const log = await openLog(`${dir}/log`);

  const handler = createWhatsAppWebhook({
    publish: log.publish,
    store: log, // connections live on the Log (§4) — session events write the map
    media: (bytes, meta) =>
      saveMedia(dir, meta.connection, bytes, {
        ...(meta.mime_type ? { mime_type: meta.mime_type } : {}),
        ...(meta.name ? { name: meta.name } : {}),
      }),
    bridgeToken: Deno.env.get("WA_BRIDGE_TOKEN") || undefined,
  });
  const port = Number(Deno.env.get("PORT") ?? 8791);
  console.error(`[whatsapp] bridge ingest on :${port} → ${dir}/log`);
  Deno.serve({ port }, handler);
}
