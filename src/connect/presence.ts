/**
 * connect/presence.ts — the mind says what it is DOING, on every surface it speaks on.
 *
 * The motive is one a log cannot serve: from the other side of a chat, a mind that has been
 * thinking for forty seconds and a mind that is wedged are the same silence. So a `thinking`
 * delta becomes `[thinking...]` and a `checkpoint` delta becomes `[compacting...]`.
 *
 * These are EVENTS — `extra.delta` rows, the family `silenced()` names (§5). That is what
 * makes them work everywhere at once: a dispatcher carries them exactly as it carries any
 * send, the platform's echo merges into the committed row by `external_id` the way every
 * other echo does, and no connector needs a line of code — not a socket, not a client, not
 * a filter at its own door. A connector that is a serverless function gets presence for
 * free, which the out-of-band version could never have offered it. What keeps the words out
 * of the mind is the flag, in one predicate: the row wakes nothing, renders nowhere, is not
 * news, is not mirrored, is not searched, and is never retried.
 *
 * Three questions, and the harness already answers all three:
 *
 *   - **WHERE** — wherever the mirror says. Deltas are the mind's, so they go where mind
 *     events go: the agent's live alias bindings (`connect/mirror.ts`'s own fan-out rule),
 *     and only for the MIND session, since a named session is mirrored nowhere. The
 *     principal's own surfaces hear it; a group never does.
 *   - **WHETHER** — only when somebody is there. A turn's `about` carries `since` per
 *     unanswered conversation; presence speaks only while the freshest of them is within
 *     `RECENT_MS`. A 3am tick wakes the mind over a three-day-old window and says nothing.
 *     Freshness is read across every service, not just one: the mind is one, so a line
 *     typed on Slack is a reason to say `[thinking...]` on WhatsApp.
 *   - **WHAT** — two words, and only ever one of each per turn.
 */

import { MIND } from "../session.ts";
import type { AliasRow } from "../store/connections.ts";
import type { About, Delta, Draft, MessageEvent, Service } from "../types.ts";

/** How recently a conversation must have spoken for presence to say anything. The wire's
 *  own sense of "now" (the whatsmeow bridge holds a minute for chat presence), and the
 *  reason the mind's background life stays invisible: nobody is watching, nobody is told. */
export const RECENT_MS = 60_000;

/** What the mind says while it works. */
export const PRESENCE_TEXT = {
  thinking: "[thinking...]",
  checkpoint: "[compacting...]",
} as const;

export type PresenceKind = keyof typeof PRESENCE_TEXT;

export interface PresenceDeps {
  /** The mirror's own surfaces, live — read through, so a binding granted while the org
   *  runs is spoken to without a restart. */
  aliases: () => AliasRow[];
  /** → the log, as the mirror publishes: one draft per surface, in one transaction. */
  publish: (drafts: Draft<MessageEvent>[]) => Promise<unknown>;
  now?: () => number;
  recentMs?: number;
  onError?: (err: unknown) => void;
}

/** What main tells presence — the same two facts it hands the doors and the stream. */
export interface Presence {
  status(agentId: string, sessionId: string, status: "busy" | "idle", about: About[]): void;
  delta(agentId: string, sessionId: string, delta: Delta): void;
}

/** An open turn: when its freshest news spoke, and what has already been said about it. */
interface Turn {
  since: number;
  told: Set<PresenceKind>;
}

/**
 * Wire presence to the log.
 *
 * A busy edge MERGES rather than replaces — main discloses on every decision, so one turn
 * can announce itself more than once, and a reset `told` would say `[thinking...]` twice.
 * The idle closes the turn; the next busy opens a new one, free to speak again.
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
      // the freshest news of the whole turn, whatever service carried it: one mind
      const since = about
        .map((a) => Date.parse(a.since))
        .filter((t) => !Number.isNaN(t))
        .reduce((a, b) => Math.max(a, b), -Infinity);
      const held = turns.get(agentId);
      if (held) held.since = Math.max(held.since, since);
      else turns.set(agentId, { since, told: new Set() });
    },
    delta(agentId, sessionId, delta) {
      const kind = delta.kind;
      if (kind !== "thinking" && kind !== "checkpoint") return;
      if (sessionId !== MIND) return;
      const turn = turns.get(agentId);
      if (!turn || turn.told.has(kind)) return;
      if (now() - turn.since > recentMs) return;
      const surfaces = deps.aliases().filter((a) => a.live && a.agentId === agentId);
      if (surfaces.length === 0) return;
      turn.told.add(kind); // claim the seat BEFORE the await: the deltas do not wait
      deps.publish(surfaces.map((a) => lineFor(a, agentId, kind, new Date().toISOString())))
        .catch((err) => deps.onError?.(err)); // a line that did not land is one nobody needed
    },
  };
}

/** One presence row: the agent's leg speaking on that surface, flagged as transport. */
function lineFor(
  a: AliasRow,
  agentId: string,
  kind: PresenceKind,
  ts: string,
): Draft<MessageEvent> {
  return {
    ts,
    type: "message",
    agent: { id: agentId, session_id: MIND },
    envelope: {
      service: a.service as Service, // the map stores wire strings; bindings are known services
      connection_address: a.connection,
      conversation: { address: a.conversation },
    },
    parts: [{ type: "text", kind: "text", text: PRESENCE_TEXT[kind] }],
    extra: { delta: true },
  };
}
