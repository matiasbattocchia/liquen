/**
 * connect/presence.ts — the mind says what it is DOING.
 *
 * The motive is one a log cannot serve: from the other side of a chat, a mind that has been
 * thinking for forty seconds and a mind that is wedged are the same silence. So each kind of
 * work, as it starts, becomes a `delta` EVENT in the mind's room (§9): the fact,
 * harness-authored, that the mind is at work.
 *
 * The event is all this module writes. The mirror does the rest, exactly as it does for a
 * gate: it crosses the fact to every live surface as a tagged line (`[agent thinking...]`),
 * and that line rides whatever dispatcher already serves the surface. Every reader of the
 * mind excludes the event by type — it renders nowhere, is not news, wakes nothing, and
 * `search` never finds it — so the mind never reads back a word it did not say.
 *
 * Three questions are this module's own:
 *
 *   - **WHAT** — the agent's `presence` level. `off` says nothing. `waiting` says each kind
 *     of work: thinking, compacting, and working, the model writing a call. `tools` leaves
 *     working to the calls themselves, which the mirror crosses by name.
 *   - **WHETHER** — only the mind's own session, and only while a surface of the agent's is
 *     bound: a fact nobody can hear is not worth a row.
 *   - **HOW OFTEN** — once per kind per turn.
 */

import { LOCAL_CONNECTION, MIND, sessionAddress } from "../session.ts";
import type { AliasRow } from "../store/connections.ts";
import type { Delta, DeltaEvent, DeltaKind, Draft, PresenceLevel } from "../types.ts";

export interface PresenceDeps {
  /** The mirror's surfaces, live — read through, so a binding granted while the org runs
   *  is heard without a restart. Presence only asks whether any exist. */
  aliases: () => Promise<AliasRow[]>;
  /** → the log: one `delta` event in the mind's room, which the mirror carries from there. */
  publish: (draft: Draft<DeltaEvent>) => Promise<unknown>;
  /** The agent's level, read at each delta. */
  level: (agentId: string) => PresenceLevel;
  onError?: (err: unknown) => void;
}

/** What main tells presence — the same two facts it hands the doors. */
export interface Presence {
  status(agentId: string, sessionId: string, status: "busy" | "idle"): void;
  delta(agentId: string, sessionId: string, delta: Delta): void;
}

/** The word a stream delta is at a level, if any: a `tool` delta is the model writing a
 *  call, which `tools` leaves to the call's own line. */
export function presenceKind(kind: Delta["kind"], level: PresenceLevel): DeltaKind | undefined {
  if (level === "off") return undefined;
  if (kind === "thinking" || kind === "checkpoint") return kind;
  if (kind === "tool" && level === "waiting") return "working";
}

/**
 * Wire presence to the log.
 *
 * A busy edge MERGES rather than replaces — main discloses on every decision, so one turn
 * can announce itself more than once, and a fresh set would say `[agent thinking...]`
 * twice. The idle closes the turn; the next busy opens a new one, free to speak again.
 */
export function createPresence(deps: PresenceDeps): Presence {
  // per open turn: the kinds it has already said
  const turns = new Map<string, Set<DeltaKind>>();

  return {
    status(agentId, sessionId, status) {
      if (sessionId !== MIND) return; // a named session is mirrored nowhere
      if (status === "idle") turns.delete(agentId);
      else if (!turns.has(agentId)) turns.set(agentId, new Set());
    },
    delta(agentId, sessionId, delta) {
      if (sessionId !== MIND) return;
      const told = turns.get(agentId);
      const kind = presenceKind(delta.kind, deps.level(agentId));
      if (!told || !kind || told.has(kind)) return;
      // the deltas do not wait: the seat is claimed as soon as a surface is known to exist,
      // and the line lands on its own time — one that did not is one nobody needed
      deps.aliases()
        .then((rows) => {
          if (told.has(kind) || !rows.some((a) => a.live && a.agentId === agentId)) return;
          told.add(kind);
          return deps.publish(factOf(agentId, kind, new Date().toISOString()));
        })
        .catch((err) => deps.onError?.(err));
    },
  };
}

/** The fact, in the mind's room: harness-authored, and the mind's own (§4). */
function factOf(agentId: string, kind: DeltaKind, ts: string): Draft<DeltaEvent> {
  return {
    ts,
    type: "delta",
    agent: { id: agentId, session_id: MIND },
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: sessionAddress(agentId, MIND) },
    },
    parts: [{ type: "data", kind: "delta", data: { kind } }],
  };
}
