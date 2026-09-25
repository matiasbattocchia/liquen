/**
 * store/pg/log.ts — the Log on Postgres (§3, §9): the SQLite adapter's contract, kept by
 * the server's own means.
 *
 *   • publish   — the same upsert on `external_id`, in one transaction per batch. Writers
 *                 take turns on an advisory lock (`serial`) and mint each id inside it, so
 *                 mint order is commit order and `ORDER BY id` is append order — what
 *                 SQLite's write lock gives. The lease a turn ends under is read `FOR
 *                 UPDATE`, so a steal waits for the turn's last writes and finds the lease
 *                 gone.
 *   • read      — the shared builder over this dialect; a JS `filter` walks a server-side
 *                 cursor and stops when the window is full.
 *   • subscribe — `LISTEN` on the `events` trigger's channel, with the poll behind it. The
 *                 cursor is seeded by a query, so every write this process makes waits for
 *                 the seeds in flight: a publish issued after `subscribe()` returns lands
 *                 after the seed, and is delivered.
 */

import type {
  DeliveryPatch,
  Law,
  Listener,
  Log,
  PublishOptions,
  SubscribeOptions,
  UsageRow,
} from "../log.ts";
import { createLocker, type Lease, LeaseLost } from "../lock.ts";
import {
  build,
  cutOf,
  type Dialect,
  eventOf,
  externalOf,
  offerOf,
  type Row,
  rowOf,
  storedAs,
  utcOf,
} from "../events.ts";
import { newId } from "../id.ts";
import type { Draft, Envelope, Event, EventId } from "../../types.ts";
import { compile, connect, count, type Db, rows, type Sql } from "./sql.ts";
import { LOG_DDL, prepare } from "./schema.ts";
import {
  pgConnections,
  pgGates,
  pgLeases,
  pgRegistry,
  pgStanding,
  pgSweeper,
  pgTimers,
  RELEASE,
} from "./tables.ts";

/** The read's engine-specific expressions, as `jsonb` writes them. */
const PG: Dialect = {
  state: "status ->> 'state'",
  unflagged: (key) => `NOT flag(extra, '${key}')`,
  lacks: (key) => `coalesce(jsonb_typeof(extra -> '${key}'), 'null') = 'null'`,
};

const POLL_MS = 300; // the backstop: a notification can be missed across a reconnect
const CURSOR_ROWS = 64; // a filtered read's batch: the walk stops within one of the cap

const UPSERT = `
INSERT INTO events (id, external_id, type, service, connection_address,
  conversation_address, conversation_name, conversation_thread, conversation_kind, session_id,
  sender_address, sender_name, agent_id, timestamp, created_at, updated_at,
  text, parts, payload, extra, status)
VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
  $9::text, $10::text, $11::text, $12::text, $13::text, $14::text, $15::text, $15::text,
  $16::text, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb)
ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
  parts      = CASE WHEN flag(excluded.extra, 'backfill')
                    THEN coalesce(events.parts, excluded.parts)
                    ELSE coalesce(excluded.parts, events.parts) END,
  payload    = json_patch(events.payload, excluded.payload),
  extra      = CASE WHEN excluded.extra IS NULL THEN events.extra
                    WHEN flag(excluded.extra, 'backfill') THEN events.extra
                    ELSE json_patch(coalesce(events.extra, '{}'), excluded.extra) END,
  status     = CASE WHEN excluded.status IS NULL THEN events.status
                    ELSE json_patch(coalesce(events.status, '{}'), excluded.status) END,
  text       = CASE WHEN flag(excluded.extra, 'backfill')
                    THEN coalesce(events.text, excluded.text)
                    ELSE coalesce(excluded.text, events.text) END,
  sender_address = CASE WHEN coalesce(events.sender_address, '') = ''
                        THEN excluded.sender_address ELSE events.sender_address END,
  sender_name    = CASE WHEN coalesce(events.sender_name, '') = ''
                        THEN excluded.sender_name ELSE events.sender_name END,
  conversation_address = CASE WHEN coalesce(events.conversation_address, '') = ''
                        THEN excluded.conversation_address ELSE events.conversation_address END,
  conversation_name    = CASE WHEN coalesce(events.conversation_name, '') = ''
                        THEN excluded.conversation_name ELSE events.conversation_name END,
  conversation_thread  = CASE WHEN coalesce(events.conversation_thread, '') = ''
                        THEN excluded.conversation_thread ELSE events.conversation_thread END,
  conversation_kind    = CASE WHEN coalesce(events.conversation_kind, '') = ''
                        THEN excluded.conversation_kind ELSE events.conversation_kind END,
  agent_id   = coalesce(events.agent_id, excluded.agent_id),
  session_id = coalesce(events.session_id, excluded.session_id),
  updated_at = excluded.updated_at
RETURNING id`;

