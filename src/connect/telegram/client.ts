/**
 * connect/telegram/client.ts — the SDK's side of the wire: an account's MTProto session
 * through mtcute, as a `TgWire` and a stream of `TgEvent`s.
 *
 * The SDK stops here. This file opens the session, turns mtcute's objects into the plain
 * shapes of `wire.ts`, and turns Telegram's refusals into the dispatch error contract: a
 * flood wait is a 429, a session Telegram ended is `SignedOut`, another refusal of the
 * request is a 400, and a failure that is no refusal carries no class.
 *
 * The session is two things kept apart. The vault holds the credential, the session
 * string a sign-in exports: the server, the authorization key and the account. The cache
 * is mtcute's own SQLite file under the org's `data/telegram/`: the peers it has met,
 * with the access hashes a call names them by, and the update cursors a restart resumes
 * from. The credential is taken in at every opening, so a new sign-in of the account
 * replaces the key and keeps the rest: the peers and the cursors are the account's, not
 * the session's. With its cursors kept, the session replays what the account received
 * while the process was away (`catchUp`), and a replayed line merges on its
 * `external_id`.
 *
 * Reactions arrive as the whole set a message wears. A set Telegram cut short (a large
 * room's names only for the latest few) is read whole from the message's reaction list
 * where the account may see it, and said not at all where it may not: a person missing
 * from a set would read as a reaction taken back.
 *
 * How the account's own app holds a chat, muted or archived, is read from the dialog list
 * at start and kept current from the settings updates the session carries; each message
 * wears the marks its chat had when it arrived.
 *
 * A group's lines carry its member count and whether the account administers it, the
 * facts the crowd rule reads (`connect/marks.ts`): a basic group says both on itself, a
 * supergroup's count is read off its full chat once in `ROOM_FACTS_MS`. A forum's lines
 * name their topic, its title read once and kept current by the topics' own service
 * messages. Both lookups can wait on the network, so messages and edits are said in a
 * queue of their own, in the order they arrived.
 */

import {
  getMarkedPeerId,
  InputMedia,
  type InputMediaLike,
  type InputPeerLike,
  type InputText,
  Long,
  MemoryStorage,
  type Message,
  type Peer,
  type PeersIndex,
  SqliteStorage,
  TelegramClient,
  tl,
  User,
} from "@mtcute/deno";
import type { ConnectionState } from "../../store/connections.ts";
import type { MediaKind } from "../../types.ts";
import { DispatchError, SignedOut } from "../errors.ts";
import { floodSeconds } from "./bio.ts";
import {
  chatOf,
  GENERAL,
  type TgAction,
  type TgEntity,
  type TgEvent,
  type TgFile,
  type TgMessage,
  type TgOutbound,
  type TgPeer,
  type TgTopic,
  type TgWire,
} from "./wire.ts";

/** How the session names itself in the account's list of devices. */
export const DEVICE = { deviceModel: "liquen", appVersion: "1" };
/** A history read's page, and how many pages one gap is read for. */
const PAGE = 100;
const PAGES = 10;
/** The most seats a roster is read to. */
const MEMBERS_MAX = 1_000;
/** How long a supergroup's member count and the account's role in it stand before its
 *  full chat is read again. */
export const ROOM_FACTS_MS = 6 * 60 * 60_000;
/** The most messages one chat's history import reads. */
export const IMPORT_MAX = 5_000;

/** Telegram's words for a session that is over. */
const ENDED = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);

/** Whether an error says the session is over. */
export function ended(err: unknown): boolean {
  return tl.RpcError.is(err) && ENDED.has(err.text);
}

