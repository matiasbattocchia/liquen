/**
 * store/connections.ts — connections + memberships: the tables policy reads (§4, §6).
 *
 * A *connection* is a connected account — a GRANT the org vouches for:
 * `(service, address, agent_id?, credential_key?, extra?)`. `agent_id` names the owner
 * and IS the privacy switch: owned ⇒ private to that agent; ownerless ⇒ the org's,
 * shared inbox (the acl table refines this later; until then absence is the config). A
 * Slack user grant is its own connection `<team>:<user>`; the org bot is the bare
 * `<team>`. `credential_key` points at the grant's secret in the vault; `extra` carries
 * discovered account facts (JSON, shallow-merged on upsert).
 *
 * Registration is the LOG's frontier gate (§4): an event on a connection with no live
 * row is refused at publish — only `local` (the substrate's own service) is exempt.
 * Deletion is SOFT (`deleted_at`) and closes the GATE ONLY: no new events enter, but
 * identity and visibility over the history the grant already ingested persist —
 * sessions are unaffected by a revocation. A re-grant upsert REVIVES it.
 *
 * A *membership* row is open-bsp's `conversations_agents`, address-keyed (mu has no
 * conversations entity table): `(service, connection_address, conversation_address,
 * agent_id, session_id)` — the MEMBER is a session, the (agent, session) pair (§4) —
 * the membership branch of visibility (channel/DM membership), and the local team-chat
 * substrate (a session's own room is a one-member conversation; a DM is a two-member
 * one). A row that names no session enrolls the ROUTED one (`routedSession`) — the wire
 * writers never decide which session a conversation belongs to. A membership is a LIFETIME: a live row grants the conversation
 * whole; a channel LEAVE stamps `deleted_at`, and the stamped row keeps granting
 * events up to the stamp — the agent keeps what it has seen, never what came after.
 * A rejoin revives the row: the conversation whole again (join-shows-history, Slack's
 * own rule).
 *
 * Both are RUNTIME data (a connect flow or the wire mirror binds them while the org
 * runs), so there is no mirror-sync: upserts only, the table is primary. A door writes
 * what it knows — an upsert with `agentId`/`credentialKey` absent PRESERVES what
 * another door bound, and `extra` merges field-wise. Policy reads THROUGH prepared
 * statements (`connection`/`isMember`) — live by construction, like the RLS join it
 * emulates (§6); a mid-run bind, delete, or revival is visible on the next event.
 */

import type { DatabaseSync } from "node:sqlite";
import { routedSession } from "../session.ts";

export interface ConnectionRow {
  service: string;
  address: string;
  agentId?: string; // the owner: present ⇒ private, absent ⇒ shared/org (§6)
  credentialKey?: string; // → the vault row this grant authenticates with (§4)
  extra?: Record<string, unknown>; // discovered account facts (slack: {url, …})
}

export interface MembershipRow {
  service: string;
  connection: string; // the connection address the conversation anchors to
  conversation: string;
  agentId: string;
  /** Whose enrollment it is: the (agent, session) pair is the member (§4). Absent — the
   *  wire writers never name one — the store enrolls the ROUTED session, the one this
   *  connection's traffic belongs to (`routedSession`). */
  sessionId?: string;
}

/** A mind-alias binding (§4): an OWNED connection's principal-identified conversation
 *  (self-talk). DERIVED where platform structure gives it away (a WA self-chat is
 *  addressed by the connection's own number), RECORDED (`extra.self_conversation`, the
 *  connect flow's discovery) where the platform's id is opaque (the Slack self-DM). */
export interface AliasRow {
  service: string;
  connection: string; // the binding row's own address (grant / paired number)
  conversation: string; // the self-conversation on the wire
  agentId: string;
  /** The grant still stands (no `deleted_at`): the surface is one somebody holds, so a
   *  mind copy sent there reaches them. A revoked binding is listed too — it keeps
   *  recognizing the history it ingested — but nothing is sent to it. */
  live: boolean;
}

/** Does this envelope land in an alias conversation? Events may anchor to a sibling of the
 *  binding row (Slack: the workspace or bot anchor vs the grant `<team>:<user>`), so the
 *  connection matches on its workspace part — the address up to the first `:` (addresses
 *  without one, like a WA number, compare whole). */