/** The merge-only path (§3): a partless draft patches the row its external id names, and
 *  stores nothing when there is none. */
const PATCH = `
UPDATE events SET
  payload    = json_patch(payload, $1::jsonb),
  extra      = CASE WHEN $2::jsonb IS NULL THEN extra
                    ELSE json_patch(coalesce(extra, '{}'), $2::jsonb) END,
  status     = CASE WHEN $3::jsonb IS NULL THEN status
                    ELSE json_patch(coalesce(status, '{}'), $3::jsonb) END,
  updated_at = $4::text
WHERE external_id = $5::text
RETURNING id`;

const MARK = `
UPDATE events SET
  external_id    = coalesce($1::text, external_id),
  status         = CASE WHEN $2::jsonb IS NULL THEN status
                        ELSE json_patch(coalesce(status, '{}'), $2::jsonb) END,
  sender_address = CASE WHEN coalesce(sender_address, '') = ''
                        THEN coalesce($5::text, sender_address) ELSE sender_address END,
  sender_name    = CASE WHEN coalesce(sender_name, '') = ''
                        THEN coalesce($6::text, sender_name) ELSE sender_name END,
  updated_at     = $3::text
WHERE id = $4::text`;

const ABSORB = `
UPDATE events SET
  parts      = coalesce((SELECT e.parts FROM events e WHERE e.id = $1::text), parts),
  payload    = json_patch(payload, (SELECT e.payload FROM events e WHERE e.id = $1::text)),
  status     = CASE WHEN (SELECT e.status FROM events e WHERE e.id = $1::text) IS NULL
                    THEN status
                    ELSE json_patch(coalesce(status, '{}'),
                                    (SELECT e.status FROM events e WHERE e.id = $1::text)) END,
  updated_at = $2::text
WHERE id = $3::text`;

/** Open a Log on the Postgres database at `url`, in `schema` (created when absent). `now`
 *  is the clock the lease reads (§9). */
