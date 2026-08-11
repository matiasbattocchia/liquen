/**
 * connect/slack_dispatch.ts — the DISPATCH half of the Slack connection (open-bsp).
 *
 * The mirror of the ingest (slack.ts): log → world. Subscribes, picks the agent's OUTBOUND
 * sends on the slack service, posts them, and backfills the
 * returned `ts` as `external_id` (+ `status.dispatched_at`) via `setDelivery` — so the echo
 * arriving through the ingest MERGES into the same row (§4; no author-based skip anywhere).
 *
 * WHICH token posts is dispatcher-internal (§4: the log is the frontier — the agent doesn't
 * know a bot exists). Policy: the AUTHOR's principal user token (xoxp) when the vault holds
 * one — the alter-ego leg (§4: the agent posts as its principal) — else the workspace bot.
 * Tokens come from the credential store — broker-side, never the agent's exec context (§9).
 */

import type { ChatPostMessageResponse } from "@slack/web-api";
import { isExternal, pathOf } from "../store/media.ts";
import type { DeliveryPatch, Subscriber } from "../store/log.ts";
import type { Event, EventId, FilePart, MessageEvent } from "../types.ts";

export interface SlackTarget {
  connection: string; // the workspace the conversation anchors to (§4)
  channel: string;
}

/** The workspace part of a connection address — tolerant of grant-shaped (`<team>:<user>`)
 *  addresses, the connector's split on `:` (§4). */
export function teamOf(connection: string): string {
  const at = connection.indexOf(":");
  return at < 0 ? connection : connection.slice(0, at);
}

/** Post `text` (and any attachments) to a channel; returns the created message `ts`
 *  (→ external_id, §4 — file shares may not surface one; the echo still lands, §5).
 *  `author` is the sending agent's registry name — the token resolver's key. */
export type SlackPost = (
  target: SlackTarget,
  text: string,
  author?: string,
  files?: FilePart[],
) => Promise<string | undefined>;

export interface SlackDispatchDeps {
  subscribe: Subscriber["subscribe"];
  post: SlackPost;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  from?: EventId;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, ts: string | undefined) => void;
}

/** Wire dispatch to the log. Returns unsubscribe. Posts serialized to preserve order. */
export function createSlackDispatch(deps: SlackDispatchDeps): () => void {
  let chain: Promise<void> = Promise.resolve();
  return deps.subscribe(
    (e) => {
      const out = outbound(e);
      if (!out) return;
      const { target, text, files, event } = out;
      chain = chain.then(async () => {
        try {
          const ts = await deps.post(target, text, event.agent?.id, files);
          await deps.setDelivery?.(event.id, {
            ...(ts !== undefined
              ? { external_id: `slack:${teamOf(target.connection)}:${target.channel}:${ts}` }
              : {}),
            status: { dispatched_at: new Date().toISOString() },
          });
          deps.onSent?.(event, ts);
        } catch (err) {
          // permanent failure (the API refused, or the post threw and nothing retries):
          // stamp `status.state = failed` so the message renders with its delivery dead —
          // the agent's only way to know a queued send never arrived (§5)
          try {
            await deps.setDelivery?.(event.id, {
              status: {
                state: "failed",
                failed_at: new Date().toISOString(),
                error: String(err),
              },
            });
          } catch { /* the stamp failed too — onError still reports */ }
          deps.onError?.(event, err);
        }
      });
    },
    { from: deps.from, filter: isOutboundSlack },
  );
}

/** A `message` authored by a handler (`agent` present) on the slack service — routing
 *  reads `envelope.service` (§3). */
function isOutboundSlack(e: Event): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.service === "slack";
}

interface Outbound {
  target: SlackTarget;
  text: string;
  files: FilePart[];
  event: MessageEvent;
}

/** Target = the envelope's coordinates: the workspace is the connection, channel the address. */
function outbound(e: Event): Outbound | null {
  if (!isOutboundSlack(e)) return null;
  const connection = e.envelope.connection_address;
  const channel = e.envelope.conversation.address;
  if (!connection || !channel) return null;
  const text = textOf(e);
  const files = filesOf(e);
  if (!text && files.length === 0) return null;
  return { target: { connection, channel }, text, files, event: e as MessageEvent };
}

