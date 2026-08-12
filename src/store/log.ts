/**
 * store/log.ts — the EventLog: the central, durable, ordered, pub/sub'd event store.
 *
 * Three operations over one append-only log:
 *   • publish   — write an event (the trigger; no separate publish/notify step)
 *   • read      — a point-in-time, filtered, bounded slice
 *   • subscribe — tail the log, receiving events as they're appended
 *
 * SQLite adapter (`node:sqlite` — in the runtime, survives `deno compile`). **Flattened
 * schema** (open-bsp lineage): every queried scalar is a column; the type-shaped remainder
 * is `payload` (JSON); `status` is the mutable delivery-lifecycle JSON. Wire addresses are
 * `*_address` columns — `id` stays internal-schema-only.
 *
 *   • publish   — an UPSERT keyed on `external_id` (partial UNIQUE): a NEW external id
 *                 INSERTs (and wakes the tail); a KNOWN one MERGES payload/status via
 *                 `json_patch` (open-bsp's before-update merge trigger, verbatim SQLite).
 *                 One mechanism = retry-dedup + echo-reconciliation + edits (§3, §4):
 *                 updates mint no new row, so they never wake — wake-on-insert only.
 *   • read      — an indexed SELECT; filters (and the readable scope, §6) are WHERE clauses,
 *                 so private rows never leave the store.
 *   • subscribe — dir-watch (WAL commits) + a poll backstop, cursored on `id`.
 *
 * **The store owns the id** (§3): `id uuid DEFAULT uuidv7()` is the Postgres shape, and this
 * adapter is the same shape — SQLite gets a bound `uuidv7()` function, the column defaults to
 * it, and `RETURNING id` hands back what was actually stored. Producers publish a `Draft` and
 * read the id off the result; an explicit id is still accepted (as in a Postgres INSERT that
 * names the column), but nobody has to mint one. Two things follow: ids are UUIDv7 by
 * construction, so `ORDER BY id` IS append order (no rowid, a SQLite-only crutch); and an
 * upsert that MERGES returns the surviving row's id instead of the caller's phantom.
 *
 * Ids are minted while the write lock is held, so mint order = commit order — except for two
 * processes writing in the SAME millisecond, where only the random tail separates them. That
 * sub-ms inversion is accepted: display order is `ts` (real-world event time), not id.
 */

import { DatabaseSync } from "node:sqlite";
import type { Conversation, DeliveryStatus, Draft, Envelope, Event, EventId } from "../types.ts";
import { newId } from "./id.ts";
import { createLocker, type Locker, LOCKS_DDL, RELEASE_SQL } from "./lock.ts";
import { AGENTS_DDL, createRegistry, type Registry } from "./agents.ts";
import { type Connections, CONNECTIONS_DDL, createConnections } from "./connections.ts";

/** A bounded, filtered read over the log. Fields AND-combine (the `search` half, §6). */
export interface ReadQuery {
  service?: string;
  connection?: string;
  conversation?: string; // conversation address
  conversations?: string[]; // restrict to this set (RLS-parity: a principal's readable scope, §6)
  from?: string; // sender address
  after?: string; // events after this TIMESTAMP (event time — Slack-search semantics, §6)
  before?: string; // events before this TIMESTAMP
  text?: string; // case-insensitive substring over text parts
  types?: Event["type"][]; // restrict to these event types
  /** `false` ⇒ drop imported history (`extra.backfill`). The TURN WINDOW passes it: those
   *  rows reach no prompt (render drops them), so reading them would spend the window's N
   *  slots on rows that are then thrown away — a window of pure history renders empty.
   *  Omitted ⇒ included, which is what `search` wants: history is the point of a search. */
  backfill?: boolean;
  limit?: number; // keep only the most recent N (still returned in append order)
  /** Row-level predicate applied BEFORE `limit` — RLS `USING` semantics: the window fills
   *  with N *visible* events, never N-minus-the-private-ones. `scoped()` (§6) pins it; on
   *  Postgres the engine does this and the field disappears. */
  filter?: Filter;
}

export type Listener = (event: Event) => void;
export type Filter = (event: Event) => boolean;

export interface SubscribeOptions {
  /** Deliver everything after the event with this id (at-least-once catch-up). Omit ⇒ live. */
  from?: EventId;
  /** Narrow the stream (e.g. a Slack connection ignores email). */
  filter?: Filter;
}

