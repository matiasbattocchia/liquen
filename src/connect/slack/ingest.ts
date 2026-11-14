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
 * **Neither carrier holds the gap.** An event with no socket to take it is gone, and an
 * HTTP delivery is retried for minutes; what a workspace said while nobody listened is in
 * its history alone, so it is read back from there (catchup.ts) — at boot on either
 * carrier, and whenever a socket comes back from more than a blip — through this same
 * mapping, as the events would have carried it. Rows are stamped with the message's own
 * time (`slackTime`) so the read-back and the live delivery of one message are one row.
 *
 * Mapping (§3, §4): a message in channel C of team T → a liquen `message` in conversation
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

import { SENDER_EMAIL } from "../../sender.ts";
import type { MemberJoinedChannelEvent, MemberLeftChannelEvent, SlackEvent } from "@slack/types";
import { roomPart } from "../../room.ts";
import type { Appender } from "../../store/log.ts";
import {
  type ConnectionRow,
  type Connections,
  type ConnectionState,
  mirrorsOf,
} from "../../store/connections.ts";
import { SignedOut } from "../errors.ts";
import { setState } from "../health.ts";
import { createMarks, marked } from "../marks.ts";
import { SIGNED_OUT_NAMES } from "./dispatch.ts";
import type { Registry } from "../../store/agents.ts";
import { sameHandle } from "../../store/roster.ts";
import type {
  Conversation,
  Draft,
  FilePart,
  MessageEvent,
  Part,
  RoomChange,
  RoomMember,
} from "../../types.ts";
import { fromSlack } from "../flavor.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { entry } from "../../entry.ts";

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

/** The name directory (§3): `sender.name` and `conversation.name` are the SERVICE's
 *  display facts, and Slack's events carry neither — so the connector asks the service
 *  itself (`users.info`, `conversations.info`) and remembers the answers. The moral twin
 *  of WhatsApp's pushname and group subject: same facts, pulled instead of broadcast.
 *  Nothing of OURS — identity resolution stays the classifier's. */
export interface SlackNames {
  /** Display name for a user id — cached after the first hit; null = unresolvable right
   *  now (no token, API miss) and UNCACHED, so a later delivery retries. `via` = the
   *  delivery's token-resolution candidates (same role as SlackMedia's `users`). */
  nameOf(team: string, user: string, via?: string[]): Promise<string | null>;
  /** The profile's email for a user id, from the same `users.info` answer (the
   *  `users:read.email` scope; without it the profile carries none and this is null).
   *  The handle the classifier scans the roster with (§4): a member is known by the
   *  email they declared, never by a Slack user id. */
  emailOf(team: string, user: string, via?: string[]): Promise<string | null>;
  /** The push leg: `user_change` deliveries carry the fresh profile — no call needed. */
  learn(team: string, user: string, name: string): void;
  /** Display name for a conversation id — a channel's or private group's subject, a
   *  group DM's `mpdm-…` handle, and for a DM the person on the other end (a DM has no
   *  subject of its own, §3). Cached after the first hit; null = unresolvable right now
   *  and UNCACHED, so a later delivery retries. */
  roomOf(team: string, channel: string, via?: string[]): Promise<string | null>;
  /** The push leg: a room's rename line (`channel_name`, `group_name`) and a new
   *  channel's `channel_created` carry the subject. */
  learnRoom(team: string, channel: string, name: string): void;
  /** What the crowd rule reads of a channel (`connect/marks.ts`), from the same
   *  `conversations.info` answer the name comes from: how many members it has and who
   *  created it. Null for a DM or an mpim, which need neither, and for a room
   *  unresolvable right now. */
  factsOf(team: string, channel: string, via?: string[]): Promise<RoomFacts | null>;
}

/** A channel as `conversations.info` counts it (`include_num_members`). */
export interface RoomFacts {
  members?: number;
  /** The user id that created the channel. */
  creator?: string;
}

/** How long a channel's facts stand before `conversations.info` is asked again: the
 *  method is Tier 3, some fifty calls a minute per workspace, so even hundreds of busy
 *  channels refresh well inside it. A count drifts by the few who came and went. */
export const ROOM_FACTS_MS = 15 * 60_000;

/** Build the directory over a token source (same shape the media seam resolves with):
 *  `users.info` per first sight, one in-flight call per user, successes cached for the
 *  process lifetime (fill-merge in the store means one resolution per user is all a
 *  name ever needs). A room's name is held as long; its facts for `ROOM_FACTS_MS`. */
export function slackNames(
  tokenFor: (team: string, users: string[]) => Promise<string | null>,
  now: () => number = Date.now,
): SlackNames {
  interface Profile {
    name: string | null;
    email: string | null;
  }
  const cache = new Map<string, Profile>();
  const inflight = new Map<string, Promise<Profile>>();
  // one users.info per first sight answers both questions; a miss on either field stays
  // uncached so a later delivery asks again
  const profileOf = (team: string, user: string, via: string[] = []): Promise<Profile> => {
    const key = `${team}:${user}`;
    const hit = cache.get(key);
    if (hit && hit.name !== null && hit.email !== null) return Promise.resolve(hit);
    const going = inflight.get(key);
    if (going) return going;
    const p = (async (): Promise<Profile> => {
      try {
        const token = await tokenFor(team, [user, ...via]);
        if (!token) return hit ?? { name: null, email: null };
        const res = await timedFetch(`https://slack.com/api/users.info?user=${user}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await res.json() as {
          ok: boolean;
          user?: {
            name?: string;
            profile?: { display_name?: string; real_name?: string; email?: string };
          };
        };
        const u = body.ok ? body.user : undefined;
        const found: Profile = {
          name: u?.profile?.display_name || u?.profile?.real_name || u?.name || hit?.name ||
            null,
          email: u?.profile?.email || hit?.email || null,
        };
        if (found.name || found.email) cache.set(key, found);
        return found;
      } catch {
        return hit ?? { name: null, email: null };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
  /** A room as its last `conversations.info` answered: `at` is when, and a name the push
   *  leg taught before any answer stands with `at` still unset. */
  interface Room extends RoomFacts {
    name: string | null;
    direct: boolean;
    at: number;
  }
  const rooms = new Map<string, Room>();
  const roomsInflight = new Map<string, Promise<Room | null>>();
  // one conversations.info per first sight, and per room again once its facts are stale;
  // a DM's answer is the counterpart's user id, which the profile leg names, so a DM
  // costs one call more, once. A refusal leaves what was held, asked again a spell later
  const infoOf = (team: string, channel: string, via: string[]): Promise<Room | null> => {
    const key = `${team}:${channel}`;
    const going = roomsInflight.get(key);
    if (going) return going;
    const p = (async (): Promise<Room | null> => {
      const held = rooms.get(key);
      try {
        const token = await tokenFor(team, via);
        if (!token) return held ?? null;
        const res = await timedFetch(
          `https://slack.com/api/conversations.info?channel=${channel}&include_num_members=true`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const body = await res.json() as {
          ok: boolean;
          channel?: {
            name?: string;
            is_im?: boolean;
            is_mpim?: boolean;
            user?: string;
            num_members?: number;
            creator?: string;
          };
        };
        const c = body.ok ? body.channel : undefined;
        if (!c) {
          if (held) held.at = now();
          return held ?? null;
        }
        const name = c.is_im
          ? (c.user ? (await profileOf(team, c.user, via)).name : null)
          : c.name || null;
        const room: Room = {
          name: name ?? held?.name ?? null,
          direct: c.is_im === true || c.is_mpim === true,
          at: now(),
          ...(typeof c.num_members === "number" ? { members: c.num_members } : {}),
          ...(c.creator ? { creator: c.creator } : {}),
        };
        rooms.set(key, room);
        return room;
      } catch {
        return held ?? null;
      } finally {
        roomsInflight.delete(key);
      }
    })();
    roomsInflight.set(key, p);
    return p;
  };
  const roomOf = async (team: string, channel: string, via: string[] = []) => {
    const hit = rooms.get(`${team}:${channel}`);
    if (hit?.name) return hit.name;
    return (await infoOf(team, channel, via))?.name ?? null;
  };
  const factsOf = async (team: string, channel: string, via: string[] = []) => {
    const hit = rooms.get(`${team}:${channel}`);
    const fresh = hit && (hit.direct || now() - hit.at < ROOM_FACTS_MS);
    const room = fresh ? hit : await infoOf(team, channel, via);
    if (!room || room.direct || room.at === -Infinity) return null;
    return {
      ...(room.members !== undefined ? { members: room.members } : {}),
      ...(room.creator ? { creator: room.creator } : {}),
    };
  };
  return {
    nameOf: async (team, user, via) => (await profileOf(team, user, via)).name,
    emailOf: async (team, user, via) => (await profileOf(team, user, via)).email,
    learn: (team, user, name) => {
      const key = `${team}:${user}`;
      cache.set(key, { name, email: cache.get(key)?.email ?? null });
    },
    roomOf,
    learnRoom: (team, channel, name) => {
      const key = `${team}:${channel}`;
      const held = rooms.get(key);
      rooms.set(key, held ? { ...held, name } : { name, direct: false, at: -Infinity });
    },
    factsOf,
  };
}

