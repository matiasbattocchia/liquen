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
 *
 * The derivation is three VIEWS over `agents` and `connections` — `speaks`, `principals`,
 * `aliases` — so the visibility law (`policy.ts`) reads them as relations, the way the
 * RLS `USING` expression joins them on Postgres. The two handle rules the views need
 * (`same_handle`, `digits`) are the functions below, bound into the engine.
 */

import type { DatabaseSync } from "node:sqlite";
import type { AgentRow } from "./agents.ts";
import type { ConnectionRow } from "./connections.ts";

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
 *  recorded rather than derived (§4). The same rule as the `speaks` view, over rows. */
export function speaksThrough(agent: AgentRow, connections: ConnectionRow[]): ConnectionRow[] {
  return connections.filter((c) =>
    c.agentId === agent.agentId ||
    (c.agentId === undefined &&
      (c.extra?.agent === agent.agentId ||
        sameHandle(c.address, agent.phone) || sameHandle(c.address, agent.email)))
  );
}

/** Bind the handle rules into the engine, under the names the views use. */
export function bindRoster(db: DatabaseSync): void {
  db.function("digits", { deterministic: true }, (s) => (s == null ? null : digits(String(s))));
  db.function(
    "same_handle",
    { deterministic: true },
    (
      a,
      b,
    ) => (sameHandle(a == null ? undefined : String(a), b == null ? undefined : String(b)) ? 1 : 0),
  );
}

/** The derivation, as views of this connection (`TEMP`: defined by the code that opened
 *  the store, never a schema another process could be running an older version of).
 *
 *   speaks      (agent_id, owner, service, address, extra)
 *               the LIVE connections an agent speaks through; `owner` is the row's
 *               `agent_id`, null on an org account
 *   principals  (agent_id, principal, rank)
 *               who steers each agent: the declared list in its order, else every member
 *               when the agent acts as the org, else itself
 *   aliases     (service, connection, conversation, agent_id, principal, live)
 *               the mind surfaces: an owned connection's self-conversation (recorded in
 *               `extra.self_conversation`, or the number itself on WhatsApp) — a revoked
 *               one still listed, `live` 0 — and, on every connection an agent speaks
 *               through, each principal's DM with it: on WhatsApp their own number, on
 *               Slack the id the ingest recorded (`extra.dms`, member → channel) */
export const ROSTER_VIEWS = `
CREATE TEMP VIEW IF NOT EXISTS speaks AS
  SELECT a.agent_id, c.agent_id AS owner, c.service, c.address, c.extra
  FROM agents a JOIN connections c
    ON c.deleted_at IS NULL
   AND (c.agent_id = a.agent_id
        OR (c.agent_id IS NULL
            AND (json_extract(c.extra, '$.agent') = a.agent_id
                 OR same_handle(c.address, a.phone) OR same_handle(c.address, a.email))));
CREATE TEMP VIEW IF NOT EXISTS principals AS
  SELECT a.agent_id, p.value AS principal, p.key AS rank
  FROM agents a, json_each(coalesce(a.principals, '[]')) p
  UNION ALL
  SELECT a.agent_id, b.agent_id, 0
  FROM agents a JOIN agents b
  WHERE a.principals IS NULL
    AND EXISTS (SELECT 1 FROM speaks s WHERE s.agent_id = a.agent_id AND s.owner IS NULL)
  UNION ALL
  SELECT a.agent_id, a.agent_id, 0
  FROM agents a
  WHERE a.principals IS NULL
    AND NOT EXISTS (SELECT 1 FROM speaks s WHERE s.agent_id = a.agent_id AND s.owner IS NULL);
CREATE TEMP VIEW IF NOT EXISTS aliases AS
  SELECT service, address AS connection,
         coalesce(json_extract(extra, '$.self_conversation'),
                  CASE service WHEN 'whatsapp' THEN address END) AS conversation,
         agent_id, agent_id AS principal, deleted_at IS NULL AS live
  FROM connections
  WHERE agent_id IS NOT NULL
    AND (json_extract(extra, '$.self_conversation') IS NOT NULL OR service = 'whatsapp')
  UNION ALL
  SELECT s.service, s.address, digits(w.phone), s.agent_id, p.principal, 1
  FROM speaks s
    JOIN principals p ON p.agent_id = s.agent_id
    JOIN agents w ON w.agent_id = p.principal
  WHERE s.service = 'whatsapp' AND w.phone IS NOT NULL AND w.phone <> ''
    AND digits(s.address) <> digits(w.phone)
  UNION ALL
  SELECT s.service, s.address, d.value, s.agent_id, d.key, 1
  FROM speaks s, json_each(json_extract(s.extra, '$.dms')) d
    JOIN principals p ON p.agent_id = s.agent_id AND p.principal = d.key
  WHERE s.service = 'slack' AND d.type = 'text';`;