export function aliasOf(
  rows: AliasRow[],
  service: string,
  connection: string,
  conversation: string,
): AliasRow | undefined {
  const root = (a: string) => {
    const at = a.indexOf(":");
    return at < 0 ? a : a.slice(0, at);
  };
  return rows.find((r) =>
    r.service === service && r.conversation === conversation &&
    root(r.connection) === root(connection)
  );
}

export interface Connections {
  /** Bind/update/REVIVE connected accounts. Upsert only — a restart never erases a
   *  binding; absent `agentId`/`credentialKey` preserve, `extra` merges. */
  upsertConnections(rows: ConnectionRow[]): void;
  /** Soft-delete: closes the publish gate for this connection — nothing else. The row
   *  keeps answering `connection()` (identity and visibility persist over ingested
   *  history), and a re-grant upsert revives ingestion. */
  deleteConnections(keys: { service: string; address: string }[]): void;
  /** Point lookup for policy and the ingest classifier (live — the RLS-join emulation).
   *  Deletion does not hide the row here; only the gate checks `deleted_at`. */
  connection(service: string, address: string): ConnectionRow | null;
  /** The map as it stands — live rows only: a soft-deleted grant is not a surface anyone
   *  has. What the anchor reads to say which surfaces exist and which are down (§5). */
  connections(): ConnectionRow[];
  /** The mind-alias bindings (§4): every owned connection's self-conversation, derived
   *  or recorded. Soft-deleted rows KEEP answering, with `live: false` — a revocation
   *  closes the gate, never the hiding: the mind copies already there are that surface's
   *  record, and the binding still names whose they are. */
  aliases(): AliasRow[];
  /** Enroll agents in conversations. Upsert only — a re-enroll REVIVES a left row. */
  upsertMemberships(rows: MembershipRow[]): void;
  /** Soft-delete: a channel LEAVE ends the membership's lifetime — `isMember` keeps
   *  answering for events up to the stamp, refuses everything after. */
  deleteMemberships(rows: MembershipRow[]): void;
  /** The membership branch of `readable`/`writable` (§6): a live row grants the whole
   *  conversation; a stamped row grants only events with `ts` ≤ its `deleted_at`.
   *  Omitting `ts` asks about NOW — live rows only. */
  isMember(
    service: string,
    connection: string,
    conversation: string,
    agentId: string,
    sessionId: string,
    ts?: string,
  ): boolean;
  /** The distinct (agent, session) pairs enrolled anywhere — boot's backlog scan (§4):
   *  a session with rooms owes them a look when the org comes up, and the enrollments
   *  are the only record a named session leaves. */
  enrolled(): { agentId: string; sessionId: string }[];
}

export const CONNECTIONS_DDL = `CREATE TABLE IF NOT EXISTS connections (
  service        TEXT NOT NULL,
  address        TEXT NOT NULL,
  agent_id       TEXT,
  credential_key TEXT,
  extra          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  PRIMARY KEY (service, address)
);
CREATE TABLE IF NOT EXISTS memberships (
  service              TEXT NOT NULL,
  connection_address   TEXT NOT NULL,
  conversation_address TEXT NOT NULL,
  agent_id             TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  deleted_at           TEXT,
  PRIMARY KEY (service, connection_address, conversation_address, agent_id, session_id)
);`;