/** How long the account's user ids stand before the connections map is read again. */
export const ACCOUNTS_MS = 60_000;

/** The user ids the account goes by on a workspace: the bot's (`<team>:<bot user>`) and
 *  each user grant's (`<team>:<user>`), off the connections map. A mention, a sender and
 *  a channel's creator carry user ids, never a connection's address. `read` takes the
 *  map again once `ACCOUNTS_MS` has passed; `of` answers from the last read, by the
 *  workspace or any of its connection addresses. */
export interface SlackAccounts {
  read(): Promise<void>;
  of(connection: string): string[];
}

export function slackAccounts(
  rows: () => Promise<{ service: string; address: string }[]>,
  now: () => number = Date.now,
): SlackAccounts {
  let held: { service: string; address: string }[] = [];
  let at = -Infinity;
  let going: Promise<void> | undefined;
  return {
    read() {
      if (now() - at < ACCOUNTS_MS) return Promise.resolve();
      going ??= rows().then((r) => {
        held = r;
        at = now();
      }).finally(() => (going = undefined));
      return going;
    },
    of(connection) {
      const team = connection.split(":")[0];
      return held
        .filter((r) => r.service === "slack" && r.address.startsWith(`${team}:`))
        .map((r) => r.address.slice(team.length + 1));
    },
  };
}

export interface SlackWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The classifier + mirror seam (§3, §4): `connection` resolves grant rows (sender →
   *  owner); memberships mirror joins/leaves and event visibility. Absent ⇒ pure mapping
   *  (an edge tier serving without the store). */
  store?:
    & Pick<
      Connections,
      "connection" | "upsertMemberships" | "deleteMemberships" | "upsertConnections"
    >
    & Partial<Pick<Registry, "agents"> & Pick<Connections, "connections">>;
  /** File attachments → the media store (absent ⇒ files are dropped, text still flows). */
  media?: SlackMedia;
  /** The name directory (absent ⇒ senders and rooms ship bare ids, mentions decode to
   *  `@<id>`, and a channel says neither its size nor who runs it). */
  names?: SlackNames;
  /** The account's user ids, which a channel's creator is told against (absent ⇒ no
   *  channel says whether the account runs it). */
  accounts?: SlackAccounts;
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
  /** Every installation an event reached (`apps.event.authorizations.list` on the app's
   *  own app-level token), by the delivery's app and `event_context`; null when it cannot
   *  be asked or was refused. Absent ⇒ the one installation Slack named stands. */
  installations?: (app: string, context: string, team: string) => Promise<Authorization[] | null>;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** Build the ingest handler. Pure over its deps — call once, serve (or carry) anywhere. */
