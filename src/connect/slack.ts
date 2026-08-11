/**
 * connect/slack.ts — the Slack ingest as a portable webhook FUNCTION (open-bsp shape).
 *
 * Canonically an **Events API webhook**: `(Request) => Response` — url_verification
 * challenge, signing-secret verification, event_callback → map → publish. That is the
 * edge-deployable piece (a request URL on the app, the same function behind it).
 *
 * **Socket Mode is a carrier, not an architecture**: locally, a thin runner opens the
 * `xapp` WebSocket, acks envelopes, and feeds each payload to the SAME handler as a
 * synthetic POST — the way `gh webhook forward` carries GitHub webhooks to our HTTP
 * ingest. One pipeline, two transports; the edge tier drops the carrier and keeps the
 * function (§9 deployment tiers).
 *
 * Mapping (§3, §4): a message in channel C of team T → a mu `message` in conversation
 * `C`, `external_id = slack:T:C:<ts>` — Slack's ts is the per-channel message id, so
 * retries, EDITS (`message_changed` carries the same ts), and our own dispatched
 * messages echoing back all MERGE via the store's upsert (the merge key is TEAM-scoped,
 * so the same message arriving through two legs converges). No author-based skip (§4).
 *
 * **Events anchor to the workspace's standing** (§4): `<team>:<bot user>` when the BOT
 * witnessed the delivery (`is_bot` in `authorizations` — the workspace reads as the org
 * exactly there; the bot's grant row is ownerless + org-credentialed ⇒ shared, §6), the
 * bare `<team>` when only personal grants did (the stub row — membership-only). A human
 * grant never anchors an event: a delivery is authorized for many at once. The human
 * grant rows (`<team>:<user>`, owned) are the identity/credential map: senders classify
 * against them, credentials hang off them.
 *
 * Ingest is a CLASSIFIER (§3) and the connection's map-writer (§4): `channel_type` stamps
 * `conversation.kind` (im/mpim are member-defined → direct); a sender resolves by point
 * lookup of its GRANT row (`<team>:<user>`, owned) on the connections map — any sender
 * classifies; and memberships MIRROR the wire — join/leave events plus the passive leg
 * (every bound user in a delivery's `authorizations` is a member of the conversation).
 * File attachments go through the MEDIA seam (§5): downloaded broker-side with the
 * connection's credential into the conversation's media shelf; the message carries
 * `FilePart`s pointing at local paths — `url_private` and the token never cross the
 * frontier. Event shapes are Slack's OWN (`@slack/types` — the open-bsp lesson:
 * hand-rolled API types encode assumptions the API never promised).
 */

import type { MemberJoinedChannelEvent, MemberLeftChannelEvent, SlackEvent } from "@slack/types";
import type { Appender } from "../store/log.ts";
import type { Connections } from "../store/connections.ts";
import type { Conversation, Draft, FilePart, MessageEvent, Part } from "../types.ts";

/** The wire's file attachment — only the fields the media seam reads. */
export interface SlackFileRef {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  size?: number;
}

/** The media seam (§9): download BROKER-side with the connection's credential and land
 *  the bytes in the media store — the platform URL + token never cross the frontier.
 *  `users` = the delivery's authorized user ids (the token-resolution candidates).
 *  Returns the local `FilePart`, or null (no credential, fetch failed) — the message
 *  still publishes with whatever parts it has. */
export type SlackMedia = (
  file: SlackFileRef,
  ctx: { team: string; conversation: string; users: string[] },
) => Promise<FilePart | null>;

export interface SlackWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The classifier + mirror seam (§3, §4): `connection` resolves grant rows (sender →
   *  owner); memberships mirror joins/leaves and event visibility. Absent ⇒ pure mapping
   *  (an edge tier serving without the store). */
  store?: Pick<Connections, "connection" | "upsertMemberships" | "deleteMemberships">;
  /** File attachments → the media store (absent ⇒ files are dropped, text still flows). */
  media?: SlackMedia;
  /** App signing secret. If set, `X-Slack-Signature` is REQUIRED and verified; absent ⇒
   *  unsigned accepted (dev / the Socket Mode carrier, already authed by `xapp`). */
  signingSecret?: string;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** Build the ingest handler. Pure over its deps — call once, serve (or carry) anywhere. */