/** A failure in the dispatch contract's terms. */
export function wireError(err: unknown): Error {
  if (err instanceof DispatchError) return err;
  if (tl.RpcError.is(err)) {
    if (ENDED.has(err.text)) return new SignedOut(`Telegram ended the session: ${err.text}`);
    if (floodSeconds(err.text) !== undefined || err.code === 420) {
      return new DispatchError(err.text, 429);
    }
    return new DispatchError(err.text, err.code >= 500 ? 503 : 400);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** A chat or a person as the SDK is asked for one: a marked id as a number, a handle or
 *  a phone as text. A forum topic's address names its supergroup. */
function target(address: string): InputPeerLike {
  const { chat } = chatOf(address);
  return /^-?\d+$/.test(chat) ? Number(chat) : chat.replace(/^@/, "");
}

export function peerOf(p: Peer): TgPeer {
  if (p.type === "user") {
    return {
      id: String(p.id),
      kind: "user",
      ...(p.displayName ? { name: p.displayName } : {}),
      ...(p.username ? { username: p.username } : {}),
      ...(p.phoneNumber ? { phone: p.phoneNumber } : {}),
      ...(p.isBot ? { bot: true } : {}),
      ...(p.isContact ? { contact: true } : {}),
      ...(p.isMin ? { min: true } : {}),
    };
  }
  const kind = p.chatType === "group"
    ? "group" as const
    : p.chatType === "channel"
    ? "channel" as const
    : "supergroup" as const;
  // a stub of a chat carries none of the account's rights in it
  const room = kind !== "channel";
  return {
    id: String(p.id),
    kind,
    ...(p.title ? { name: p.title } : {}),
    ...(p.username ? { username: p.username } : {}),
    ...(kind === "channel" && (p.isCreator || p.adminRights?.postMessages) ? { posts: true } : {}),
    ...(p.isForum ? { forum: true } : {}),
    ...(room && p.membersCount !== null ? { members: p.membersCount } : {}),
    ...(room && !p.isMin ? { admin: p.isCreator || p.isAdmin } : {}),
  };
}

const ENTITY: Record<string, TgEntity["type"]> = {
  messageEntityBold: "bold",
  messageEntityItalic: "italic",
  messageEntityUnderline: "underline",
  messageEntityStrike: "strike",
  messageEntitySpoiler: "spoiler",
  messageEntityCode: "code",
  messageEntityPre: "pre",
  messageEntityTextUrl: "link",
  messageEntityBlockquote: "quote",
  messageEntityMention: "mention",
  messageEntityMentionName: "mention_name",
};

function entitiesOf(raw: tl.TypeMessageEntity[] | undefined): TgEntity[] {
  return (raw ?? []).flatMap((e): TgEntity[] => {
    const type = ENTITY[e._];
    if (!type) return [];
    return [{
      type,
      offset: e.offset,
      length: e.length,
      ...(e._ === "messageEntityTextUrl" ? { url: e.url } : {}),
      ...(e._ === "messageEntityPre" && e.language ? { language: e.language } : {}),
      ...(e._ === "messageEntityMentionName" ? { user: String(e.userId) } : {}),
    }];
  });
}

/** A reaction's glyph: the emoji itself, `custom:<id>` for a custom one. A paid reaction
 *  is Stars, not a person's glyph, and is none. */
export function glyphOf(r: tl.TypeReaction): string | undefined {
  if (r._ === "reactionEmoji") return r.emoticon;
  if (r._ === "reactionCustomEmoji") return `custom:${r.documentId.toString()}`;
  return undefined;
}

/** A glyph as Telegram takes one. */
function inputReaction(emoji: string): tl.TypeReaction {
  return emoji.startsWith("custom:")
    ? { _: "reactionCustomEmoji", documentId: Long.fromString(emoji.slice(7)) }
    : { _: "reactionEmoji", emoticon: emoji };
}

/** Whether the people a set names are all of them: Telegram counts every glyph but names
 *  only the latest reactors in a larger room. */
export function whole(r: tl.TypeMessageReactions): boolean {
  if (r.min) return false;
  const counted = r.results
    .filter((c) => glyphOf(c.reaction) !== undefined)
    .reduce((n, c) => n + c.count, 0);
  const named = (r.recentReactions ?? []).filter((x) => glyphOf(x.reaction) !== undefined);
  return named.length === counted;
}

/** The most reactors a cut-short set is read to; a set with more says nothing. */
const REACTORS_MAX = 300;

const DISCARD: Record<string, "missed" | "rejected" | "ended"> = {
  phoneCallDiscardReasonMissed: "missed",
  phoneCallDiscardReasonBusy: "rejected",
  phoneCallDiscardReasonHangup: "ended",
  phoneCallDiscardReasonDisconnect: "ended",
};

export function createTelegramWire(
  client: TelegramClient,
  self: TgPeer,
): {
  wire: TgWire;
  messageOf: (m: Message) => TgMessage;
  /** A message as a line: `messageOf`, its room's facts and its topic looked up. */
  lineOf: (m: Message) => Promise<TgMessage>;
  /** A room with the facts the crowd rule reads, and a forum's topic by id. */
  roomed: (p: TgPeer) => Promise<TgPeer>;
  topicOf: (chat: string, id: number) => Promise<TgTopic>;
  /** Whether a message is a line: a service message the room vocabulary has no word
   *  for is none. */
  said: (m: Message) => boolean;
  views: Views;
  rooms: Rooms;
} {
  const views: Views = new Map();
  const rooms: Rooms = new Map();
  const titles = new Map<string, string>(); // a topic's address → its title

  /** A room as its lines carry it: a supergroup's count and the account's role, read off
   *  its full chat when the peer did not say them, at most once in `ROOM_FACTS_MS`. */
  const roomed = async (p: TgPeer): Promise<TgPeer> => {
    if (p.kind !== "group" && p.kind !== "supergroup") return p;
    const held = rooms.get(p.id);
    const fresh = held && Date.now() - held.at < ROOM_FACTS_MS;
    if (p.members !== undefined && p.admin !== undefined) {
      rooms.set(p.id, { members: p.members, admin: p.admin, at: held?.at ?? Date.now() });
      return p;
    }
    let facts = held;
    if (!fresh && p.kind === "supergroup") {
      facts = { ...held, at: Date.now() };
      rooms.set(p.id, facts);
      try {
        const full = await client.getFullChat(Number(p.id));
        facts.members = full.membersCount ?? facts.members;
        facts.admin = full.isCreator || full.isAdmin;
      } catch { /* the facts wait for the next read */ }
    }
    return {
      ...p,
      ...(p.members === undefined && facts?.members !== undefined
        ? { members: facts.members }
        : {}),
      ...(p.admin === undefined && facts?.admin !== undefined ? { admin: facts.admin } : {}),
    };
  };

  /** A forum topic, its title read once and then kept by the topics' service messages. */
  const topicOf = async (chat: string, id: number): Promise<TgTopic> => {
    const key = `${chat}/${id}`;
    if (!titles.has(key)) {
      try {
        const [topic] = await client.getForumTopicsById(Number(chat), id);
        if (topic) titles.set(key, topic.title);
      } catch { /* untitled until a line says it */ }
    }
    const title = titles.get(key);
    return { id, ...(title ? { title } : {}) };
  };

  /** The topic a forum's message sits in: the one it opens, the one its reply header
   *  names, or General. */
  const topicIdOf = (m: Message): number => {
    if (m.action?.type === "topic_created") return m.id;
    const header = (m.raw as { replyTo?: tl.TypeMessageReplyHeader }).replyTo;
    if (header?._ === "messageReplyHeader" && header.forumTopic) {
      return header.replyToTopId ?? header.replyToMsgId ?? GENERAL;
    }
    return GENERAL;
  };

  /** A person an action names by id, with the name the message came with. */
  const named = (m: Message, id: number): TgPeer => {
    try {
      const raw = m._peers.user(id);
      if (raw._ === "user") return peerOf(new User(raw));
    } catch { /* the message came without them */ }
    return { id: String(id), kind: "user" };
  };

  const actionOf = (m: Message): TgAction | undefined => {
    const a = m.action;
    if (!a) return undefined;
    switch (a.type) {
      case "chat_created":
        return { type: "created", title: a.title, members: a.users.map((u) => named(m, u)) };
      case "channel_created":
        return { type: "created", title: a.title, members: [] };
      case "users_added":
        return { type: "added", members: a.users.map((u) => named(m, u)) };
      case "user_joined_link":
        return { type: "joined", how: "link" };
      case "user_joined_approved":
        return { type: "joined", how: "approved" };
      case "user_joined_community":
        return { type: "joined" };
      case "user_left":
        return { type: "left" };
      case "user_removed":
        return { type: "removed", member: named(m, a.user) };
      case "title_changed":
        return { type: "title", title: a.title };
      case "photo_changed":
        return { type: "photo", photo: "set" };
      case "photo_deleted":
        return { type: "photo", photo: "removed" };
      case "message_pinned":
        return { type: "pinned", ...(m.replyToMessage?.id ? { id: m.replyToMessage.id } : {}) };
      case "ttl_changed":
        return { type: "timer", seconds: a.period };
      case "call":
        return {
          type: "call",
          state: a.reason ? DISCARD[a.reason._] ?? "ended" : "ended",
          kind: a.isVideo ? "video" : "audio",
          ...(a.duration ? { seconds: a.duration } : {}),
        };
      case "group_call_started":
        return { type: "call", state: "started" };
      case "group_call_ended":
        return { type: "call", state: "ended", seconds: a.duration };
      case "chat_migrate_to":
        return { type: "moved", to: String(a.id) };
      case "topic_created":
        return { type: "topic", title: a.title, state: "created" };
      case "topic_edited":
        return {
          type: "topic",
          ...(a.title ? { title: a.title } : {}),
          ...(a.closed === undefined ? {} : { state: a.closed ? "closed" : "reopened" }),
        };
      // the supergroup's own first line, said already in the group it came from; a
      // person joining Telegram is no change to any room
      case "channel_migrate_from":
      case "contact_joined":
      case "history_cleared":
        return undefined;
      default:
        return { type: "other", name: a.type };
    }
  };

  const fileOf = (m: Message): TgFile | undefined => {
    const media = m.media;
    if (!media) return undefined;
    const bytes = async () => await client.downloadAsBuffer(media as never);
    switch (media.type) {
      case "photo":
        return { kind: "image", mime: "image/jpeg", bytes };
      case "voice":
      case "audio":
      case "video":
      case "sticker":
      case "document": {
        const kind: MediaKind = media.type === "voice"
          ? "audio"
          : media.type === "document"
          ? "document"
          : media.type;
        return {
          kind,
          mime: media.mimeType,
          ...(media.fileName ? { name: media.fileName } : {}),
          ...(media.fileSize ? { size: media.fileSize } : {}),
          bytes,
        };
      }
      default:
        return undefined;
    }
  };

  const said = (m: Message) => !m.isService || actionOf(m) !== undefined;

  const messageOf = (m: Message): TgMessage => {
    const chat = peerOf(m.chat);
    const view = views.get(chat.id);
    const media = m.media;
    const file = fileOf(m);
    const action = m.isService ? actionOf(m) : undefined;
    const reply = m.replyToMessage;
    return {
      id: m.id,
      chat,
      // a channel's post is the channel's, and wears no author
      ...(m.isChannelPost ? {} : { sender: peerOf(m.sender) }),
      out: m.isOutgoing,
      date: m.date.toISOString(),
      ...(m.editDate && !m.hideEditMark ? { edited: m.editDate.toISOString() } : {}),
      text: m.text,
      entities: entitiesOf(m.raw._ === "message" ? m.raw.entities : undefined),
      ...(file ? { file } : {}),
      ...(media?.type === "location" || media?.type === "live_location"
        ? { location: { latitude: media.latitude, longitude: media.longitude } }
        : {}),
      ...(media?.type === "venue"
        ? {
          location: {
            latitude: media.location.latitude,
            longitude: media.location.longitude,
            name: media.title,
            address: media.address,
          },
        }
        : {}),
      ...(media?.type === "contact"
        ? {
          contact: {
            name: [media.firstName, media.lastName].filter(Boolean).join(" "),
            phone: media.phoneNumber,
          },
        }
        : {}),
      ...(media && !file && !["location", "live_location", "venue", "contact", "webpage"]
          .includes(media.type)
        ? { other: media.type }
        : {}),
      // a forum's topic is the reply's thread, and no message being answered
      ...(reply?.id && !m.isService && !(reply.isForumTopic && reply.threadId === null) &&
          reply.origin === "same_chat"
        ? { reply: reply.id }
        : {}),
      ...(m.forward ? { forwarded: true } : {}),
      ...(m.isMention ? { mentioned: true } : {}),
      ...(action ? { action } : {}),
      ...(view?.muted ? { muted: true } : {}),
      ...(view?.archived ? { archived: true } : {}),
    };
  };

  const lineOf = async (m: Message): Promise<TgMessage> => {
    const line = messageOf(m);
    const chat = await roomed(line.chat);
    if (!chat.forum) return { ...line, chat };
    const id = topicIdOf(m);
    const a = line.action;
    if (a?.type === "topic" && a.title) titles.set(`${chat.id}/${id}`, a.title);
    return { ...line, chat, topic: await topicOf(chat.id, id) };
  };

  const inputEntities = async (entities: TgEntity[]): Promise<tl.TypeMessageEntity[]> => {
    const out: tl.TypeMessageEntity[] = [];
    for (const e of entities) {
      const at = { offset: e.offset, length: e.length };
      switch (e.type) {
        case "bold":
          out.push({ _: "messageEntityBold", ...at });
          break;
        case "italic":
          out.push({ _: "messageEntityItalic", ...at });
          break;
        case "underline":
          out.push({ _: "messageEntityUnderline", ...at });
          break;
        case "strike":
          out.push({ _: "messageEntityStrike", ...at });
          break;
        case "spoiler":
          out.push({ _: "messageEntitySpoiler", ...at });
          break;
        case "code":
          out.push({ _: "messageEntityCode", ...at });
          break;
        case "pre":
          out.push({ _: "messageEntityPre", ...at, language: e.language ?? "" });
          break;
        case "link":
          if (e.url) out.push({ _: "messageEntityTextUrl", ...at, url: e.url });
          break;
        case "quote":
          out.push({ _: "messageEntityBlockquote", ...at });
          break;
        case "mention_name":
          if (!e.user) break;
          try {
            out.push({
              _: "inputMessageEntityMentionName",
              ...at,
              userId: await client.resolveUser(Number(e.user)),
            });
          } catch { /* a person the session cannot name is left as their words */ }
          break;
      }
    }
    return out;
  };

  const textOf = async (out: TgOutbound): Promise<InputText> => ({
    text: out.text ?? "",
    entities: await inputEntities(out.entities ?? []),
  });

  const mediaOf = async (out: TgOutbound): Promise<InputMediaLike | undefined> => {
    const caption = out.text ? { caption: await textOf(out) } : {};
    if (out.file) {
      const f = out.file;
      const params = {
        ...caption,
        fileMime: f.mime,
        ...(f.name ? { fileName: f.name } : {}),
      };
      switch (f.kind) {
        case "image":
          return InputMedia.photo(f.bytes, params);
        case "video":
          return InputMedia.video(f.bytes, params);
        case "audio":
          return f.mime.startsWith("audio/ogg")
            ? InputMedia.voice(f.bytes, params)
            : InputMedia.audio(f.bytes, params);
        case "sticker":
          return InputMedia.sticker(f.bytes, params);
        default:
          return InputMedia.document(f.bytes, params);
      }
    }
    if (out.location) return InputMedia.geo(out.location.latitude, out.location.longitude);
    if (out.contact) {
      const [first, ...rest] = out.contact.name.split(/\s+/);
      return InputMedia.contact({
        phone: out.contact.phone,
        firstName: first ?? "",
        lastName: rest.join(" "),
      });
    }
    return undefined;
  };

  /** Run a call, its failure in the contract's terms. */
  const asked = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      throw wireError(err);
    }
  };

  const wire: TgWire = {
    self,
    send: (chat, out) =>
      asked(async () => {
        const to = target(chat);
        const { topic } = chatOf(chat);
        const params = {
          ...(out.reply !== undefined ? { replyTo: out.reply } : {}),
          // General takes a line that names no topic
          ...(topic !== undefined && topic !== GENERAL ? { threadId: topic } : {}),
        };
        const media = await mediaOf(out);
        const sent = media
          ? await client.sendMedia(to, media, params)
          : await client.sendText(to, await textOf(out), params);
        const landed = peerOf(sent.chat);
        return { id: sent.id, chat: topic !== undefined ? { ...landed, id: chat } : landed };
      }),
    edit: (chat, id, text, entities) =>
      asked(async () => {
        await client.editMessage({
          chatId: target(chat),
          message: id,
          text: await textOf({ text, entities }),
        });
      }),
    delete: (chat, ids) => asked(() => client.deleteMessagesById(target(chat), ids)),
    react: (chat, id, emojis) =>
      asked(async () => {
        const sent = await client.sendReaction({
          chatId: target(chat),
          message: id,
          emoji: emojis.length ? emojis.map(inputReaction) : null,
        });
        const mine = sent?.raw._ === "message"
          ? sent.raw.reactions?.recentReactions?.find((r) => r.my)
          : undefined;
        return mine ? new Date(mine.date * 1_000).toISOString() : undefined;
      }),
    resolve: async (handle) => {
      try {
        return peerOf(await client.getPeer(target(handle)));
      } catch (err) {
        const e = wireError(err);
        // Telegram's words for nobody there; anything else is the call's own failure
        if (e instanceof DispatchError && e.code === 400) return null;
        throw e;
      }
    },
    about: (user) => asked(async () => (await client.getFullUser(target(user))).bio),
    contacts: () => asked(async () => (await client.getContacts()).map(peerOf)),
    saveContact: (user, name) =>
      asked(async () => {
        const who = await client.getUser(target(user));
        const [first, ...rest] = (name ?? who.displayName).trim().split(/\s+/);
        const saved = await client.addContact({
          userId: who.inputPeer,
          firstName: first || who.firstName,
          lastName: rest.join(" "),
          phone: who.phoneNumber ?? "",
        });
        return { ...peerOf(saved), contact: true };
      }),
    dropContact: (user) =>
      asked(async () => {
        await client.deleteContacts(target(user));
      }),
    createRoom: (title, members, kind) =>
      asked(async () => {
        const users = members.map(target);
        if (kind === "group") return peerOf((await client.createGroup({ title, users })).chat);
        const room = await client.createSupergroup({ title });
        if (users.length) await client.addChatMembers(room.inputPeer, users, {});
        return peerOf(room);
      }),
    members: (chat) =>
      asked(async () => {
        const out: TgPeer[] = [];
        for await (const m of client.iterChatMembers(target(chat), { limit: MEMBERS_MAX })) {
          out.push(peerOf(m.user));
        }
        return out;
      }),
    join: (chat) =>
      asked(async () => {
        await client.joinChat(target(chat));
      }),
    leave: (chat) => asked(() => client.leaveChat(target(chat))),
    add: (chat, members) =>
      asked(async () => {
        const missing = await client.addChatMembers(target(chat), members.map(target), {});
        if (missing.length) {
          throw new DispatchError(
            `Telegram would not seat ${
              missing.map((m) => m.userId).join(", ")
            }: their privacy settings ask for an invite link`,
            403,
          );
        }
      }),
    remove: (chat, members) =>
      asked(async () => {
        for (const m of members) {
          await client.kickChatMember({ chatId: target(chat), userId: target(m) });
        }
      }),
    rename: (chat, title) =>
      asked(async () => {
        const { topic } = chatOf(chat);
        if (topic === undefined) return await client.setChatTitle(target(chat), title);
        await client.editForumTopic({ chatId: target(chat), topicId: topic, title });
        titles.set(chat, title);
      }),
    view: (chat) => ({ ...views.get(chat) }),
    topics: (chat) =>
      asked(async () => {
        const out: number[] = [];
        for await (const t of client.iterForumTopics(target(chat))) out.push(t.id);
        return out;
      }),
    dialogs: () =>
      asked(async () => {
        const out: TgPeer[] = [];
        for await (const d of client.iterDialogs()) out.push(peerOf(d.peer));
        return out;
      }),
    since: (chat, since) =>
      asked(async () => {
        const floor = Date.parse(since);
        const got: Message[] = [];
        for await (const m of client.iterHistory(target(chat), { limit: IMPORT_MAX })) {
          if (m.date.getTime() <= floor) break;
          got.push(m);
        }
        const out: TgMessage[] = [];
        for (const m of got.reverse()) if (said(m)) out.push(await lineOf(m));
        return out;
      }),
    history: (chat, since) =>
      asked(async () => {
        const out: Message[] = [];
        let below: number | undefined;
        for (let page = 0; page < PAGES; page++) {
          const got = await client.getHistory(target(chat), {
            minId: since,
            limit: PAGE,
            ...(below !== undefined ? { maxId: below } : {}),
          });
          const fresh = got.filter((m) => m.id > since);
          if (!fresh.length) break;
          out.push(...fresh);
          below = Math.min(...fresh.map((m) => m.id));
        }
        const lines: TgMessage[] = [];
        for (const m of out.sort((a, b) => a.id - b.id)) if (said(m)) lines.push(await lineOf(m));
        return lines;
      }),
  };
  return { wire, messageOf, lineOf, roomed, topicOf, said, views, rooms };
}