export function createSlackWebhook(deps: SlackWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  // when the room's own line of the bot leaving was heard, by room: the account's
  // `channel_left` that follows it is the same fact
  const botLeft = new Map<string, number>();

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

  /** Every installation the delivery reached (§4). Slack names one, so when that one is
   *  not the bot the whole list is asked for; a failure leaves the one it named. */
  async function reached(payload: EventsEnvelope): Promise<Authorization[] | undefined> {
    const named = payload.authorizations;
    const { api_app_id: app, event_context: context, team_id: team } = payload;
    if (!deps.installations || !app || !context || !team) return named;
    if (named?.length !== 1 || named[0].is_bot) return named;
    return (await deps.installations(app, context, team)) ?? named;
  }

  async function handle(delivered: EventsEnvelope): Promise<void> {
    const team = delivered.team_id;
    const e = delivered.event;
    if (!team || !e) return;
    const payload = { ...delivered, authorizations: await reached(delivered) };

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
    // the membership mirror, active leg (§4): joins/leaves move rows, nothing published —
    // but the bot's own leave is a room it is out of (steering rooms). Its arrival adopts
    // nothing: a room is adopted from its lines alone (the room's own "joined" line is the
    // first), as Teams adopts a chat — one fact, one trigger, where Slack says the arrival
    // twice at once and both would adopt
    if (e.type === "member_joined_channel" || e.type === "member_left_channel") {
      const anchor = anchorOf(team, payload.authorizations);
      if (e.user !== undefined && e.user === botOf(team, anchor)) {
        if (e.type === "member_left_channel") {
          await releaseRoom(deps, team, anchor, e.channel);
        }
        return;
      }
      await mirrorMember(e, team, deps.store);
      return;
    }
    // the account itself is out of a room: whatever steering it was is released, and the
    // room's line says so — unless the room's own leave line for the bot was just heard,
    // which already did. The one who took it out, when the wire names someone else, is
    // the line's sender
    if (e.type === "channel_left" || e.type === "group_left") {
      if (typeof e.channel !== "string") return;
      const anchor = anchorOf(team, payload.authorizations);
      await releaseRoom(deps, team, anchor, e.channel);
      const bot = botOf(team, anchor);
      const key = `${team}:${e.channel}`;
      const twin = Date.now() - (botLeft.get(key) ?? -Infinity) < LEAVE_TWIN_MS;
      botLeft.delete(key);
      if (!bot || twin || !e.event_ts) return;
      const by = e.actor_id && e.actor_id !== bot ? e.actor_id : undefined;
      await deps.publish(
        await roomLine(
          {
            channel: e.channel,
            id: e.event_ts,
            ts: slackTime(e.event_ts, now),
            by,
            change: { left: [{ address: bot }], ...(by ? { reason: "removed" } : {}) },
            wire: { event: e.type },
          },
          team,
          anchor,
          payload.authorizations,
          deps.store,
          deps.names,
          deps.accounts,
        ),
      );
      return;
    }
    // a room's change Slack says only as an event, never as a line in the room: the event
    // is the line
    const said = roomEvent(e, now);
    if (said) {
      if (e.type === "channel_created" && e.channel.name) {
        deps.names?.learnRoom(team, said.channel, e.channel.name);
      }
      const anchor = anchorOf(team, payload.authorizations);
      await deps.publish(
        await roomLine(
          said,
          team,
          anchor,
          payload.authorizations,
          deps.store,
          deps.names,
          deps.accounts,
        ),
      );
      return;
    }
    // a reaction is an ACTION event (§3): add/remove + the reacted message's id in
    // ref_external_id, the ReactionPart carrying what changed; identity is the
    // delivery's event_ts, so retries dedupe
    if (e.type === "reaction_added" || e.type === "reaction_removed") {
      const item = e.item;
      if (item?.type !== "message" || !item.channel || !item.ts) return;
      const im = isIm(item.channel);
      const anchor = anchorOf(team, payload.authorizations, im);
      const via = boundUsers(payload.authorizations);
      const who = e.user ? await deps.names?.nameOf(team, e.user, via) : undefined;
      const email = e.user ? await deps.names?.emailOf(team, e.user, via) : undefined;
      // same classifier stamp as messages (§3): the reactor's grant row or email names them
      const owner = await memberOf(deps.store, deps.names, team, e.user, via);
      const facts = await roomFacts(
        team,
        item.channel,
        im ? "direct" : undefined,
        via,
        deps.names,
        deps.accounts,
      );
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
          conversation: { address: item.channel, ...facts },
          ...(e.user ? { sender: { address: e.user, ...(who ? { name: who } : {}) } } : {}),
          external_id: `slack:${team}:${item.channel}:${e.event_ts}`,
        },
        parts: [{ type: "data", kind: "reaction", data: { name: e.reaction } }],
        ...(email ? { extra: { [SENDER_EMAIL]: email } } : {}),
      });
      return;
    }
    if (e.type !== "message") return;

    const anchor = anchorOf(team, payload.authorizations, e.channel_type === "im");
    // a room the bot is met in may be an agent's steering room: recorded before the line
    // that met it lands, so that line is already the room's. The room's line of the bot
    // leaving, or of the channel archived, is the bot out of it
    if (e.channel && (e.channel_type === "channel" || e.channel_type === "group")) {
      const via = boundUsers(payload.authorizations);
      const { subtype, user } = e as RoomMessage;
      const left = (subtype === "channel_leave" || subtype === "group_leave") &&
        user === botOf(team, anchor);
      if (left) botLeft.set(`${team}:${e.channel}`, Date.now());
      const archived = subtype === "channel_archive" || subtype === "group_archive";
      if (left || archived) await releaseRoom(deps, team, anchor, e.channel);
      else await adoptRoom(deps, team, anchor, e.channel, via);
    }
    const msgs = await mapMessage(
      e,
      team,
      anchor,
      payload.authorizations,
      deps.store,
      deps.media,
      deps.names,
      { now, accounts: deps.accounts },
    );
    if (msgs.length === 0) return;
    await deps.publish(msgs);
  }
}

/* ── mapping: Slack event → a liquen message (channel address + workspace anchor) ── */

export interface MapCtx {
  now: () => string;
  accounts?: SlackAccounts;
}

export type Store = NonNullable<SlackWebhookDeps["store"]>;

/** The delivery's anchor (§4): the BOT's own grant (`<team>:<bot user>`) when the bot
 *  witnessed it, the bare workspace when only personal grants did. A DM (`im`) anchors to
 *  the bare workspace whoever saw it: a DM with the shared bot is its sender's agent's
 *  surface or nobody's, never the shared inbox. */
export function anchorOf(team: string, auths: Authorization[] | undefined, im = false): string {
  const bot = im ? undefined : auths?.find((a) => a.is_bot && a.user_id);
  return bot ? `${team}:${bot.user_id}` : team;
}

/** Whether the bot is among a delivery's installations. */
function sawBot(auths: Authorization[] | undefined): boolean {
  return (auths ?? []).some((a) => a.is_bot);
}

/** A DM by its channel id: Slack's DM ids begin with `D`, which is all a reaction says of
 *  its place. */
function isIm(channel: string): boolean {
  return channel.startsWith("D");
}

/** The bot user an anchor names, or undefined on the bare workspace. */
function botOf(team: string, anchor: string): string | undefined {
  return anchor === team ? undefined : anchor.slice(team.length + 1);
}

/** The delivery's token-resolution candidates: its bound (non-bot) authorized users. */
function boundUsers(auths: Authorization[] | undefined): string[] {
  return (auths ?? []).filter((a) => !a.is_bot && a.user_id).map((a) => a.user_id);
}

/** What a line in a channel says of the room for the crowd rule (`connect/marks.ts`): how
 *  many members it has, and whether the account runs it, which on Slack is the channel's
 *  creator being one of the account's own users. A DM or an mpim carries neither. */
async function roomFacts(
  team: string,
  channel: string,
  kind: Conversation["kind"],
  via: string[],
  names: SlackNames | undefined,
  accounts: SlackAccounts | undefined,
): Promise<Pick<Conversation, "members" | "admin">> {
  if (kind === "direct" || !names) return {};
  const facts = await names.factsOf(team, channel, via);
  if (!facts) return {};
  await accounts?.read();
  const creator = facts.creator;
  return {
    ...(facts.members !== undefined ? { members: facts.members } : {}),
    ...(creator && accounts ? { admin: accounts.of(team).includes(creator) } : {}),
  };
}

/** The classifier (§3): who a wire user IS — a point lookup of the sender's grant row
 *  (`<team>:<user>`, owned) on the connections map. Any sender classifies, not just the
 *  delivery's own user. */
async function ownerOf(
  store: Store | undefined,
  team: string,
  user: string | undefined,
): Promise<string | null> {
  if (!store || !user) return null;
  return (await store.connection("slack", `${team}:${user}`))?.agentId ?? null;
}

