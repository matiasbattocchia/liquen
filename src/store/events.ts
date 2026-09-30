/**
 * store/events.ts — the event as a row, and a read as a WHERE: what every adapter of the
 * `events` table shares (§3, §6).
 *
 * A draft flattens into columns (`rowOf`) and a row reassembles into the runtime event
 * (`eventOf`); a `ReadQuery` becomes one SELECT (`build`), its few engine-specific
 * expressions supplied by the adapter's `Dialect`. Nothing here opens a database.
 */

import type { Conversation, Draft, Envelope, Event } from "../types.ts";
import type { ReadQuery } from "./log.ts";
import { nameWords } from "./names.ts";
import { turnLockOf } from "./lock.ts";

/** An event as a row of the `events` table, as either engine hands it back: JSON columns
 *  as their text. */
export interface Row {
  id: string;
  external_id: string | null;
  type: string;
  service: string | null;
  connection_address: string | null;
  conversation_address: string | null;
  conversation_name: string | null;
  conversation_thread: string | null;
  conversation_kind: string | null;
  session_id: string | null;
  sender_address: string | null;
  sender_name: string | null;
  agent_id: string | null;
  timestamp: string;
  updated_at: string;
  text: string | null;
  parts: string | null;
  payload: string;
  extra: string | null;
  status: string | null;
}

/** ONE clock in the column (§3): whatever offset the producer wrote — WhatsApp stamps
 *  `-03:00`, the harness stamps `Z` — the stored sort key is UTC, because lexical order
 *  (`byTs`, the before/after bounds) only means time on a single zone. The producer's
 *  offset is presentation, and presentation is render's job (org config `timezone`, §5).
 *  Unparseable stamps pass through: an odd row beats a thrown insert. */
export function utcOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

/** Flatten a draft into columns. `id` is null unless the caller named one — `write` mints
 *  it otherwise. `envelope.status` is the shorthand for `status.state`: both land in the
 *  same lifecycle column, the explicit object carrying the stamps (§3). */
export function rowOf(e: Draft) {
  const { envelope } = e;
  const status = (e.status || envelope.status)
    ? { ...e.status, ...(envelope.status ? { state: envelope.status } : {}) }
    : null;
  const parts = (e as { parts?: unknown }).parts;
  return {
    id: e.id ?? null,
    external_id: envelope.external_id ?? null,
    type: e.type,
    service: envelope.service ?? null,
    connection_address: envelope.connection_address ?? null,
    conversation_address: envelope.conversation?.address ?? null,
    conversation_name: envelope.conversation?.name ?? null,
    conversation_thread: envelope.conversation?.thread ?? null,
    conversation_kind: envelope.conversation?.kind ?? null,
    session_id: e.agent?.session_id ?? null,
    sender_address: envelope.sender?.address ?? null,
    sender_name: envelope.sender?.name ?? null,
    agent_id: e.agent?.id ?? null,
    timestamp: utcOf(e.ts),
    text: textOf(e),
    parts: parts !== undefined ? JSON.stringify(parts) : null,
    payload: JSON.stringify(e.payload ?? {}),
    extra: e.extra !== undefined ? JSON.stringify(e.extra) : null,
    status: status ? JSON.stringify(status) : null,
  };
}

/** Rebuild the runtime Event from a row (nulls omitted). `envelope.status` mirrors
 *  `status.state` — one column, two views. */
export function eventOf(r: Row): Event {
  const payload = JSON.parse(r.payload) as Record<string, unknown>;
  const status = r.status ? JSON.parse(r.status) as Event["status"] : undefined;
  const state = status?.state;
  const envelope: Envelope = {
    service: r.service as Envelope["service"],
    connection_address: r.connection_address ?? "",
    conversation: {
      address: r.conversation_address ?? "",
      ...(r.conversation_name ? { name: r.conversation_name } : {}),
      ...(r.conversation_kind ? { kind: r.conversation_kind as Conversation["kind"] } : {}),
      ...(r.conversation_thread ? { thread: r.conversation_thread } : {}),
    },
    ...(r.sender_address
      ? { sender: { address: r.sender_address, ...(r.sender_name ? { name: r.sender_name } : {}) } }
      : {}),
    ...(r.external_id ? { external_id: r.external_id } : {}),
    ...(state ? { status: state } : {}),
  };
  return {
    id: r.id,
    ts: r.timestamp,
    type: r.type,
    envelope,
    ...(r.agent_id
      ? { agent: { id: r.agent_id, ...(r.session_id ? { session_id: r.session_id } : {}) } }
      : {}),
    ...(Object.keys(payload).length ? { payload } : {}),
    ...(r.parts ? { parts: JSON.parse(r.parts) } : {}),
    ...(r.extra ? { extra: JSON.parse(r.extra) as Record<string, unknown> } : {}),
    ...(status ? { status } : {}),
  } as Event;
}