/** Bind the connections capability to an open DB (composed by openLog, like the registry). */
export function createConnections(db: DatabaseSync): Connections {
  const putC = db.prepare(
    `INSERT INTO connections (service, address, agent_id, credential_key, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(service, address) DO UPDATE SET
       agent_id = COALESCE(excluded.agent_id, agent_id),
       credential_key = COALESCE(excluded.credential_key, credential_key),
       extra = CASE WHEN excluded.extra IS NULL THEN extra
                    ELSE json_patch(coalesce(extra, '{}'), excluded.extra) END,
       updated_at = excluded.updated_at,
       deleted_at = NULL`,
  );
  const delC = db.prepare(
    "UPDATE connections SET deleted_at = ?, updated_at = ? WHERE service = ? AND address = ?",
  );
  const getC = db.prepare(
    `SELECT service, address, agent_id, credential_key, extra FROM connections
     WHERE service = ? AND address = ?`,
  );
  const listC = db.prepare(
    `SELECT service, address, agent_id, credential_key, extra FROM connections
     WHERE deleted_at IS NULL ORDER BY service, address`,
  );
  const rowOf = (r: {
    service: string;
    address: string;
    agent_id: string | null;
    credential_key: string | null;
    extra: string | null;
  }): ConnectionRow => ({
    service: r.service,
    address: r.address,
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.credential_key ? { credentialKey: r.credential_key } : {}),
    ...(r.extra ? { extra: JSON.parse(r.extra) as Record<string, unknown> } : {}),
  });
  // a binding is DERIVED where platform structure gives it away — an owned WhatsApp
  // connection's self-chat IS its own address, nothing stored — and RECORDED where it
  // can't be (Slack's self-DM id is opaque: resolved once at connect, `extra.self_conversation`)
  const getAliases = db.prepare(
    `SELECT service, address, agent_id, deleted_at IS NULL AS live,
            coalesce(json_extract(extra, '$.self_conversation'),
                     CASE service WHEN 'whatsapp' THEN address END) AS conversation
     FROM connections
     WHERE agent_id IS NOT NULL
       AND (json_extract(extra, '$.self_conversation') IS NOT NULL OR service = 'whatsapp')`,
  );
  const putM = db.prepare(
    `INSERT INTO memberships
       (service, connection_address, conversation_address, agent_id, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(service, connection_address, conversation_address, agent_id, session_id)
     DO UPDATE SET deleted_at = NULL`,
  );
  const getM = db.prepare(
    `SELECT 1 AS x FROM memberships
     WHERE service = ? AND connection_address = ? AND conversation_address = ? AND agent_id = ?
       AND session_id = ? AND (deleted_at IS NULL OR ? <= deleted_at)`,
  );
  const delM = db.prepare(
    `UPDATE memberships SET deleted_at = ?
     WHERE service = ? AND connection_address = ? AND conversation_address = ? AND agent_id = ?
       AND session_id = ? AND deleted_at IS NULL`,
  );
  const pairs = db.prepare(
    "SELECT DISTINCT agent_id, session_id FROM memberships WHERE deleted_at IS NULL",
  );
  // a row that names no session enrolls the ROUTED one — the wire writers never decide
  const sessionOf = (r: MembershipRow) =>
    r.sessionId ?? routedSession({ service: r.service, connection_address: r.connection });

  return {
    upsertConnections(rows: ConnectionRow[]): void {
      const now = new Date().toISOString();
      for (const r of rows) {
        putC.run(
          r.service,
          r.address,
          r.agentId ?? null,
          r.credentialKey ?? null,
          r.extra ? JSON.stringify(r.extra) : null,
          now,
          now,
        );
      }
    },

    deleteConnections(keys: { service: string; address: string }[]): void {
      const now = new Date().toISOString();
      for (const k of keys) delC.run(now, now, k.service, k.address);
    },

    connection(service: string, address: string): ConnectionRow | null {
      const r = getC.get(service, address) as Parameters<typeof rowOf>[0] | undefined;
      return r ? rowOf(r) : null;
    },

    connections(): ConnectionRow[] {
      return (listC.all() as unknown as Parameters<typeof rowOf>[0][]).map(rowOf);
    },

    aliases(): AliasRow[] {
      const rows = getAliases.all() as unknown as {
        service: string;
        address: string;
        agent_id: string;
        conversation: string;
        live: number;
      }[];
      return rows.map((r) => ({
        service: r.service,
        connection: r.address,
        conversation: r.conversation,
        agentId: r.agent_id,
        live: r.live === 1,
      }));
    },

    upsertMemberships(rows: MembershipRow[]): void {
      const now = new Date().toISOString();
      for (const r of rows) {
        putM.run(r.service, r.connection, r.conversation, r.agentId, sessionOf(r), now);
      }
    },

    deleteMemberships(rows: MembershipRow[]): void {
      const now = new Date().toISOString();
      for (const r of rows) {
        delM.run(now, r.service, r.connection, r.conversation, r.agentId, sessionOf(r));
      }
    },

    isMember(
      service: string,
      connection: string,
      conversation: string,
      agentId: string,
      sessionId: string,
      ts?: string,
    ): boolean {
      return getM.get(service, connection, conversation, agentId, sessionId, ts ?? null) !==
        undefined;
    },

    enrolled(): { agentId: string; sessionId: string }[] {
      return (pairs.all() as { agent_id: string; session_id: string }[])
        .map((r) => ({ agentId: r.agent_id, sessionId: r.session_id }));
    },
  };
}