/** How the account's app holds each chat, by marked id. */
type Views = Map<string, { muted?: boolean; archived?: boolean }>;
/** A group's member count and the account's role in it, by marked id, and when its full
 *  chat was last read. */
type Rooms = Map<string, { members?: number; admin?: boolean; at: number }>;

export interface TelegramSession {
  wire: TgWire;
  /** Close the session's connection and its cache. */
  stop: () => Promise<void>;
  /** End the session on Telegram, then close it. */
  logOut: () => Promise<void>;
}

export interface OpenOptions {
  apiId: number;
  apiHash: string;
  /** The credential: the session string the door stored. */
  session: string;
  /** The cache file. */
  cache: string;
  /** Every event, in arrival order. */
  onEvent: (event: TgEvent) => void;
  onError?: (what: string, err: unknown) => void;
}

/** mtcute's log, at the level that says only what failed. */
const LOG_ERRORS = 1;

/** End a session on Telegram, so the account's list of devices no longer shows it: the
 *  session a new sign-in replaced. Run on a session of its own in memory, after the
 *  connector's client of it has closed, since two clients on one session cost it. A
 *  session Telegram already ended is no failure. */
export async function logOutSession(
  opts: { apiId: number; apiHash: string; session: string },
): Promise<void> {
  const client = new TelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: new MemoryStorage(),
    initConnectionOptions: DEVICE,
    logLevel: LOG_ERRORS,
    disableUpdates: true,
  });
  try {
    await client.importSession(opts.session);
    await client.logOut();
  } catch (err) {
    if (!ended(err)) throw wireError(err);
  } finally {
    await client.destroy().catch(() => {});
  }
}

