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
 * Four questions are this module's own:
 *
 *   - **WHAT** — the agent's `presence` level. `off` says nothing. `waiting` and `tools`
 *     say thinking and compacting. The calls are the mirror's: each crosses as it lands,
 *     as `[agent working...]` at `waiting` and by name at `tools`.
 *   - **FOR WHOM** — work somebody asked for (`Cause`): the principal's word, or the
 *     harness's own request. A stretch the world woke, a stranger's line in some group,
 *     says nothing on the principal's surface. The cause belongs to the stretch, not the
 *     turn: the unload and the checkpoint that follow a turn are its tail, and say what
 *     it would have said however long they run. A word the principal speaks mid-stretch
 *     makes it theirs, and what is running is said at once: that is when they wonder why
 *     the answer is late.
 *   - **WHETHER** — only the mind's own session, and only while a surface of the agent's is
 *     bound: a fact nobody can hear is not worth a row.
 *   - **HOW OFTEN** — once per occurrence. The stream turning to a kind from another opens
 *     one: a step's thinking after the last step's words or call, a checkpoint's next try.
 */

import { LOCAL_CONNECTION, MIND, sessionAddress } from "../session.ts";
import type { AliasRow } from "../store/connections.ts";
import type { Cause, Delta, DeltaEvent, DeltaKind, Draft, PresenceLevel } from "../types.ts";

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

/** What main tells presence: each decision with its cause, the stream's deltas, and the
 *  principal's word as it lands in the mind's room. The mirror asks it whether a stretch
 *  was asked for. */
export interface Presence {
  status(agentId: string, sessionId: string, status: "busy" | "idle", cause?: Cause): void;
  delta(agentId: string, sessionId: string, delta: Delta): void;
  heard(agentId: string): void;
  asked(agentId: string): boolean;
}

/** The word a stream delta is at a level, if any. */
export function presenceKind(kind: Delta["kind"], level: PresenceLevel): DeltaKind | undefined {
  if (level === "off") return undefined;
  if (kind === "thinking" || kind === "checkpoint") return kind;
}

/** One occurrence of a kind of work, and whether its line was said. */
interface Doing {
  kind: DeltaKind;
  said: boolean;
}

/** An open turn: the kind of the stream's last delta, and the work running now, if the
 *  stream is at a kind presence names. */
interface Turn {
  last?: Delta["kind"];
  doing?: Doing;
}

/**
 * Wire presence to the log.
 *
 * A busy decision MERGES rather than replaces — main discloses on every decision, so one
 * turn can announce itself more than once, and a fresh turn would cut a thinking block in
 * two. The idle closes the turn. The cause outlives the idle: the tail that follows a turn
 * opens with none of its own.
 */
export function createPresence(deps: PresenceDeps): Presence {
  const turns = new Map<string, Turn>();
  const asked = new Map<string, boolean>(); // per agent: its stretch was asked for

  const say = (agentId: string, doing: Doing) => {
    if (doing.said) return;
    // the deltas do not wait: the seat is claimed as soon as a surface is known to exist,
    // and the line lands on its own time — one that did not is one nobody needed
    deps.aliases()
      .then((rows) => {
        if (doing.said || !rows.some((a) => a.live && a.agentId === agentId)) return;
        doing.said = true;
        return deps.publish(factOf(agentId, doing.kind, new Date().toISOString()));
      })
      .catch((err) => deps.onError?.(err));
  };

  return {
    status(agentId, sessionId, status, cause) {
      if (sessionId !== MIND) return; // a named session is mirrored nowhere
      if (cause !== undefined) asked.set(agentId, cause === "asked");
      if (status === "idle") turns.delete(agentId);
      else if (!turns.has(agentId)) turns.set(agentId, {});
    },
    delta(agentId, sessionId, delta) {
      if (sessionId !== MIND) return;
      const turn = turns.get(agentId);
      if (!turn) return;
      const goesOn = turn.last === delta.kind;
      turn.last = delta.kind;
      if (goesOn) return;
      const kind = presenceKind(delta.kind, deps.level(agentId));
      turn.doing = kind && { kind, said: false };
      if (turn.doing && asked.get(agentId)) say(agentId, turn.doing);
    },
    heard(agentId) {
      asked.set(agentId, true);
      const doing = turns.get(agentId)?.doing;
      if (doing) say(agentId, doing);
    },
    asked: (agentId) => asked.get(agentId) ?? false,
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
