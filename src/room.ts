/**
 * room.ts — a room's change as the room's own line (§3): who joined, who left, the name it
 * now wears, its topic, its lifecycle, a call, a pin, how the account's own app shows it.
 * Every service says it the same way — the wire's system line or event mapped at ingest,
 * a local room's change said by the `conversation` tool — so the model reads one element,
 * `<room>`, wherever the room is. A room line informs and never wakes (§2).
 */

import type { Event, Json, RoomChange, RoomMember, RoomPart } from "./types.ts";

/** The part, with only what the change moved: an empty list, an empty object or an absent
 *  value is left out, so a rename carries its name alone and a join its joined alone. A
 *  `reason` with nobody moving says nothing and goes too. */
export function roomPart(change: RoomChange): RoomPart {
  const data = prune(change as Json) as RoomChange ?? {};
  if (!data.joined && !data.left) delete data.reason;
  return { type: "data", kind: "room", data };
}

function prune(v: Json | undefined): Json | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (typeof v !== "object") return v;
  const out = Object.fromEntries(
    Object.entries(v).flatMap(([k, x]) => {
      const p = prune(x);
      return p === undefined ? [] : [[k, p]];
    }),
  );
  return Object.keys(out).length ? out : undefined;
}

/** A message that is a room's change and nothing else: informs, never news (§2). */
export function roomOnly(e: Event): boolean {
  return e.type === "message" && e.parts.length > 0 &&
    e.parts.every((p) => p.type === "data" && p.kind === "room");
}

/** The part in a person's words, for a surface that paints lines rather than elements:
 *  `joined mind@cy, Bea` · `left Caro` · `renamed ops-q4` · `archived` · `call ended`. */
export function roomWords(part: RoomPart): string {
  const who = (people: RoomMember[]) => people.map((p) => p.name ?? p.address).join(", ");
  const said = (s: string) => s === "" ? "cleared" : `“${s}”`;
  const {
    joined = [],
    left = [],
    reason,
    promoted = [],
    demoted = [],
    name,
    was: _was,
    topic,
    description,
    state,
    pinned,
    call,
    view,
    ...rest
  } = part.data;
  const words = [
    ...(joined.length ? [`${reason === "added" ? "added" : "joined"} ${who(joined)}`] : []),
    ...(left.length ? [`${reason === "removed" ? "removed" : "left"} ${who(left)}`] : []),
    ...(promoted.length ? [`made ${who(promoted)} admin`] : []),
    ...(demoted.length ? [`took admin from ${who(demoted)}`] : []),
    ...(name ? [`renamed ${name}`] : []),
    ...(topic !== undefined ? [`topic ${said(topic)}`] : []),
    ...(description !== undefined ? [`description ${said(description)}`] : []),
    ...(state ? [state] : []),
    ...(pinned !== undefined ? [pinned ? "pinned" : "unpinned"] : []),
    ...(call ? [`call ${call.state}`] : []),
    ...Object.entries(rest).map(([k, v]) => `${k} ${JSON.stringify(v)}`),
    ...(view ? [`(own view) ${JSON.stringify(view)}`] : []),
  ];
  return words.join(" · ");
}
