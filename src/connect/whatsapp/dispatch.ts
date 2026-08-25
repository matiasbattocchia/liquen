/**
 * connect/whatsapp/dispatch.ts — the DISPATCH half of the WhatsApp connection.
 *
 * The mirror of the ingest (whatsapp.ts): log → world, through the whatsmeow BRIDGE's
 * `POST /dispatch` (server.go). Subscribes, picks the agent's outbound sends on the
 * whatsapp service, maps each mu event BACK to the bridge's record shape (an OpenBSP
 * MessageRow — one content part per call), posts, and backfills the returned wmw id as
 * `external_id` via `setDelivery` — so the bridge's echo MERGES into the same row (§4;
 * no author-based skip anywhere).
 *
 * Media rides the `media_url` leg: the bridge GETs the url and uploads the bytes to
 * WhatsApp itself (encrypt + CDN push are ITS job — the multi-device protocol has no
 * send-by-link, so whoever sends must hold the plaintext). A local `file://` part needs
 * a url the bridge can reach: the `mediaUrl` seam mints a RELATIVE signed path
 * (`/m/<payload>.<mac>`, `store/media.ts`) which the bridge resolves against its
 * `OPENBSP_URL` — our ingest — and fetches there. An external `http(s)` part passes
 * through as-is. The token and the files stay broker-side (§9).
 *
 * One event, N parts → N bridge calls (the bridge takes ONE content each): the first
 * file carries the text as caption; the FIRST response's id backfills `external_id` —
 * later parts' echoes land as their own rows (they ARE their own WhatsApp messages).
 *
 * The bridge's error contract: 4xx = permanent, 5xx = transient. mu has no dispatch
 * retry loop yet (that's the scheduler, PROJECT #10) — a failure stamps `failed` with
 * `error_code` = the HTTP status, so a retrier can read the class off the log.
 */

import { isExternal } from "../../store/media.ts";
import { DispatchError, failedStatus } from "../errors.ts";
import type { DeliveryPatch, Subscriber } from "../../store/log.ts";
import type {
  Event,
  EventId,
  FilePart,
  MessageEvent,
  ReactionPart,
  TextPart,
} from "../../types.ts";
import { externalId, SERVICE, type WAContent } from "./ingest.ts";
import { type Directory, whatsappMentions } from "../mentions.ts";
import { toWhatsApp } from "../flavor.ts";

/** The bridge's dispatch request (server.go `dispatchRequest`) — record verbatim. */
export interface WADispatchRecord {
  id: string;
  external_id: string;
  organization_address: string;
  conversation_address: string;
  content: WAContent;
  status: Record<string, unknown>;
}

/** POST one record to the bridge; returns the created message's wmw id. Throws a
 *  `DispatchError` on failure — `code` carries the bridge's HTTP status. */
export type WASend = (
  record: WADispatchRecord,
  mediaUrl?: string,
) => Promise<string | undefined>;

/** Mint a bridge-reachable download url for a LOCAL file part (the entry's loopback
 *  server). External parts never come here. */
export type WAMediaUrl = (file: FilePart) => Promise<string>;

export interface WhatsAppDispatchDeps {
  subscribe: Subscriber["subscribe"];
  send: WASend;
  mediaUrl?: WAMediaUrl;
  /** The conversation's name directory (§3 mentions): lets the agent's `@Name` tokens
   *  claim addresses — the bridge does the wire encoding (`@digits` + MentionedJID).
   *  Absent ⇒ mentions ship as literal text. */
  directory?: Directory;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  from?: EventId;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, wmwId: string | undefined) => void;
}