/** The classifier's second look (§4): a sender with no grant row is still a member when
 *  the email on their Slack profile is one the roster declares — the same handle scan
 *  the WhatsApp ingest does on phones, one directory call away. */
async function memberOf(
  store: Store | undefined,
  names: SlackNames | undefined,
  team: string,
  user: string | undefined,
  via: string[],
): Promise<string | null> {
  const owner = await ownerOf(store, team, user);
  if (owner || !user || !store?.agents || !names) return owner;
  const email = await names.emailOf(team, user, via);
  if (!email) return null;
  return (await store.agents()).find((a) => sameHandle(a.email, email))?.agentId ?? null;
}

/** A member's DM with the shared bot is a surface of the mind of their own agent (§4), and
 *  Slack's id for it is opaque — so the first line a member sends the bot in an `im`
 *  RECORDS the channel on the workspace stub (`extra.mirrors.dms`, member → channel), the
 *  row every DM anchors to, where the alias derivation reads it. The whole conversation
 *  rides the stub: their lines, the mirror's copies out, the echoes. Whether that agent
 *  runs and counts them is decided there, not here. */
async function recordDm(
  store: Store,
  team: string,
  member: string,
  channel: string,
): Promise<void> {
  const row = await store.connection("slack", team);
  if (!row || row.agentId || mirrorsOf(row).dms?.[member] === channel) return;
  await store.upsertConnections([{
    service: "slack",
    address: team,
    extra: { mirrors: { dms: { [member]: channel } } },
  }]);
}

/** A steering room (§4): on the shared bot, a channel named exactly as a roster agent is
 *  that agent's room, whatever the agent owns elsewhere. It is RECORDED the first time the
 *  bot is met in it (`extra.mirrors.rooms`, agent → channel), by id, so a rename never
 *  moves it and another channel wearing the name later is nobody's while the first holds
 *  it. */
async function adoptRoom(
  deps: SlackWebhookDeps,
  team: string,
  anchor: string,
  channel: string,
  via: string[],
): Promise<void> {
  const { store, names } = deps;
  if (!store?.agents || !names || anchor === team) return;
  const row = await store.connection("slack", anchor);
  if (!row || row.agentId) return;
  const name = await names.roomOf(team, channel, via);
  const agent = name ? (await store.agents()).find((a) => a.agentId === name) : undefined;
  if (!agent || agent.runs === false || mirrorsOf(row).rooms?.[agent.agentId] !== undefined) {
    return;
  }
  await store.upsertConnections([{
    service: "slack",
    address: anchor,
    extra: { mirrors: { rooms: { [agent.agentId]: channel } } },
  }]);
}

/** The bot is out of a room — it left, or the channel was archived: whatever agent's
 *  steering room it was is nobody's now, and the next channel to wear the name may be
 *  adopted. */
