/**
 * connect/telegram/ingest.ts — the Telegram ingest: what an account's session says, mapped
 * and published.
 *
 * Telegram pushes over the session itself, so there is no request to serve: `client.ts`
 * turns the SDK's updates into `TgEvent`s and this file maps each to drafts, in arrival
 * order, one publish per event. A publish that fails is tried again until it lands: the
 * session's own cursor moves on whether or not the handler did, so a line let go here is
 * gone. The one refusal that is final is the log's for an account whose row was removed:
 * nothing of it lands any more, and its drafts are let go.
 *
 * Mapping (§3, §4). The connection is the account's user id. A conversation's address is
 * its marked id and its kind the chat's own type: a user is `direct`, a basic group a
 * `group`, a supergroup a `group` or, with a public handle, a `channel`, and a channel
 * the account posts in a `broadcast`. A channel it only follows is a newsletter and no
 * conversation: nothing of it is published.
 *
 * `external_id` is `telegram:<account>.<message id>` in a direct chat or a basic group,
 * whose ids the account's whole inbox shares, and `telegram:<account>.<chat>.<message id>`
 * in a supergroup or a channel, which numbers its own. The dispatcher stamps the same key,
 * so a send's echo merges, and a line typed on the phone is the same shape on a new id:
 * the account speaking.
 *
 * An edit is its own event (`action: "edit"`, the original in `ref_external_id`), keyed on
 * the edit's time. A delete is the delete event plus a merge-only `deleted` stamp on the
 * original, whose content stays. A read receipt is a merge-only `read` stamp on the
 * newest message the other side has seen. A service message is the room's own line (§3):
 * one `room` data part in the shared vocabulary, from whoever made the change. A message's
 * reactions arrive as the whole set it wears, and become an add or a remove per person
 * and glyph against what the log holds (`reactions.ts`).
 *
 * A sender resolves by point lookup of their own connection row, else by a roster
 * member's declared phone when Telegram shows the number. The name is Telegram's display
 * fact, `sender_saved` when the account's address book holds the person. For a stranger
 * in a direct chat or a private group the about text of their profile rides the first
 * line they write in each conversation (`sender_about`, `bio.ts`). A member writing to an
 * owned account in a direct chat has that chat recorded on the account's row as
 * `mirrors.dms`: a principal's DM there is their agent's mind surface (§4).
 */

import { SENDER_ABOUT, SENDER_SAVED } from "../../sender.ts";
import type { Appender, Reader } from "../../store/log.ts";
import { type Connections, mirrorsOf } from "../../store/connections.ts";
import type { Registry } from "../../store/agents.ts";
import { sameHandle } from "../../store/roster.ts";
import { saveMedia } from "../../store/media.ts";
import type { Storage } from "../../store/storage.ts";
import type {
  Conversation,
  Draft,
  Lifecycle,
  MessageEvent,
  Part,
  Payload,
  RoomChange,
  RoomMember,
} from "../../types.ts";
import { roomPart } from "../../room.ts";
import { setState } from "../health.ts";
import type { Bios } from "./bio.ts";
import { fromTelegram } from "./text.ts";
import { reactionDiff, standingOn } from "./reactions.ts";
import {
  externalId,
  messageIdOf,
  ownNumbering,
  SERVICE,
  type TgAction,
  type TgEvent,
  type TgMessage,
  type TgPeer,
  type TgWire,
} from "./wire.ts";

/** The largest file the ingest fetches. A bigger one is named on its line and left on
 *  Telegram. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** How long a stranger's first line in a direct chat waits for their about text. */
export const BIO_WAIT_MS = 4_000;
/** How many message ids of direct chats and basic groups are remembered with their chat:
 *  a delete there names the id alone. */
const RECENT = 8192;
/** The pause before a failed publish is tried again, doubling up to the cap. */
const RETRY_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export interface TelegramIngestDeps {
  /** The account's session: its own identity, and the history a gap is read back from. */
  wire: Pick<TgWire, "self" | "history">;
  publish: Appender["publish"];
  /** The newest row of a conversation, where a gap's reading starts. */
  read?: Reader["read"];
  /** The classifier and the map (§4): grant rows and the roster's declared handles resolve
   *  senders, and the session's state lands on the account's row. Absent: pure mapping. */
  store?:
    & Pick<Connections, "connection" | "connections" | "upsertConnections">
    & Partial<Pick<Registry, "agents">>;
  /** Where a message's file is kept. Absent: a file is named and not fetched. */
  storage?: Storage;
  /** Strangers' about texts. Absent: none is read. */
  bios?: Bios;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onError?: (what: string, err: unknown) => void;
}

