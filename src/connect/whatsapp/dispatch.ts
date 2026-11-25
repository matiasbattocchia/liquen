/**
 * connect/whatsapp/dispatch.ts — the DISPATCH half of the WhatsApp connection.
 *
 * The mirror of the ingest (whatsapp.ts): log → world, through the whatsmeow BRIDGE's
 * `POST /dispatch` (server.go). Subscribes, picks the agent's outbound sends on the
 * whatsapp service, maps each liquen event BACK to the bridge's record shape (an OpenBSP
 * MessageRow — one content part per call), posts, and backfills the returned wmw id as
 * `external_id` via `setDelivery` — so the bridge's echo MERGES into the same row (§4;
 * no author-based skip anywhere).
 *
 * Media rides the `media_url` leg: the bridge GETs the url and uploads the bytes to
 * WhatsApp itself (encrypt + CDN push are ITS job — the multi-device protocol has no
 * send-by-link, so whoever sends must hold the plaintext). A kept `storage://` part needs
 * a url the bridge can reach: the `mediaUrl` seam mints a RELATIVE signed path
 * (`ingest/media/<payload>.<mac>`, `store/media.ts`) which the bridge resolves against the
 * session's receiver — our ingest, registered at pairing — and fetches there. An external `http(s)` part passes
 * through as-is. The token and the files stay broker-side (§9).
 *
 * One event, N parts → N bridge calls (the bridge takes ONE content each): the first
 * file carries the text as caption, a location and contact cards are contents of their own
 * after them (all the cards one message, which the bridge writes as vCards); the
 * FIRST response's id backfills `external_id` — later parts' echoes land as their own
 * rows (they ARE their own WhatsApp messages).
 *
 * The bridge's error contract: 4xx = permanent, 5xx = transient. A failure stamps `failed`
 * with `error_code` = the HTTP status; the sweeper (`store/sweep.ts`) reads the class off
 * the log and re-offers the transient ones.
 */

import { isExternal } from "../../store/media.ts";
import { DispatchError, httpError } from "../errors.ts";
import { createDispatcher, type DispatcherDeps } from "../dispatcher.ts";
import type { DeliveryPatch, Reader, Subscriber } from "../../store/log.ts";
import type {
  ContactsPart,
  EventId,
  FilePart,
  LocationPart,
  MessageEvent,
  ReactionPart,
  TextPart,
} from "../../types.ts";
import { externalId, SERVICE, type WAContent } from "./ingest.ts";
import { whatsappMentions } from "../mentions.ts";
import { toWhatsApp } from "../flavor.ts";
import { findRoot, orgFlag, settingsOf } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { entry } from "../../entry.ts";

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
 *  `DispatchError` on failure — `code` carries the bridge's HTTP status. `engagedUntil`
 *  is when the conversation stops being engaged after this send (RFC 3339): the bridge
 *  shows the account online until then, the state WhatsApp tells who is typing to. */
export type WASend = (
  record: WADispatchRecord,
  mediaUrl?: string,
  engagedUntil?: string,
) => Promise<string | undefined>;

/** Mint a bridge-reachable download url for a LOCAL file part (the entry's loopback
 *  server). External parts never come here. */
export type WAMediaUrl = (file: FilePart) => Promise<string>;

export interface WhatsAppDispatchDeps {
  subscribe: Subscriber["subscribe"];
  send: WASend;
  mediaUrl?: WAMediaUrl;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  store?: DispatcherDeps<unknown>["store"];
  read: Reader["read"];
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, wmwId: string | undefined) => void;
  /** How long the sending agent's own word keeps a conversation engaged (§2). */
  engagedMinutes?: (agentId: string) => Promise<number>;
  now?: () => number;
}

/** Wire dispatch to the log — the shared loop (`dispatcher.ts`) over the bridge's
 *  one-content-per-call shape. Returns stop. */
