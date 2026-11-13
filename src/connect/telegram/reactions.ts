/**
 * connect/telegram/reactions.ts — a message's reactions as lines (§3): one `add` row per
 * person and glyph, and a `remove` row when it goes.
 *
 * Telegram says reactions as the whole set a message wears now, never as a change. So the
 * set is compared with what the log already holds of the message: a glyph the log has no
 * standing add for is an add, and a standing add the set no longer holds is a remove. The
 * log is the memory, which is why the ingest and the dispatcher read it the same way, and
 * why they spell a reaction's id the same way: the account's own reaction, sent by an
 * agent, is the row the dispatcher stamped, and the next set that shows it changes
 * nothing.
 *
 * An add's id carries the time Telegram gave the reaction, so a glyph taken off and put
 * back is a new line; its remove is the add's id with `.removed`.
 */

import type { Reader } from "../../store/log.ts";
import type { Draft, Event, MessageEvent, ReactionPart } from "../../types.ts";
import { externalId, SERVICE, type TgPeer } from "./wire.ts";

/** How recent a standing add is that a set without it does not take back: a set Telegram
 *  took before the agent's own reaction may arrive after it. */
export const SETTLE_MS = 10_000;
/** How many of a message's reaction rows are read to know what stands. */
const ROWS = 500;

/** The id of `by`'s reaction `emoji` on message `id`, given at `date`. */
export function reactionId(
  account: string,
  chat: string,
  id: number,
  by: string,
  emoji: string,
  date: string,
): string {
  const at = Math.floor(Date.parse(date) / 1_000);
  return externalId(account, chat, `${id}.react.${by}.${emoji}.${at}`);
}

/** The glyph a reaction row carries. */
function glyphOf(e: Event): string | undefined {
  if (e.type !== "message") return undefined;
  const part = e.parts.find((p): p is ReactionPart => p.type === "data" && p.kind === "reaction");
  return part ? part.data.unicode ?? part.data.name : undefined;
}

/** A standing reaction: the row that added it. */
export interface Standing {
  by: string;
  emoji: string;
  row: Event;
}

const keyOf = (by: string, emoji: string) => `${by} ${emoji}`;

/** The reactions on `target` the log holds as standing, by person and glyph: each add
 *  not yet followed by its remove. A row with no sender is the account's own, an agent's
 *  send before its stamp lands. */
export async function standingOn(
  read: Reader["read"],
  account: string,
  chat: string,
  target: string,
): Promise<Map<string, Standing>> {
  const rows = await read({
    service: SERVICE,
    connection: account,
    conversation: chat,
    types: ["message"],
    filter: (e) => e.payload?.ref_external_id === target && glyphOf(e) !== undefined,
    limit: ROWS,
  });
  const out = new Map<string, Standing>();
  for (const row of rows) {
    const emoji = glyphOf(row)!;
    const by = row.envelope.sender?.address ?? account;
    const action = row.payload?.action;
    if (action === "add") out.set(keyOf(by, emoji), { by, emoji, row });
    else if (action === "remove") out.delete(keyOf(by, emoji));
  }
  return out;
}

/** The reaction row: `by` putting `emoji` on `target`, or taking it off. */
export function reactionDraft(r: {
  account: TgPeer;
  chat: { address: string; kind?: MessageEvent["envelope"]["conversation"]["kind"]; name?: string };
  target: string;
  by: TgPeer;
  emoji: string;
  action: "add" | "remove";
  external_id: string;
  ts: string;
}): Draft<MessageEvent> {
  const own = r.by.id === r.account.id;
  const name = own ? r.account.name : r.by.name;
  return {
    ts: r.ts,
    type: "message",
    payload: { action: r.action, ref_external_id: r.target },
    envelope: {
      service: SERVICE,
      connection_address: r.account.id,
      conversation: r.chat,
      sender: { address: r.by.id, ...(name ? { name } : {}) },
      external_id: r.external_id,
    },
    parts: [{
      type: "data",
      kind: "reaction",
      data: { name: r.emoji, ...(r.emoji.startsWith("custom:") ? {} : { unicode: r.emoji }) },
    }],
  };
}

/** The rows a message's set amounts to against what stands: an add for each new glyph,
 *  a remove for each standing one the set dropped, unless it is too fresh to judge. */
export function reactionDiff(r: {
  account: TgPeer;
  chat: { address: string; kind?: MessageEvent["envelope"]["conversation"]["kind"]; name?: string };
  id: number;
  set: { by: TgPeer; emoji: string; date: string }[];
  standing: Map<string, Standing>;
  now: string;
}): Draft<MessageEvent>[] {
  const target = externalId(r.account.id, r.chat.address, r.id);
  const drafts: Draft<MessageEvent>[] = [];
  const seen = new Set<string>();
  for (const x of r.set) {
    const key = keyOf(x.by.id, x.emoji);
    seen.add(key);
    if (r.standing.has(key)) continue;
    drafts.push(reactionDraft({
      account: r.account,
      chat: r.chat,
      target,
      by: x.by,
      emoji: x.emoji,
      action: "add",
      external_id: reactionId(r.account.id, r.chat.address, r.id, x.by.id, x.emoji, x.date),
      ts: x.date,
    }));
  }
  for (const [key, s] of r.standing) {
    if (seen.has(key)) continue;
    if (Date.parse(r.now) - Date.parse(s.row.ts) < SETTLE_MS) continue;
    const added = s.row.envelope.external_id ?? `${target}.react.${s.row.id}`;
    drafts.push(reactionDraft({
      account: r.account,
      chat: r.chat,
      target,
      by: s.by === r.account.id ? r.account : {
        id: s.by,
        kind: "user",
        ...(s.row.envelope.sender?.name ? { name: s.row.envelope.sender.name } : {}),
      },
      emoji: s.emoji,
      action: "remove",
      external_id: `${added}.removed`,
      ts: r.now,
    }));
  }
  return drafts;
}