/** The conversation a chat is (§3), from its type alone. */
export function kindOf(chat: TgPeer): NonNullable<Conversation["kind"]> {
  if (chat.kind === "user") return "direct";
  if (chat.kind === "channel") return "broadcast";
  return chat.kind === "supergroup" && chat.username ? "channel" : "group";
}

/** A channel the account only follows: a newsletter, and no conversation. */
export function followed(chat: TgPeer): boolean {
  return chat.kind === "channel" && !chat.posts;
}

const member = (p: TgPeer): RoomMember => ({ address: p.id, ...(p.name ? { name: p.name } : {}) });

/** A service message in the room vocabulary (§3). `by` is the message's sender. */
export function roomChange(action: TgAction, by: TgPeer | undefined): RoomChange {
  const others = (people: TgPeer[]) => !by || !people.some((p) => p.id === by.id);
  switch (action.type) {
    case "created":
      return { state: "created", name: action.title, joined: action.members.map(member) };
    case "added":
      return {
        joined: action.members.map(member),
        ...(others(action.members) ? { reason: "added" } : {}),
      };
    case "joined":
      return {
        joined: by ? [member(by)] : [],
        ...(action.how === "link" ? { reason: "link" } : {}),
      };
    case "left":
      return { left: by ? [member(by)] : [] };
    case "removed":
      return {
        left: [member(action.member)],
        ...(others([action.member]) ? { reason: "removed" } : {}),
      };
    case "title":
      return { name: action.title };
    case "photo":
      return { picture: action.photo };
    case "pinned":
      return { pinned: true };
    case "timer":
      return { settings: { disappearing: action.seconds } };
    case "call":
      return {
        call: {
          state: action.state,
          ...(action.kind ? { kind: action.kind } : {}),
          ...(action.seconds !== undefined ? { seconds: action.seconds } : {}),
        },
      };
    case "moved":
      return { moved: { to: action.to } };
    case "topic":
      return {
        changed: [
          ["topic", action.state ?? "renamed", action.title].filter(Boolean).join(" "),
        ],
      };
    case "other":
      return { changed: [action.name] };
  }
}

/** The people a text names (§3): each span that carries a person, and the account itself
 *  when Telegram says the message names it. */