/** What differs between the engines in a read's WHERE: the lifecycle stage, and the
 *  sidecar's flags. Everything else in a read is the same SQL on both. */
export interface Dialect {
  /** The row's lifecycle stage, as an expression over `status`. */
  state: string;
  /** `extra.<key>` is not set true. */
  unflagged(key: string): string;
  /** `extra.<key>` is absent (or null). */
  lacks(key: string): string;
}

/** The ReadQuery pushed into WHERE (privacy and filters at the source). Positional
 *  bindings are `?`; the law's are named. */
export function build(
  q: ReadQuery,
  dialect: Dialect,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const eq = (col: string, v: string | undefined) => {
    if (v !== undefined) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  };
  eq("service", q.service);
  eq("connection_address", q.connection);
  eq("conversation_address", q.conversation);
  eq("external_id", q.externalId);
  if (q.conversations && q.conversations.length > 0) {
    // the readable scope pushed into WHERE — private rows never leave the store (§6)
    where.push(`conversation_address IN (${q.conversations.map(() => "?").join(",")})`);
    params.push(...q.conversations);
  }
  eq("sender_address", q.from);
  if (q.senders && q.senders.length > 0) {
    where.push(`sender_address IN (${q.senders.map(() => "?").join(",")})`);
    params.push(...q.senders);
  }
  // a name column answers to the name rule (`store/names.ts`): every word of the query, in
  // any order, folded — `REVECO EDGARDO` reaches the row that says `Edgardo Reveco`. A
  // query with no word at all names nobody.
  const like = (column: string, value?: string) => {
    if (value === undefined) return;
    const words = nameWords(value);
    if (words.length === 0) {
      where.push("FALSE");
      return;
    }
    for (const w of words) {
      where.push(`${column} IS NOT NULL AND fold(${column}) LIKE '%' || ? || '%'`);
      params.push(w);
    }
  };
  like("conversation_name", q.conversationName);
  like("sender_name", q.senderName);
  // time bounds compare EVENT time (the `timestamp` column), not ids: the callers that
  // filter by time (search, §6) mean the world's clock, and an ISO string compared against
  // a uuid would silently match everything or nothing (a real bug this replaced)
  if (q.after !== undefined) (where.push("timestamp > ?"), params.push(utcOf(q.after)));
  if (q.before !== undefined) (where.push("timestamp < ?"), params.push(utcOf(q.before)));
  if (q.afterId !== undefined) (where.push("id > ?"), params.push(q.afterId));
  if (q.beforeId !== undefined) (where.push("id < ?"), params.push(q.beforeId));
  if (q.types && q.types.length > 0) {
    where.push(`type IN (${q.types.map(() => "?").join(",")})`);
    params.push(...q.types);
  }
  eq(dialect.state, q.state);
  if (q.text !== undefined) {
    where.push("text IS NOT NULL AND lower(text) LIKE '%' || lower(?) || '%'");
    params.push(q.text);
  }
  // in SQL, not in a `filter`: that field is the §6 scope's, and it runs in JS over every
  // materialized row — an import would be paged into memory only to be dropped
  if (q.silenced === false) {
    where.push(["backfill", "muted", "archived"].map(dialect.unflagged).join(" AND "));
  }
  if (q.broadcasts === false) {
    where.push("(conversation_kind IS NULL OR conversation_kind <> 'broadcast')");
  }
  if (q.broadcasts === true) where.push("conversation_kind = 'broadcast'");
  if (q.copies === false) where.push(dialect.lacks("via"));
  // the law (§6): named bindings, supplied by read() beside the positional ones
  if (q.law !== undefined) where.push(`(${q.law.sql})`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // append order = `id` (store-minted UUIDv7 — lexical order is mint order, §3).
  // limit ⇒ the most recent N: fetch DESC and reverse in read(); first ⇒ the earliest N,
  // fetched ASC as they stand; else natural append order.
  // a cap + a JS filter ⇒ NO SQL limit: read() cuts AFTER the predicate (RLS-before-LIMIT),
  // so the SQL can't know how deep the N visible rows reach. The law needs none of this:
  // it is in the WHERE, and the engine fills the window with visible rows itself.
  if (q.limit !== undefined && q.first !== undefined) {
    throw new Error("read: `limit` and `first` are exclusive");
  }
  const cap = q.limit ?? q.first;
  const order = q.first !== undefined ? "ASC" : "DESC";
  if (cap !== undefined) {
    if (q.filter !== undefined) {
      return { sql: `SELECT * FROM events ${clause} ORDER BY id ${order}`, params };
    }
    return {
      sql: `SELECT * FROM events ${clause} ORDER BY id ${order} LIMIT ?`,
      params: [...params, cap],
    };
  }
  return { sql: `SELECT * FROM events ${clause} ORDER BY id ASC`, params };
}

/** The search column (§6) — every part's words, part by part, one rule per part TYPE:
 *    text   its `text`
 *    file   the file's `name` (the wire's filename), then the caption in `text`
 *    data   the textual leaves of `data` (values kept, keys dropped), then its `text`
 *  Nothing is indexed twice: what a connector puts in `data` it does not repeat in `text`
 *  (a calendar event's description, a PR's body — prose is the part's `text`, structure is
 *  its `data`). Filtering on `type === "text"` once left every WhatsApp caption out — 5,419
 *  file rows, none of them findable.
 *
 *  MESSAGES only: the column exists for `search`, and search reads messages (xi passes
 *  `types: ["message"]`). A tool call's arguments and a thinking block's signature are
 *  machinery, not words anyone looks for — indexing them would only bloat the column. */
export function textOf(event: Draft): string | null {
  if (event.type !== "message") return null;
  const parts = (event as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const p of parts) {
    const part = p as {
      type?: unknown;
      text?: unknown;
      file?: { name?: unknown };
      data?: unknown;
    };
    if (part.type === "file" && typeof part.file?.name === "string") texts.push(part.file.name);
    if (part.type === "data") stringLeaves(part.data, texts);
    if (typeof part.text === "string" && part.text.length > 0) texts.push(part.text);
  }
  const t = texts.join(" ");
  return t.length ? t : null;
}

/** A json object's textual VALUES, keys dropped, nesting traversed — a pruned `data` is
 *  clean search terms (a title, a place, an invitee's name) by the time it reaches here. */
function stringLeaves(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    if (v.length) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) stringLeaves(x, out);
  } else if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) stringLeaves(x, out);
  }
}