async function releaseRoom(
  deps: SlackWebhookDeps,
  team: string,
  anchor: string,
  channel: string,
): Promise<void> {
  const { store } = deps;
  if (!store || anchor === team) return;
  const row = await store.connection("slack", anchor);
  const held = Object.entries(row ? mirrorsOf(row).rooms ?? {} : {})
    .filter(([, c]) => c === channel).map(([agent]) => agent);
  if (held.length === 0) return;
  await store.upsertConnections([{
    service: "slack",
    address: anchor,
    extra: { mirrors: { rooms: Object.fromEntries(held.map((agent) => [agent, null])) } },
  }]);
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

/** A row's time is the message's own: Slack's ts is seconds since the epoch with the
 *  message's ordinal in the fraction, so the row reads in the order the room saw it
 *  whether it arrived live or was read back after a gap. */
export function slackTime(ts: string | undefined, now: () => string): string {
  const n = Number(ts);
  return ts && Number.isFinite(n) ? new Date(n * 1000).toISOString() : now();
}

/** One message of a delivery, as the log takes it. Shared by the event handler and the
 *  catch-up (catchup.ts), which reads the same shape back from the history API. */
export async function mapMessage(
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
    const ts = slackTime(e.event_ts, ctx.now);
    const facts = await roomFacts(
      team,
      e.channel,
      KIND[e.channel_type],
      boundUsers(authorizations),
      names,
      ctx.accounts,
    );
    return [{
      ts,
      type: "message",
      payload: { action: "delete", ref_external_id: originalId },
      envelope: {
        service: "slack",
        connection_address: anchor,
        conversation: { address: e.channel, ...facts },
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
  const subtype: string | undefined = e.subtype;
  if (subtype && ROOM_SUBTYPES.has(subtype)) {
    return await mapRoomLine(e as RoomMessage, team, anchor, authorizations, store, names, ctx);
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
    const changed = e.message as RoomMessage & { edited?: unknown };
    const previous = e.previous_message as RoomMessage | undefined;
    // a huddle's message is rewritten as it runs, and the rewrite that ends it is the
    // room's line of the call ended, its own line beside the one that started it
    if (changed.subtype === "huddle_thread") {
      const at = e.event_ts ?? e.ts;
      if (!at || !huddleOf(changed.room).ended || huddleOf(previous?.room).ended) return [];
      return await mapRoomLine(
        { ...changed, channel: e.channel, channel_type: e.channel_type, ts: at },
        team,
        anchor,
        authorizations,
        store,
        names,
        ctx,
      );
    }
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
    const members = (await Promise.all(
      authorizations.filter((a) => !a.is_bot).map((a) => ownerOf(store, team, a.user_id)),
    ))
      .filter((id) => id !== null)
      .map((id) => ({ service: "slack", connection: team, conversation, agentId: id }));
    if (members.length) await store.upsertMemberships(members);
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
  // sender.name and conversation.name are the SERVICE's display facts — Slack's events
  // carry neither, so the name directory asks the service itself (users.info /
  // conversations.info, the rename lines and profile events pushing updates); still nothing of
  // ours: identity resolution is the classifier's business (§3)
  const who = m.user ? await names?.nameOf(team, m.user, via) : undefined;
  const email = m.user ? await names?.emailOf(team, m.user, via) : undefined;
  const room = await names?.roomOf(team, conversation, via);
  const facts = await roomFacts(team, conversation, kind, via, names, ctx.accounts);
  // the classifier's authorship stamp (§3): a sender whose grant row or declared email
  // names a member is that member — `agent.id` alone (a Slack client is not the harness,
  // so no session_id); turn_id, never this stamp, marks the model's voice
  const owner = await memberOf(store, names, team, m.user, via);
  // a member's DM with the bot: written down where the mind's surfaces are derived (§4).
  // The bot among the installations is what says the DM is with it, not a member's DM
  // with a colleague that only their own grant sees
  if (owner && store && e.channel_type === "im" && sawBot(authorizations)) {
    await recordDm(store, team, owner, conversation);
  }
  return [{
    ts: slackTime(edit ? e.event_ts : m.ts, ctx.now),
    type: "message",
    ...(owner ? { agent: { id: owner } } : {}),
    ...(Object.keys(payload).length ? { payload } : {}),
    envelope: {
      service: "slack",
      connection_address: anchor,
      conversation: {
        address: conversation,
        ...(kind ? { kind } : {}),
        ...(room ? { name: room } : {}),
        ...facts,
      },
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
    ...(e.subtype || authorizations || email
      ? {
        extra: {
          ...(e.subtype || authorizations
            ? {
              slack: {
                ...(e.subtype ? { subtype: e.subtype } : {}),
                ...(authorizations ? { authorizations } : {}),
              },
            }
            : {}),
          // the profile's email (§3 sender_email): a Slack address is a user id, and the
          // email is the handle that names the person anywhere else
          ...(email ? { [SENDER_EMAIL]: email } : {}),
        },
      }
      : {}),
  }];
}

/** The subtypes that are a room's change rather than anything said in it. A private
 *  channel's (`group_…`) say the same as a public one's. */
const ROOM_SUBTYPES = new Set([
  "channel_join",
  "group_join",
  "channel_leave",
  "group_leave",
  "channel_name",
  "group_name",
  "channel_topic",
  "group_topic",
  "channel_purpose",
  "group_purpose",
  "channel_archive",
  "group_archive",
  "channel_unarchive",
  "group_unarchive",
  "channel_posting_permissions",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "huddle_thread",
  "reminder_add",
  "message_locked",
]);

/** A room subtype's message: what any of them may carry. `@slack/types` types the
 *  documented few; `huddle_thread`, `reminder_add`, `message_locked` and the `group_`
 *  forms are Slack's own undocumented shapes, so every field is a guess the mapping
 *  guards. */
interface RoomMessage {
  subtype?: string;
  ts?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  inviter?: string;
  name?: string;
  old_name?: string;
  topic?: string;
  purpose?: string;
  text?: string;
  thread_ts?: string;
  room?: unknown;
}

/** A huddle as its message's `room` says it: ended once it has an end (or says so),
 *  with everyone who was ever in it and how long it ran. */
function huddleOf(room: unknown): { ended: boolean; seconds?: number; with: string[] } {
  const r = typeof room === "object" && room !== null ? room as Record<string, unknown> : {};
  const start = typeof r.date_start === "number" && r.date_start > 0 ? r.date_start : undefined;
  const end = typeof r.date_end === "number" && r.date_end > 0 ? r.date_end : undefined;
  const people = Array.isArray(r.participant_history) ? r.participant_history : [];
  return {
    ended: r.has_ended === true || end !== undefined,
    ...(start !== undefined && end !== undefined && end >= start ? { seconds: end - start } : {}),
    with: people.filter((p): p is string => typeof p === "string"),
  };
}

/** A room's change is the room's own line (§3). Slack says most of them as messages of
 *  their own subtypes, whose text ("<@U…> has joined the channel") is Slack's wording, not
 *  anything the mover typed — so the line is a `room` part, from whoever made the change:
 *  the inviter who added someone, else the one who moved, renamed, set or archived. A
 *  huddle is Slackbot's message and the room's own (no sender). Keyed on the message's own
 *  ts like any row, so the live delivery and the catch-up's read of it merge. A rename
 *  also teaches the name directory the room's new name. */
async function mapRoomLine(
  m: RoomMessage,
  team: string,
  anchor: string,
  authorizations: Authorization[] | undefined,
  store: Store | undefined,
  names: SlackNames | undefined,
  ctx: MapCtx,
): Promise<Draft<MessageEvent>[]> {
  if (!m.ts || !m.channel || !m.subtype) return [];
  const mover = m.user ? [{ address: m.user }] : [];
  const verb = m.subtype.replace(/^(channel|group)_/, "");
  let by = m.user;
  let ref: string | undefined;
  let change: RoomChange;
  switch (verb) {
    case "join":
      change = { joined: mover, ...(m.inviter ? { reason: "added" as const } : {}) };
      by = m.inviter ?? m.user;
      break;
    case "leave":
      change = { left: mover };
      break;
    case "name":
      if (m.name) names?.learnRoom(team, m.channel, m.name);
      change = { name: m.name, was: m.old_name };
      break;
    case "topic":
      change = { topic: m.topic ?? "" };
      break;
    case "purpose":
      change = { description: m.purpose ?? "" };
      break;
    case "archive":
      change = { state: "archived" };
      break;
    case "unarchive":
      change = { state: "unarchived" };
      break;
    case "posting_permissions":
      // the rule itself is not on the wire
      change = { settings: { send: "changed" } };
      break;
    case "convert_to_private":
    case "convert_to_public":
      change = { settings: { private: verb === "convert_to_private" } };
      break;
    case "huddle_thread": {
      const h = huddleOf(m.room);
      change = {
        call: h.ended
          ? {
            state: "ended",
            kind: "huddle",
            seconds: h.seconds,
            with: h.with.map((address) => ({ address })),
          }
          : { state: "started", kind: "huddle" },
      };
      by = undefined;
      break;
    }
    case "reminder_add":
      // Slack's sentence quotes what the reminder says: “standup” in this channel at 10AM
      change = { reminder: m.text?.match(/[“"]([^”"]+)[”"]/)?.[1] ?? m.text };
      break;
    default: // message_locked: the thread is its first message's
      change = { state: "locked" };
      if (m.thread_ts) ref = m.thread_ts;
  }
  return [
    await roomLine(
      {
        channel: m.channel,
        id: m.ts,
        ts: slackTime(m.ts, ctx.now),
        by,
        change,
        ref,
        type: m.channel_type,
        wire: { subtype: m.subtype },
      },
      team,
      anchor,
      authorizations,
      store,
      names,
      ctx.accounts,
    ),
  ];
}

/** One room line, wherever Slack said it: in `channel`, keyed `slack:<team>:<channel>:<id>`
 *  (the message's ts, or the event's own stable identity, so a retry or a re-read merges),
 *  from `by` (absent: the account's own — Slackbot's or the workspace's word, no person),
 *  pointing at the message `ref` names when it is about one. Everyone the change moves is
 *  named here, from the directory, as a sender is. */
interface RoomLineSpec {
  channel: string;
  id: string;
  ts: string;
  by?: string;
  change: RoomChange;
  /** The ts of the message the change is about (a pin, a locked thread). */
  ref?: string;
  /** The wire's `channel_type`, when it said one. */
  type?: string;
  /** How the wire said it: the message subtype, or the event's type. */
  wire: { subtype: string } | { event: string };
}

async function roomLine(
  line: RoomLineSpec,
  team: string,
  anchor: string,
  authorizations: Authorization[] | undefined,
  store: Store | undefined,
  names: SlackNames | undefined,
  accounts: SlackAccounts | undefined,
): Promise<Draft<MessageEvent>> {
  const via = boundUsers(authorizations);
  const person = async ({ address }: RoomMember): Promise<RoomMember> => {
    const name = await names?.nameOf(team, address, via);
    return { address, ...(name ? { name } : {}) };
  };
  const everyone = (people: RoomMember[] | undefined) =>
    people ? Promise.all(people.map(person)) : undefined;
  const { change } = line;
  const named: RoomChange = {
    ...change,
    joined: await everyone(change.joined),
    left: await everyone(change.left),
    ...(change.call ? { call: { ...change.call, with: await everyone(change.call.with) } } : {}),
  };
  const sender = line.by ? await person({ address: line.by }) : undefined;
  const owner = await memberOf(store, names, team, line.by, via);
  const kind = line.type ? KIND[line.type] : undefined;
  const room = await names?.roomOf(team, line.channel, via);
  const facts = await roomFacts(
    team,
    line.channel,
    kind ?? (isIm(line.channel) ? "direct" : undefined),
    via,
    names,
    accounts,
  );
  return {
    ts: line.ts,
    type: "message",
    ...(owner ? { agent: { id: owner } } : {}),
    ...(line.ref
      ? { payload: { ref_external_id: `slack:${team}:${line.channel}:${line.ref}` } }
      : {}),
    envelope: {
      service: "slack",
      connection_address: anchor,
      conversation: {
        address: line.channel,
        ...(kind ? { kind } : {}),
        ...(room ? { name: room } : {}),
        ...facts,
      },
      ...(sender ? { sender } : {}),
      external_id: `slack:${team}:${line.channel}:${line.id}`,
    },
    parts: [roomPart(named)],
    extra: { slack: { ...line.wire, ...(authorizations ? { authorizations } : {}) } },
  };
}

/** The room changes Slack says only as events, as the line each one is: in the room the
 *  event names, keyed on the event's own ts (a retry is the same line) or, for what
 *  happens to a room once, on what happened. Null for every other event, and for one
 *  that names no room. */
function roomEvent(e: SlackEvent, now: () => string): RoomLineSpec | null {
  const wire = { event: e.type };
  switch (e.type) {
    case "channel_created": {
      const c = e.channel;
      if (!c?.id) return null;
      return {
        channel: c.id,
        id: "created",
        ts: slackTime(c.created ? String(c.created) : e.event_ts, now),
        by: c.creator || undefined,
        change: { state: "created", name: c.name },
        type: c.is_private ? "group" : "channel",
        wire,
      };
    }
    case "channel_deleted":
    case "group_deleted": {
      // Slack does not say who
      const at = (e as { event_ts?: string }).event_ts;
      return typeof e.channel === "string"
        ? {
          channel: e.channel,
          id: "deleted",
          ts: slackTime(at, now),
          change: { state: "deleted" },
          wire,
        }
        : null;
    }
    case "pin_added":
    case "pin_removed": {
      // a message pinned or unpinned; a pinned file is no message a line can point at
      const channel = e.channel_id ?? e.item?.channel;
      const ref = e.item?.type === "message" ? e.item.message?.ts : undefined;
      if (!channel || !ref || !e.event_ts) return null;
      return {
        channel,
        id: e.event_ts,
        ts: slackTime(e.event_ts, now),
        by: e.user,
        change: { pinned: e.type === "pin_added" },
        ref,
        wire,
      };
    }
    case "channel_shared":
    case "channel_unshared": {
      if (!e.channel || !e.event_ts) return null;
      // the other organization by its team id: the event names no more of it
      const shared = e.type === "channel_shared"
        ? { added: e.connected_team_id }
        : { removed: e.previously_connected_team_id };
      return {
        channel: e.channel,
        id: e.event_ts,
        ts: slackTime(e.event_ts, now),
        change: { shared },
        wire,
      };
    }
    case "shared_channel_invite_received":
    case "shared_channel_invite_accepted":
    case "shared_channel_invite_approved":
    case "shared_channel_invite_declined":
    case "shared_channel_invite_requested": {
      const channel = e.type === "shared_channel_invite_requested" ? e.channel_id : e.channel?.id;
      const from = e.type === "shared_channel_invite_requested"
        ? undefined
        : e.invite?.inviting_team?.name;
      if (!channel || !e.event_ts) return null;
      return {
        channel,
        id: e.event_ts,
        ts: slackTime(e.event_ts, now),
        change: { invite: { state: e.type.slice("shared_channel_invite_".length), from } },
        wire,
      };
    }
    case "channel_id_changed":
      // the line stands in the old room and names the new one
      if (!e.old_channel_id || !e.new_channel_id || !e.event_ts) return null;
      return {
        channel: e.old_channel_id,
        id: e.event_ts,
        ts: slackTime(e.event_ts, now),
        change: { moved: { to: e.new_channel_id } },
        wire,
      };
    case "channel_history_changed":
    case "group_history_changed":
    case "im_history_changed": {
      // Slack's documented payload names no room: the line is written only when it does
      const channel = (e as { channel?: unknown }).channel;
      if (typeof channel !== "string" || !e.event_ts) return null;
      return {
        channel,
        id: e.event_ts,
        ts: slackTime(e.event_ts, now),
        change: { history: "changed" },
        wire,
      };
    }
    case "im_created": {
      const c = e.channel as { id?: string; created?: number };
      if (!c?.id || !e.user) return null;
      return {
        channel: c.id,
        id: "created",
        ts: slackTime(c.created ? String(c.created) : undefined, now),
        by: e.user,
        change: { state: "created", joined: [{ address: e.user }] },
        type: "im",
        wire,
      };
    }
    case "call_rejected":
      if (!e.channel_id || !e.call_id) return null;
      return {
        channel: e.channel_id,
        id: `call.${e.call_id}`,
        ts: now(),
        by: e.user_id,
        change: { call: { state: "rejected" } },
        wire,
      };
    default:
      return null;
  }
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
async function mirrorMember(
  e: MemberJoinedChannelEvent | MemberLeftChannelEvent,
  team: string,
  store: Store | undefined,
): Promise<void> {
  const who = await ownerOf(store, team, e.user);
  if (!store || !who) return;
  const row = {
    service: "slack",
    connection: team,
    conversation: e.channel,
    agentId: who,
  };
  if (e.type === "member_joined_channel") await store.upsertMemberships([row]);
  else await store.deleteMemberships([row]); // a leave ends the lifetime — seen history stays (§6)
}

/* ── signature verification (Web-standard, constant-time; replay-bounded) ── */

const encoder = new TextEncoder();
const FRESH_MS = 5 * 60 * 1000;
/** Slack refreshes sockets routinely, so a close is the normal case and reconnects fast;
 *  an error means the far side is unwell and the wait is longer. */
const RECONNECT_MS = 1_000;
const RECONNECT_ERROR_MS = 5_000;
/** How long after the room's line of the bot leaving the account's own `channel_left` is
 *  that same leave, said twice. */
const LEAVE_TWIN_MS = 60_000;
/** A socket back after this long was an outage, not a blip, and the gap is read back. */
const CATCH_UP_AFTER_MS = 5_000;
/** How long every socket may be gone before the workspaces read `unavailable` (§5): a
 *  refresh or a dropped socket is back in seconds and passes without a word. */
export const UNAVAILABLE_AFTER_MS = 120_000;

/** What the sockets say of the workspace rows (§5): an app token Slack refused for good
 *  signs them out at once; every socket gone `after` ms makes them `unavailable`; a socket
 *  up again brings back what the sockets themselves took down — an unavailable row, or one
 *  signed out by a refused open — and leaves a token a send found revoked to its own door. */
export function socketHealth(deps: {
  carriers: number;
  store: Pick<Connections, "connections" | "upsertConnections">;
  after?: number;
  onError?: (err: unknown) => void;
}): { up(i: number): void; down(i: number, err?: unknown): void; stop(): Promise<void> } {
  const after = deps.after ?? UNAVAILABLE_AFTER_MS;
  const gone = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let marking: Promise<void> = Promise.resolve();
  const rows = async () => (await deps.store.connections()).filter((r) => r.service === "slack");
  const ours = (r: ConnectionRow) =>
    r.extra?.state === "unavailable" ||
    (r.extra?.state === "signed_out" &&
      String(r.extra?.error ?? "").startsWith("connections.open"));
  const mark = (pick: (r: ConnectionRow) => boolean, state: ConnectionState, error?: string) => {
    marking = marking
      .then(async () => {
        for (const r of (await rows()).filter(pick)) {
          await setState(deps.store, r, state, error ? { error } : {});
        }
      })
      .catch((err) => deps.onError?.(err));
  };
  const settle = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    up(i) {
      gone.delete(i);
      settle();
      mark(ours, "connected");
    },
    down(i, err) {
      gone.add(i);
      if (err instanceof SignedOut) {
        settle();
        return mark(() => true, "signed_out", err.message);
      }
      if (gone.size < deps.carriers || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (gone.size === deps.carriers) {
          mark((r) => r.extra?.state !== "signed_out", "unavailable");
        }
      }, after);
    },
    stop() {
      settle();
      return marking;
    },
  };
}

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

export interface Authorization {
  user_id: string;
  is_bot?: boolean;
}

/** The `installations` seam (§4): `apps.event.authorizations.list` on the app's own
 *  app-level token, every page, kept to the delivery's workspace (a shared channel lists
 *  another's too). An app with no token here answers null; so does a refusal, said once
 *  per app and reason. */
export function slackInstallations(
  appToken: (app: string) => Promise<string | undefined>,
  fetchApi: typeof fetch = timedFetch,
  say: (line: string) => void = (line) => console.error(line),
): (app: string, context: string, team: string) => Promise<Authorization[] | null> {
  const said = new Set<string>();
  const refused = (app: string, why: string): null => {
    if (!said.has(`${app} ${why}`)) {
      said.add(`${app} ${why}`);
      say(
        `[ingest] slack app ${app}: the installations an event reached are unread (${why}); ` +
          "the one Slack named stands. The app-level token needs authorizations:read",
      );
    }
    return null;
  };
  return async (app, context, team) => {
    const token = await appToken(app);
    if (!token) return null;
    const found: Authorization[] = [];
    let cursor: string | undefined;
    try {
      do {
        const res = await fetchApi("https://slack.com/api/apps.event.authorizations.list", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ event_context: context, ...(cursor ? { cursor } : {}) }),
        });
        const body = await res.json() as {
          ok: boolean;
          error?: string;
          authorizations?: { team_id?: string; user_id?: string; is_bot?: boolean }[];
          response_metadata?: { next_cursor?: string };
        };
        if (!body.ok) return refused(app, body.error ?? `HTTP ${res.status}`);
        for (const a of body.authorizations ?? []) {
          if (!a.user_id || (a.team_id !== undefined && a.team_id !== team)) continue;
          found.push({ user_id: a.user_id, ...(a.is_bot ? { is_bot: true } : {}) });
        }
        cursor = body.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      return refused(app, err instanceof Error ? err.message : String(err));
    }
    return found.length ? found : null;
  };
}

interface EventsEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  /** the app the delivery is for: whose app-level token asks for the rest */
  api_app_id?: string;
  /** the installed users this delivery is for — Slack names one (§4) */
  authorizations?: Authorization[];
  /** the event's handle for `apps.event.authorizations.list` */
  event_context?: string;
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
  if (SIGNED_OUT_NAMES.has(open.error ?? "")) {
    throw new SignedOut(`connections.open: ${open.error}`);
  }
  if (!open.ok || !open.url) throw new Error(`connections.open: ${open.error}`);
  return open.url;
}

export interface SlackSocketCarrierDeps {
  /** The WebSocket URL for an app-level token; default = apps.connections.open. */
  open?: (appToken: string) => Promise<string>;
  /** The socket is up: `down` is how long it was closed before this open, in ms, and
   *  null on the first. Slack holds nothing for a socket that is not there — what the
   *  workspace said in the gap is only in its history — so this is where the catch-up
   *  (catchup.ts) is asked for. */
  onOpen?: (down: number | null) => void;
  /** The socket is not there: it fell, or an open failed with `err` (a `SignedOut` when
   *  Slack ended the app token's access). */
  onDown?: (err?: unknown) => void;
}

/** Open the `xapp` socket and feed every events_api envelope to `handler` (built WITHOUT
 *  `track`, so its answer is the outcome) as a synthetic POST. An envelope is acked only
 *  on a 2xx: a refusal or a throw leaves it unacked, logged to stderr, and Slack redelivers
 *  it — the store's external_id upsert makes the redelivery converge. Envelopes that carry
 *  no event ack on arrival; a `disconnect` opens the successor before this socket closes,
 *  and a socket that falls is reopened after a pause. Returns stop: close the socket,
 *  settle the deliveries already being handled. */
export function slackSocket(
  appToken: string,
  handler: WebhookHandler,
  deps: SlackSocketCarrierDeps = {},
): () => Promise<void> {
  let ws: WebSocket | undefined;
  let closed = false;
  let opened = 0;
  let downSince: number | null = null;
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

  /** Open a socket; `handover` is the one it replaces — closed once this one is up, so a
   *  refresh Slack asks for (`disconnect`) leaves no gap: the new socket takes deliveries
   *  before the old stops. A socket that fell is reconnected after a pause, and the time
   *  it was down is what `onOpen` is told. */
  const connect = async (handover?: WebSocket) => {
    if (closed) return;
    try {
      const socket = new WebSocket(await open(appToken));
      ws = socket;
      socket.onopen = () => {
        const down = opened === 0 ? null : downSince === null ? 0 : Date.now() - downSince;
        opened++;
        downSince = null;
        handover?.close();
        deps.onOpen?.(down);
      };
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
            // then(f, f): a rejected `finally` would be a second, unhandled rejection
            const done = () => inFlight.delete(delivery);
            delivery.then(done, done);
            await delivery;
            return;
          }
          if (env.envelope_id) socket.send(JSON.stringify({ envelope_id: env.envelope_id }));
          if (env.type === "disconnect") void connect(socket);
        } catch (err) {
          console.error(
            "[ingest] socket delivery failed:",
            err instanceof Error ? err.message : err,
          );
        }
      };
      socket.onclose = () => {
        if (ws !== socket) return; // handed over: its successor is already up
        downSince ??= Date.now();
        if (closed) return;
        deps.onDown?.();
        setTimeout(() => void connect(), RECONNECT_MS);
      };
    } catch (err) {
      downSince ??= Date.now();
      deps.onDown?.(err);
      console.error("[ingest] socket error:", err instanceof Error ? err.message : err);
      if (!closed) setTimeout(() => void connect(), RECONNECT_ERROR_MS);
    }
  };
  void connect(); // it reports its own failures and schedules its own retry

  return async () => {
    closed = true;
    ws?.close();
    await Promise.allSettled([...inFlight]);
  };
}

/* ── local entry: Socket Mode carriers (from the vault) or HTTP ─────────────
 *
 *   deno task run:slack       # xapp in the vault → socket mode; else HTTP on
 *                             # data/run/slack.sock behind the edge
 *
 * Env: none — everything comes from the vault. Socket carriers are the app-level
 * tokens `liquen connect slack app` stored, one socket per app (§4). No carrier ⇒ HTTP
 * mode, verified by the apps' signing secrets (the same door stores them); no app, no
 * server. */
/** The secrets an HTTP-mode server verifies with: every app row's `signing_secret`. None
 *  is a refusal to serve — an unverified Events URL would take any POST as the workspace's
 *  word, `authorizations` included. */
export function httpSigningSecrets(apps: { value: Record<string, string> }[]): string[] {
  const secrets = apps.map((a) => a.value.signing_secret).filter((s) => s);
  if (secrets.length === 0) {
    throw new Error(
      "HTTP mode needs a signing secret — `liquen connect slack app` pastes it, or an " +
        "app-level token (xapp) for Socket Mode",
    );
  }
  return secrets;
}

/** Wire the inbound half over the org's log — resident once it returns (socket or server).
 *  Returns stop: refuse new deliveries, finish the ones in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openStore } = await import("../../store/mod.ts");
  const { SOCKET_PREFIX } = await import("./connect.ts");
  const { slackConfig } = await import("./config.ts");
  const { kindOf, saveMedia } = await import("../../store/media.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  const storage = store.storage();
  // socket carriers: one per app-level token in the vault — Socket Mode is app-scoped,
  // and one socket carries every workspace that app is installed in (§4)
  const carriers = [
    ...new Set(
      (await creds.list(SOCKET_PREFIX)).map((r) => r.value.app_token).filter(Boolean),
    ),
  ];

  // the media seam, broker-side (§9): resolve a token that can read `url_private`
  // (the shared bot → any authorized grant), download, land in the media store —
  // the URL and the token stay on this side of the frontier
  const tokenFor = async (team: string, users: string[]): Promise<string | null> => {
    const org = await creds.get(`slack:${team}:org`);
    if (org?.value.token) return org.value.token;
    for (const u of users) {
      const key = (await log.connection("slack", `${team}:${u}`))?.credentialKey;
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
      const file = await saveMedia(storage, bytes, { mime_type: f.mimetype, name: f.name });
      return { type: "file", kind: kindOf(file.mime_type), file };
    } catch (err) {
      console.error("[ingest] media download failed:", err instanceof Error ? err.message : err);
      return null;
    }
  };

  // the name directory reads with the same resolution the media seam uses (shared bot →
  // any authorized grant → env) — a display name is a workspace fact any grant can read
  const names = slackNames(tokenFor);
  // every row is marked before it lands (connect/marks.ts): a crowded channel's lines
  // silenced, a line for the account among them news. The account is its bot and its
  // user grants
  const accounts = slackAccounts(() => log.connections());
  const marks = createMarks({
    read: (q) => log.read(q),
    knobs: await slackConfig(root),
    self: accounts.of,
  });

  const base: SlackWebhookDeps = {
    // the log's publish closes over the db, not `this`; `marked` keeps its overloads
    publish: marked(log.publish, async (drafts) => {
      await accounts.read();
      return await marks(drafts);
    }),
    store: log, // identities + memberships live on the Log (§4) — the wire fills the map
    media,
    names,
    accounts,
    // every installation a live event reached, asked with the delivering app's own token
    installations: slackInstallations(async (app) =>
      (await creds.get(`${SOCKET_PREFIX}${app}`))?.value.app_token
    ),
  };
  const release = async () => {
    await creds.close();
    await log.close();
  };
  // the gap's reader (catchup.ts): what the workspace said while no carrier was there,
  // read back from the history APIs with the workspace's own tokens
  const { createSlackCatchUp, slackLegs } = await import("./catchup.ts");
  const catchUp = createSlackCatchUp({
    ...base,
    read: (q) => log.read(q),
    legs: async () => slackLegs(await creds.list("slack:"), await log.connections()),
    onCaughtUp: (team, n) => n && console.error(`[ingest] ${team}: caught up, +${n} row(s)`),
    onSkipped: (team, rooms) =>
      console.error(
        `[ingest] ${team}: catch-up skipped ${rooms.length} room(s): ${rooms.join("; ")}`,
      ),
    onError: (team, err) =>
      console.error(`[ingest] ${team}: catch-up FAILED:`, err instanceof Error ? err.message : err),
  });
  if (carriers.length > 0) {
    // socket mode: no signing secret (the xapp IS the authentication) and no `track` —
    // the carrier acks on the handler's answer, and each carrier's stop settles the
    // deliveries it still has in hand. Every open reads the gap back, the first at boot;
    // a refresh hands over with no gap and asks for nothing
    console.error(`[ingest] socket mode, ${carriers.length} carrier(s) → ${dir}/log`);
    const handler = createSlackWebhook(base);
    const health = socketHealth({
      carriers: carriers.length,
      store: log,
      onError: (err) => console.error("[ingest] socket state FAILED:", err),
    });
    const stops = carriers.map((t, i) =>
      slackSocket(t, handler, {
        onOpen: (down) => {
          health.up(i);
          if (down === null || down > CATCH_UP_AFTER_MS) void catchUp.run();
        },
        onDown: (err) => health.down(i, err),
      })
    );
    return async () => {
      await Promise.allSettled(stops.map((stop) => stop()));
      await health.stop();
      await catchUp.settle();
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
      // then(f, f): a rejected `finally` would be a second, unhandled rejection
      const done = () => inFlight.delete(work);
      work.then(done, done);
    },
  });
  const { serveIngest } = await import("../serve.ts");
  const server = await serveIngest(root, "slack", handler);
  console.error(`[ingest] HTTP on ${server.addr.path} → ${dir}/log (Events API request URL)`);
  // Slack retried what it could not deliver for minutes, not for the whole gap: what a
  // restart missed is read back once the door is open
  void catchUp.run();
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await Promise.allSettled([...inFlight]);
    await catchUp.settle();
    await release();
  };
}

if (import.meta.main) await entry(runIngest);