function mentionsOf(m: TgMessage, account: TgPeer): NonNullable<Payload["mentions"]> {
  const out = new Map<string, { address: string; name?: string }>();
  for (const e of m.entities) {
    if (e.type !== "mention_name" || !e.user) continue;
    const name = m.text.slice(e.offset, e.offset + e.length).replace(/^@/, "");
    out.set(e.user, { address: e.user, ...(name ? { name } : {}) });
  }
  if (m.mentioned && !out.has(account.id)) {
    out.set(account.id, { address: account.id, ...(account.name ? { name: account.name } : {}) });
  }
  return [...out.values()];
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Build the ingest: a handler for the session's events and the gap's reading. Pure over
 *  its deps. `handle` settles when the event's drafts are in the log. */
export function createTelegramIngest(deps: TelegramIngestDeps): {
  handle: (event: TgEvent) => Promise<void>;
  stop: () => void;
} {
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const account = deps.wire.self;
  const connection = account.id;
  const recent = new Map<number, string>(); // message id → chat, direct chats and basic groups
  const told = new Set<string>(); // sender + conversation: the about text is on a line there
  let stopped = false;

  const remember = (m: TgMessage) => {
    if (ownNumbering(m.chat.id)) return;
    recent.set(m.id, m.chat.id);
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!);
  };

  const conversationOf = (chat: TgPeer): Conversation => ({
    address: chat.id,
    kind: kindOf(chat),
    ...(chat.name ? { name: chat.name } : {}),
  });

  /** The envelope's sender: the account's own id on its own lines, whoever wrote it
   *  otherwise, and nobody on a channel's post. */
  const senderOf = (m: TgMessage) =>
    m.out
      ? { address: connection, ...(account.name ? { name: account.name } : {}) }
      : m.sender
      ? { address: m.sender.id, ...(m.sender.name ? { name: m.sender.name } : {}) }
      : undefined;

  const partsOf = async (m: TgMessage): Promise<Part[]> => {
    const text = fromTelegram(m.text, m.entities);
    const parts: Part[] = [];
    let said = text;
    if (m.file) {
      const f = m.file;
      const named = f.name ?? f.kind;
      if (!deps.storage || (f.size ?? 0) > MAX_FILE_BYTES) {
        const why = deps.storage ? `${megabytes(f.size!)}, left on Telegram` : "not fetched";
        said = [`[${named}: ${why}]`, text].filter(Boolean).join("\n");
      } else {
        try {
          const bytes = await f.bytes();
          const file = await saveMedia(deps.storage, bytes, {
            mime_type: f.mime,
            ...(f.name ? { name: f.name } : {}),
          });
          parts.push({ type: "file", kind: f.kind, file, ...(text ? { text } : {}) });
          said = "";
        } catch (err) {
          deps.onError?.(`fetching ${named}`, err);
          said = [`[${named}: could not be fetched]`, text].filter(Boolean).join("\n");
        }
      }
    }
    if (m.location) {
      parts.push({ type: "data", kind: "location", data: m.location });
    }
    if (m.contact) {
      parts.push({
        type: "data",
        kind: "contacts",
        data: [{ name: { formatted_name: m.contact.name }, phones: [{ phone: m.contact.phone }] }],
      });
    }
    if (m.other) said = [`[${m.other}]`, said].filter(Boolean).join("\n");
    if (said || parts.length === 0) parts.unshift({ type: "text", kind: "text", text: said });
    return parts;
  };

  /** The about text a stranger's line carries: once per conversation, in a direct chat or
   *  a private group, for a person the book does not hold. */
  const aboutOf = async (m: TgMessage): Promise<string | undefined> => {
    const s = m.sender;
    if (!deps.bios || m.out || !s || s.kind !== "user" || s.bot || s.contact || s.min) {
      return undefined;
    }
    const kind = kindOf(m.chat);
    if (kind !== "direct" && kind !== "group") return undefined;
    const key = `${s.id} ${m.chat.id}`;
    if (told.has(key)) return undefined;
    const about = await deps.bios.of(s.id, kind === "direct" ? BIO_WAIT_MS : 0);
    if (about === undefined) return undefined;
    told.add(key);
    return about || undefined;
  };

  const marksOf = (m: TgMessage) => ({
    ...(m.muted ? { muted: true } : {}),
    ...(m.archived ? { archived: true } : {}),
    ...(!m.out && m.sender?.contact && m.sender.name ? { [SENDER_SAVED]: true } : {}),
  });

  const mapMessage = async (m: TgMessage): Promise<Draft<MessageEvent> | null> => {
    if (followed(m.chat)) return null;
    remember(m);
    const sender = senderOf(m);
    const envelope = {
      service: SERVICE,
      connection_address: connection,
      conversation: conversationOf(m.chat),
      ...(sender ? { sender } : {}),
      external_id: externalId(connection, m.chat.id, m.id),
    };
    if (m.action) {
      const part = roomPart(roomChange(m.action, m.out ? account : m.sender));
      if (!Object.keys(part.data).length) return null;
      const pinned = m.action.type === "pinned" ? m.action.id : undefined;
      const marks = marksOf(m);
      return {
        ts: m.date,
        type: "message",
        envelope,
        parts: [part],
        ...(pinned !== undefined
          ? { payload: { ref_external_id: externalId(connection, m.chat.id, pinned) } }
          : {}),
        ...(Object.keys(marks).length ? { extra: marks } : {}),
      };
    }
    const mentions = mentionsOf(m, account);
    const payload: Payload = {
      ...(m.reply !== undefined
        ? { action: "reply", ref_external_id: externalId(connection, m.chat.id, m.reply) }
        : m.forwarded
        ? { action: "forward" }
        : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    const about = await aboutOf(m);
    const extra = { ...marksOf(m), ...(about ? { [SENDER_ABOUT]: about } : {}) };
    return {
      ts: m.date,
      type: "message",
      envelope,
      parts: await partsOf(m),
      ...(Object.keys(payload).length ? { payload } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  };

  const mapEdit = (m: TgMessage): Draft<MessageEvent> | null => {
    if (followed(m.chat) || m.action || !m.edited) return null;
    const sender = senderOf(m);
    const mentions = mentionsOf(m, account);
    const marks = marksOf(m);
    const stamp = Math.floor(Date.parse(m.edited) / 1_000);
    return {
      ts: m.edited,
      type: "message",
      payload: {
        action: "edit",
        ref_external_id: externalId(connection, m.chat.id, m.id),
        ...(mentions.length ? { mentions } : {}),
      },
      ...(Object.keys(marks).length ? { extra: marks } : {}),
      envelope: {
        service: SERVICE,
        connection_address: connection,
        conversation: conversationOf(m.chat),
        ...(sender ? { sender } : {}),
        external_id: externalId(connection, m.chat.id, `${m.id}.edit.${stamp}`),
      },
      parts: [{ type: "text", kind: "text", text: fromTelegram(m.text, m.entities) }],
    };
  };

  /** A draft with no `parts` key: it patches the row its id names and stores nothing when
   *  there is none. */
  const mergeOnly = (chat: string, id: number, status: Lifecycle): Draft<MessageEvent> =>
    ({
      ts: now(),
      type: "message",
      envelope: {
        service: SERVICE,
        connection_address: connection,
        conversation: { address: "" },
        external_id: externalId(connection, chat, id),
      },
      status,
    }) as unknown as Draft<MessageEvent>;

  const mapDelete = (ids: number[], chat: string | undefined): Draft<MessageEvent>[] => {
    const ts = now();
    return ids.flatMap((id) => {
      const where = chat ?? recent.get(id) ?? "";
      return [
        {
          ts,
          type: "message" as const,
          payload: {
            action: "delete" as const,
            ref_external_id: externalId(connection, where, id),
          },
          envelope: {
            service: SERVICE,
            connection_address: connection,
            conversation: { address: where },
            external_id: externalId(connection, where, `${id}.deleted`),
          },
          parts: [],
        },
        mergeOnly(where, id, { state: "deleted", deleted_at: ts }),
      ];
    });
  };

  /** The classifier (§3): a sender whose own connection row names a mind, or whose phone
   *  is a member's declared one, is that member. */
  const classify = async (drafts: Draft<MessageEvent>[], phones: Map<string, string>) => {
    if (!deps.store) return;
    const members = (await deps.store.agents?.()) ?? [];
    for (const d of drafts) {
      const s = d.envelope.sender?.address;
      if (!s || d.agent) continue;
      const owner = (await deps.store.connection(SERVICE, s))?.agentId ??
        members.find((a) => sameHandle(a.phone, phones.get(s)))?.agentId;
      if (owner) d.agent = { id: owner };
    }
  };

  /** A member's direct chat with an owned account is a face of its agent's mind (§4),
   *  recorded as `mirrors.dms`, member → chat, before the line that meets it lands, so
   *  that line is already the mind's. A chat's address is the person's user id, which no
   *  roster names, so the record is the only way to know it. Every member is written; the
   *  aliases view keeps the agent's principals among them. */
  const recordDms = async (drafts: Draft<MessageEvent>[]) => {
    if (!deps.store) return;
    for (const d of drafts) {
      const member = d.agent?.id;
      const chat = d.envelope.conversation;
      if (!member || chat.kind !== "direct" || d.envelope.sender?.address !== chat.address) {
        continue;
      }
      try {
        const row = await deps.store.connection(SERVICE, connection);
        // the account's own agent is no principal of its own DMs
        if (!row?.agentId || member === row.agentId) continue;
        if (mirrorsOf(row).dms?.[member] === chat.address) continue;
        await deps.store.upsertConnections([{
          service: SERVICE,
          address: connection,
          extra: { mirrors: { dms: { [member]: chat.address } } },
        }]);
      } catch (err) {
        // the line lands all the same; the record is tried again on the member's next one
        deps.onError?.(`recording ${member}'s DM`, err);
      }
    }
  };

  /** Whether the account's row still stands: once it is removed, the log takes nothing
   *  more of it, and a publish it refuses is refused for good. */
  const standing = async () =>
    !deps.store ||
    (await deps.store.connections()).some((r) => r.service === SERVICE && r.address === connection);

  /** Publish, again and again until it lands, the ingest stops, or the row is gone. */
  const publish = async (drafts: Draft<MessageEvent>[]) => {
    if (!drafts.length) return;
    for (let wait = RETRY_MS; !stopped; wait = Math.min(wait * 2, RETRY_CAP_MS)) {
      try {
        await deps.publish(drafts);
        return;
      } catch (err) {
        deps.onError?.("publishing", err);
        if (!(await standing().catch(() => true))) return;
        await sleep(wait);
      }
    }
  };

  /** A message's whole set of reactions, against what the log holds of it. */
  const mapReactions = async (
    event: Extract<TgEvent, { type: "reactions" }>,
  ): Promise<Draft<MessageEvent>[]> => {
    if (followed(event.chat) || !deps.read) return [];
    const target = externalId(connection, event.chat.id, event.id);
    const drafts = reactionDiff({
      account,
      chat: conversationOf(event.chat),
      id: event.id,
      set: event.reactions,
      standing: await standingOn(deps.read, connection, event.chat.id, target),
      now: now(),
    });
    const phones = new Map<string, string>();
    for (const r of event.reactions) if (r.by.phone) phones.set(r.by.id, r.by.phone);
    await classify(drafts, phones);
    return drafts;
  };

  const phonesOf = (ms: TgMessage[]) => {
    const phones = new Map<string, string>();
    for (const m of ms) if (m.sender?.phone) phones.set(m.sender.id, m.sender.phone);
    if (account.phone) phones.set(account.id, account.phone);
    return phones;
  };

  /** The messages a channel's replay left out, read from its history: the newest row the
   *  log holds of the room is where the listening stopped. A room the log never heard is
   *  left alone. */
  const readGap = async (chat: string): Promise<Draft<MessageEvent>[]> => {
    if (!deps.read) return [];
    const rows = await deps.read({
      service: SERVICE,
      connection,
      conversation: chat,
      types: ["message"],
      // a message's own row: an edit, a delete or a reaction names an older one
      filter: (e) => messageIdOf(e.envelope.external_id ?? "") !== undefined,
      limit: 20,
    });
    const since = Math.max(0, ...rows.map((r) => messageIdOf(r.envelope.external_id!)!));
    if (since === 0) return [];
    const missed = await deps.wire.history(chat, since);
    const drafts: Draft<MessageEvent>[] = [];
    for (const m of missed) {
      const d = await mapMessage(m);
      if (d) drafts.push(d);
      const e = mapEdit(m);
      if (e) drafts.push(e);
    }
    await classify(drafts, phonesOf(missed));
    await recordDms(drafts);
    return drafts;
  };

  return {
    stop() {
      stopped = true;
    },
    async handle(event) {
      switch (event.type) {
        case "message": {
          const d = await mapMessage(event.message);
          if (!d) return;
          await classify([d], phonesOf([event.message]));
          await recordDms([d]);
          return publish([d]);
        }
        case "edit": {
          const d = mapEdit(event.message);
          if (!d) return;
          await classify([d], phonesOf([event.message]));
          return publish([d]);
        }
        case "delete":
          return publish(mapDelete(event.ids, event.chat));
        case "reactions":
          try {
            return await publish(await mapReactions(event));
          } catch (err) {
            deps.onError?.(`the reactions on ${event.chat.id}/${event.id}`, err);
            return;
          }
        case "read":
          return publish([
            mergeOnly(event.chat, event.id, { state: "read", read_at: now() }),
          ]);
        case "gap":
          try {
            return await publish(await readGap(event.chat));
          } catch (err) {
            deps.onError?.(`reading the gap of ${event.chat}`, err);
            return;
          }
        case "state":
          if (!deps.store) return;
          await setState(deps.store, { service: SERVICE, address: connection }, event.state, {
            ...(event.error ? { error: event.error } : {}),
            now: now(),
          });
          return;
      }
    },
  };
}