/** The mutable delivery lifecycle (open-bsp): timestamps per stage, merged on update (§3). */
export interface DeliveryPatch {
  external_id?: string; // backfilled by the dispatcher (echo-reconciliation key, §4)
  status?: Record<string, string | number>; // e.g. { dispatched_at: iso, error_code: 503 } — json-merged into `status`
}

/** Capability slices — a consumer can depend on exactly what it's allowed (RLS parity, §6). */
export interface Appender {
  /** PUBLISH. Durably append; the write itself is the trigger. Upsert on `external_id`:
   *  known id ⇒ merge (no wake) · new/absent ⇒ insert (wakes). Takes `Draft`s — the store
   *  mints event ids — and returns the STORED events, so callers read `.id` off the result.
   *  A batch is ONE transaction: all of it lands, or none. */
  publish(event: Draft): Promise<Event>;
  publish(events: Draft[]): Promise<Event[]>;
  /** PUBLISH, and DROP A LEASE, in one transaction (§2). This is how a turn ends: its last
   *  events and its turn-lease release become visible together, so the wake they fire can
   *  never find the lease still held — that bounced wake was a real stalled-cycle bug. */
  publishAndRelease(event: Draft, lock: string): Promise<Event>;
  publishAndRelease(events: Draft[], lock: string): Promise<Event[]>;
}
export interface Reader {
  /** QUERY. A point-in-time slice in append order. The escape hatch beyond a pushed event. */
  read(query?: ReadQuery): Promise<Event[]>;
}
export interface Subscriber {
  /** TAIL. Receive appended events, across processes. Returns unsubscribe. At-least-once. */
  subscribe(listener: Listener, opts?: SubscribeOptions): () => void;
}

/** One model call's spend, as the metered transport reports it (§2: a table, not the log —
 *  the tail ignores it, so recording usage never wakes anyone). */