/** A draft as its columns (`rowOf`). */
export type Columns = ReturnType<typeof rowOf>;

/** An agent's message bound for a wire is born an OFFER: `queued`, stamped now. The
 *  dispatcher that serves the connection takes it off the stream, or off the rows if it
 *  opens later — so no send waits on a process being there to see it land. `local` rows
 *  are the mind's own traffic and go on no wire. */
export function offerOf(
  r: Columns,
  now: string,
): { state: "queued"; queued_at: string } | undefined {
  return r.status === null && r.type === "message" && r.agent_id !== null &&
      r.external_id === null && r.service !== "local"
    ? { state: "queued", queued_at: now }
    : undefined;
}

/** The lease a `control` row cuts (§2): the turn RUNNING in its room. The publish that
 *  lands the row marks that lease in the same transaction — the heartbeat reads the mark —
 *  and cuts a holder in its own process once the row is committed. The turn's own closing
 *  row (`cancelled`) orders nothing. */
export function cutOf(r: Columns, event: Draft): string | undefined {
  return r.type === "control" && r.conversation_address !== null &&
      (event.payload as { control?: string } | undefined)?.control !== "cancelled"
    ? turnLockOf(r.conversation_address)
    : undefined;
}

/** The external id a row is stored under: the wire's, else — on a LOCAL event — its own
 *  id, so references live in ONE space (§3). Wire-service events keep NULL until their
 *  platform names them: absence IS the "never confirmed" signal the dispatcher's
 *  echo-dedup and the mirror's absorb guard read. */
export function externalOf(r: Columns, event: Draft, id: string): string | null {
  return r.external_id ?? (event.envelope.service === "local" ? id : null);
}

/** The caller's copy of what was stored: the draft, the id the row carries, and the offer
 *  it was born as. */
export function storedAs(
  event: Draft,
  id: string,
  offer: { state: "queued"; queued_at: string } | undefined,
): Event {
  return {
    ...event,
    id,
    ...(offer ? { status: offer, envelope: { ...event.envelope, status: offer.state } } : {}),
  } as Event;
}

