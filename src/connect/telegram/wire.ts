/**
 * connect/telegram/wire.ts — Telegram as the connector reads and writes it: plain shapes
 * and one interface, `TgWire`, over an account's live MTProto session.
 *
 * The SDK stops at `client.ts`, which fills these from mtcute's objects. Everything else
 * in the folder (the ingest's mapping, the dispatcher, the ports) reads and writes these
 * shapes alone, so each is pure over data and a test hands it a wire made of literals.
 *
 * Ids are MARKED, as Telegram's own clients and the Bot API spell them, because a user, a
 * basic group and a channel number their ids apart and the numbers collide: a user is its
 * id, a basic group is `-<id>`, a supergroup or a channel is `-100<id>`. They travel as
 * strings, the form the log holds an address in.
 */

import type { ConnectionState } from "../../store/connections.ts";
import type { MediaKind } from "../../types.ts";

export const SERVICE = "telegram" as const;

/** Whether a chat numbers its own messages: a supergroup or a channel. A direct chat and
 *  a basic group number theirs in the account's one inbox. */
export const ownNumbering = (chat: string): boolean => chat.startsWith("-100");

/** A message's `external_id`: `telegram:<account>.<id>`, with the chat between them where
 *  the chat numbers its own. */
export function externalId(account: string, chat: string, id: number | string): string {
  return ownNumbering(chat) ? `${SERVICE}:${account}.${chat}.${id}` : `${SERVICE}:${account}.${id}`;
}

/** The message an external id names: a message's own, and nothing for a line about one
 *  (an edit, a delete, a reaction). */
export function messageIdOf(external: string): number | undefined {
  const m = /^telegram:\d+\.(?:-100\d+\.)?(\d+)$/.exec(external);
  return m ? Number(m[1]) : undefined;
}

/** Someone or somewhere on Telegram. `kind` is the platform's own: a `user`, a basic
 *  `group`, a `supergroup` (a group that scales, a forum among them) or a `channel` (one
 *  to many). */
export interface TgPeer {
  id: string;
  kind: "user" | "group" | "supergroup" | "channel";
  /** A person's first and last name, a room's title. */
  name?: string;
  /** The public handle, without its `@`. A room that has one is open to anybody. */
  username?: string;
  phone?: string;
  bot?: boolean;
  /** The account's address book holds them, and `name` is the book's word. */
  contact?: boolean;
  /** Telegram sent only a stub of this person: enough to name them in the chat it came
   *  with, not enough to ask the server about them. */
  min?: boolean;
  /** A channel the account may post in. */
  posts?: boolean;
}

/** A span of a message's text. Offsets and lengths count UTF-16 units, which is how
 *  Telegram counts them and how a JavaScript string indexes. */
export interface TgEntity {
  type:
    | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "spoiler"
    | "code"
    | "pre"
    | "link"
    | "quote"
    | "mention"
    | "mention_name";
  offset: number;
  length: number;
  /** A `link`'s target. */
  url?: string;
  /** A `pre`'s language. */
  language?: string;
  /** A `mention_name`'s person, by id. */
  user?: string;
}

/** A file a message carries. The bytes stay on Telegram until `bytes` is called. */
export interface TgFile {
  kind: MediaKind;
  mime: string;
  name?: string;
  size?: number;
  bytes: () => Promise<Uint8Array>;
}

/** A service message: what a chat says about itself. */
export type TgAction =
  | { type: "created"; title: string; members: TgPeer[] }
  | { type: "added"; members: TgPeer[] }
  | { type: "joined"; how?: "link" | "approved" }
  | { type: "left" }
  | { type: "removed"; member: TgPeer }
  | { type: "title"; title: string }
  | { type: "photo"; photo: "set" | "removed" }
  | { type: "pinned"; id?: number }
  | { type: "timer"; seconds: number }
  | {
    type: "call";
    state: "started" | "ended" | "missed" | "rejected";
    kind?: "audio" | "video";
    seconds?: number;
  }
  /** The basic group became a supergroup, which has an id of its own. */
  | { type: "moved"; to: string }
  | { type: "topic"; title?: string; state?: "created" | "closed" | "reopened" }
  /** One the connector has no word for, by Telegram's name for it. */
  | { type: "other"; name: string };