export interface SignInOptions {
  apiId: number;
  apiHash: string;
  /** Set: the code flow for that number, the code asked through `code`. Absent: the QR
   *  flow, each link handed to `onQr` as Telegram rotates it. */
  phone?: string;
  code: () => Promise<string>;
  /** The account's two-step password, asked only when it has one. */
  password: () => Promise<string>;
  onQr: (url: string) => void;
}

/** Sign an account in on a session of its own and answer the credential: the session
 *  string, and who the account is. Nothing is kept here; the session lives in memory
 *  until its string is exported. */
export async function signIn(opts: SignInOptions): Promise<{ session: string; self: TgPeer }> {
  const client = new TelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: new MemoryStorage(),
    initConnectionOptions: DEVICE,
    logLevel: LOG_ERRORS,
    disableUpdates: true,
  });
  try {
    const me = await client.start({
      ...(opts.phone ? { phone: opts.phone, code: opts.code } : { qrCodeHandler: opts.onQr }),
      password: opts.password,
    });
    return { session: await client.exportSession(), self: peerOf(me) };
  } catch (err) {
    throw wireError(err);
  } finally {
    await client.destroy().catch(() => {});
  }
}

/** Open an account's session and start listening. Throws `SignedOut` when Telegram no
 *  longer takes the credential. */
