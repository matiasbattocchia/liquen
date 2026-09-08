/**
 * connect/slack/ingest.ts — the Slack ingest as a portable webhook FUNCTION (open-bsp shape).
 *
 * Canonically an **Events API webhook**: `(Request) => Response` — url_verification
 * challenge, signing-secret verification, event_callback → map → publish. That is the
 * edge-deployable piece (a request URL on the app, the same function behind it).
 *
 * **Socket Mode is a carrier, not an architecture**: locally, a thin runner opens the
 * `xapp` WebSocket, feeds each payload to the SAME handler as a synthetic POST, and acks
 * the envelope on the handler's 2xx — the way `gh webhook forward` carries GitHub webhooks
 * to our HTTP ingest. One pipeline, two transports; the edge tier drops the carrier and
 * keeps the function (§9 deployment tiers).
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
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Conversation, Draft, FilePart, MessageEvent, Part } from "../../types.ts";
import { fromSlack } from "../flavor.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";

/** The wire's file attachment — only the fields the media seam reads. */
export interface SlackFileRef {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  size?: number;
}

/** Slack answers a `url_private` fetch the token may not read with its sign-in page —
 *  HTTP 200, `text/html` — so an HTML body for a file that is not HTML is a refusal, not
 *  the file. No content-type header ⇒ no verdict. */