export interface TgMessage {
  id: number;
  chat: TgPeer;
  /** Whoever wrote it. Absent on a channel's post, which the channel signs. */
  sender?: TgPeer;
  /** The account wrote it, from this session or any other device. */
  out: boolean;
  date: string;
  edited?: string;
  text: string;
  entities: TgEntity[];
  file?: TgFile;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contact?: { name: string; phone: string };
  /** Media the connector carries no bytes of, by Telegram's name: a poll, a game. */
  other?: string;
  /** The message this one answers, in this chat. */
  reply?: number;
  forwarded?: boolean;
  /** The account is named in it. */
  mentioned?: boolean;
  action?: TgAction;
  /** How the account's own app holds the chat. */
  muted?: boolean;
  archived?: boolean;
}

/** What the session says, in arrival order. */
export type TgEvent =
  | { type: "message"; message: TgMessage }
  | { type: "edit"; message: TgMessage }
  /** `chat` is known only for a channel's or a supergroup's: Telegram names a deleted
   *  message of a direct chat or a basic group by its id alone. */
  | { type: "delete"; ids: number[]; chat?: string }
  /** Every reaction message `id` of `chat` wears now, by person: the whole set, never a
   *  change. Said only when the set is whole: a set Telegram cut short says nothing. */
  | { type: "reactions"; chat: TgPeer; id: number; reactions: TgReaction[] }
  /** The other side read the account's messages up to `id`. */
  | { type: "read"; chat: string; id: number }
  /** A channel fell further behind than Telegram replays: its history is the record. */
  | { type: "gap"; chat: string }
  | { type: "state"; state: ConnectionState; error?: string };

/** One person's reaction: a glyph, or `custom:<id>` for a custom emoji, and when. */
export interface TgReaction {
  by: TgPeer;
  emoji: string;
  date: string;
}

/** What a send carries: one message's worth. */
export interface TgOutbound {
  text?: string;
  entities?: TgEntity[];
  file?: { bytes: Uint8Array; name?: string; mime: string; kind: MediaKind };
  location?: { latitude: number; longitude: number };
  contact?: { name: string; phone: string };
  reply?: number;
}

/** One account's live session. Every call rides the session's single connection, which
 *  is why the connector's process alone holds one: a second client on the same session
 *  costs the account the session. A call Telegram refuses throws `DispatchError`. */
export interface TgWire {
  /** The account. */
  self: TgPeer;
  /** How the account's own app holds `chat` now: muted, archived. */
  view(chat: string): { muted?: boolean; archived?: boolean };
  /** Post one message in `chat`: an address the log holds, or a handle (`@name`) for a
   *  first contact. Answers the message's id and the chat it landed in. */
  send(chat: string, out: TgOutbound): Promise<{ id: number; chat: TgPeer }>;
  edit(chat: string, id: number, text: string, entities: TgEntity[]): Promise<void>;
  delete(chat: string, ids: number[]): Promise<void>;
  /** Set the account's reactions on a message to `emojis`, none taking them all off.
   *  Answers when Telegram says the account reacted, if the set is not empty. */
  react(chat: string, id: number, emojis: string[]): Promise<string | undefined>;
  /** Who a handle or an id reaches: `@name`, a phone as `+digits`, a marked id. */
  resolve(handle: string): Promise<TgPeer | null>;
  /** A person's about text, as their profile shows it. */
  about(user: string): Promise<string>;
  /** The account's address book. */
  contacts(): Promise<TgPeer[]>;
  /** Save a person under `name`, or under the name they go by. Answers the entry. */
  saveContact(user: string, name?: string): Promise<TgPeer>;
  dropContact(user: string): Promise<void>;
  /** Make a room with these people in it: a group, or a public-style channel room. */
  createRoom(title: string, members: string[], kind: "group" | "channel"): Promise<TgPeer>;
  members(chat: string): Promise<TgPeer[]>;
  join(chat: string): Promise<void>;
  leave(chat: string): Promise<void>;
  add(chat: string, members: string[]): Promise<void>;
  remove(chat: string, members: string[]): Promise<void>;
  rename(chat: string, title: string): Promise<void>;
  /** The messages of `chat` after `since`, oldest first. */
  history(chat: string, since: number): Promise<TgMessage[]>;
}
