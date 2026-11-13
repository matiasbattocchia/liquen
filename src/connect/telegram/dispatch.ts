/**
 * connect/telegram/dispatch.ts — the DISPATCH half of the Telegram connection: log to
 * world, over the account's live session.
 *
 * Subscribes, picks the agents' outbound sends on the telegram service, and posts each
 * through the wire of the account it rides. The message id Telegram answers with is
 * stamped as `external_id` in the ingest's own spelling, so the session's echo of the
 * send merges into the same row.
 *
 * One event may be several Telegram messages: each file is one, the first wearing the
 * text as its caption; text with no file is one; a location and each contact card are
 * their own. The first message's id is the row's. An edit, a delete and a reaction act on
 * the message the row points at (`ref_external_id`) and carry nothing else.
 *
 * Text crosses as Telegram's entities (`text.ts`), and an `@Name` the room's directory
 * claims names that person by id. A first contact is addressed by handle (`@name`): the
 * wire resolves it, and the row moves to the chat the message landed in, the person's id,
 * which is where their answer arrives.
 *
 * Telegram's refusals keep their class: a flood wait is a 429 the sweeper offers again, a
 * session Telegram ended is `SignedOut`, anything else about these bytes is permanent.
 */

import { bytesOf, isExternal, tailOf } from "../../store/media.ts";
import type { Storage } from "../../store/storage.ts";
import { DispatchError } from "../errors.ts";
import { createDispatcher, type DispatcherDeps, type Posted } from "../dispatcher.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../../store/log.ts";
import type {
  ContactsPart,
  EventId,
  FilePart,
  LocationPart,
  MessageEvent,
  ReactionPart,
  TextPart,
} from "../../types.ts";
import type { Directory } from "../mentions.ts";
import { kindOf } from "./ingest.ts";
import { reactionDraft, reactionId, standingOn } from "./reactions.ts";
import { mentionSpans, toTelegram } from "./text.ts";
import { externalId, messageIdOf, SERVICE, type TgOutbound, type TgWire } from "./wire.ts";

export interface TelegramDispatchDeps {
  subscribe: Subscriber["subscribe"];
  read: Reader["read"];
  /** The live session of an account, by its connection address; undefined when this
   *  process holds none for it. */
  wireOf: (connection: string) => TgWire | undefined;
  /** Where a kept file's bytes are read from. */
  storage?: Storage;
  /** The log, for the remove line of a reaction an agent's own replaced. */
  publish?: Appender["publish"];
  /** The conversation's name directory (§3 mentions). Absent: a name ships as text. */
  directory?: Directory;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  store?: DispatcherDeps<unknown>["store"];
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, id: string | undefined) => void;
}

/** What a row asks of the wire. */
type Work =
  | { act: "edit"; id: number; text: string }
  | { act: "delete"; id: number }
  | { act: "react"; id: number; emoji: string; remove: boolean }
  | {
    act: "send";
    text: string;
    files: FilePart[];
    location?: LocationPart;
    contacts?: ContactsPart;
    reply?: number;
  };

function select(event: MessageEvent): Work | null {
  if (!event.envelope.connection_address || !event.envelope.conversation.address) return null;
  const ref = event.payload?.ref_external_id;
  const re = typeof ref === "string" ? messageIdOf(ref) : undefined;
  const texts = event.parts.filter((p): p is TextPart => p.type === "text");
  const text = texts.filter((p) => p.kind !== "reaction").map((p) => p.text).join("\n");
  const action = event.payload?.action;

  if (action === "edit" || action === "delete") {
    if (re === undefined) return null;
    return action === "edit" ? { act: "edit", id: re, text } : { act: "delete", id: re };
  }
  const react = event.parts.find((p): p is ReactionPart =>
    p.type === "data" && p.kind === "reaction"
  );
  const reactText = texts.find((p) => p.kind === "reaction");
  if (react || reactText) {
    if (re === undefined) return null;
    const glyph = react ? (react.data.unicode ?? react.data.name) : reactText!.text;
    return { act: "react", id: re, emoji: glyph, remove: action === "remove" };
  }
  const files = event.parts.filter((p): p is FilePart => p.type === "file");
  const location = event.parts.find((p): p is LocationPart =>
    p.type === "data" && p.kind === "location"
  );
  const contacts = event.parts.find((p): p is ContactsPart =>
    p.type === "data" && p.kind === "contacts"
  );
  if (!text && !files.length && !location && !contacts) return null;
  return {
    act: "send",
    text,
    files,
    ...(location ? { location } : {}),
    ...(contacts ? { contacts } : {}),
    ...(re !== undefined ? { reply: re } : {}),
  };
}