/** Wire dispatch to the log. Returns unsubscribe. Posts serialized to preserve order. */
export function createWhatsAppDispatch(deps: WhatsAppDispatchDeps): () => void {
  let chain: Promise<void> = Promise.resolve();
  return deps.subscribe(
    (e) => {
      const out = outbound(e);
      if (!out) return;
      chain = chain.then(async () => {
        const { event, contents } = out;
        try {
          // the agent mentions as a human (`@Name`) — the directory claims the tokens,
          // the BRIDGE encodes (its `encodeMentions`: text messages and captions alike).
          // Unclaimed tokens stay literal text — the honest nothing.
          if (deps.directory) {
            const dir = await deps.directory(SERVICE, event.envelope.conversation.address);
            for (const c of contents) {
              if (c.content.kind === "reaction" || !c.content.text) continue;
              const claimed = whatsappMentions(c.content.text, dir);
              if (claimed.length) c.content.mentions = claimed;
            }
          }
          let first: string | undefined;
          for (const c of contents) {
            const mediaUrl = await urlFor(c.content, deps.mediaUrl);
            const wmwId = await deps.send(recordOf(event, c.content), mediaUrl);
            first ??= wmwId;
          }
          // the wire names its own side IN THE SEND RESPONSE (§4): the returned id is
          // `wmw.<own>.<chat>.<sender>.<id>` — lift <own> into sender alongside
          // dispatched_at, so sender-presence means "on the wire" without waiting for the
          // echo (which still fill-merges what only it knows: the pushname)
          const own = first?.split(".")[1];
          await deps.setDelivery?.(event.id, {
            ...(first !== undefined ? { external_id: externalId(first) } : {}),
            ...(own ? { sender: { address: own } } : {}),
            status: { dispatched_at: new Date().toISOString() },
          });
          deps.onSent?.(event, first);
        } catch (err) {
          // no retry here (the scheduler's job, PROJECT #10) — the stamp tags the class:
          // `error_code` = the bridge's HTTP status (4xx permanent / 5xx transient;
          // absent = the request never reached the bridge)
          try {
            await deps.setDelivery?.(event.id, { status: failedStatus(err) });
          } catch { /* the stamp failed too — onError still reports */ }
          deps.onError?.(event, err);
        }
      });
    },
    { from: deps.from, filter: isOutboundWhatsApp },
  );
}

/** OURS and not yet on the wire (§3, §4): `agent` present (our side authored it) AND no
 *  `external_id` at insert (a platform id means it already crossed — the classifier stamps
 *  `agent.id` on the principal's inbound rows too, and those must never re-dispatch). */
function isOutboundWhatsApp(e: Event): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.external_id === undefined &&
    e.envelope.service === SERVICE;
}

interface Outbound {
  event: MessageEvent;
  contents: { content: WAContent }[];
}

/** mu parts → the bridge's one-content-per-call shape. Text joins into one; a reaction
 *  is its own content (kind + re_message_id); the first file carries the text as its
 *  caption, later files go bare. `re` travels in `extra.whatsapp.re` (the ingest's
 *  convention) with the `whatsapp:` prefix stripped back to the raw wmw id. */
function outbound(e: Event): Outbound | null {
  if (!isOutboundWhatsApp(e)) return null;
  const event = e as MessageEvent;
  if (!event.envelope.connection_address || !event.envelope.conversation.address) return null;

  const re = reOf(event);
  const texts = event.parts.filter((p): p is TextPart => p.type === "text");
  const files = event.parts.filter((p): p is FilePart => p.type === "file");
  // the canonical reaction is the DataPart (§3: what was added/removed rides the part,
  // add vs remove is the event's action); a text-kind reaction is tolerated on input
  const reactData = event.parts.find((p): p is ReactionPart =>
    p.type === "data" && p.kind === "reaction"
  );
  const reactText = texts.find((p) => p.kind === "reaction");
  // common markdown → the wire's dialect, here at the frontier (flavor.ts)
  const text = toWhatsApp(
    texts.filter((p) => p.kind !== "reaction").map((p) => p.text).join("\n"),
  );

  const contents: { content: WAContent }[] = [];
  const action = event.payload?.action;

  // A mutation acts on its referent and carries nothing else — the bridge answers 422 for a
  // reference it can't resolve, which stamps the send failed instead of letting it vanish.
  if (action === "edit" || action === "delete") {
    return {
      event,
      contents: [{
        content: {
          version: "1",
          type: "data",
          kind: action === "edit" ? "edit" : "revoke",
          ...(action === "edit" ? { text } : {}),
          re_message_id: re ?? "",
        },
      }],
    };
  }

  if (reactData || reactText) {
    // the bridge's reaction shape (openbsp.go): a DataPart whose `action` is added/removed
    // — a removal is WhatsApp's empty reaction, which the bridge writes from the action
    const removed = action === "remove";
    const glyph = reactData ? (reactData.data.unicode ?? reactData.data.name) : reactText!.text;
    contents.push({
      content: {
        version: "1",
        type: "data",
        kind: "reaction",
        data: removed ? { action: "removed" } : { action: "added", name: glyph, unicode: glyph },
        re_message_id: re ?? "",
      },
    });
  }
  files.forEach((f, i) => {
    contents.push({
      content: {
        version: "1",
        type: "file",
        kind: f.kind,
        file: {
          mime_type: f.file.mime_type,
          uri: f.file.uri,
          ...(f.file.name ? { name: f.file.name } : {}),
          ...(f.file.size !== undefined ? { size: f.file.size } : {}),
        },
        ...(i === 0 && text ? { text } : {}), // the caption seat
        ...(i === 0 && re ? { re_message_id: re } : {}),
      },
    });
  });
  if (!files.length && text) {
    contents.push({
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text,
        ...(re ? { re_message_id: re } : {}),
      },
    });
  }
  return contents.length ? { event, contents } : null;
}

