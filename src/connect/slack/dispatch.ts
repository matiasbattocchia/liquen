/**
 * connect/slack/dispatch.ts — the DISPATCH half of the Slack connection (open-bsp).
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
 *
 * A failed post stamps `state = "failed"`, `failed_at`, `error`, `error_code` (§5): the
 * real HTTP status when the transport surfaces one (a 429, a 5xx on the upload URL), else
 * assigned from Slack's error NAME (`slackErrorCode` — the API answers HTTP 200 `ok: false`).
 * No retry loop here (the scheduler's job, PROJECT #10); the code is the class a retrier
 * reads off the log: 4xx permanent, 5xx/429 transient, absent = never reached Slack.
 */

import type { ChatPostMessageResponse } from "@slack/web-api";
import { isExternal, pathOf } from "../../store/media.ts";
import { DispatchError, failedStatus } from "../errors.ts";
import type { DeliveryPatch, Subscriber } from "../../store/log.ts";
import type { Event, EventId, FilePart, MessageEvent } from "../../types.ts";
import { type Directory, encodeSlackText } from "../mentions.ts";
import { toSlack } from "../flavor.ts";

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

const TRANSIENT_NAMES = new Set(["fatal_error", "internal_error", "service_unavailable"]);

/** The HTTP class for a NAMED Slack API error (the `ok: false` body rides HTTP 200, so
 *  the code is assigned): `ratelimited` → 429, Slack's self-declared retryables → 503,
 *  every other named refusal → 400 — the same request is refused again. */
export function slackErrorCode(error?: string): number {
  if (error === "ratelimited") return 429;
  return TRANSIENT_NAMES.has(error ?? "") ? 503 : 400;
}

/** Slack names its reactions (`thumbsup`), WhatsApp draws them (👍) — and the log carries
 *  whichever the composer wrote. The common glyphs translate; a name passes through (it is
 *  what a Slack reaction the agent SAW already looks like); anything else gets no guess,
 *  because a wrong emoji is a wrong statement. Custom workspace emoji arrive as names. */
const EMOJI_NAMES: Record<string, string> = {
  "👍": "thumbsup",
  "👎": "thumbsdown",
  "❤": "heart",
  "🙏": "pray",
  "🎉": "tada",
  "😂": "joy",
  "🤣": "rolling_on_the_floor_laughing",
  "😄": "smile",
  "😊": "blush",
  "😮": "open_mouth",
  "😢": "cry",
  "😅": "sweat_smile",
  "🤔": "thinking_face",
  "👀": "eyes",
  "✅": "white_check_mark",
  "❌": "x",
  "🔥": "fire",
  "💯": "100",
  "🚀": "rocket",
  "🙌": "raised_hands",
  "👏": "clap",
  "💪": "muscle",
  "🤝": "handshake",
  "⚡": "zap",
  "⭐": "star",
  "💡": "bulb",
  "📌": "pushpin",
  "🥳": "partying_face",
  "😍": "heart_eyes",
  "😡": "rage",
  "🤯": "exploding_head",
  "👌": "ok_hand",
  "🫡": "saluting_face",
};

export function slackEmojiName(glyph: string): string | undefined {
  const bare = glyph.replaceAll("️", "").replaceAll(":", "").trim(); // presentation selector
  if (bare.length === 0) return undefined;
  if (/^[a-z0-9_+-]+$/.test(bare)) return bare; // already a name (or a custom one)
  return EMOJI_NAMES[bare];
}

/** Post `text` (and any attachments) to a channel; returns the created message `ts`
 *  (→ external_id, §4 — file shares may not surface one; the echo still lands, §5) and,
 *  when the API names it, the posting identity `user` — the wire stating its own side in
 *  the send response, which stamps `sender` beside `dispatched_at` (§4).
 *  `author` is the sending agent's registry name — the token resolver's key. */
export type SlackPost = (
  target: SlackTarget,
  text: string,
  author?: string,
  files?: FilePart[],
  /** The message being answered (§5 `re`): Slack's reply IS a thread, so a reference posts
   *  into the referent's thread — the parent's `ts` when it has one, else its own. */
  threadTs?: string,
) => Promise<{ ts?: string; user?: string }>;

/** Replace or take back a message we sent — `chat.update` / `chat.delete`. Neither mints a
 *  new `ts`: the edit IS the original message, so nothing backfills here either. */
export type SlackAmend = (
  target: SlackTarget,
  amend: { ts: string; action: "edit" | "delete"; text: string },
  author?: string,
) => Promise<void>;

/** Land (or lift) a glyph on a message — `reactions.add`/`remove`. A reaction is not a
 *  message: it gets no `ts` of its own, so nothing backfills and no echo merges. */
