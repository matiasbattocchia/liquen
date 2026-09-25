/**
 * policy.ts — the RLS seam (§6): what an agent may SEE and WRITE, one law each.
 *
 * `scoped(log, policy)` returns the same `Log` with the policy baked into every operation —
 * exactly a Supabase client holding the agent's JWT:
 *
 *   • read       — the law applies BEFORE the window limit (RLS `USING` runs before
 *                  `LIMIT`), so a spectator-heavy log can't under-fill the window
 *   • publish    — every draft is checked inside the writing transaction (`WITH CHECK`):
 *                  one bad draft aborts the whole batch, just as Postgres aborts the INSERT
 *   • subscribe  — delivery itself is filtered (the Realtime shape: a socket only carries
 *                  rows RLS lets you see), so each agent tails its OWN view of the log
 *
 * A policy is SQL (`Law`, `store/log.ts`): the visibility predicate written over an
 * event's columns, joined to the memberships, the connections and the roster views, and
 * evaluated by the store — read-through, so a connection bound mid-run is visible on the
 * very next event. Locally the store is SQLite and the law rides every statement; on
 * Postgres the same expression is the role's policy, with the agent taken from the JWT's
 * claims, and the wrapper vanishes (§9). xi can't tell which world it's in. The gate in xi
 * (`relevant`) keeps only what a trigger's WHEN clause holds — event class; visibility is
 * the port's law.
 */

import type { AgentId, Draft, SessionRef } from "./types.ts";
import { type Appender, both, type Law, type Log } from "./store/log.ts";
import type { Lease } from "./store/lock.ts";

export interface Policy {
  /** RLS `USING`: what the agent sees. Applied at every read (before the window limit —
   *  so `search` and the turn window see the same law) and at delivery. */
  using?: Law;
  /** RLS `WITH CHECK`: what the agent may write. Omitted ⇒ `using`: one law, both sides. */
  check?: Law;
}

/** The law that admits nothing. */
export const NOTHING: Law = { sql: "0", params: {} };

/** The mind-alias rule (§4), shared by every law: an alias conversation is INVISIBLE to
 *  every agent — the mirror's mind copies are its face in the window, and hiding the wire
 *  conversation is what keeps the surface out of the world render and out of `send`'s
 *  reach (a principal is never a send target). Every agent, not only its own: a
 *  principal's line is stamped with THEIR agent id wherever it lands and reads as steering
 *  anywhere, so a member's DM with an org agent, left visible on the org connection, would
 *  wake that member's alter-ego on an instruction meant for someone else. Events may
 *  anchor to a sibling of the binding row (Slack: the workspace or bot anchor vs the grant
 *  `<team>:<user>`), so the connection matches on its workspace part — the address up to
 *  the first `:`; an address without one, like a WA number, compares whole. */
const NOT_AN_ALIAS = `NOT EXISTS (
  SELECT 1 FROM aliases al
  WHERE al.service = events.service AND al.conversation = events.conversation_address
    AND substr(al.connection, 1, instr(al.connection || ':', ':') - 1)
      = substr(events.connection_address, 1, instr(events.connection_address || ':', ':') - 1))`;

/** Branches 1–2, the CONNECTION grants: the org's shared inbox (an ownerless row the org
 *  holds the credential of) and the agent's own account (a row naming it as owner).
 *  OWNERSHIP IS THE PRIVACY SWITCH (§4). An ownerless row without a credential is a
 *  registration STUB — the gate's admission for a workspace whose only tokens are
 *  personal — and visibility rides membership alone; so does NO row (the local service).
 *  A soft-DELETED grant keeps its visibility — revocation closes the publish gate, never a
 *  running session's window. */
const GRANTED = `EXISTS (
  SELECT 1 FROM connections c
  WHERE c.service = events.service AND c.address = events.connection_address
    AND (c.agent_id = $law_agent OR (c.agent_id IS NULL AND c.credential_key IS NOT NULL)))`;

/** Branch 3's lifetime rule: a live row grants the whole conversation; a stamped row grants
 *  only events with `ts` ≤ its `deleted_at` — the agent keeps what it has seen (events up
 *  to the leave) and loses the conversation's future, reads and writes alike. */