/** Wire dispatch to the log, over the shared loop (`dispatcher.ts`). Returns stop. */
export function createTelegramDispatch(deps: TelegramDispatchDeps): () => Promise<void> {
  const written = async (markdown: string, event: MessageEvent) => {
    const flat = toTelegram(markdown);
    if (!deps.directory || !flat.text) return flat;
    const dir = await deps.directory(SERVICE, event.envelope.conversation.address);
    return { text: flat.text, entities: [...flat.entities, ...mentionSpans(flat.text, dir)] };
  };

  const fileOf = async (f: FilePart): Promise<NonNullable<TgOutbound["file"]>> => {
    if (isExternal(f.file.uri)) {
      const res = await fetch(f.file.uri);
      if (!res.ok) throw new DispatchError(`${f.file.uri}: HTTP ${res.status}`, 400);
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mime: f.file.mime_type,
        kind: f.kind,
        ...(f.file.name ? { name: f.file.name } : {}),
      };
    }
    const bytes = deps.storage ? await bytesOf(deps.storage, f.file.uri) : null;
    if (!bytes) throw new DispatchError(`${f.file.uri}: the file is gone`, 400);
    return {
      bytes,
      mime: f.file.mime_type,
      kind: f.kind,
      name: f.file.name ?? tailOf(f.file.uri),
    };
  };

  /** The account's reactions on a message, set to what the row asks: a glyph put on
   *  replaces the account's own (Telegram keeps one each, more on a premium account, and
   *  the agent asks one at a time), a glyph taken off leaves the rest. The row is stamped
   *  with the id the ingest gives the same reaction, so the next set Telegram says of the
   *  message finds it standing; a glyph the add replaced gets its remove line here, since
   *  Telegram says nothing of a change the account made. */
  const react = async (
    wire: TgWire,
    work: Extract<Work, { act: "react" }>,
    event: MessageEvent,
  ): Promise<Posted> => {
    const connection = event.envelope.connection_address;
    const chat = event.envelope.conversation.address;
    const target = externalId(connection, chat, work.id);
    const mine = [...(await standingOn(deps.read, connection, chat, target)).values()]
      .filter((s) => s.by === connection && s.row.id !== event.id);
    if (work.remove) {
      const off = mine.find((s) => s.emoji === work.emoji);
      await wire.react(chat, work.id, mine.filter((s) => s !== off).map((s) => s.emoji));
      const added = off?.row.envelope.external_id;
      return added ? { external_id: `${added}.removed` } : {};
    }
    const date = await wire.react(chat, work.id, [work.emoji]);
    const replaced = mine.filter((s) => s.emoji !== work.emoji);
    if (replaced.length && deps.publish) {
      const conversation = event.envelope.conversation;
      await deps.publish(replaced.map((s) => ({
        ...reactionDraft({
          account: wire.self,
          chat: conversation,
          target,
          by: wire.self,
          emoji: s.emoji,
          action: "remove",
          external_id: `${s.row.envelope.external_id ?? `${target}.react.${s.row.id}`}.removed`,
          ts: new Date().toISOString(),
        }),
        ...(event.agent ? { agent: { id: event.agent.id } } : {}),
      })));
    }
    return date
      ? { external_id: reactionId(connection, chat, work.id, connection, work.emoji, date) }
      : {};
  };

  return createDispatcher<Work>({
    subscribe: deps.subscribe,
    service: SERVICE,
    select,
    read: deps.read,
    setDelivery: deps.setDelivery,
    store: deps.store,
    onError: deps.onError,
    onSent: deps.onSent,
    post: async (work, event): Promise<Posted> => {
      const connection = event.envelope.connection_address;
      const chat = event.envelope.conversation.address;
      const wire = deps.wireOf(connection);
      if (!wire) {
        throw new DispatchError(`no Telegram session is up for ${connection}`, 503);
      }
      if (work.act === "edit") {
        const { text, entities } = await written(work.text, event);
        await wire.edit(chat, work.id, text, entities);
        return {};
      }
      if (work.act === "delete") {
        await wire.delete(chat, [work.id]);
        return {};
      }
      if (work.act === "react") return await react(wire, work, event);

      const flat = work.text ? await written(work.text, event) : undefined;
      const outs: TgOutbound[] = [];
      for (const [i, f] of work.files.entries()) {
        outs.push({ file: await fileOf(f), ...(i === 0 && flat ? flat : {}) });
      }
      if (!work.files.length && flat) outs.push(flat);
      if (work.location) {
        const { latitude, longitude } = work.location.data;
        outs.push({ location: { latitude, longitude } });
      }
      for (const card of work.contacts?.data ?? []) {
        const phone = card.phones[0]?.phone;
        if (phone) outs.push({ contact: { name: card.name.formatted_name, phone } });
      }
      if (!outs.length) throw new DispatchError("nothing Telegram can carry", 400);
      if (work.reply !== undefined) outs[0].reply = work.reply;

      let first: Awaited<ReturnType<TgWire["send"]>> | undefined;
      // every message after the first goes to the chat the first landed in: a handle is
      // resolved once
      for (const out of outs) {
        const sent = await wire.send(first?.chat.id ?? chat, out);
        first ??= sent;
      }
      const landed = first!.chat;
      return {
        id: String(first!.id),
        external_id: externalId(connection, landed.id, first!.id),
        sender: { address: connection, ...(wire.self.name ? { name: wire.self.name } : {}) },
        ...(landed.id !== chat
          ? {
            conversation: {
              address: landed.id,
              kind: kindOf(landed),
              ...(landed.name ? { name: landed.name } : {}),
            },
          }
          : {}),
      };
    },
  });
}