export interface UsageRow {
  created_at: string;
  agent_id?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type Log = Appender & Reader & Subscriber & Locker & Registry & Connections & {
  /** Record one model call's spend. Fire-and-forget telemetry — never read on the hot path. */
  meter(row: UsageRow): void;
  /** Delivery bookkeeping on an already-published event: backfill `external_id`, merge
   *  `status` stages. An UPDATE — no new row, so it never wakes the tail (§3, §4). */
  setDelivery(id: EventId, patch: DeliveryPatch): Promise<void>;
  close(): Promise<void>;
};

const DB_FILE = "log.db";
const POLL_MS = 300; // backstop period — fs-watch can drop events under load

/** Open (or create) a SQLite-backed, multi-process Log rooted at `dir`. */
export async function openLog(dir: string): Promise<Log> {
  await Deno.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(`${dir}/${DB_FILE}`);
  // the store's id authority: Postgres writes `DEFAULT uuidv7()`, SQLite needs the function
  // bound first — same DDL, same guarantee (evaluated at INSERT, under the write lock).
  db.function("uuidv7", () => newId());
  db.exec(
    `PRAGMA journal_mode=WAL;
     PRAGMA busy_timeout=5000;
     PRAGMA synchronous=NORMAL;
     CREATE TABLE IF NOT EXISTS events (
       id     TEXT PRIMARY KEY DEFAULT (uuidv7()),  -- uuidv7: identity AND append order
       external_id          TEXT,              -- platform id; the upsert/merge key (mutable)
       type                 TEXT NOT NULL,
       service              TEXT,
       connection_address     TEXT,
       conversation_address TEXT,
       conversation_name    TEXT,
       conversation_thread  TEXT,
       conversation_kind    TEXT,              -- direct | group | channel (ingest-stamped, §3)
       session_id           TEXT,              -- harness session (agent authorship)
       sender_address       TEXT,
       sender_name          TEXT,
       agent_id             TEXT,              -- null = the world wrote it
       timestamp            TEXT NOT NULL,     -- event time (platform inbound / append internal)
       created_at           TEXT NOT NULL,
       updated_at           TEXT NOT NULL,
       text                 TEXT,              -- derived from payload parts — the search column
       payload              TEXT NOT NULL,     -- type-shaped JSON (parts, re, cause, meta…)
       extra                TEXT,              -- wire-derived sidecar JSON, json_patch-merged (§3)
       status               TEXT               -- delivery lifecycle JSON, json_patch-merged
     );
     CREATE UNIQUE INDEX IF NOT EXISTS events_external
       ON events(external_id) WHERE external_id IS NOT NULL;
     CREATE INDEX IF NOT EXISTS events_conv ON events(conversation_address);
     CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
     CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id);
     CREATE TABLE IF NOT EXISTS usage (   -- telemetry, NOT events (§2): append-only spend
       created_at         TEXT NOT NULL,
       agent_id           TEXT,
       model              TEXT NOT NULL,
       input_tokens       INTEGER NOT NULL,
       output_tokens      INTEGER NOT NULL,
       cache_read_tokens  INTEGER,
       cache_write_tokens INTEGER
     );
     ${LOCKS_DDL}
     ${AGENTS_DDL}
     ${CONNECTIONS_DDL}`,
  );
  const connections = createConnections(db); // the gate below reads its table

  const upsert = db.prepare(
    `INSERT INTO events (id, external_id, type, service, connection_address,
       conversation_address, conversation_name, conversation_thread, conversation_kind, session_id,
       sender_address, sender_name, agent_id, timestamp, created_at, updated_at,
       text, payload, extra, status)
     VALUES (coalesce(?, uuidv7()), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       payload    = json_patch(events.payload, excluded.payload),
       extra      = CASE WHEN excluded.extra IS NULL THEN events.extra
                         ELSE json_patch(coalesce(events.extra, '{}'), excluded.extra) END,
       status     = CASE WHEN excluded.status IS NULL THEN events.status
                         ELSE json_patch(coalesce(events.status, '{}'), excluded.status) END,
       text       = coalesce(excluded.text, events.text),
       updated_at = excluded.updated_at
     RETURNING id`, // the STORED id: minted here, or the surviving row's on a merge
  );
  // the frontier gate (§4): only a REGISTERED (and live) connection may log — an event on
  // an unknown or soft-deleted account is refused before anything lands. `local` is the
  // substrate's own service (minds, DMs), not a connected account: exempt.
  const registered = db.prepare(
    "SELECT 1 AS x FROM connections WHERE service = ? AND address = ? AND deleted_at IS NULL",
  );
  const mark = db.prepare(
    `UPDATE events SET
       external_id = coalesce(?, external_id),
       status      = CASE WHEN ?2 IS NULL THEN status
                          ELSE json_patch(coalesce(status, '{}'), ?2) END,
       updated_at  = ?3
     WHERE id = ?4`,
  );
  const byExternal = db.prepare("SELECT id FROM events WHERE external_id = ?");
  const absorb = db.prepare(
    `UPDATE events SET
       payload    = json_patch(payload, (SELECT payload FROM events WHERE id = ?1)),
       status     = CASE WHEN (SELECT status FROM events WHERE id = ?1) IS NULL THEN status
                         ELSE json_patch(coalesce(status, '{}'),
                                         (SELECT status FROM events WHERE id = ?1)) END,
       updated_at = ?2
     WHERE id = ?3`,
  );
  const drop = db.prepare("DELETE FROM events WHERE id = ?");
  const unlock = db.prepare(RELEASE_SQL);

  /** One upsert. Returns the STORED id (minted here, or the surviving row's on a merge). */
  const write = (event: Draft, now: string): Event => {
    const r = rowOf(event);
    const stored = upsert.get(
      r.id,
      r.external_id,
      r.type,
      r.service,
      r.connection_address,
      r.conversation_address,
      r.conversation_name,
      r.conversation_thread,
      r.conversation_kind,
      r.session_id,
      r.sender_address,
      r.sender_name,
      r.agent_id,
      r.timestamp,
      now,
      now,
      r.text,
      r.payload,
      r.extra,
      r.status,
    ) as { id: string };
    return { ...event, id: stored.id } as Event;
  };

  /** Both writers, in one transaction: the batch (all or none) and, optionally, the lease
   *  release that ends a turn. Singles in ⇒ single out; a batch in ⇒ a batch out. */
  const commit = (one: Draft | Draft[], lock?: string): Promise<Event | Event[]> => {
    const drafts = Array.isArray(one) ? one : [one];
    for (const d of drafts) {
      const { service, connection_address: address } = d.envelope;
      if (service !== "local" && registered.get(service, address) === undefined) {
        throw new Error(`connection not registered: ${service}:${address}`);
      }
    }
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = drafts.map((e) => write(e, now));
      if (lock !== undefined) unlock.run(lock);
      db.exec("COMMIT");
      return Promise.resolve(Array.isArray(one) ? stored : stored[0]);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  const spend = db.prepare(
    `INSERT INTO usage (created_at, agent_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    meter(row: UsageRow): void {
      spend.run(
        row.created_at,
        row.agent_id ?? null,
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens ?? null,
        row.cache_write_tokens ?? null,
      );
    },

    ...createLocker(db), // the turn lease lives HERE — same DB, so one transaction holds both
    //                      a turn's last writes and its release (`publishAndRelease`, §2)
    ...createRegistry(db), // the agent registry (§9): folders declare, this table mirrors
    ...connections, // connections + memberships (§4, §6): what policy reads, live

    async publish(one: Draft | Draft[]): Promise<Event & Event[]> {
      return await (commit(one) as Promise<Event & Event[]>);
    },

    async publishAndRelease(one: Draft | Draft[], lock: string): Promise<Event & Event[]> {
      return await (commit(one, lock) as Promise<Event & Event[]>);
    },

    read(query: ReadQuery = {}): Promise<Event[]> {
      const { sql, params } = build(query);
      const rows = db.prepare(sql).all(...params) as unknown as Row[];
      if (query.filter === undefined) {
        if (query.limit !== undefined) rows.reverse(); // built as DESC LIMIT — restore order
        return Promise.resolve(rows.map(eventOf));
      }
      // the predicate applies BEFORE the limit (RLS `USING` runs before `LIMIT`): walk the
      // newest rows backward, fill the window with VISIBLE events, then restore append
      // order. Parsing stops as soon as the window is full; Postgres does all of this
      // inside the engine.
      const out: Event[] = [];
      for (const r of rows) {
        const e = eventOf(r);
        if (!query.filter(e)) continue;
        out.push(e);
        if (query.limit !== undefined && out.length >= query.limit) break;
      }
      return Promise.resolve(query.limit !== undefined ? out.reverse() : out);
    },

    subscribe(listener: Listener, opts: SubscribeOptions = {}): () => void {
      return tail(dir, db, listener, opts);
    },

    setDelivery(id: EventId, patch: DeliveryPatch): Promise<void> {
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (patch.external_id) {
          // the echo race: the platform's webhook can deliver our own artifact BEFORE this
          // backfill runs — the upsert then INSERTed it as a new row (and woke the tail).
          // Reconcile: absorb that row's payload/status into ours and drop it — the log
          // converges to ONE row per artifact, and the already-fired wake finds a quiescent
          // window on its fresh re-read (the verdict re-reads; nothing owed → exit) (§2, §4).
          const clash = byExternal.get(patch.external_id) as { id: string } | undefined;
          if (clash && clash.id !== id) {
            absorb.run(clash.id, now, id);
            drop.run(clash.id);
          }
        }
        mark.run(
          patch.external_id ?? null,
          patch.status ? JSON.stringify(patch.status) : null,
          now,
          id,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return Promise.resolve();
    },

    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
}

/* ── decompose / reassemble (the runtime Event ⟷ the flat row) ─────────── */

interface Row {
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
  text: string | null;
  payload: string;
  extra: string | null;
  status: string | null;
}

/** Flatten a draft into columns + the type-shaped payload remainder. `id` is null unless the
 *  caller named one — the INSERT coalesces null to the column's `uuidv7()` default. */
function rowOf(e: Draft) {
  // everything not a column travels in payload: parts, re, cause, meta…
  const { id: _i, ts: _t, type: _y, envelope, agent, extra, ...payload } = e as
    & Draft
    & Record<string, unknown>;
  const status = envelope.status ? { state: envelope.status } : null;
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
    session_id: agent?.session_id ?? null,
    sender_address: envelope.sender?.address ?? null,
    sender_name: envelope.sender?.name ?? null,
    agent_id: agent?.id ?? null,
    timestamp: e.ts,
    text: textOf(e),
    payload: JSON.stringify(payload),
    extra: extra !== undefined ? JSON.stringify(extra) : null,
    status: status ? JSON.stringify(status) : null,
  };
}

/** Rebuild the runtime Event from a row (nulls omitted, payload spread back to the top). */
function eventOf(r: Row): Event {
  const payload = JSON.parse(r.payload) as Record<string, unknown>;
  const state = r.status ? (JSON.parse(r.status) as { state?: DeliveryStatus }).state : undefined;
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
    ...(r.agent_id ? { agent: { id: r.agent_id, session_id: r.session_id ?? "" } } : {}),
    ...(r.extra ? { extra: JSON.parse(r.extra) as Record<string, unknown> } : {}),
    ...payload,
  } as Event;
}

/* ── tail: watch the dir (WAL commits) + poll backstop, cursored on `id` ──
 *
 * The cursor is the id itself: every row's id is a store-minted UUIDv7, so lexical order is
 * mint order, and mint happens under the write lock — no rowid needed (it was a SQLite-only
 * crutch for when producers minted their own, possibly v4, ids). `from` needs no lookup: an
 * id IS a position, even one this log never stored. */

function tail(
  dir: string,
  db: DatabaseSync,
  listener: Listener,
  opts: SubscribeOptions,
): () => void {
  let closed = false;
  let watcher: Deno.FsWatcher | undefined;
  let poll: number | undefined;
  let chain: Promise<void> = Promise.resolve();

  const maxId = db.prepare("SELECT MAX(id) AS m FROM events");
  const after = db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC");

  // Seed SYNCHRONOUSLY, here — not in the first pump. `subscribe()` returning is the
  // subscriber's guarantee: everything appended after it is delivered. A lazy seed would
  // read MAX(id) after the first publishes had landed and skip them as backlog.
  // live: skip what's already there · from: resume just after that id ("" ⇒ replay all).
  let cursor = opts.from ?? ((maxId.get() as { m: string | null }).m ?? "");

  const pump = (): Promise<void> => (chain = chain.then(() => {
    if (closed) return;
    const rows = after.all(cursor) as unknown as Row[];
    for (const r of rows) {
      cursor = r.id;
      const e = eventOf(r);
      if (!opts.filter || opts.filter(e)) listener(e);
    }
  }));

  (async () => {
    watcher = Deno.watchFs(dir);
    if (closed) {
      watcher.close();
      return;
    }
    await pump(); // deliver whatever is already past the cursor (a `from` backlog)
    for await (const _ of watcher) {
      if (closed) break;
      await pump();
    }
  })().catch(() => {
    // watcher torn down / io error — a consumer reconciles via the durable log.
  });

  // backstop: fs-watch can miss events under load; a slow poll guarantees eventual delivery
  const loop = () => {
    if (closed) return;
    pump().finally(() => {
      if (!closed) poll = setTimeout(loop, POLL_MS);
    });
  };
  poll = setTimeout(loop, POLL_MS);

  return () => {
    closed = true;
    watcher?.close();
    if (poll !== undefined) clearTimeout(poll);
  };
}

/* ── query builder: the ReadQuery pushed into WHERE (privacy/filter at source) ─────────── */

function build(q: ReadQuery): { sql: string; params: (string | number)[] } {
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
  if (q.conversations && q.conversations.length > 0) {
    // the readable scope pushed into WHERE — private rows never leave the store (§6)
    where.push(`conversation_address IN (${q.conversations.map(() => "?").join(",")})`);
    params.push(...q.conversations);
  }
  eq("sender_address", q.from);
  // time bounds compare EVENT time (the `timestamp` column), not ids: the callers that
  // filter by time (search, §6) mean the world's clock, and an ISO string compared against
  // a uuid would silently match everything or nothing (a real bug this replaced)
  if (q.after !== undefined) (where.push("timestamp > ?"), params.push(q.after));
  if (q.before !== undefined) (where.push("timestamp < ?"), params.push(q.before));
  if (q.types && q.types.length > 0) {
    where.push(`type IN (${q.types.map(() => "?").join(",")})`);
    params.push(...q.types);
  }
  if (q.text !== undefined) {
    where.push("text IS NOT NULL AND lower(text) LIKE '%' || lower(?) || '%'");
    params.push(q.text);
  }
  // in SQL, not in a `filter`: that field is the §6 scope's, and it runs in JS over every
  // materialized row — an import would be paged into memory only to be dropped
  if (q.backfill === false) where.push("json_extract(extra, '$.backfill') IS NOT 1");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // append order = `id` (store-minted UUIDv7 — lexical order is mint order, §3).
  // limit ⇒ the most recent N: fetch DESC and reverse in read(); else natural append order.
  // limit + filter ⇒ DESC with NO SQL limit: read() cuts AFTER the predicate (RLS-before-
  // LIMIT), so the SQL can't know how deep the N visible rows reach.
  if (q.limit !== undefined) {
    if (q.filter !== undefined) {
      return { sql: `SELECT * FROM events ${clause} ORDER BY id DESC`, params };
    }
    return {
      sql: `SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`,
      params: [...params, q.limit],
    };
  }
  return { sql: `SELECT * FROM events ${clause} ORDER BY id ASC`, params };
}

/** Concatenated text parts (the search column); null for events with no text. */
function textOf(event: Draft): string | null {
  const parts = (event as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const t = parts
    .filter((p) => (p as { type?: unknown }).type === "text")
    .map((p) => (p as { text?: unknown }).text)
    .filter((x): x is string => typeof x === "string")
    .join(" ");
  return t.length ? t : null;
}
