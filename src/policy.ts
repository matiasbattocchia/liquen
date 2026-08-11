/**
 * policy.ts — the RLS seam (§6): what an agent may SEE and WRITE, one boolean each.
 *
 * `scoped(log, policy)` returns the same `Log` with the policy baked into every operation —
 * exactly a Supabase client holding the agent's JWT:
 *
 *   • read       — the predicate applies BEFORE the window limit (RLS `USING` runs before
 *                  `LIMIT`), so a spectator-heavy log can't under-fill the window
 *   • publish    — every draft is checked BEFORE anything lands (`WITH CHECK`): one bad draft
 *                  aborts the whole batch, just as Postgres aborts the whole INSERT
 *   • subscribe  — delivery itself is filtered (the Realtime shape: a socket only carries
 *                  rows RLS lets you see), so each agent tails its OWN view of the log
 *
 * xi can't tell which world it's in: locally the scope is this wrapper; on Postgres it's the
 * agent's credential, and the wrapper vanishes (§9). The gate in xi (`relevant`) keeps only
 * what a trigger's WHEN clause holds — event class; visibility is the port's law, applied
 * here, and applied twice in the DB tier too (trigger-body economy + RLS enforcement).
 *
 * HOW readable/writable are computed is the connections map's business (future) — this seam
 * only fixes WHERE they apply. Both default to allow-all: v0 declares no policy, it builds
 * the place policy will stand.
 */

import type { Draft, Envelope, Event } from "./types.ts";
import type { Appender, Filter, Log } from "./store/log.ts";
import type { Connections } from "./store/connections.ts";

export interface Policy {
  /** RLS `USING`: may the agent see this event? Applied at every read (before the window
   *  limit — so `search` and the turn window see the same law) and at delivery. */
  readable?: (e: Event) => boolean;
  /** RLS `WITH CHECK`: may the agent write this draft? Checked before anything lands. */
  writable?: (d: Draft) => boolean;
}

/**
 * Derive an agent's Policy from the connections map (§6) — THE three-branch visibility
 * predicate, shared by readable and writable:
 *
 *   member(service, connection, conversation, agent, ts)  -- branch 3: membership (Slack
 *                                                             channel/DM · local team chat ·
 *                                                             the mind: a 1-member conv)
 *   ∨ connection is ownerless AND org-credentialed        -- branch 1: the org's, shared
 *   ∨ connection.owner resolves to me                     -- branch 2: owned ⇒ private
 *
 * OWNERSHIP IS THE PRIVACY SWITCH (§4): a row with `agent_id` is that agent's private
 * account view. An ownerless row is the org's ONLY when the org actually holds its
 * credential (`credential_key` — a Slack bot, an org WhatsApp session): that account IS
 * the shared inbox. An ownerless row without one is a registration STUB — the gate's
 * admission for a workspace whose only tokens are personal — and visibility rides
 * membership alone. NO row at all (the local service) likewise. A soft-DELETED grant
 * keeps its visibility — revocation closes the publish gate, never a running session's
 * window. A membership is a LIFETIME: the event's `ts` rides into the check, so a left
 * row keeps granting what the agent has seen (events up to the leave) and refuses the
 * conversation's future — reads and writes alike. The acl table refines sharedness
 * later; until then the row is the config.
 *
 * The lookups read THROUGH the store's prepared statements — live, like the Postgres RLS
 * join this emulates: a connection bound mid-run is visible on the very next event, no
 * reload, no restart. `agent_id` is a registry name and v0 resolves
 * it by identity (principal name = agent name); when N:M principals↔agents lands, only
 * this resolver changes — the predicate's shape doesn't (§4).
 */
export function policyFor(
  agentId: string,
  map: Pick<Connections, "connection" | "isMember">,
): Policy {
  const visible = (e: { ts?: string; envelope: Envelope }): boolean => {
    const { service, connection_address: connection, conversation } = e.envelope;
    if (map.isMember(service, connection, conversation.address, agentId, e.ts)) return true;
    const conn = map.connection(service, connection);
    if (conn === null) return false;
    return conn.agentId === agentId ||
      (conn.agentId === undefined && conn.credentialKey !== undefined);
  };
  return { readable: visible, writable: visible };
}

/** The same `Log`, seen through an agent's policy — the local stand-in for connecting as a
 *  role. `lock`, `meter`, `setDelivery`, `close` pass through untouched: leases are keyed by
 *  the agent's own session (nothing cross-agent to protect yet), the rest is telemetry. */
export function scoped(log: Log, policy: Policy): Log {
  const readable = policy.readable ?? (() => true);
  const writable = policy.writable ?? (() => true);
  const check = (one: Draft | Draft[]) => {
    for (const d of Array.isArray(one) ? one : [one]) {
      if (!writable(d)) throw new Error(`policy: draft not writable (type=${d.type})`);
    }
  };
  const and = (extra?: Filter): Filter => extra ? (e: Event) => readable(e) && extra(e) : readable;
  return {
    ...log,
    publish: (async (one: Draft | Draft[]) => {
      check(one); // rejects BEFORE the write — nothing lands, like an aborted transaction
      return await log.publish(one as Draft[]);
    }) as Appender["publish"],
    publishAndRelease: (async (one: Draft | Draft[], lock: string) => {
      check(one); // and before the release: the lease outlives a refused turn-end
      return await log.publishAndRelease(one as Draft[], lock);
    }) as Appender["publishAndRelease"],
    read: (q = {}) => log.read({ ...q, filter: and(q.filter) }),
    subscribe: (listener, opts = {}) =>
      log.subscribe(listener, { ...opts, filter: and(opts.filter) }),
  };
}
