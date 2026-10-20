/**
 * store/roster.ts — who steers whom, derived (§4).
 *
 * The registry says who is in the org; the connections map says whose each account is and
 * where its mind surfaces are (`extra.mirrors`). Between them, nothing else is written
 * down: an agent speaks through the connections it owns and through every org account,
 * and its principals are itself when it owns an account — it is a person's — or the org's
 * people when it owns none, unless the entry declares the list itself.
 *
 * The derivation is two VIEWS over `agents` and `connections` — `principals`, `aliases` —
 * so the visibility law (`policy.ts`) reads them as relations, the way the RLS `USING`
 * expression joins them on Postgres. The handle rule the views need (`digits`) is the
 * function below, bound into the engine.
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

/** The connections an agent speaks through (§4, §6): the ones it owns, where it speaks as
 *  their owner, and every org account that holds a credential, where it speaks as the org.
 *  An ownerless row without a credential is a registration stub and nobody's voice. */
export function speaksThrough(agent: AgentRow, connections: ConnectionRow[]): ConnectionRow[] {
  return connections.filter((c) =>
    c.agentId === agent.agentId || (c.agentId === undefined && !!c.credentialKey)
  );
}

/** Bind the handle rule into the engine, under the name the views use. */
export function bindRoster(db: DatabaseSync): void {
  db.function("digits", { deterministic: true }, (s) => (s == null ? null : digits(String(s))));
}

/** The derivation, as views of this connection (`TEMP`: defined by the code that opened
 *  the store, never a schema another process could be running an older version of).
 *
 *   principals  (agent_id, principal, rank)
 *               who steers each agent: the declared list in its order, else itself when
 *               it owns a connection (a person's account, revoked ones included), else
 *               the org's people — an agent that holds no account of its own is the
 *               org's, and the members who are persons (an account of their own, or a
 *               person alone, `mind: false`) steer it
 *   aliases     (service, connection, conversation, agent_id, principal, live, raw)
 *               the mind surfaces, each read off `extra.mirrors` or derived beside it:
 *               self   on a connection the agent owns, its self-conversation
 *                      (`mirrors.self`, or the number itself on WhatsApp) — a revoked
 *                      one still listed, `live` 0
 *               dms    on a live connection the agent owns, each principal's DM with it:
 *                      on WhatsApp their own number, elsewhere the id the ingest recorded
 *                      (`mirrors.dms`, principal → conversation)
 *               rooms  on a live org account, each agent's steering room
 *                      (`mirrors.rooms`, agent → conversation), `principal` null because
 *                      whoever writes there steers
 *               `raw` is the connection's `extra.raw`: its dispatcher renders a crossing
 *               itself */
export const ROSTER_VIEWS = `
CREATE TEMP VIEW IF NOT EXISTS principals AS
  SELECT a.agent_id, p.value AS principal, p.key AS rank
  FROM agents a, json_each(coalesce(a.principals, '[]')) p
  UNION ALL
  SELECT a.agent_id, b.agent_id, 0
  FROM agents a JOIN agents b
  WHERE a.principals IS NULL
    AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.agent_id = a.agent_id)
    AND (b.runs = 0 OR EXISTS (SELECT 1 FROM connections c WHERE c.agent_id = b.agent_id))
  UNION ALL
  SELECT a.agent_id, a.agent_id, 0
  FROM agents a
  WHERE a.principals IS NULL
    AND EXISTS (SELECT 1 FROM connections c WHERE c.agent_id = a.agent_id);
CREATE TEMP VIEW IF NOT EXISTS aliases AS
  SELECT service, address AS connection,
         coalesce(json_extract(extra, '$.mirrors.self'),
                  CASE service WHEN 'whatsapp' THEN address END) AS conversation,
         agent_id, agent_id AS principal, deleted_at IS NULL AS live,
         json_extract(extra, '$.raw') IS 1 AS raw
  FROM connections
  WHERE agent_id IS NOT NULL
    AND (json_extract(extra, '$.mirrors.self') IS NOT NULL OR service = 'whatsapp')
  UNION ALL
  SELECT c.service, c.address, digits(w.phone), c.agent_id, p.principal, 1,
         json_extract(c.extra, '$.raw') IS 1
  FROM connections c
    JOIN principals p ON p.agent_id = c.agent_id
    JOIN agents w ON w.agent_id = p.principal
  WHERE c.deleted_at IS NULL AND c.service = 'whatsapp'
    AND w.phone IS NOT NULL AND w.phone <> '' AND digits(c.address) <> digits(w.phone)
  UNION ALL
  SELECT c.service, c.address, d.value, c.agent_id, d.key, 1,
         json_extract(c.extra, '$.raw') IS 1
  FROM connections c, json_each(json_extract(c.extra, '$.mirrors.dms')) d
    JOIN principals p ON p.agent_id = c.agent_id AND p.principal = d.key
  WHERE c.deleted_at IS NULL AND d.type = 'text'
  UNION ALL
  SELECT c.service, c.address, r.value, r.key, NULL, 1,
         json_extract(c.extra, '$.raw') IS 1
  FROM connections c, json_each(json_extract(c.extra, '$.mirrors.rooms')) r
    JOIN agents a ON a.agent_id = r.key
  WHERE c.deleted_at IS NULL AND c.agent_id IS NULL AND r.type = 'text';`;