function filesOf(e: Event): FilePart[] {
  const parts = (e as MessageEvent).parts ?? [];
  return parts.filter((p): p is FilePart => p.type === "file");
}

function textOf(e: Event): string {
  const parts = (e as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => (p as { type?: unknown }).type === "text")
    .map((p) => (p as { text?: unknown }).text)
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/* ── local entry: `post` = chat.postMessage with the workspace bot token ──────────────── */

if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const { openCredentials } = await import("../store/credentials.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);

  // one form-encoded Web-API call (the upload endpoints don't take JSON)
  const api = async <T extends { ok?: boolean; error?: string }>(
    method: string,
    token: string,
    params: Record<string, string>,
  ): Promise<T> => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams(params),
    });
    const out = await res.json() as T;
    if (!out.ok) throw new Error(`${method}: ${out.error}`);
    return out;
  };

  const post: SlackPost = async ({ connection, channel }, text, author, files) => {
    // the token resolver (§4, dispatcher-internal): the author's own grant (alter-ego)
    // → the workspace bot — vault keys follow the connector's convention (§4)
    const team = teamOf(connection);
    const user = author ? await creds.get(`slack:${team}:${author}`) : null;
    const bot = user?.value.token ? null : await creds.get(`slack:${team}:org`);
    const token = user?.value.token ?? bot?.value.token ?? Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) throw new Error(`no token for connection ${connection}`);

    // Slack doesn't take media-by-link: LOCAL uris upload; external links join the text
    // as lines instead — Slack's own idiom (the client unfurls them). Never fetched here.
    const local = files?.filter((f) => !isExternal(f.file.uri)) ?? [];
    const links = files?.filter((f) => isExternal(f.file.uri)).map((f) => f.file.uri) ?? [];
    const body = [text, ...links].filter((s) => s.length > 0).join("\n");

    if (local.length) {
      // the files.uploadV2 flow, broker-side reads (§5 media): an upload URL per file,
      // POST the bytes, complete into the channel with the text as the share comment —
      // one Slack message carrying every attachment
      const ids: { id: string; title?: string }[] = [];
      for (const f of local) {
        const bytes = await Deno.readFile(pathOf(f.file.uri));
        const name = f.file.name ?? f.file.uri.slice(f.file.uri.lastIndexOf("/") + 1);
        const up = await api<{ ok: boolean; error?: string; upload_url: string; file_id: string }>(
          "files.getUploadURLExternal",
          token,
          { filename: name, length: String(bytes.length) },
        );
        const putRes = await fetch(up.upload_url, { method: "POST", body: bytes });
        if (!putRes.ok) throw new Error(`upload ${name}: HTTP ${putRes.status}`);
        await putRes.body?.cancel();
        ids.push({ id: up.file_id, title: name });
      }
      type Shares = Record<string, Record<string, { ts?: string }[]>>;
      const done = await api<
        {
          ok: boolean;
          error?: string;
          files?: { shares?: { public?: Shares[string]; private?: Shares[string] } }[];
        }
      >("files.completeUploadExternal", token, {
        files: JSON.stringify(ids),
        channel_id: channel,
        ...(body ? { initial_comment: body } : {}),
      });
      // the share's ts when the response carries one; absent, the echo lands as its own row
      const shares = done.files?.[0]?.shares;
      return (shares?.public?.[channel] ?? shares?.private?.[channel])?.[0]?.ts;
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text: body }),
    });
    const out = await res.json() as ChatPostMessageResponse;
    if (!out.ok) throw new Error(`chat.postMessage: ${out.error}`);
    return out.ts;
  };

  createSlackDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post,
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, ts) =>
      console.error(`[slack-dispatch] sent → ${e.envelope.conversation.address} (ts ${ts})`),
    onError: (e, err) =>
      console.error(`[slack-dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[slack-dispatch] watching ${dir}/log for outbound slack sends`);
}