export function createWhatsAppDispatch(deps: WhatsAppDispatchDeps): () => Promise<void> {
  return createDispatcher<Outbound>({
    subscribe: deps.subscribe,
    service: SERVICE,
    select: outbound,
    read: deps.read,
    setDelivery: deps.setDelivery,
    store: deps.store,
    onError: deps.onError,
    onSent: deps.onSent,
    post: async ({ contents }, event) => {
      // the people the send resolved (§3 mentions), each content handed the ones its text
      // or caption writes: the BRIDGE encodes them (`encodeMentions`)
      const said = event.payload?.mentions ?? [];
      for (const c of contents) {
        if (c.content.kind === "reaction" || !c.content.text || said.length === 0) continue;
        const claimed = whatsappMentions(c.content.text, said);
        if (claimed.length) c.content.mentions = claimed;
      }
      const minutes = event.agent && deps.engagedMinutes
        ? await deps.engagedMinutes(event.agent.id)
        : undefined;
      const engagedUntil = minutes === undefined
        ? undefined
        : new Date((deps.now ?? Date.now)() + minutes * 60_000).toISOString();
      let first: string | undefined;
      for (const c of contents) {
        const mediaUrl = await urlFor(c.content, deps.mediaUrl);
        const wmwId = await deps.send(recordOf(event, c.content), mediaUrl, engagedUntil);
        first ??= wmwId;
      }
      // the wire names its own side IN THE SEND RESPONSE (§4): the returned id is
      // `wmw.<own>.<chat>.<sender>.<id>` — lift <own> into sender alongside
      // dispatched_at, so sender-presence means "on the wire" without waiting for the
      // echo (which still fill-merges what only it knows: the pushname)
      const own = first?.split(".")[1];
      return {
        id: first,
        ...(first !== undefined ? { external_id: externalId(first) } : {}),
        ...(own ? { sender: { address: own } } : {}),
      };
    },
  });
}

interface Outbound {
  contents: { content: WAContent }[];
}

/** liquen parts → the bridge's one-content-per-call shape. Text joins into one; a reaction
 *  is its own content (kind + re_message_id); the first file carries the text as its
 *  caption, and every file its own caption, the one a received file came with; a location,
 *  then the contact cards, close the send as contents of their own, each taking `re` only
 *  when nothing before it did. `re` travels in `extra.whatsapp.re` (the ingest's
 *  convention) with the `whatsapp:` prefix stripped back to the raw wmw id. A forward's
 *  contents are each marked `forwarded` and quote nothing: its referent is the message it
 *  copies, in another conversation. */
