/**
 * store/roster.ts — who steers whom, derived (§4).
 *
 * The registry says who is in the org and what account each agent acts as; the connections
 * map says whose each account is. Between them, nothing else is written down: an agent
 * speaks through the connections that name it as owner and through any org account its
 * handle claims, and its principals are its owner, or the whole roster when the account
 * is the org's, unless the entry declares the list itself. The DM between a principal's
 * own number and the agent's account is a mind surface — one alias per principal, and no
 * table holds them, since every input to the derivation is already a row.
 */

import type { AgentRow } from "./agents.ts";
import type { AliasRow, ConnectionRow } from "./connections.ts";

/** A phone as the wire spells it: digits only. A declared handle may carry `+`, spaces or
 *  dashes; a WhatsApp address never does. */
export function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Do two handles name one account? Phones agree on their digits, everything else on the
 *  string (case-folded: an email's mailbox is what people type, and they type it loosely). */
export function sameHandle(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const phoneish = (s: string) => /^[\d\s+().-]+$/.test(s.trim());
  if (phoneish(a) && phoneish(b)) return digits(a).length > 0 && digits(a) === digits(b);
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The connections an agent speaks through: the ones that name it as owner, and the
 *  ownerless ones its handles claim (an org account — that is what makes it an org agent).
 *  An account with no handle a human could declare — a Slack bot — names its agent on
 *  the row instead (`extra.agent`, written by the bot door), the way an opaque id is
 *  recorded rather than derived (§4). */
export function speaksThrough(agent: AgentRow, connections: ConnectionRow[]): ConnectionRow[] {
  return connections.filter((c) =>
    c.agentId === agent.agentId ||
    (c.agentId === undefined &&
      (c.extra?.agent === agent.agentId ||
        sameHandle(c.address, agent.phone) || sameHandle(c.address, agent.email)))
  );
}

/** Does the agent act as the org? True when a handle of its claims an ownerless connection. */
export function orgOwned(agent: AgentRow, connections: ConnectionRow[]): boolean {
  return speaksThrough(agent, connections).some((c) => c.agentId === undefined);
}

/** Who steers `agentId` (§4): the entry's own list when it declares one; else every
 *  member when the agent acts as the org, else its owner alone — which is itself, the
 *  alter-ego duality. Unknown agent ⇒ nobody. */
export function principalsOf(
  agentId: string,
  agents: AgentRow[],
  connections: ConnectionRow[],
): string[] {
  const me = agents.find((a) => a.agentId === agentId);
  if (!me) return [];
  if (me.principals) return me.principals;
  if (orgOwned(me, connections)) return agents.map((a) => a.agentId);
  return [agentId];
}

/** The DM aliases (§4): on every connection an agent speaks through, the direct chat with
 *  each principal is a surface of its mind. On WhatsApp the chat is addressed by the
 *  principal's own number, so it is derived from their declared phone; on Slack the id is
 *  opaque, so it is read back from the row (`extra.dms`, member → channel, which the
 *  ingest records on first sight) — and only the entries naming a principal count. The
 *  self-chat is not among them — it is the connection's own row's business (`aliases()`
 *  in the store) — so a principal whose number IS the connection's yields nothing here.
 *  Only live connections are consulted: a revoked account's DMs are hidden by nothing,
 *  and shown to no one, since the gate is closed there and no new line can land. */
export function dmAliases(agents: AgentRow[], connections: ConnectionRow[]): AliasRow[] {
  const out: AliasRow[] = [];
  for (const agent of agents) {
    const own = speaksThrough(agent, connections);
    if (own.length === 0) continue;
    const principals = principalsOf(agent.agentId, agents, connections);
    for (const c of own) {
      if (c.service === "whatsapp") {
        for (const p of principals) {
          const who = agents.find((a) => a.agentId === p);
          if (!who?.phone) continue;
          const number = digits(who.phone);
          if (digits(c.address) === number) continue;
          out.push({
            service: c.service,
            connection: c.address,
            conversation: number,
            agentId: agent.agentId,
            principal: p,
            live: true,
          });
        }
      } else if (c.service === "slack") {
        const dms = (c.extra?.dms ?? {}) as Record<string, string>;
        for (const [p, channel] of Object.entries(dms)) {
          if (!principals.includes(p) || typeof channel !== "string") continue;
          out.push({
            service: c.service,
            connection: c.address,
            conversation: channel,
            agentId: agent.agentId,
            principal: p,
            live: true,
          });
        }
      }
    }
  }
  return out;
}
