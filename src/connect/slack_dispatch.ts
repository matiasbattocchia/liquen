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
import type { DeliveryPatch, Subscriber } from "../store/log.ts";
import type { Event, EventId, MessageEvent } from "../types.ts";

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

/** Post `text` to a channel; returns the created message `ts` (→ external_id, §4).
 *  `author` is the sending agent's registry name — the token resolver's key. */
export type SlackPost = (
  target: SlackTarget,
  text: string,
  author?: string,
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
      const { target, text, event } = out;
      chain = chain.then(async () => {
        try {
          const ts = await deps.post(target, text, event.agent?.id);
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
  event: MessageEvent;
}

/** Target = the envelope's coordinates: the workspace is the connection, channel the address. */
function outbound(e: Event): Outbound | null {
  if (!isOutboundSlack(e)) return null;
  const connection = e.envelope.connection_address;
  const channel = e.envelope.conversation.address;
  if (!connection || !channel) return null;
  const text = textOf(e);
  if (!text) return null;
  return { target: { connection, channel }, text, event: e as MessageEvent };
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

  const post: SlackPost = async ({ connection, channel }, text, author) => {
    // the token resolver (§4, dispatcher-internal): the author's own grant (alter-ego)
    // → the workspace bot — vault keys follow the connector's convention (§4)
    const team = teamOf(connection);
    const user = author ? await creds.get(`slack:${team}:${author}`) : null;
    const bot = user?.value.token ? null : await creds.get(`slack:${team}:org`);
    const token = user?.value.token ?? bot?.value.token ?? Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) throw new Error(`no token for connection ${connection}`);
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text }),
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