export type SlackReact = (
  target: SlackTarget,
  react: { ts: string; glyph: string; remove: boolean },
  author?: string,
) => Promise<void>;

export interface SlackDispatchDeps {
  subscribe: Subscriber["subscribe"];
  post: SlackPost;
  /** Absent = this deployment cannot react: the send stamps `failed` rather than
   *  disappearing, because a reaction nobody sees is the worst kind of success. */
  react?: SlackReact;
  /** Absent = it cannot edit or delete either — same rule, same stamp. */
  amend?: SlackAmend;
  /** The conversation's name directory (§3 mentions): lets the agent's `@Name` tokens
   *  claim user ids for the wire encoding. Specials (`@here`) and bare ids encode
   *  regardless; unclaimed names stay literal text. */
  directory?: Directory;
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
      const { target, text, files, event, re, glyph } = out;
      const action = event.payload?.action;
      chain = chain.then(async () => {
        try {
          if (action === "edit" || action === "delete") {
            if (!re) throw new DispatchError(`a ${action} needs the message it acts on`, 400);
            if (!deps.amend) throw new DispatchError("this connection cannot edit", 400);
            await deps.amend(target, { ts: re, action, text }, event.agent?.id);
            // chat.update keeps the original `ts`: there is no new artifact to converge on
            await deps.setDelivery?.(event.id, {
              status: { dispatched_at: new Date().toISOString() },
            });
            deps.onSent?.(event, undefined);
            return;
          }
          if (glyph !== undefined) {
            if (!re) throw new DispatchError("a reaction needs the message it lands on", 400);
            if (!deps.react) throw new DispatchError("this connection cannot react", 400);
            await deps.react(target, {
              ts: re,
              glyph,
              remove: event.payload?.action === "remove",
            }, event.agent?.id);
            // no `ts` of its own to backfill: the reaction is on the wire, and that is all
            // the log can ever learn about it
            await deps.setDelivery?.(event.id, {
              status: { dispatched_at: new Date().toISOString() },
            });
            deps.onSent?.(event, undefined);
            return;
          }
          // the agent mentions as a human (`@Name`, `#chan`, `@here`) — encode to the
          // wire's forms here at the frontier; unclaimed names stay literal text
          const dir = /[@#]/.test(text) ? await deps.directory?.("slack", target.channel) : null;
          const encoded = text ? encodeSlackText(text, dir ?? []) : text;
          const { ts, user } = await deps.post(target, encoded, event.agent?.id, files, re);
          // sender stamps WITH dispatched_at when the response names the posting identity
          // (§4): the wire states its own side twice, and we take the first statement —
          // the echo's merge still fills what only it knows (the display name)
          await deps.setDelivery?.(event.id, {
            ...(ts !== undefined
              ? { external_id: `slack:${teamOf(target.connection)}:${target.channel}:${ts}` }
              : {}),
            ...(user ? { sender: { address: user } } : {}),
            status: { dispatched_at: new Date().toISOString() },
          });
          deps.onSent?.(event, ts);
        } catch (err) {
          // no retry here (the scheduler's job, PROJECT #10) — the stamp tags the class
          // via `error_code`, and renders the message with its delivery dead: the agent's
          // only way to know a queued send never arrived (§5)
          try {
            await deps.setDelivery?.(event.id, { status: failedStatus(err) });
          } catch { /* the stamp failed too — onError still reports */ }
          deps.onError?.(event, err);
        }
      });
    },
    { from: deps.from, filter: isOutboundSlack },
  );
}

/** OURS and not yet on the wire (§3, §4): `agent` present AND no `external_id` at insert —
 *  the classifier stamps `agent.id` on the principal's inbound rows too, and those always
 *  arrive carrying a platform id, so they never re-dispatch. Routing reads
 *  `envelope.service` (§3). */
function isOutboundSlack(e: Event): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.external_id === undefined &&
    e.envelope.service === "slack";
}

interface Outbound {
  target: SlackTarget;
  text: string;
  files: FilePart[];
  event: MessageEvent;
  /** The referent's `ts` — a thread to post into, or the message a glyph lands on. */
  re?: string;
  /** Present ⇒ this send is a reaction, not a message (empty on a remove). */
  glyph?: string;
}

