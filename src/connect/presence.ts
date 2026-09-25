/**
 * connect/presence.ts — the mind says what it is DOING.
 *
 * The motive is one a log cannot serve: from the other side of a chat, a mind that has been
 * thinking for forty seconds and a mind that is wedged are the same silence. So a `thinking`
 * delta and a `checkpoint` delta each become a `delta` EVENT in the mind's room (§9) — the
 * fact, harness-authored, that the mind is at work.
 *
 * The event is all this module writes. The mirror does the rest, exactly as it does for a
 * gate: it crosses the fact to every live surface as a tagged line (`[agent thinking...]`),
 * and that line rides whatever dispatcher already serves the surface. Every reader of the
 * mind excludes the event by type — it renders nowhere, is not news, wakes nothing, and
 * `search` never finds it — so the mind never reads back a word it did not say.
 *
 * Two questions are this module's own:
 *
 *   - **WHETHER** — only when the PRINCIPAL is there, because the line is painted on THEIR
 *     surface. A turn's `about` carries `since` per unanswered conversation; presence reads
 *     the one room the principal speaks in, the mind's own, where their word lands whether
 *     typed into a door or crossed in by the mirror — so a line sent from Slack is still a
 *     reason to say `[agent thinking...]` on WhatsApp, and a stranger's message in some
 *     group, which wakes the mind exactly the same way, is not. It must also be a word:
 *     an alarm ringing in that room is the clock, and nobody is waiting on it. Then the
 *     word must be within `RECENT_MS` — a 3am tick over a three-day-old window says
 *     nothing. That question is settled ONCE, at the turn's edge: the answer a principal
 *     waits five minutes for is the one they most need a sign of life during, and the
 *     minute is about whether they are there, not how long the mind may take. And nothing
 *     at all is written while no surface is bound: a fact nobody can hear is not worth a
 *     row.
 *   - **HOW OFTEN** — once per kind per turn.
 */

import { MIND, sessionAddress } from "../session.ts";
import type { AliasRow } from "../store/connections.ts";
import type { About, Delta, DeltaEvent, DeltaKind, Draft } from "../types.ts";

/** How recently a conversation must have spoken for presence to say anything. The wire's
 *  own sense of "now" (the whatsmeow bridge holds a minute for chat presence), and the
 *  reason the mind's background life stays invisible: nobody is watching, nobody is told. */
export const RECENT_MS = 60_000;

export interface PresenceDeps {
  /** The mirror's surfaces, live — read through, so a binding granted while the org runs
   *  is heard without a restart. Presence only asks whether any exist. */
  aliases: () => Promise<AliasRow[]>;
  /** → the log: one `delta` event in the mind's room, which the mirror carries from there. */
  publish: (draft: Draft<DeltaEvent>) => Promise<unknown>;
  now?: () => number;
  recentMs?: number;
  onError?: (err: unknown) => void;
}

/** What main tells presence — the same two facts it hands the doors. */
export interface Presence {
  status(agentId: string, sessionId: string, status: "busy" | "idle", about: About[]): void;
  delta(agentId: string, sessionId: string, delta: Delta): void;
}

/** An open turn: whether the principal was there when it began, and what it has already
 *  said about itself. */
interface Turn {
  heard: boolean;
  told: Set<DeltaKind>;
}

/**
 * Wire presence to the log.
 *
 * A busy edge MERGES rather than replaces — main discloses on every decision, so one turn
 * can announce itself more than once, and a reset `told` would say `[agent thinking...]`
 * twice. The idle closes the turn; the next busy opens a new one, free to speak again.
 */
export function createPresence(deps: PresenceDeps): Presence {
  const now = deps.now ?? (() => Date.now());
  const recentMs = deps.recentMs ?? RECENT_MS;
  const turns = new Map<string, Turn>();

  return {
    status(agentId, sessionId, status, about) {
      if (sessionId !== MIND) return; // a named session is mirrored nowhere
      if (status === "idle") {
        turns.delete(agentId);
        return;
      }
      // when the PRINCIPAL last spoke: their word lands in the mind's own room whatever
      // carried it — typed into a door, or crossed in by the mirror from any wire
      const home = sessionAddress(agentId, MIND);
      const since = about
        .filter((a) => a.conversation === home && a.spoken)
        .map((a) => Date.parse(a.since))
        .filter((t) => !Number.isNaN(t))
        .reduce((a, b) => Math.max(a, b), -Infinity);
      // asked once, at the edge: somebody who asked a minute ago is somebody who is still
      // waiting, however long the answer takes — and the long answers are the ones worth
      // saying anything about. A turn that opened over nothing can still be joined: a word
      // spoken into it is the principal arriving mid-answer.
      const heard = now() - since <= recentMs;
      const held = turns.get(agentId);
      if (held) held.heard ||= heard;
      else turns.set(agentId, { heard, told: new Set() });
    },
    delta(agentId, sessionId, delta) {
      const kind = delta.kind;
      if (kind !== "thinking" && kind !== "checkpoint") return;
      if (sessionId !== MIND) return;
      const turn = turns.get(agentId);
      if (!turn || !turn.heard || turn.told.has(kind)) return;
      // the deltas do not wait: the seat is claimed as soon as a surface is known to exist,
      // and the line lands on its own time — one that did not is one nobody needed
      deps.aliases()
        .then((rows) => {
          if (turn.told.has(kind) || !rows.some((a) => a.live && a.agentId === agentId)) return;
          turn.told.add(kind);
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
      connection_address: "agent",
      conversation: { address: sessionAddress(agentId, MIND) },
    },
    parts: [{ type: "data", kind: "delta", data: { kind } }],
  };
}