export function createSlackWebhook(deps: SlackWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    const body = await req.text(); // raw bytes — verify BEFORE parsing

    if (deps.signingSecret) {
      const ts = req.headers.get("x-slack-request-timestamp") ?? "";
      const sig = req.headers.get("x-slack-signature") ?? "";
      if (!(await verify(deps.signingSecret, ts, body, sig))) return text(401, "bad signature");
    }

    let payload: EventsEnvelope;
    try {
      payload = JSON.parse(body) as EventsEnvelope;
    } catch {
      return text(400, "invalid json");
    }

    // the Events API handshake — echo the challenge, never touch the log
    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (payload.type !== "event_callback") return text(202, `ignored: ${payload.type}`);

    const team = payload.team_id;
    const e = payload.event;
    if (!team || !e) return text(202, "ignored");

    // the membership mirror, active leg (§4): joins/leaves move rows, nothing published
    if (e.type === "member_joined_channel" || e.type === "member_left_channel") {
      mirrorMember(e, team, deps.store);
      return text(202, "membership");
    }
    if (e.type !== "message") return text(202, `ignored: ${e.type}`);

    const anchor = anchorOf(team, payload.authorizations);
    const msg = await mapMessage(
      e,
      team,
      anchor,
      payload.authorizations,
      deps.store,
      deps.media,
      { now },
    );
    if (!msg) return text(202, "ignored");
    try {
      await deps.publish(msg);
    } catch {
      return text(500, "publish failed");
    }
    return text(202, "accepted");
  };
}

/* ── mapping: Slack event → a mu message (channel address + workspace anchor) ── */

interface MapCtx {
  now: () => string;
}

type Store = NonNullable<SlackWebhookDeps["store"]>;

/** The delivery's anchor (§4): the BOT's own grant (`<team>:<bot user>`) when the bot
 *  witnessed it, the bare workspace when only personal grants did. */
function anchorOf(team: string, auths: Authorization[] | undefined): string {
  const bot = auths?.find((a) => a.is_bot && a.user_id);
  return bot ? `${team}:${bot.user_id}` : team;
}

/** The classifier (§3): who a wire user IS — a point lookup of the sender's grant row
 *  (`<team>:<user>`, owned) on the connections map. Any sender classifies, not just the
 *  delivery's own user. */
function ownerOf(store: Store | undefined, team: string, user: string | undefined): string | null {
  if (!store || !user) return null;
  return store.connection("slack", `${team}:${user}`)?.agentId ?? null;
}

/** `channel_type` → `conversation.kind` (§4): im/mpim are member-DEFINED (direct — the
 *  member set is the address), `group` a private room, `channel` a public one; app_home
 *  is a 1:1 surface → direct. Stamped from the platform fact, never counted (§3). */
const KIND: Record<string, NonNullable<Conversation["kind"]>> = {
  im: "direct",
  mpim: "direct",
  app_home: "direct",
  group: "group",
  channel: "channel",
};