export async function openPgLog(
  url: string,
  opts: { schema?: string; now?: () => number } = {},
): Promise<Log> {
  const schema = opts.schema ?? "public";
  const sql = connect(url, schema);
  try {
    await prepare(sql, schema, LOG_DDL);
  } catch (err) {
    await sql.end();
    throw err;
  }
  const channel = `${schema}.events`;
  // the subscriptions still reading their cursor: this process's writes wait for them
  const seeding = new Set<Promise<unknown>>();
  const serial = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    await Promise.allSettled([...seeding]);
    return await sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1::text))", [
        `liquen:${schema}:events`,
      ]);
      return await fn(tx);
    }) as T;
  };

  const admits = async (db: Db, law: Law, e: { ts?: string; envelope: Envelope }) => {
    const { service, connection_address, conversation } = e.envelope;
    const c = compile(
      `SELECT (${law.sql}) AS ok FROM (SELECT $e_service::text AS service,
         $e_connection::text AS connection_address, $e_conversation::text AS conversation_address,
         $e_ts::text AS timestamp) AS events`,
      [],
      {
        ...law.params,
        e_service: service,
        e_connection: connection_address,
        e_conversation: conversation.address,
        e_ts: e.ts === undefined ? null : utcOf(e.ts),
      },
    );
    const [r] = await rows<{ ok: boolean | null }>(db, c.text, c.params);
    return r?.ok === true;
  };

  const locker = createLocker(
    pgLeases(sql),
    opts.now,
    (ring) =>
      tail(sql, channel, seeding, ring, { law: { sql: "events.type = 'control'", params: {} } }),
  );

  const write = async (
    tx: Db,
    event: Draft,
    now: string,
    cuts: string[],
  ): Promise<Event | null> => {
    const r = rowOf(event);
    const offer = offerOf(r, now);
    if (offer) r.status = JSON.stringify(offer);
    if (r.parts === null && r.external_id !== null) {
      const [hit] = await rows<{ id: string }>(tx, PATCH, [
        r.payload,
        r.extra,
        r.status,
        now,
        r.external_id,
      ]);
      return hit ? { ...event, id: hit.id } as Event : null;
    }
    const cut = cutOf(r, event);
    if (cut !== undefined) {
      await count(tx, "UPDATE locks SET cancel = 1 WHERE name = $1::text", [cut]);
      cuts.push(cut);
    }
    const id = r.id ?? newId();
    const [stored] = await rows<{ id: string }>(tx, UPSERT, [
      id,
      externalOf(r, event, id),
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
      r.text,
      r.parts,
      r.payload,
      r.extra,
      r.status,
    ]);
    return storedAs(event, stored.id, offer);
  };

  const commit = async (
    one: Draft | Draft[],
    lease?: Lease,
    opts: PublishOptions = {},
  ): Promise<Event | Event[] | null> => {
    const drafts = Array.isArray(one) ? one : [one];
    for (const d of drafts) {
      const { service, connection_address: address } = d.envelope;
      if (
        service !== "local" &&
        (await rows(
            sql,
            `SELECT 1 FROM connections
           WHERE service = $1::text AND address = $2::text AND deleted_at IS NULL`,
            [service, address],
          )).length === 0
      ) {
        throw new Error(`connection not registered: ${service}:${address}`);
      }
    }
    const cuts: string[] = [];
    const stored = await serial(async (tx) => {
      const now = new Date().toISOString();
      if (
        lease !== undefined &&
        (await rows(
            tx,
            "SELECT 1 FROM locks WHERE name = $1::text AND born = $2::bigint FOR UPDATE",
            [lease.name, lease.born],
          )).length === 0
      ) {
        throw new LeaseLost(lease);
      }
      if (opts.check !== undefined) {
        for (const d of drafts) {
          if (!(await admits(tx, opts.check, d))) {
            throw new Error(`policy: draft not writable (type=${d.type})`);
          }
        }
      }
      const out: Event[] = [];
      for (const d of drafts) {
        const e = await write(tx, d, now, cuts);
        if (e !== null) out.push(e);
      }
      if (lease !== undefined) await count(tx, RELEASE, [lease.name, lease.born]);
      return out;
    });
    for (const name of cuts) locker.cancel(name);
    return Array.isArray(one) ? stored : stored[0] ?? null;
  };

  return {
    async meter(row: UsageRow): Promise<void> {
      await count(
        sql,
        `INSERT INTO usage (created_at, agent_id, turn_id, kind, model, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::integer,
           $8::integer, $9::integer)`,
        [
          row.created_at,
          row.agent_id ?? null,
          row.turn_id ?? null,
          row.kind ?? null,
          row.model,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens ?? null,
          row.cache_write_tokens ?? null,
        ],
      );
    },

    lock: locker.lock,
    ...pgRegistry(sql),
    ...pgTimers(sql),
    ...pgGates(sql, eventOf as (row: unknown) => Event),
    ...pgSweeper(serial),
    ...pgStanding(sql),
    ...pgConnections(sql),
    async principalsOf(agentId) {
      return (await rows<{ principal: string }>(
        sql,
        "SELECT principal FROM principals WHERE agent_id = $1::text ORDER BY rank, principal",
        [agentId],
      )).map((r) => r.principal);
    },

    async publish(one: Draft | Draft[], opts?: PublishOptions): Promise<Event & Event[]> {
      return await (commit(one, undefined, opts) as Promise<Event & Event[]>);
    },

    async publishAndRelease(
      one: Draft | Draft[],
      lease: Lease,
      opts?: PublishOptions,
    ): Promise<Event & Event[]> {
      return await (commit(one, lease, opts) as Promise<Event & Event[]>);
    },

    admits(law: Law, e: { ts?: string; envelope: Envelope }): Promise<boolean> {
      return admits(sql, law, e);
    },

    async read(query = {}): Promise<Event[]> {
      const built = build(query, PG);
      const c = compile(built.sql, built.params, query.law?.params ?? {});
      if (query.filter === undefined) {
        const found = await rows<Row>(sql, c.text, c.params);
        if (query.limit !== undefined) found.reverse(); // built as DESC LIMIT
        return found.map(eventOf);
      }
      // the predicate applies BEFORE the limit (RLS `USING` runs before `LIMIT`): walk the
      // cursor, fill the window with visible events, stop the moment it is full
      const out: Event[] = [];
      const cap = query.limit ?? query.first;
      walk: for await (const batch of sql.unsafe(c.text, c.params as never[]).cursor(CURSOR_ROWS)) {
        for (const r of batch) {
          const e = eventOf(r as unknown as Row);
          if (!query.filter(e)) continue;
          out.push(e);
          if (cap !== undefined && out.length >= cap) break walk;
        }
      }
      return query.limit !== undefined ? out.reverse() : out;
    },

    subscribe(listener: Listener, opts: SubscribeOptions = {}): () => void {
      return tail(sql, channel, seeding, listener, opts);
    },

    setDelivery(id: EventId, patch: DeliveryPatch): Promise<void> {
      return serial(async (tx) => {
        const now = new Date().toISOString();
        if (patch.external_id) {
          // the echo race (§2, §4): the platform's webhook delivered our own artifact
          // before this backfill, as a row of its own — absorb it into ours and drop it
          const [clash] = await rows<{ id: string }>(
            tx,
            "SELECT id FROM events WHERE external_id = $1::text",
            [patch.external_id],
          );
          if (clash && clash.id !== id) {
            await count(tx, ABSORB, [clash.id, now, id]);
            await count(tx, "DELETE FROM events WHERE id = $1::text", [clash.id]);
          }
        }
        await count(tx, MARK, [
          patch.external_id ?? null,
          patch.status ? JSON.stringify(patch.status) : null,
          now,
          id,
          patch.sender?.address ?? null,
          patch.sender?.name ?? null,
        ]);
      });
    },

    async close(): Promise<void> {
      locker.stop(); // no holder is left to speak for once the store is gone
      await sql.end({ timeout: 5 });
    },
  } as Log;
}