/** Target = the envelope's coordinates: the workspace is the connection, channel the address. */
function outbound(e: Event): Outbound | null {
  if (!isOutboundSlack(e)) return null;
  const connection = e.envelope.connection_address;
  const channel = e.envelope.conversation.address;
  if (!connection || !channel) return null;
  const event = e as MessageEvent;
  // common markdown → mrkdwn, here at the frontier (flavor.ts)
  const text = toSlack(textOf(e));
  const files = filesOf(e);
  const re = tsOf(event.payload?.ref_external_id);
  const reaction = (event.parts ?? []).find((p) => p.type === "data" && p.kind === "reaction") as {
    data?: { unicode?: string; name?: string };
  } | undefined;
  if (reaction) {
    const glyph = reaction.data?.unicode ?? reaction.data?.name ?? "";
    return { target: { connection, channel }, text: "", files: [], event, re, glyph };
  }
  const action = event.payload?.action;
  if (action === "delete") {
    return { target: { connection, channel }, text: "", files: [], event, re };
  }
  if (!text && files.length === 0) return null;
  return { target: { connection, channel }, text, files, event, re };
}

/** `slack:<team>:<channel>:<ts>` → the `ts` the API takes. A reference minted anywhere else
 *  (another service, a local row) names nothing here and is dropped rather than guessed at. */
function tsOf(externalId?: string): string | undefined {
  if (!externalId?.startsWith("slack:")) return undefined;
  const ts = externalId.slice(externalId.lastIndexOf(":") + 1);
  return ts.length > 0 ? ts : undefined;
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
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const dir = "./data";
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);

  // one form-encoded Web-API call (the upload endpoints don't take JSON); a non-2xx
  // transport answer (429, 5xx) keeps its real status, a named `ok: false` gets its
  // class assigned (`slackErrorCode`)
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
    if (!res.ok) {
      await res.body?.cancel();
      throw new DispatchError(`${method}: HTTP ${res.status}`, res.status);
    }
    const out = await res.json() as T;
    if (!out.ok) throw new DispatchError(`${method}: ${out.error}`, slackErrorCode(out.error));
    return out;
  };

  // the token resolver (§4, dispatcher-internal): the author's own grant (alter-ego)
  // → the workspace bot — vault keys follow the connector's convention (§4)
  const tokenFor = async (connection: string, author?: string): Promise<string> => {
    const team = teamOf(connection);
    const user = author ? await creds.get(`slack:${team}:${author}`) : null;
    const bot = user?.value.token ? null : await creds.get(`slack:${team}:org`);
    const token = user?.value.token ?? bot?.value.token ?? Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) throw new Error(`no token for connection ${connection}`);
    return token;
  };

  const post: SlackPost = async ({ connection, channel }, text, author, files, threadTs) => {
    const token = await tokenFor(connection, author);

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
        if (!putRes.ok) {
          throw new DispatchError(`upload ${name}: HTTP ${putRes.status}`, putRes.status);
        }
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
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      // the share's ts when the response carries one; absent, the echo lands as its own
      // row. No posting identity in this response shape — the echo stamps sender (§4)
      const shares = done.files?.[0]?.shares;
      return { ts: (shares?.public?.[channel] ?? shares?.private?.[channel])?.[0]?.ts };
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text: body, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new DispatchError(`chat.postMessage: HTTP ${res.status}`, res.status);
    }
    const out = await res.json() as ChatPostMessageResponse;
    if (!out.ok) {
      throw new DispatchError(`chat.postMessage: ${out.error}`, slackErrorCode(out.error));
    }
    // `message.user` = the wire naming who posted — the send-response sender fact (§4)
    return { ts: out.ts, user: out.message?.user };
  };

  const react: SlackReact = async ({ connection, channel }, { ts, glyph, remove }, author) => {
    const token = await tokenFor(connection, author);
    const name = slackEmojiName(glyph);
    if (!name) throw new DispatchError(`Slack has no name for ${glyph}`, 400);
    const method = remove ? "reactions.remove" : "reactions.add";
    const out = await api<{ ok: boolean; error?: string }>(method, token, {
      channel,
      timestamp: ts,
      name,
    });
    // already there / already gone is the state we wanted, not a failure
    if (!out.ok && out.error !== "already_reacted" && out.error !== "no_reaction") {
      throw new DispatchError(`${method}: ${out.error}`, slackErrorCode(out.error));
    }
  };

  const amend: SlackAmend = async ({ connection, channel }, { ts, action, text }, author) => {
    const token = await tokenFor(connection, author);
    const method = action === "edit" ? "chat.update" : "chat.delete";
    const out = await api<{ ok: boolean; error?: string }>(method, token, {
      channel,
      ts,
      ...(action === "edit" ? { text } : {}),
    });
    if (!out.ok) throw new DispatchError(`${method}: ${out.error}`, slackErrorCode(out.error));
  };

  const { logDirectory } = await import("../mentions.ts");
  createSlackDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post,
    react,
    amend,
    directory: logDirectory((q) => log.read(q)),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, ts) =>
      console.error(`[slack-dispatch] sent → ${e.envelope.conversation.address} (ts ${ts})`),
    onError: (e, err) =>
      console.error(`[slack-dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[slack-dispatch] watching ${dir}/log for outbound slack sends`);
}
