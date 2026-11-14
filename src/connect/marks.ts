/**
 * connect/marks.ts — the silencing marks the core decides, the same for every wire (§5):
 * whether a room is crowded, and whether a line is for the account.
 *
 * A connector stamps what its wire says of a room on the draft's conversation: how many
 * members it has (`members`) and whether the account administers it (`admin`), and the
 * chat's own state (`extra.muted`, `extra.archived`). It publishes through `marked`, which
 * reads those facts against the connection's knobs and the log, stamps the marks, and
 * drops the two facts, which are no part of the row.
 *
 * CROWDED. A room with more than `crowd` members, more than `busy` lines landed in it in
 * the last 24 hours, and the account no admin there, unless the connection follows it.
 * The count is the log's, read once a minute per room and carried forward between reads.
 *
 * ADDRESSED. A line for the account: its `mentions` name one of the account's own
 * addresses, or it replies to a line one of them wrote. It lifts `muted` and `crowded`,
 * never `archived` or `backfill` (`silenced`, render.ts). It is asked only of a line that
 * one of the two would silence.
 */

import type { RoomKnobs } from "../config.ts";
import type { Reader } from "../store/log.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";

/** How long a room's count of the day's lines stands before the log is read again. */
export const COUNT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface MarkDeps {
  read: Reader["read"];
  /** The connection's room knobs (`crowd`, `busy`, `follow`), as its connector read them. */
  knobs: RoomKnobs;
  /** The addresses the account goes by on its wire. Absent: the connection's own address,
   *  which is the account's on WhatsApp and Telegram. */
  self?: (connection: string) => string[];
  now?: () => number;
}

type Line = Draft<MessageEvent>;

/** Mark drafts before they are published. Answers the same drafts, marked. */
export function createMarks(deps: MarkDeps): (drafts: Line[]) => Promise<Line[]> {
  const now = deps.now ?? Date.now;
  const self = deps.self ?? ((connection: string) => [connection]);
  const counts = new Map<string, { at: number; lines: number }>();

  /** The lines a room took in the last day, this one excluded. */
  const linesOf = async (d: Line): Promise<number> => {
    const { service, connection_address: connection, conversation } = d.envelope;
    const key = `${service} ${connection} ${conversation.address}`;
    const held = counts.get(key);
    const at = now();
    if (held && at - held.at < COUNT_MS) {
      held.lines++;
      return held.lines - 1;
    }
    const rows = await deps.read({
      service,
      connection,
      conversation: conversation.address,
      types: ["message"],
      after: new Date(at - DAY_MS).toISOString(),
      limit: deps.knobs.busy + 1,
    });
    counts.set(key, { at, lines: rows.length + 1 });
    return rows.length;
  };

  const crowded = async (d: Line): Promise<boolean> => {
    const c = d.envelope.conversation;
    if (c.members === undefined || c.members <= deps.knobs.crowd || c.admin === true) {
      return false;
    }
    if (deps.knobs.follow.includes(c.address)) return false;
    return (await linesOf(d)) > deps.knobs.busy;
  };

  const addressed = async (d: Line): Promise<boolean> => {
    const own = new Set(self(d.envelope.connection_address));
    if (d.payload?.mentions?.some((m) => own.has(m.address))) return true;
    const ref = d.payload?.ref_external_id;
    // a reply names its line with no action or as `reply`; an edit, a delete, a reaction
    // and a forward name one too, and answer nobody
    const action = d.payload?.action;
    if (!ref || (action !== undefined && action !== "reply")) return false;
    const [target] = await deps.read({ externalId: ref, limit: 1 }) as Event[];
    const by = target?.envelope.sender?.address;
    return by !== undefined && own.has(by);
  };

  return async (drafts) => {
    for (const d of drafts) {
      const c = d.envelope.conversation;
      const facts = c && (c.members !== undefined || c.admin !== undefined);
      if (!("parts" in d) || d.type !== "message") {
        if (facts) d.envelope.conversation = strip(c);
        continue;
      }
      const x = d.extra ?? {};
      const settled = x.backfill === true || x.archived === true;
      const marks: Record<string, true> = {};
      if (!settled && await crowded(d)) marks.crowded = true;
      if (!settled && (x.muted === true || marks.crowded) && await addressed(d)) {
        marks.addressed = true;
      }
      if (Object.keys(marks).length) d.extra = { ...x, ...marks };
      if (facts) d.envelope.conversation = strip(c);
    }
    return drafts;
  };
}

/** The conversation as the row keeps it: the room facts dropped. */
function strip(c: Line["envelope"]["conversation"]): Line["envelope"]["conversation"] {
  const { members: _members, admin: _admin, ...kept } = c;
  return kept;
}

/** A publish that marks its drafts first: the seam a connector's process wires its
 *  ingest to, in place of the log's own. One draft or a list, as the log takes them; the
 *  marks land on the drafts themselves, so the publish answers as it would have. */
// deno-lint-ignore no-explicit-any
export function marked<P extends (one: any, ...rest: any[]) => Promise<unknown>>(
  publish: P,
  marks: (drafts: Line[]) => Promise<Line[]>,
): P {
  return (async (one: Line | Line[], ...rest: unknown[]) => {
    await marks(Array.isArray(one) ? one : [one]);
    return publish(one, ...rest);
  }) as unknown as P;
}