export function looksLikeSignIn(
  claimedMime: string | undefined,
  responseContentType: string | null,
): boolean {
  if (!responseContentType?.toLowerCase().startsWith("text/html")) return false;
  return !claimedMime?.toLowerCase().startsWith("text/html");
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

/** The name directory (§3): `sender.name` is the SERVICE's display fact, and Slack's
 *  events carry none — so the connector asks the service itself (`users.info`) and
 *  remembers the answer. The moral twin of WhatsApp's pushname: same fact, pulled
 *  instead of broadcast. Nothing of OURS — identity resolution stays the classifier's. */
export interface SlackNames {
  /** Display name for a user id — cached after the first hit; null = unresolvable right
   *  now (no token, API miss) and UNCACHED, so a later delivery retries. `via` = the
   *  delivery's token-resolution candidates (same role as SlackMedia's `users`). */
  nameOf(team: string, user: string, via?: string[]): Promise<string | null>;
  /** The push leg: `user_change` deliveries carry the fresh profile — no call needed. */
  learn(team: string, user: string, name: string): void;
}

/** Build the directory over a token source (same shape the media seam resolves with):
 *  `users.info` per first sight, one in-flight call per user, successes cached for the
 *  process lifetime (fill-merge in the store means one resolution per user is all a
 *  name ever needs). */
export function slackNames(
  tokenFor: (team: string, users: string[]) => Promise<string | null>,
): SlackNames {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const nameOf = (team: string, user: string, via: string[] = []): Promise<string | null> => {
    const key = `${team}:${user}`;
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const going = inflight.get(key);
    if (going) return going;
    const p = (async () => {
      try {
        const token = await tokenFor(team, [user, ...via]);
        if (!token) return null;
        const res = await timedFetch(`https://slack.com/api/users.info?user=${user}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await res.json() as {
          ok: boolean;
          user?: { name?: string; profile?: { display_name?: string; real_name?: string } };
        };
        const u = body.ok ? body.user : undefined;
        const name = u?.profile?.display_name || u?.profile?.real_name || u?.name || null;
        if (name) cache.set(key, name);
        return name;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
  return { nameOf, learn: (team, user, name) => cache.set(`${team}:${user}`, name) };
}

export interface SlackWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The classifier + mirror seam (§3, §4): `connection` resolves grant rows (sender →
   *  owner); memberships mirror joins/leaves and event visibility. Absent ⇒ pure mapping
   *  (an edge tier serving without the store). */
  store?: Pick<Connections, "connection" | "upsertMemberships" | "deleteMemberships">;
  /** File attachments → the media store (absent ⇒ files are dropped, text still flows). */
  media?: SlackMedia;
  /** The name directory (absent ⇒ senders ship bare ids, mentions decode to `@<id>`). */
  names?: SlackNames;
  /** The apps' signing secrets. Set ⇒ `X-Slack-Signature` is REQUIRED and must verify
   *  under one of them (one server, every app the vault holds); absent ⇒ unsigned
   *  accepted — the Socket Mode carrier, already authed by `xapp`. */
  signingSecrets?: string[];
  /** The response's timing. PRESENT (HTTP mode): the 200 goes out first and each
   *  delivery's processing is handed here as it starts — Slack re-delivers anything
   *  unanswered within its window, so the wire is answered before the log is, and the
   *  entry awaits these on stop so nothing in flight is cut off. ABSENT (a carrier that
   *  acks for itself): the handler answers only once the processing settled — 200 when the
   *  publish landed, 500 when it did not — so the carrier's ack means the row exists. */
  track?: (work: Promise<void>) => void;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** Build the ingest handler. Pure over its deps — call once, serve (or carry) anywhere. */
export function createSlackWebhook(deps: SlackWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    const body = await req.text(); // raw bytes — verify BEFORE parsing

    if (deps.signingSecrets) {
      const ts = req.headers.get("x-slack-request-timestamp") ?? "";
      const sig = req.headers.get("x-slack-signature") ?? "";
      let signed = false;
      for (const secret of deps.signingSecrets) {
        if (await verify(secret, ts, body, sig, now)) signed = true;
      }
      if (!signed) return text(401, "bad signature");
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

    // verified and parsed. With `track`: ack now, process behind the response — a failure
    // there has no wire to answer on, so stderr is where it lands. Without it: the answer
    // IS the outcome, and the caller (a carrier) acks or refuses on it
    if (deps.track) {
      deps.track(
        handle(payload).catch((err) => {
          console.error(
            `[ingest] ${payload.event?.type ?? "event"} in ${payload.team_id ?? "?"} failed:`,
            err instanceof Error ? err.message : err,
          );
        }),
      );
      return text(200, "accepted");
    }
    try {
      await handle(payload);
      return text(200, "accepted");
    } catch (err) {
      return text(500, err instanceof Error ? err.message : String(err));
    }
  };

  async function handle(payload: EventsEnvelope): Promise<void> {
    const team = payload.team_id;
    const e = payload.event;
    if (!team || !e) return;

    // the name directory's push leg: profile changes arrive as events — the fresh fact
    // lands in the cache, nothing published
    if (e.type === "user_change") {
      const u = (e as {
        user?: {
          id?: string;
          name?: string;
          profile?: { display_name?: string; real_name?: string };
        };
      }).user;
      const name = u?.profile?.display_name || u?.profile?.real_name || u?.name;
      if (u?.id && name) deps.names?.learn(team, u.id, name);
      return;
    }
    // the membership mirror, active leg (§4): joins/leaves move rows, nothing published
    if (e.type === "member_joined_channel" || e.type === "member_left_channel") {
      mirrorMember(e, team, deps.store);
      return;
    }
    // a reaction is an ACTION event (§3): add/remove + the reacted message's id in
    // ref_external_id, the ReactionPart carrying what changed; identity is the
    // delivery's event_ts, so retries dedupe
    if (e.type === "reaction_added" || e.type === "reaction_removed") {
      const item = e.item;
      if (item?.type !== "message" || !item.channel || !item.ts) return;
      const anchor = anchorOf(team, payload.authorizations);
      const who = e.user
        ? await deps.names?.nameOf(team, e.user, boundUsers(payload.authorizations))
        : undefined;
      // same classifier stamp as messages (§3): the reactor's grant row names the mind
      const owner = e.user && deps.store ? ownerOf(deps.store, team, e.user) : null;
      await deps.publish({
        ts: now(),
        type: "message",
        ...(owner ? { agent: { id: owner } } : {}),
        payload: {
          action: e.type === "reaction_added" ? "add" : "remove",
          ref_external_id: `slack:${team}:${item.channel}:${item.ts}`,
        },
        envelope: {
          service: "slack",
          connection_address: anchor,
          conversation: { address: item.channel },
          ...(e.user ? { sender: { address: e.user, ...(who ? { name: who } : {}) } } : {}),
          external_id: `slack:${team}:${item.channel}:${e.event_ts}`,
        },
        parts: [{ type: "data", kind: "reaction", data: { name: e.reaction } }],
      });
      return;
    }
    if (e.type !== "message") return;

    const anchor = anchorOf(team, payload.authorizations);
    const msgs = await mapMessage(
      e,
      team,
      anchor,
      payload.authorizations,
      deps.store,
      deps.media,
      deps.names,
      { now },
    );
    if (msgs.length === 0) return;
    await deps.publish(msgs);
  }
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

/** The delivery's token-resolution candidates: its bound (non-bot) authorized users. */
function boundUsers(auths: Authorization[] | undefined): string[] {
  return (auths ?? []).filter((a) => !a.is_bot && a.user_id).map((a) => a.user_id);
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
  names: SlackNames | undefined,
  ctx: MapCtx,
): Promise<Draft<MessageEvent>[]> {
  // a delete marks, never removes (the log is append-only — same policy as WhatsApp
  // revokes) — TWO drafts (§3): the delete EVENT (action delete, empty parts, the
  // original in ref_external_id — what a later WUM renders; its own id is the delivery's
  // event_ts), and the merge-only `status.deleted_at` stamp on the original row
  if (e.subtype === "message_deleted") {
    if (!e.deleted_ts || !e.channel) return [];
    const originalId = `slack:${team}:${e.channel}:${e.deleted_ts}`;
    const ts = ctx.now();
    return [{
      ts,
      type: "message",
      payload: { action: "delete", ref_external_id: originalId },
      envelope: {
        service: "slack",
        connection_address: anchor,
        conversation: { address: e.channel },
        external_id: `slack:${team}:${e.channel}:${e.event_ts ?? `del.${e.deleted_ts}`}`,
      },
      parts: [],
    }, {
      ts,
      type: "message",
      envelope: {
        service: "slack",
        connection_address: anchor,
        conversation: { address: e.channel },
        external_id: originalId,
      },
      status: { state: "deleted", deleted_at: e.event_ts ?? ts },
    } as unknown as Draft<MessageEvent>]; // the stamp is partless by design
  }

  // plain message, an edit (message_changed nests the new content — its OWN event, the
  // original row untouched), or a file share (file_share is a plain message carrying
  // `files` — same row semantics)
  const edit = e.subtype === "message_changed";
  // a message_changed is an EDIT only when the inner message says so (`edited`) or its
  // text differs from `previous_message`'s: Slack also re-delivers a message under this
  // subtype when its attachments change (a link unfurling), the text untouched, and that
  // delivery states nothing the row does not already hold
  if (edit) {
    const changed = e.message as { edited?: unknown; text?: string };
    const previous = e.previous_message as { text?: string } | undefined;
    if (changed.edited === undefined && changed.text === previous?.text) return [];
  }
  const inner = edit ? e.message : e;
  const m = inner.subtype === undefined || inner.subtype === "file_share" ? inner : null;
  const files = (m as { files?: SlackFileRef[] } | null)?.files;
  if (!m?.ts || !e.channel || (!m.text && !files?.length)) return [];

  const conversation = e.channel; // the platform's own id — service/connection ride the envelope (§3)
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
  // that fails to download drops silently (the path is re-fetchable; the message isn't).
  // Mentions live INLINE in mrkdwn (`<@U…>`) — an encoding no Slack client ever shows:
  // decode to display form, lift the addresses to payload.mentions (§3)
  const via = boundUsers(authorizations);
  const parts: Part[] = [];
  let mentions: MentionEntry[] = [];
  if (m.text) {
    const d = await decodeMentions(m.text, team, names, via);
    mentions = d.mentions;
    // mrkdwn → common markdown, here at the frontier (flavor.ts): the log speaks one tongue
    parts.push({ type: "text", kind: "text", text: fromSlack(d.text) });
  }
  if (media && files) {
    for (const f of files) {
      const p = await media(f, { team, conversation, users: via });
      if (p) parts.push(p);
    }
  }
  if (parts.length === 0) return [];

  const kind = KIND[e.channel_type];
  // an edit is its own event (§3): action + the original's id; the delivery's event_ts
  // is its identity, so retries dedupe and the original's row never re-opens. A plain
  // message inside a thread is a REPLY to the thread's root: Slack threads are one level
  // deep, so `thread_ts` always names the root, and a root carries its own ts there
  const threadTs = (m as { thread_ts?: string }).thread_ts;
  const reply = !edit && threadTs !== undefined && threadTs !== m.ts;
  const payload = {
    ...(edit
      ? { action: "edit" as const, ref_external_id: `slack:${team}:${e.channel}:${m.ts}` }
      : reply
      ? { action: "reply" as const, ref_external_id: `slack:${team}:${e.channel}:${threadTs}` }
      : {}),
    ...(mentions.length ? { mentions } : {}),
  };
  // sender.name is the SERVICE's display fact — Slack's events carry none, so the name
  // directory asks the service itself (users.info / user_change); still nothing of ours:
  // identity resolution is the classifier's business (§3)
  const who = m.user ? await names?.nameOf(team, m.user, via) : undefined;
  // the classifier's authorship stamp (§3): a sender whose grant row names a mind is that
  // principal — `agent.id` alone (a Slack client is not the harness, so no session_id);
  // turn_id, never this stamp, marks the model's voice
  const owner = m.user && store ? ownerOf(store, team, m.user) : null;
  return [{
    ts: ctx.now(),
    type: "message",
    ...(owner ? { agent: { id: owner } } : {}),
    ...(Object.keys(payload).length ? { payload } : {}),
    envelope: {
      service: "slack",
      connection_address: anchor,
      conversation: { address: conversation, ...(kind ? { kind } : {}) },
      sender: m.user ? { address: m.user, ...(who ? { name: who } : {}) } : undefined,
      // the upsert/merge key: Slack's ts is the per-channel message id (§3, §4) — for an
      // edit, the change delivery's own ts
      external_id: edit
        ? `slack:${team}:${e.channel}:${e.event_ts ?? `edit.${m.ts}`}`
        : `slack:${team}:${e.channel}:${m.ts}`,
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
  }];
}

/** Slack's mention encodings → display text + `payload.mentions` entries. `<@U123>`
 *  (rarely `<@U123|label>`) decodes to `@<display name>` — resolved name first (the
 *  label is legacy and can be stale; Slack's own guidance is to resolve the id), then
 *  the label, then the bare id. `<#C123|general>` decodes to `#general` (`type: "#"`;
 *  the label rides the delivery, no lookup). `<!here>` etc decode to `@here` — control
 *  words, not addresses: text only. The entries keep the wire facts the decode spends,
 *  each address paired with the display the text now wears. */
const MENTION = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;
const CHANNEL = /<#([A-Z0-9]+)(?:\|([^>]*))?>/g;
const SPECIAL = /<!(here|channel|everyone)>/g;

type MentionEntry = { address: string; name?: string; type?: "#" };

async function decodeMentions(
  text: string,
  team: string,
  names: SlackNames | undefined,
  via: string[],
): Promise<{ text: string; mentions: MentionEntry[] }> {
  const ids = [...new Set([...text.matchAll(MENTION)].map((m) => m[1]))];
  const resolved = new Map<string, string>();
  for (const id of ids) {
    const n = await names?.nameOf(team, id, via);
    if (n) resolved.set(id, n);
  }
  const mentions: MentionEntry[] = [];
  const seen = new Set<string>();
  const claim = (e: MentionEntry) => {
    if (!seen.has(e.address)) {
      seen.add(e.address);
      mentions.push(e);
    }
  };
  const out = text
    .replace(MENTION, (_, id, label) => {
      const name = resolved.get(id) ?? label;
      claim({ address: id, ...(name ? { name } : {}) });
      return `@${name ?? id}`;
    })
    .replace(CHANNEL, (_, id, label) => {
      claim({ address: id, ...(label ? { name: label } : {}), type: "#" });
      return `#${label || id}`;
    })
    .replace(SPECIAL, "@$1");
  return { text: out, mentions };
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
/** Slack refreshes sockets routinely, so a close is the normal case and reconnects fast;
 *  an error means the far side is unwell and the wait is longer. */
const RECONNECT_MS = 1_000;
const RECONNECT_ERROR_MS = 5_000;

async function verify(
  secret: string,
  ts: string,
  body: string,
  header: string,
  now: () => string,
): Promise<boolean> {
  // the replay guard, against the ingest's own clock (§9) — ms derived from the ISO stamp
  if (!ts || Math.abs(Date.parse(now()) - Number(ts) * 1000) > FRESH_MS) return false;
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

/** apps.connections.open — the socket URL an app-level token is entitled to. */
async function openSocketUrl(appToken: string): Promise<string> {
  const res = await timedFetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  const open = await res.json() as { ok: boolean; url?: string; error?: string };
  if (!open.ok || !open.url) throw new Error(`connections.open: ${open.error}`);
  return open.url;
}

export interface SlackSocketCarrierDeps {
  /** The WebSocket URL for an app-level token; default = apps.connections.open. */
  open?: (appToken: string) => Promise<string>;
}

/** Open the `xapp` socket and feed every events_api envelope to `handler` (built WITHOUT
 *  `track`, so its answer is the outcome) as a synthetic POST. An envelope is acked only
 *  on a 2xx: a refusal or a throw leaves it unacked, logged to stderr, and Slack redelivers
 *  it — the store's external_id upsert makes the redelivery converge. Envelopes that carry
 *  no event (`disconnect`) ack on arrival. Reconnects on disconnect/close. Returns stop:
 *  close the socket, settle the deliveries already being handled. */
export function slackSocket(
  appToken: string,
  handler: WebhookHandler,
  deps: SlackSocketCarrierDeps = {},
): () => Promise<void> {
  let ws: WebSocket | undefined;
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const open = deps.open ?? openSocketUrl;

  const deliver = async (socket: WebSocket, envelopeId: string | undefined, payload: unknown) => {
    const res = await handler(
      new Request("http://socket-mode.local/", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      }),
    );
    if (res.ok) {
      await res.body?.cancel();
      if (envelopeId && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ envelope_id: envelopeId }));
      }
      return;
    }
    console.error(
      `[ingest] envelope ${envelopeId ?? "?"} not acked: HTTP ${res.status} ${await res.text()}`,
    );
  };

  const connect = async () => {
    if (closed) return;
    try {
      const socket = new WebSocket(await open(appToken));
      ws = socket;
      socket.onmessage = async (evt) => {
        try {
          const env = JSON.parse(String(evt.data)) as {
            type?: string;
            envelope_id?: string;
            payload?: unknown;
          };
          if (env.type === "events_api" && env.payload) {
            const delivery = deliver(socket, env.envelope_id, env.payload);
            inFlight.add(delivery);
            delivery.finally(() => inFlight.delete(delivery));
            await delivery;
            return;
          }
          if (env.envelope_id) socket.send(JSON.stringify({ envelope_id: env.envelope_id }));
          if (env.type === "disconnect") socket.close();
        } catch (err) {
          console.error(
            "[ingest] socket delivery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      };
      socket.onclose = () => {
        if (!closed) setTimeout(connect, RECONNECT_MS);
      };
    } catch (err) {
      console.error("[ingest] socket error:", err instanceof Error ? err.message : err);
      if (!closed) setTimeout(connect, RECONNECT_ERROR_MS);
    }
  };
  connect();

  return async () => {
    closed = true;
    ws?.close();
    await Promise.allSettled([...inFlight]);
  };
}

/* ── local entry: Socket Mode carriers (from the vault) or HTTP ─────────────
 *
 *   deno task run:slack       # xapp in the vault → socket mode; else HTTP on :8789
 *
 * Env: none — everything comes from the vault. Socket carriers are the app-level
 * tokens the socket door stored (`mu connect slack socket`), one socket per app (§4). No
 * carrier ⇒ HTTP mode on connections.slack.ingestPort, verified by the apps' signing
 * secrets (`mu connect slack app` stores them); no app, no server. */
/** The secrets an HTTP-mode server verifies with: every app row's `signing_secret`. None
 *  is a refusal to serve — an unverified Events URL would take any POST as the workspace's
 *  word, `authorizations` included. */
export function httpSigningSecrets(apps: { value: Record<string, string> }[]): string[] {
  const secrets = apps.map((a) => a.value.signing_secret).filter((s) => s);
  if (secrets.length === 0) {
    throw new Error(
      "HTTP mode needs a signing secret — `mu connect slack app` stores it, or " +
        "`mu connect slack socket` for Socket Mode",
    );
  }
  return secrets;
}

/** Wire the inbound half over the org's log — resident once it returns (socket or server).
 *  Returns stop: refuse new deliveries, finish the ones in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { SOCKET_PREFIX } = await import("./connect.ts");
  const { kindOf, saveMedia } = await import("../../store/media.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  // socket carriers: one per app-level token in the vault — Socket Mode is app-scoped,
  // and one socket carries every workspace that app is installed in (§4)
  const carriers = [
    ...new Set(
      (await creds.list(SOCKET_PREFIX)).map((r) => r.value.app_token).filter(Boolean),
    ),
  ];

  // the media seam, broker-side (§9): resolve a token that can read `url_private`
  // (the org bot → any authorized grant), download, land in the media store —
  // the URL and the token stay on this side of the frontier
  const tokenFor = async (team: string, users: string[]): Promise<string | null> => {
    const org = await creds.get(`slack:${team}:org`);
    if (org?.value.token) return org.value.token;
    for (const u of users) {
      const key = log.connection("slack", `${team}:${u}`)?.credentialKey;
      const c = key ? await creds.get(key) : null;
      if (c?.value.token) return c.value.token;
    }
    return null;
  };
  const media: SlackMedia = async (f, ctx) => {
    if (!f.url_private) return null;
    const token = await tokenFor(ctx.team, ctx.users);
    if (!token) return null;
    try {
      const res = await timedFetch(f.url_private, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      if (looksLikeSignIn(f.mimetype, res.headers.get("content-type"))) {
        await res.body?.cancel();
        console.error(`[ingest] media ${f.id ?? f.name ?? "?"}: the token cannot read it`);
        return null;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const file = await saveMedia(dir, ctx.conversation, bytes, {
        mime_type: f.mimetype,
        name: f.name,
      });
      return { type: "file", kind: kindOf(file.mime_type), file };
    } catch (err) {
      console.error("[ingest] media download failed:", err instanceof Error ? err.message : err);
      return null;
    }
  };

  // the name directory reads with the same resolution the media seam uses (org bot →
  // any authorized grant → env) — a display name is a workspace fact any grant can read
  const names = slackNames(tokenFor);

  const base: SlackWebhookDeps = {
    publish: log.publish, // no wrapper: keep the overloads (it closes over the db, not `this`)
    store: log, // identities + memberships live on the Log (§4) — the wire fills the map
    media,
    names,
  };
  const release = async () => {
    await creds.close();
    await log.close();
  };
  if (carriers.length > 0) {
    // socket mode: no signing secret (the xapp IS the authentication) and no `track` —
    // the carrier acks on the handler's answer, and each carrier's stop settles the
    // deliveries it still has in hand
    console.error(`[ingest] socket mode, ${carriers.length} carrier(s) → ${dir}/log`);
    const handler = createSlackWebhook(base);
    const stops = carriers.map((t) => slackSocket(t, handler));
    return async () => {
      await Promise.allSettled(stops.map((stop) => stop()));
      await release();
    };
  }
  // HTTP mode verifies with the apps' signing secrets (the app door stores them) and
  // serves nothing without one; deliveries are acked before they are processed, so what
  // is still processing at stop finishes before the handles close
  const { APP_PREFIX } = await import("./connect.ts");
  const signingSecrets = httpSigningSecrets(await creds.list(APP_PREFIX));
  const inFlight = new Set<Promise<void>>();
  const handler = createSlackWebhook({
    ...base,
    signingSecrets,
    track: (work) => {
      inFlight.add(work);
      work.finally(() => inFlight.delete(work));
    },
  });
  const { slackConfig } = await import("./config.ts");
  const { serveIngest } = await import("../serve.ts");
  const port = (await slackConfig(root)).ingestPort;
  const server = serveIngest(
    "connections.slack.ingestPort",
    port,
    handler,
    (bound) => console.error(`[ingest] HTTP on :${bound} → ${dir}/log (Events API request URL)`),
  );
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await Promise.allSettled([...inFlight]);
    await release();
  };
}

if (import.meta.main) await runIngest();