function outbound(event: MessageEvent): Outbound | null {
  if (!event.envelope.connection_address || !event.envelope.conversation.address) return null;

  const forwarded = event.payload?.action === "forward";
  const re = forwarded ? undefined : reOf(event);
  const texts = event.parts.filter((p): p is TextPart => p.type === "text");
  const files = event.parts.filter((p): p is FilePart => p.type === "file");
  // the canonical reaction is the DataPart (§3: what was added/removed rides the part,
  // add vs remove is the event's action); a text-kind reaction is tolerated on input
  const reactData = event.parts.find((p): p is ReactionPart =>
    p.type === "data" && p.kind === "reaction"
  );
  const reactText = texts.find((p) => p.kind === "reaction");
  const location = event.parts.find((p): p is LocationPart =>
    p.type === "data" && p.kind === "location"
  );
  const contacts = event.parts.find((p): p is ContactsPart =>
    p.type === "data" && p.kind === "contacts"
  );
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
    // the caption seat: the send's text on the first file, then the file's own
    const caption = [i === 0 ? text : "", f.text ?? ""].filter((s) => s !== "").join("\n");
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
        ...(caption ? { text: caption } : {}),
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
  for (const part of [location, contacts]) {
    if (!part) continue;
    contents.push({
      content: {
        version: "1",
        type: "data",
        kind: part.kind,
        data: part.data,
        ...(re && !contents.length ? { re_message_id: re } : {}),
      },
    });
  }
  if (forwarded) { for (const c of contents) c.content.forwarded = true; }
  return contents.length ? { contents } : null;
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

/** `POST <base>/dispatch` with the bridge's bearer — each call bounded by `API_TIMEOUT_MS`
 *  unless a fetch is injected. The bridge's error contract: 4xx = permanent, 5xx =
 *  transient; the status rides the `DispatchError`. */
export function bridgeSend(
  base: string,
  token: string,
  fetchApi: typeof fetch = timedFetch,
): WASend {
  return async (record, mediaUrl, engagedUntil) => {
    const res = await fetchApi(`${base}/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        record,
        ...(mediaUrl ? { media_url: mediaUrl } : {}),
        ...(engagedUntil ? { engaged_until: engagedUntil } : {}),
      }),
    });
    if (!res.ok) throw await httpError(res);
    const out = await res.json() as { external_id?: string };
    return out.external_id;
  };
}

/* ── local entry: `send` = POST <bridgeUrl>/dispatch ──────────────────────────
 *
 *   deno task run:whatsapp
 *
 * Env: WA_BRIDGE_TOKEN (the secret); the bridge's address is connections.whatsapp. */
/** Wire the outbound half over the org's log — resident once it returns (subscribed).
 *  Returns stop: unsubscribe, settle the posts in flight, release the handles. */
export async function runDispatch(): Promise<() => Promise<void>> {
  const { openStore } = await import("../../store/mod.ts");
  const { mediaSecret, signMediaPath } = await import(
    "../../store/media.ts"
  );
  const { isStored } = await import("../../store/storage.ts");
  const { SPEC } = await import("./config.ts");
  const { liveConfig, liveKnobs } = await import("../../org.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  const knobs = await liveKnobs<{ bridgeUrl: string }>(root, SPEC, log);
  const token = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";

  // The bytes leave by being FETCHED: a signed, expiring path rides `media_url`, the
  // bridge resolves it against the address it already delivers to and GETs it there —
  // the INGEST serves it (one door in, §4), out of the object store. The file never
  // rides the log or the agent's context (§9), and a retry re-fetches.
  const mediaUrl: WAMediaUrl = async (f) => {
    if (!isStored(f.file.uri)) throw new DispatchError(`${f.file.uri}: not a kept file`, 400);
    return signMediaPath(f.file.uri, await mediaSecret(creds));
  };

  // each send posts to the bridge's address as the org states it then
  const send: WASend = async (record, media, engagedUntil) =>
    await bridgeSend((await knobs()).bridgeUrl, token)(record, media, engagedUntil);
  const org = await liveConfig(root, log);

  const stop = createWhatsAppDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    send,
    mediaUrl,
    engagedMinutes: async (agentId) => settingsOf(await org(), agentId).engagedMinutes,
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    store: log,
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[dispatch] watching ${dir}/log → ${(await knobs()).bridgeUrl}/dispatch`);

  // the bridge's absence, which it cannot say itself: written on its sessions' rows. Each
  // probe asks the bridge at its address as the org states it then
  const { bridgeStatus, createBridgeProbe, PROBE_MS } = await import("./probe.ts");
  let quiet = false; // a bridge that stays away is said once, and once when it is back
  let base = (await knobs()).bridgeUrl;
  const probe = createBridgeProbe({
    status: async (address) => {
      base = (await knobs()).bridgeUrl;
      return await bridgeStatus(base, token)(address);
    },
    store: log,
    onError: (err) => {
      if (!quiet) console.error(`[dispatch] bridge not answering at ${base}:`, err);
      quiet = true;
    },
    onAnswered: () => {
      if (quiet) console.error(`[dispatch] bridge answering again at ${base}`);
      quiet = false;
    },
  });
  let probing = Promise.resolve();
  const round = () => {
    probing = probing.then(() => probe.tick()).then(
      () => undefined,
      (err) => console.error("[dispatch] bridge probe:", err),
    );
  };
  round();
  const probes = setInterval(round, PROBE_MS);
  return async () => {
    clearInterval(probes);
    await probing;
    await stop();
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await entry(runDispatch);
