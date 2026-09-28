/**
 * route.ts — which NAMED sessions an event wakes (§4).
 *
 * The minds need no routing: each tails its own scoped view of the log, and the policy is
 * the delivery (§6). A named session has no standing subscription — it is reactive, woken
 * by the events whose address names it: its own room, a direct room it is a member of, or
 * a group or channel it is enrolled in. A direct address spells its members, so `route`
 * reads them off the row; a group's minted id says nothing, so its members are asked of
 * the memberships table. `enroll` is what a session named for the first time owes the
 * store before it runs — the membership that makes its room its own (WITH CHECK, §6).
 */

import type { Log } from "./store/log.ts";
import { MIND, parseDirect, sessionAddress } from "./session.ts";
import type { Event } from "./types.ts";

export interface Session {
  agentId: string;
  sessionId: string;
}

/** The named sessions an event's address names — the direct room's members, or the room's
 *  live enrollments. A `control` row acts on a running turn — the store fires the lease's
 *  interrupt (§2) — and never starts one. */
export async function route(
  e: Event,
  log: Pick<Log, "membersOf">,
): Promise<Session[]> {
  if (e.type === "control" || e.envelope.service !== "local") return [];
  const { connection_address, conversation } = e.envelope;
  const members = parseDirect(conversation.address) ??
    await log.membersOf("local", connection_address, conversation.address);
  return members.filter((p) => p.sessionId !== MIND); // the minds tail their own scoped views
}

/** Born when first named (§4): the session's own room is a one-member conversation, and
 *  this enrollment is what lets its closing messages land there. Idempotent — every
 *  host that runs a named session may enroll it again. */
export function enroll(
  log: Pick<Log, "upsertMemberships">,
  { agentId, sessionId }: Session,
): Promise<void> {
  return log.upsertMemberships([{
    service: "local",
    connection: "agent",
    conversation: sessionAddress(agentId, sessionId),
    agentId,
    sessionId,
  }]);
}
