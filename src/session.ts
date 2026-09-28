/**
 * session.ts — the session address vocabulary (DESIGN §4, §7).
 *
 * A session's identity is the PAIR `(agent_id, session_id)` — `session_id` holds the bare
 * name (`mind`, `build`), and bare names collide across agents (every agent has a `mind`),
 * so nothing compares a session by one string. The ADDRESS is how the pair is written
 * wherever one string is needed — an envelope, a `send` target, a doc path:
 *
 *     mind@matias · build@matias
 *
 * `@` because `:` already separates the segments of world addresses (`slack:T0AB:C123`),
 * and because a local address lands in filesystem paths (`conversations/<address>/` is a
 * doc scope walked as a directory), where `/` could not.
 *
 * A DIRECT room between sessions is its sorted members joined by `,` — the member set IS
 * the address (§3 `direct`, the mpim rule), so a copy in any order names the same room and
 * nothing has to be looked up to know who is in it:
 *
 *     mind@ana,mind@bo · build@ana,mind@ana,mind@cy
 *
 * A session's own room is the one-member case. A local group or channel has an address of
 * its own (a minted id), since its members change; its members are the memberships table's.
 */

import type { AgentId, SessionId } from "./types.ts";

/** The default session — the one world traffic is routed to (§4). A bare agent name in an
 *  address position means the agent, which canonicalizes to this session. */
export const MIND: SessionId = "mind";

/** A session or agent NAME: usable as an address segment and a path segment. The same
 *  shape config enforces on agent names — what `@` and `:` are reserved for is exactly
 *  what this keeps them out of. */
const NAME = /^[a-z][a-z0-9_-]*$/;

/** The pair, written as an address: `sessionAddress("matias", "mind")` → `mind@matias`.
 *  Refuses a name the address grammar cannot carry — the one door every construction
 *  passes through, so a malformed name never reaches an envelope or a path. */
export function sessionAddress(agentId: AgentId, sessionId: SessionId): string {
  for (const name of [agentId, sessionId]) {
    if (!NAME.test(name)) {
      throw new Error(`"${name}" is not a name — lowercase, digits, - and _, letter first`);
    }
  }
  return `${sessionId}@${agentId}`;
}

/** An address back to its pair, or null when it is not a session address. */
export function parseSession(
  address: string,
): { agentId: AgentId; sessionId: SessionId } | null {
  const at = address.indexOf("@");
  if (at === -1) return null;
  const [sessionId, agentId] = [address.slice(0, at), address.slice(at + 1)];
  return NAME.test(sessionId) && NAME.test(agentId) ? { agentId, sessionId } : null;
}

/** The direct room of some session addresses: the distinct members, sorted, joined by `,`
 *  — member-defined identity (§3 `direct`), one rule for sessions of one agent and
 *  sessions of many. */
export function directAddress(members: string[]): string {
  return [...new Set(members)].sort().join(",");
}

/** The members a local address spells, when it spells them: every `,` part a session
 *  address — a session's own room is the one-part case. Null for anything else, a
 *  group's or channel's minted id included: those hold their members in the table. */
export function parseDirect(
  address: string,
): { agentId: AgentId; sessionId: SessionId }[] | null {
  const parts = address.split(",").map(parseSession);
  return parts.every((p) => p !== null) ? parts : null;
}

/** Which of an agent's sessions a connection's traffic belongs to (§4): whose window may
 *  see those rows, whose xi wakes for them, which session a wire-filled membership
 *  enrolls, and whose complex an unstamped echo row reads as. ONE decision, consulted
 *  everywhere it matters — connections and credentials stay agent-owned, and this is the
 *  only place that says what that means session-wise. Today every connection routes to
 *  the mind. */
export function routedSession(
  _envelope: { service: string; connection_address: string },
): SessionId {
  return MIND;
}