export async function openTelegram(opts: OpenOptions): Promise<TelegramSession> {
  const storage = new SqliteStorage(opts.cache);
  let behind: (chat: string) => void = () => {};
  const client = new TelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage,
    initConnectionOptions: DEVICE,
    logLevel: LOG_ERRORS,
    updates: {
      catchUp: true,
      onChannelTooLong: (channel) => behind(String(getMarkedPeerId(channel, "channel"))),
    },
  });
  // the account is known once the session starts, and the listeners stand before it does:
  // starting is what begins the replay of what the account missed
  const { wire, lineOf, roomed, topicOf, said, views, rooms } = createTelegramWire(client, {
    id: "",
    kind: "user",
  });
  behind = (chat) => opts.onEvent({ type: "gap", chat });

  // a line's facts may wait on a lookup, and the lines still go out in arrival order
  let queue: Promise<void> = Promise.resolve();
  const inOrder = (what: string, make: () => Promise<TgEvent | undefined>) => {
    queue = queue.then(make).then(
      (event) => event && opts.onEvent(event),
      (err) => opts.onError?.(what, err),
    );
  };

  // what the session says before the chats' marks are read waits for them, in order
  let ready = false;
  const held: (() => void)[] = [];
  const guarded = <T>(what: string, fn: (x: T) => void) => (x: T) => {
    const run = () => {
      try {
        fn(x);
      } catch (err) {
        opts.onError?.(what, err);
      }
    };
    if (ready) run();
    else held.push(run);
  };
  client.onNewMessage.add(guarded("a message", (m: Message) => {
    if (!said(m)) return;
    inOrder("a message", async () => ({ type: "message", message: await lineOf(m) }));
  }));
  client.onEditMessage.add(guarded("an edit", (m: Message) => {
    inOrder("an edit", async () => ({ type: "edit", message: await lineOf(m) }));
  }));
  client.onDeleteMessage.add(guarded("a delete", (d) => {
    opts.onEvent({
      type: "delete",
      ids: d.messageIds,
      ...(d.channelId !== null ? { chat: String(getMarkedPeerId(d.channelId, "channel")) } : {}),
    });
  }));
  client.onHistoryRead.add(guarded("a read", (r) => {
    if (r.isOutbox && !r.isDiscussion) {
      opts.onEvent({ type: "read", chat: String(r.chatId), id: r.maxReadId });
    }
  }));
  /** A message's reactions as the session said them, whole, or nothing. */
  const reactionsOf = async (
    u: tl.RawUpdateMessageReactions,
    peers: PeersIndex,
  ): Promise<TgEvent | undefined> => {
    if (u.reactions.reactionsAsTags) return undefined; // Saved Messages' tags, not people
    const chatId = getMarkedPeerId(u.peer);
    const chat = await roomed(peerOf(await client.getPeer(chatId)));
    const topic = chat.forum ? { topic: await topicOf(chat.id, u.topMsgId ?? GENERAL) } : {};
    const person = (id: number): TgPeer => {
      try {
        const raw = peers.user(id);
        if (raw._ === "user") return peerOf(new User(raw));
      } catch { /* the update came without them */ }
      return { id: String(id), kind: "user" };
    };
    const said = (r: tl.RawMessagePeerReaction) => {
      const emoji = glyphOf(r.reaction);
      if (!emoji || r.peerId._ !== "peerUser") return [];
      const by = r.my ? wire.self : person(r.peerId.userId);
      return [{ by, emoji, date: new Date(r.date * 1_000).toISOString() }];
    };
    if (whole(u.reactions)) {
      return {
        type: "reactions",
        chat,
        ...topic,
        id: u.msgId,
        reactions: (u.reactions.recentReactions ?? []).flatMap(said),
      };
    }
    if (!u.reactions.canSeeList) return undefined;
    const listed: tl.RawMessagePeerReaction[] = [];
    for await (
      const r of client.iterReactionUsers({ chatId, message: u.msgId, limit: REACTORS_MAX })
    ) {
      listed.push(r.raw);
    }
    const counted = u.reactions.results
      .filter((c) => glyphOf(c.reaction) !== undefined)
      .reduce((n, c) => n + c.count, 0);
    if (listed.filter((r) => glyphOf(r.reaction) !== undefined).length !== counted) {
      return undefined;
    }
    return { type: "reactions", chat, ...topic, id: u.msgId, reactions: listed.flatMap(said) };
  };

  client.onRawUpdate.add(guarded("a reactions update", ({ update, peers }) => {
    if (update._ !== "updateMessageReactions") return;
    reactionsOf(update, peers).then(
      (event) => event && opts.onEvent(event),
      (err) => opts.onError?.("reading reactions", err),
    );
  }));
  client.onRawUpdate.add(guarded("a settings update", ({ update }) => {
    if (update._ === "updateNotifySettings" && update.peer._ === "notifyPeer") {
      const chat = String(getMarkedPeerId(update.peer.peer));
      const until = update.notifySettings.muteUntil ?? 0;
      views.set(chat, { ...views.get(chat), muted: until * 1_000 > Date.now() });
    }
    if (update._ === "updateFolderPeers") {
      for (const f of update.folderPeers) {
        const chat = String(getMarkedPeerId(f.peer));
        views.set(chat, { ...views.get(chat), archived: f.folderId === 1 });
      }
    }
  }));
  const STATE: Partial<Record<string, ConnectionState>> = {
    offline: "unavailable",
    connected: "connected",
  };
  client.onConnectionState.add((state) => {
    const mapped = STATE[state];
    if (mapped) opts.onEvent({ type: "state", state: mapped });
  });
  client.onError.add((err) => {
    if (ended(err)) opts.onEvent({ type: "state", state: "signed_out", error: String(err) });
    else opts.onError?.("the session", err);
  });

  try {
    wire.self = peerOf(await client.start({ session: opts.session, sessionForce: true }));
  } catch (err) {
    await client.destroy().catch(() => {});
    // an account Telegram signed out is asked for a phone, which nobody here gives
    if (ended(err) || !tl.RpcError.is(err)) {
      throw new SignedOut(
        `Telegram no longer takes this session (${err instanceof Error ? err.message : err})`,
      );
    }
    throw wireError(err);
  }

  // the marks every chat wears today, and the facts its peer says of it; a chat met later
  // wears no marks until its settings move
  try {
    for await (const d of client.iterDialogs()) {
      const peer = peerOf(d.peer);
      views.set(peer.id, {
        ...(d.isMuted ? { muted: true } : {}),
        ...(d.isArchived ? { archived: true } : {}),
      });
      if (peer.members !== undefined && peer.admin !== undefined) {
        rooms.set(peer.id, { members: peer.members, admin: peer.admin, at: Date.now() });
      }
    }
  } catch (err) {
    opts.onError?.("reading the dialogs", err);
  }
  ready = true;
  for (const run of held.splice(0)) run();
  opts.onEvent({ type: "state", state: "connected" });

  return {
    wire,
    stop: async () => {
      await client.destroy();
    },
    logOut: async () => {
      try {
        await client.logOut();
      } catch (err) {
        if (!ended(err)) throw wireError(err);
      } finally {
        await client.destroy().catch(() => {});
      }
    },
  };
}
