/**
 * room.ts — a room's change as the room's own line (§3): who joined, who left, the name it
 * now wears. Every service says it the same way — the wire's system line mapped at ingest,
 * a local room's change said by the `conversation` tool — so the model reads one element,
 * `<room>`, wherever the room is.
 */

import { MIND, sessionAddress } from "./session.ts";
import type { Draft, MessageEvent, RoomMember, RoomPart } from "./types.ts";

/** The part, with only what the change moved: an empty side is left out, so a rename
 *  carries its name alone and a join its joined alone. */
export function roomPart(change: {
  joined?: RoomMember[];
  left?: RoomMember[];
  name?: string;
  reason?: string;
}): RoomPart {
  const { joined = [], left = [], name, reason } = change;
  return {
    type: "data",
    kind: "room",
    data: {
      ...(joined.length ? { joined } : {}),
      ...(left.length ? { left } : {}),
      ...(name ? { name } : {}),
      ...(reason && joined.length ? { reason } : {}),
    },
  };
}

/** A steering room adopted into an agent's mind or let go (§4), as the mind's own room
 *  line, which the mirror carries to every surface of the mind as `[system]`. */
export function mindRoomLine(
  agent: string,
  change: { joined?: RoomMember[]; left?: RoomMember[] },
  ts: string,
): Draft<MessageEvent> {
  return {
    ts,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: sessionAddress(agent, MIND) },
    },
    parts: [roomPart(change)],
  };
}

/** The part in a person's words, for a surface that paints lines rather than elements:
 *  `joined mind@cy, Bea` · `left Caro` · `renamed ops-q4`. */
export function roomWords(part: RoomPart): string {
  const who = (people: RoomMember[]) => people.map((p) => p.name ?? p.address).join(", ");
  const { joined = [], left = [], name } = part.data;
  return [
    ...(joined.length ? [`joined ${who(joined)}`] : []),
    ...(left.length ? [`left ${who(left)}`] : []),
    ...(name ? [`renamed ${name}`] : []),
  ].join(" · ");
}