/** The tail: `LISTEN` on the change feed, a poll behind it, cursored on `id` for appends
 *  and on `(updated_at, id)` for moves — the SQLite tail's cursors, read by query. */
function tail(
  sql: Sql,
  channel: string,
  seeding: Set<Promise<unknown>>,
  listener: Listener,
  opts: SubscribeOptions,
): () => void {
  let closed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  let cursor: string | undefined;
  let moved: [string, string] = ["", ""];

  // the law (§6) in the scan itself: a row the subscriber may not see never leaves the engine
  const law = opts.law ? ` AND (${opts.law.sql})` : "";
  const named = opts.law?.params ?? {};
  const after = `SELECT * FROM events WHERE id > $cursor${law} ORDER BY id ASC`;
  const movedAfter = `SELECT * FROM events WHERE updated_at > created_at
       AND (updated_at > $at OR (updated_at = $at AND id > $cursor))${law}
     ORDER BY updated_at ASC, id ASC`;

  const deliver = (r: Row) => {
    const e = eventOf(r);
    if (!opts.filter || opts.filter(e)) listener(e);
  };

  // the ring before the cursor, so nothing lands unheard between the two. A failed listen
  // leaves the poll to carry the stream; a failed seed is retried by the next pump.
  const seed = async () => {
    if (unlisten === undefined) {
      try {
        unlisten = (await sql.listen(channel, () => void pump())).unlisten;
      } catch {
        // the poll carries it
      }
    }
    const start = opts.from ??
      (await rows<{ m: string | null }>(sql, "SELECT max(id) AS m FROM events"))[0]?.m ?? "";
    if (opts.updates) {
      // updates start live whatever `from` says: an offer made before this subscriber
      // existed stands in the row's state, and the subscriber reads it there
      const [last] = await rows<{ updated_at: string; id: string }>(
        sql,
        `SELECT updated_at, id FROM events WHERE updated_at > created_at
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      );
      if (last) moved = [last.updated_at, last.id];
    }
    cursor = start;
  };
  const seeded = seed();
  seeding.add(seeded);
  const settle = () => seeding.delete(seeded);
  seeded.then(settle, settle);

  let chain: Promise<void> = seeded.catch(() => {});
  const pump = (): Promise<void> => (chain = chain.then(async () => {
    if (closed) return;
    if (cursor === undefined) await seed();
    for (const r of await scan(after, { ...named, cursor })) {
      if (closed) return;
      cursor = r.id;
      deliver(r);
    }
    if (!opts.updates) return;
    for (const r of await scan(movedAfter, { ...named, at: moved[0], cursor: moved[1] })) {
      if (closed) return;
      moved = [r.updated_at, r.id];
      deliver(r);
    }
  }).catch(() => {
    // the store is closing or unreachable — the next ring or poll tries again
  }));
  const scan = (text: string, bound: Record<string, unknown>) => {
    const c = compile(text, [], bound);
    return rows<Row>(sql, c.text, c.params);
  };

  void pump(); // whatever is already past the cursor (a `from` backlog)
  const loop = () => {
    if (closed) return;
    const next = () => {
      if (!closed) poll = setTimeout(loop, POLL_MS);
    };
    pump().then(next, next);
  };
  poll = setTimeout(loop, POLL_MS);

  return () => {
    closed = true;
    if (poll !== undefined) clearTimeout(poll);
    void seeded.catch(() => {}).then(() => unlisten?.()).catch(() => {});
  };
}