/** The statements that file every mail row as a `group` at its thread's root Message-ID,
 *  named by its subject: each row's reply chain is walked up through the log
 *  (`ref_external_id`), and the furthest id it reaches — the last one the log holds, or the
 *  one it answers and the log never saw — is the root. `MAIL_MAILBOXES` runs after them.
 *  `ref` is the engine's expression for the payload's `ref_external_id`. */
export const MAIL_THREADS = (ref: string): string[] => [
  `CREATE TEMPORARY TABLE mail_roots AS
     WITH RECURSIVE up(id, at, ref, depth) AS (
       SELECT id, substr(external_id, 6), ${ref}, 0
         FROM events
        WHERE type = 'message' AND external_id LIKE 'mail:%'
       UNION ALL
       SELECT up.id, substr(up.ref, 6),
              (SELECT ${ref} FROM events WHERE external_id = up.ref), up.depth + 1
         FROM up
        WHERE up.ref LIKE 'mail:%' AND up.depth < 100
     )
     SELECT id, at AS root
       FROM up
      WHERE depth = (SELECT max(depth) FROM up u WHERE u.id = up.id)`,
  `UPDATE events
      SET conversation_address = (SELECT root FROM mail_roots r WHERE r.id = events.id),
          conversation_kind = 'group',
          conversation_name = conversation_thread,
          conversation_thread = NULL
    WHERE id IN (SELECT id FROM mail_roots)`,
  `DROP TABLE mail_roots`,
];

/** How an engine spells the JSON a mail migration reads and writes. */
export interface MailSql {
  /** The payload's `ref_external_id`, as text. */
  ref: string;
  /** The payload with its `ref_external_id` set to the text expression `value`. */
  setRef: (value: string) => string;
  /** The Gmail `threadId` a row's `extra.google.thread` kept, as text. */
  thread: string;
}

/** The statements that key the log's mail per mailbox and file it where the mailbox does: a
 *  message keyed `mail:<account>:<Message-ID>` (and every `ref_external_id` naming one
 *  likewise), a Gmail row filed at its `threadId` — a row that kept none, at the one its
 *  thread's other rows kept. An Outlook row kept no `conversationId` and stays at its root
 *  Message-ID. `MAIL_GROUPS` runs after them. */
export const MAIL_MAILBOXES = (sql: MailSql): string[] => [
  `UPDATE events
      SET external_id = 'mail:' || lower(connection_address) || ':' || substr(external_id, 6)
    WHERE external_id LIKE 'mail:%' AND connection_address IS NOT NULL
      AND external_id NOT LIKE 'mail:' || lower(connection_address) || ':%'`,
  `UPDATE events
      SET payload = ${
    sql.setRef(`'mail:' || lower(connection_address) || ':' || substr(${sql.ref}, 6)`)
  }
    WHERE ${sql.ref} LIKE 'mail:%' AND connection_address IS NOT NULL
      AND ${sql.ref} NOT LIKE 'mail:' || lower(connection_address) || ':%'`,
  `CREATE TEMPORARY TABLE gmail_threads AS
     SELECT connection_address AS conn, conversation_address AS old, min(${sql.thread}) AS thread
       FROM events
      WHERE service = 'google' AND ${sql.thread} IS NOT NULL
      GROUP BY connection_address, conversation_address`,
  `UPDATE events
      SET conversation_address = coalesce(${sql.thread},
            (SELECT thread FROM gmail_threads g
              WHERE g.conn = events.connection_address AND g.old = events.conversation_address))
    WHERE service = 'google' AND type = 'message'
      AND (${sql.thread} IS NOT NULL OR EXISTS (SELECT 1 FROM gmail_threads g
            WHERE g.conn = events.connection_address AND g.old = events.conversation_address))`,
  `DROP TABLE gmail_threads`,
];

/** The statements that stamp every mail thread `group` (§4), each row of it — an agent's
 *  send still unconfirmed, whose `external_id` is not yet a mail key, included. */
export const MAIL_GROUPS: string[] = [
  `CREATE TEMPORARY TABLE mail_threads AS
     SELECT DISTINCT connection_address AS conn, conversation_address AS address
       FROM events
      WHERE external_id LIKE 'mail:%'`,
  `UPDATE events
      SET conversation_kind = 'group'
    WHERE type = 'message' AND EXISTS (SELECT 1 FROM mail_threads t
            WHERE t.conn = events.connection_address AND t.address = events.conversation_address)`,
  `DROP TABLE mail_threads`,
];