const IN_LIFETIME = "(m.deleted_at IS NULL OR events.timestamp <= m.deleted_at)";

/**
 * Derive a session's Policy from the connections map (§6) — THE three-branch visibility
 * law, one expression for `USING` and `WITH CHECK`:
 *
 *   member(service, connection, conversation, agent, session, ts)  -- branch 3: membership
 *                                                             (Slack channel/DM · local
 *                                                             team chat · an own room:
 *                                                             a 1-member conv)
 *   ∨ routed here AND connection is ownerless AND org-credentialed -- branch 1: the org's
 *   ∨ routed here AND connection.owner resolves to me              -- branch 2: owned ⇒
 *                                                                     private
 *
 * The member is the (agent, session) PAIR (§4): a session reads and writes where it is
 * enrolled, and a sibling's room is simply not its. Branches 1–2 are CONNECTION grants,
 * and a connection's traffic belongs to ONE of the agent's sessions — the routed one
 * (`routed`, the store's binding of `routedSession`). Ownership stays the agent's; which
 * session it opens is the routing function's single say. `agent_id` is a registry name
 * and v0 resolves it by identity (principal name = agent name); when N:M
 * principals↔agents lands, only the owner clause changes — the law's shape doesn't.
 */
export function policyFor(session: SessionRef): Policy {
  const { agentId, id: sessionId } = session;
  return {
    using: {
      sql: `${NOT_AN_ALIAS} AND (EXISTS (
  SELECT 1 FROM memberships m
  WHERE m.service = events.service AND m.connection_address = events.connection_address
    AND m.conversation_address = events.conversation_address
    AND m.agent_id = $law_agent AND m.session_id = $law_session AND ${IN_LIFETIME})
  OR ($law_session = routed(events.service, events.connection_address) AND ${GRANTED}))`,
      params: { law_agent: agentId, law_session: sessionId },
    },
  };
}

/**
 * An agent's HISTORY (§6): what `search` reads, whichever of the agent's sessions asks. The
 * window is a session's context; the log is the agent's memory — one agent, one memory
 * (§7) — so this is the same three-branch law keyed on the AGENT: a room any of its
 * sessions is enrolled in (branch 3, under the same lifetime rule), and its connections
 * whatever session their traffic routes to (branches 1–2). Another agent's rows stay as
 * invisible as ever, and the alias rule holds: the mind copies are a surface's readable
 * record. Read-only by law — the handle refuses every draft.
 */
export function historyFor(agentId: AgentId): Policy {
  return {
    using: {
      sql: `${NOT_AN_ALIAS} AND (EXISTS (
  SELECT 1 FROM memberships m
  WHERE m.service = events.service AND m.connection_address = events.connection_address
    AND m.conversation_address = events.conversation_address
    AND m.agent_id = $law_agent AND ${IN_LIFETIME})
  OR ${GRANTED})`,
      params: { law_agent: agentId },
    },
    check: NOTHING,
  };
}

/** The same `Log`, seen through an agent's policy — the local stand-in for connecting as a
 *  role. `lock`, `meter`, `setDelivery`, `close` pass through untouched: leases are keyed by
 *  the agent's own session (nothing cross-agent to protect yet), the rest is telemetry. */
export function scoped(log: Log, policy: Policy): Log {
  const using = policy.using;
  const check = policy.check ?? policy.using;
  return {
    ...log,
    // a refused draft aborts the whole transaction — nothing lands, and a turn-end's lease
    // outlives it
    publish:
      ((one: Draft | Draft[], opts = {}) =>
        log.publish(one as Draft[], { ...opts, check: both(opts.check, check) })) as Appender[
          "publish"
        ],
    publishAndRelease:
      ((one: Draft | Draft[], lease: Lease, opts = {}) =>
        log.publishAndRelease(one as Draft[], lease, {
          ...opts,
          check: both(opts.check, check),
        })) as Appender["publishAndRelease"],
    read: (q = {}) => log.read({ ...q, law: both(q.law, using) }),
    subscribe: (listener, opts = {}) =>
      log.subscribe(listener, { ...opts, law: both(opts.law, using) }),
  };
}