/** The `whatsapp:`-prefixed external ref from `payload` (§3) → the bridge's raw wmw id. */
function reOf(e: MessageEvent): string | undefined {
  const re = e.payload?.ref_external_id;
  return typeof re === "string" ? re.replace(/^whatsapp:/, "") : undefined;
}

function recordOf(e: MessageEvent, content: WAContent): WADispatchRecord {
  return {
    id: e.id,
    external_id: e.envelope.external_id ?? "",
    organization_address: e.envelope.connection_address,
    conversation_address: e.envelope.conversation.address,
    content,
    status: {},
  };
}

/** The media_url leg: external links pass through (the bridge GETs them directly);
 *  local files need the seam to mint a reachable url. No seam ⇒ the call proceeds
 *  without one and the bridge answers its own 422 — the honest failure. */
function urlFor(c: WAContent, mediaUrl?: WAMediaUrl): Promise<string | undefined> {
  if (c.type !== "file" || !c.file) return Promise.resolve(undefined);
  if (isExternal(c.file.uri)) return Promise.resolve(c.file.uri);
  if (!mediaUrl) return Promise.resolve(undefined);
  return mediaUrl({ type: "file", kind: "document", file: c.file });
}

/* ── local entry: `send` = POST <bridgeUrl>/dispatch ──────────────────────────
 *
 *   deno task dispatch:whatsapp
 *
 * Env: WA_BRIDGE_TOKEN (the secret); the bridge's address is connections.whatsapp. */
if (import.meta.main) {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { mediaSecret, signMediaPath } = await import("../../store/media.ts");
  const { whatsappConfig } = await import("./config.ts");
  const dir = "./data";
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const { bridgeUrl: base } = await whatsappConfig(dir);
  const token = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";

  // The bytes leave by being FETCHED: a signed, expiring path rides `media_url`, the
  // bridge resolves it against the address it already delivers to and GETs it there —
  // the INGEST serves it (one door in, §4). Nothing is buffered on either side, the
  // file never rides the log or the agent's context (§9), and a retry re-fetches.
  const mediaUrl: WAMediaUrl = async (f) => signMediaPath(f.file.uri, await mediaSecret(creds));

  const send: WASend = async (record, mediaUrl) => {
    const res = await fetch(`${base}/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        record,
        ...(mediaUrl ? { media_url: mediaUrl } : {}),
      }),
    });
    if (!res.ok) {
      const reason = (await res.text()).slice(0, 256).trim();
      throw new DispatchError(`bridge /dispatch HTTP ${res.status}: ${reason}`, res.status);
    }
    const out = await res.json() as { external_id?: string };
    return out.external_id;
  };

  const { logDirectory } = await import("../mentions.ts");
  createWhatsAppDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    send,
    mediaUrl,
    directory: logDirectory((q) => log.read(q)),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[wa-dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[wa-dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[wa-dispatch] watching ${dir}/log → ${base}/dispatch`);
}