async function mapMessage(
  e: Extract<SlackEvent, { type: "message" }>,
  team: string,
  anchor: string,
  authorizations: Authorization[] | undefined,
  store: Store | undefined,
  media: SlackMedia | undefined,
  ctx: MapCtx,
): Promise<Draft<MessageEvent> | null> {
  // a delete marks, never removes (the log is append-only — same policy as WhatsApp
  // revokes): a MERGE-ONLY draft — no `parts` key, so the upsert's `json_patch` leaves
  // the stored payload untouched and only `extra.slack.deleted_at` lands
  if (e.subtype === "message_deleted") {
    if (!e.deleted_ts || !e.channel) return null;
    return {
      ts: ctx.now(),
      type: "message",
      envelope: {
        service: "slack",
        connection_address: anchor,
        conversation: { address: e.channel },
        external_id: `slack:${team}:${e.channel}:${e.deleted_ts}`,
      },
      extra: { slack: { deleted_at: e.event_ts ?? ctx.now() } },
    } as unknown as Draft<MessageEvent>; // partless by design — see above
  }

  // plain message, an edit (message_changed nests the message; same ts ⇒ same row), or a
  // file share (file_share is a plain message carrying `files` — same row semantics)
  const inner = e.subtype === "message_changed" ? e.message : e;
  const m = inner.subtype === undefined || inner.subtype === "file_share" ? inner : null;
  const files = (m as { files?: SlackFileRef[] } | null)?.files;
  if (!m?.ts || !e.channel || (!m.text && !files?.length)) return null;

  const conversation = e.channel; // the platform's own id — service/connection ride the envelope (§3)
  const who = ownerOf(store, team, m.user);
  // the membership mirror, passive leg (§4): the delivery's `authorizations` are the
  // users this event is visible to — every BOUND one is a member of this conversation;
  // messages fill the map
  if (store && authorizations) {
    const members = authorizations
      .filter((a) => !a.is_bot)
      .map((a) => ownerOf(store, team, a.user_id))
      .filter((id) => id !== null)
      .map((id) => ({ service: "slack", connection: team, conversation, agentId: id }));
    if (members.length) store.upsertMemberships(members);
  }

  // body: the text (when any), then each attachment the media seam could land — a file
  // that fails to download drops silently (the path is re-fetchable; the message isn't)
  const parts: Part[] = [];
  if (m.text) parts.push({ type: "text", kind: "text", text: m.text });
  if (media && files) {
    for (const f of files) {
      const p = await media(f, {
        team,
        conversation,
        users: (authorizations ?? []).filter((a) => !a.is_bot && a.user_id).map((a) => a.user_id),
      });
      if (p) parts.push(p);
    }
  }
  if (parts.length === 0) return null;

  const kind = KIND[e.channel_type];
  return {
    ts: ctx.now(),
    type: "message",
    envelope: {
      service: "slack",
      connection_address: anchor,
      conversation: { address: conversation, ...(kind ? { kind } : {}) },
      sender: m.user ? { address: m.user, ...(who ? { name: who } : {}) } : undefined,
      // the upsert/merge key: Slack's ts is the per-channel message id (§3, §4)
      external_id: `slack:${team}:${e.channel}:${m.ts}`,
    },
    parts,
    // the wire-derived sidecar (§3): only what the envelope has no slot for — the wire's
    // event shape and the delivery's authorization entries verbatim (`is_bot` included:
    // the org-readability ingredient the acl refinement reads later; memberships hold
    // the membership consequence)
    ...(e.subtype || authorizations
      ? {
        extra: {
          slack: {
            ...(e.subtype ? { subtype: e.subtype } : {}),
            ...(authorizations ? { authorizations } : {}),
          },
        },
      }
      : {}),
  };
}

/** Join/leave → the membership row moves when the mover is a bound user. Unbound movers
 *  aren't ours — nothing to mirror. */
function mirrorMember(
  e: MemberJoinedChannelEvent | MemberLeftChannelEvent,
  team: string,
  store: Store | undefined,
): void {
  const who = ownerOf(store, team, e.user);
  if (!store || !who) return;
  const row = {
    service: "slack",
    connection: team,
    conversation: e.channel,
    agentId: who,
  };
  if (e.type === "member_joined_channel") store.upsertMemberships([row]);
  else store.deleteMemberships([row]); // a leave ends the lifetime — seen history stays (§6)
}

/* ── signature verification (Web-standard, constant-time; replay-bounded) ── */

const encoder = new TextEncoder();
const FRESH_MS = 5 * 60 * 1000;

async function verify(secret: string, ts: string, body: string, header: string): Promise<boolean> {
  if (!ts || Math.abs(Date.now() - Number(ts) * 1000) > FRESH_MS) return false; // replay guard
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, header);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── the Events API wrapper. `@slack/types` covers the INNER events only (the outer
 *    envelope is Bolt's, not typed by the platform package) — only the fields we read. ── */

interface Authorization {
  user_id: string;
  is_bot?: boolean;
}

interface EventsEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  /** the installed user this delivery is for — what names the LEG (§4) */
  authorizations?: Authorization[];
  event?: SlackEvent;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── the Socket Mode carrier (local transport for the same handler) ─────── */

/** Open the `xapp` socket and feed every events_api envelope to `handler` as a synthetic
 *  POST, acking each envelope. Reconnects on disconnect/close. Returns a stop(). */
export function slackSocket(appToken: string, handler: WebhookHandler): () => void {
  let ws: WebSocket | undefined;
  let closed = false;

  const connect = async () => {
    if (closed) return;
    try {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { authorization: `Bearer ${appToken}` },
      });
      const open = await res.json() as { ok: boolean; url?: string; error?: string };
      if (!open.ok || !open.url) throw new Error(`connections.open: ${open.error}`);
      ws = new WebSocket(open.url);
      ws.onmessage = async (evt) => {
        const env = JSON.parse(String(evt.data)) as {
          type?: string;
          envelope_id?: string;
          payload?: unknown;
        };
        if (env.envelope_id) ws?.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack fast
        if (env.type === "events_api" && env.payload) {
          await handler(
            new Request("http://socket-mode.local/", {
              method: "POST",
              body: JSON.stringify(env.payload),
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (env.type === "disconnect") ws?.close();
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1_000); // Slack refreshes sockets routinely
      };
    } catch (err) {
      console.error("[slack] socket error:", err instanceof Error ? err.message : err);
      if (!closed) setTimeout(connect, 5_000);
    }
  };
  connect();

  return () => {
    closed = true;
    ws?.close();
  };
}

/* ── local entry: Socket Mode carrier (SLACK_APP_TOKEN) or HTTP (PORT) ──────
 *
 *   deno task ingest:slack       # xapp set → socket mode; else HTTP on :8789
 *
 * Env: MU_DIR · SLACK_APP_TOKEN (socket mode) · SLACK_SIGNING_SECRET (HTTP mode) · PORT. */
if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const { openCredentials } = await import("../store/credentials.ts");
  const { kindOf, saveMedia } = await import("../store/media.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const appToken = Deno.env.get("SLACK_APP_TOKEN");

  // the media seam, broker-side (§9): resolve a token that can read `url_private`
  // (the org bot → any authorized grant → env), download, land in the media store —
  // the URL and the token stay on this side of the frontier
  const tokenFor = async (team: string, users: string[]): Promise<string | null> => {
    const org = await creds.get(`slack:${team}:org`);
    if (org?.value.token) return org.value.token;
    for (const u of users) {
      const key = log.connection("slack", `${team}:${u}`)?.credentialKey;
      const c = key ? await creds.get(key) : null;
      if (c?.value.token) return c.value.token;
    }
    return Deno.env.get("SLACK_BOT_TOKEN") ?? null;
  };
  const media: SlackMedia = async (f, ctx) => {
    if (!f.url_private) return null;
    const token = await tokenFor(ctx.team, ctx.users);
    if (!token) return null;
    try {
      const res = await fetch(f.url_private, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const file = await saveMedia(dir, ctx.conversation, bytes, {
        mime_type: f.mimetype,
        name: f.name,
      });
      return { type: "file", kind: kindOf(file.mime_type), file };
    } catch (err) {
      console.error("[slack] media download failed:", err instanceof Error ? err.message : err);
      return null;
    }
  };

  const handler = createSlackWebhook({
    publish: log.publish, // no wrapper: keep the overloads (it closes over the db, not `this`)
    store: log, // identities + memberships live on the Log (§4) — the wire fills the map
    media,
    signingSecret: appToken ? undefined : Deno.env.get("SLACK_SIGNING_SECRET") || undefined,
  });
  if (appToken) {
    console.error(`[slack] socket-mode ingest → ${dir}/log`);
    slackSocket(appToken, handler);
  } else {
    const port = Number(Deno.env.get("PORT") ?? 8789);
    console.error(`[slack] HTTP ingest on :${port} → ${dir}/log (Events API request URL)`);
    Deno.serve({ port }, handler);
  }
}
