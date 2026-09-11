/**
 * store/log.ts — the EventLog: the central, durable, ordered, pub/sub'd event store.
 *
 * Three operations over one append-only log:
 *   • publish   — write an event (the trigger; no separate publish/notify step)
 *   • read      — a point-in-time, filtered, bounded slice
 *   • subscribe — tail the log, receiving events as they're appended — and, for a
 *                 subscriber that asks, as their lifecycle moves
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
 *                 updates mint no new row, so they never wake a mind — wake-on-insert only.
 *                 A BACKFILL (`extra.backfill`, an import of history) is the one merge that
 *                 fills instead of overwriting: a re-pair re-sends what was already
 *                 received live, and the live row is the richer one.
 *   • read      — an indexed SELECT; filters (and the readable scope, §6) are WHERE clauses,
 *                 so private rows never leave the store.
 *   • subscribe — dir-watch (WAL commits) + a poll backstop. Two cursors: appends on `id`,
 *                 and — only for a subscriber that asked (`updates`) — lifecycle moves on
 *                 `(updated_at, id)`, which is how a dispatcher receives the sweeper's
 *                 re-offer of a failed send.
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
import type {
  CallKind,
  Conversation,
  DeliveryStatus,
  Draft,
  Envelope,
  Event,
  EventId,
} from "../types.ts";
import { newId } from "./id.ts";
import {
  createLocker,
  type Lease,
  LeaseLost,
  type Locker,
  LOCKS_DDL,
  OWNS_SQL,
  RELEASE_SQL,
} from "./lock.ts";
import { AGENTS_DDL, createRegistry, type Registry } from "./agents.ts";
import { createStanding, RULES_DDL, type Standing } from "./rules.ts";
import { type Connections, CONNECTIONS_DDL, createConnections } from "./connections.ts";
import { createTimers, type Timers, TIMERS_DDL } from "./timers.ts";
import { createSweeper, type Sweeper } from "./sweep.ts";
import { dmAliases, principalsOf } from "./roster.ts";

/** A bounded, filtered read over the log. Fields AND-combine (the `search` half, §6). */
export interface ReadQuery {
  service?: string;
  connection?: string;
  conversation?: string; // conversation address
  conversations?: string[]; // restrict to this set (RLS-parity: a principal's readable scope, §6)
  from?: string; // sender address
  senders?: string[]; // restrict to this set of sender addresses (the `from` filter, widened)
  /** LIKE over the names a row denormalizes (§3): what it calls its room and its author.
   *  `search` uses these to turn the handle the model was SHOWN — a name — into the
   *  addresses the log keys on, which is the only reason a name is ever matched: the
   *  filters themselves stay exact, over addresses. */
  conversationName?: string;
  senderName?: string;
  after?: string; // events after this TIMESTAMP (event time — Slack-search semantics, §6)
  before?: string; // events before this TIMESTAMP
  text?: string; // case-insensitive substring over text parts
  types?: Event["type"][]; // restrict to these event types
  /** Rows whose lifecycle stands at this stage (`status.state`, indexed). A dispatcher
   *  opens on `queued`: every offer made before it existed, read off the rows. */
  state?: DeliveryStatus;
  /** `false` ⇒ drop silenced rows (`extra.backfill` · `muted` · `archived` — imported
   *  history and muted/archived-chat traffic, §5). The TURN WINDOW passes it: those rows
   *  reach no prompt (render drops them), so reading them would spend the window's N
   *  slots on rows that are then thrown away — a window of pure history renders empty.
   *  Omitted ⇒ included, which is what `search` wants: silenced rows are its whole point. */
  silenced?: boolean;
  /** Exact match on the wire's artifact id (`envelope.external_id`) — how a dispatcher
   *  finds the row a `re` points at. */
  externalId?: string;
  limit?: number; // keep only the most recent N (still returned in append order)
  /** Row-level predicate applied BEFORE `limit` — RLS `USING` semantics: the window fills
   *  with N *visible* events, never N-minus-the-private-ones. `scoped()` (§6) pins it; on
   *  Postgres the engine does this and the field disappears. */
  filter?: Filter;
}

export type Listener = (event: Event) => void;
export type Filter = (event: Event) => boolean;

export interface SubscribeOptions {
  /** Deliver everything after the event with this id (at-least-once catch-up). Omit ⇒ live.
   *  Positions the append stream only: updates always start live. */
  from?: EventId;
  /** Narrow the stream (e.g. a Slack connection ignores email). */
  filter?: Filter;
  /** Also deliver a row each time its lifecycle moves (an UPDATE), as it then stands. The
   *  dispatcher rides this: a re-offer is a `queued` stamp on a row that exists. Off, the
   *  stream is appends only — a stamp or a receipt never wakes a mind. */
  updates?: boolean;
}

/** The mutable delivery lifecycle (open-bsp): timestamps per stage, merged on update (§3).
 *  A `null` value removes the key (json_patch's law). */
export interface DeliveryPatch {
  external_id?: string; // backfilled by the dispatcher (echo-reconciliation key, §4)
  status?: Record<string, string | number | null>; // e.g. { state: "dispatched", dispatched_at: iso } — json-merged into `status`
  /** The wire naming its own side in the SEND RESPONSE (§4) — stamped with `dispatched_at`,
   *  so sender-presence means "on the wire", not "echo arrived". Fill-only: the echo's
   *  later merge still contributes what only it knows (the pushname). */
  sender?: { address: string; name?: string };
}

/** Capability slices — a consumer can depend on exactly what it's allowed (RLS parity, §6). */
export interface Appender {
  /** PUBLISH. Durably append; the write itself is the trigger. Upsert on `external_id`:
   *  known id ⇒ merge (no wake) · new/absent ⇒ insert (wakes). A PARTLESS draft is
   *  merge-ONLY (§3): it patches the row its external_id names, and when that row doesn't
   *  exist NOTHING is stored — null (single) or omitted (batch). Takes `Draft`s — the
   *  store mints event ids — and returns the STORED events, so callers read `.id` off the
   *  result. A batch is ONE transaction: all of it lands, or none. */
  publish(event: Draft): Promise<Event | null>;
  publish(events: Draft[]): Promise<Event[]>;
  /** PUBLISH, and DROP A LEASE, in one transaction (§2). This is how a turn ends: its last
   *  events and its turn-lease release become visible together, so the wake they fire can
   *  never find the lease still held — that bounced wake was a real stalled-cycle bug. */
  publishAndRelease(event: Draft, lease: Lease): Promise<Event | null>;
  publishAndRelease(events: Draft[], lease: Lease): Promise<Event[]>;
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
  /** The call's turn — the join key back to the log: the events this spend produced carry
   *  the same `payload.turn_id`, so a row's cost resolves to a conversation (§2). */
  turn_id?: string;
  /** What the call was for — a turn, or the checkpoint that displaced one (§5). Two calls
   *  in the same turn differ only here, so maintenance spend is a WHERE, not forensics. */
  kind?: CallKind;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type Log =
  & Appender
  & Reader
  & Subscriber
  & Locker
  & Registry
  & Standing
  & Connections
  & Timers
  & Sweeper
  & {
    /** Record one model call's spend. Fire-and-forget telemetry — never read on the hot path. */
    meter(row: UsageRow): void;
    /** Delivery bookkeeping on an already-published event: backfill `external_id`, merge
     *  `status` stages. An UPDATE — no new row: the append stream never sees it, only a
     *  subscriber that asked for `updates` does (§3, §4). */
    setDelivery(id: EventId, patch: DeliveryPatch): Promise<void>;
    /** Who steers an agent (§4): the entry's list, else the roster when its account is
     *  the org's, else itself. Live — read off the registry and the connections map. */
    principalsOf(agentId: string): string[];
    close(): Promise<void>;
  };

const DB_FILE = "log.db";
const POLL_MS = 300; // backstop period — fs-watch can drop events under load
/** How many BUSY write-lock waits a commit sits out beyond the engine's own (`busy_timeout`),
 *  and the pause between them. See `commit`. */
const BUSY_RETRIES = 1;
const BUSY_RETRY_MS = 250;
const isBusy = (err: unknown): boolean =>
  err instanceof Error && /database is locked|SQLITE_BUSY/.test(err.message);

/** Open (or create) a SQLite-backed, multi-process Log rooted at `dir`. `now` is the
 *  clock the lease reads (§9): a test moves it to age a lease instead of waiting one out. */
export async function openLog(
  dir: string,
  opts: { now?: () => number } = {},
): Promise<Log> {
  await Deno.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(`${dir}/${DB_FILE}`);
  // the store's id authority: Postgres writes `DEFAULT uuidv7()`, SQLite needs the function
  // bound first — same DDL, same guarantee (evaluated at INSERT, under the write lock).
  db.function("uuidv7", () => newId());
  // A log that cannot be read must say so once, in a sentence naming itself. Every child
  // of the org opens this file, so a corrupt one otherwise arrives as four stack traces
  // every few seconds, none of them saying which file or what to do about it — and the
  // supervisor restarts them forever (live, 2026-09-10: a page count outrunning the file
  // by 17MB, under bcachefs). `.recover` rebuilds what is still there.
  let health: string | undefined;
  try {
    health = (db.prepare("PRAGMA quick_check(1)").get() as { quick_check: string }).quick_check;
  } catch {
    health = undefined; // too broken to even ask
  }
  if (health !== "ok") {
    db.close();
    throw new Error(
      `the log at ${dir}/${DB_FILE} is corrupt (${health ?? "unreadable"}) — rebuild it with ` +
        `\`sqlite3 ${DB_FILE} .recover | sqlite3 recovered.db\`, keeping the original until ` +
        `the copy checks out`,
    );
  }
  db.exec(
    `PRAGMA busy_timeout=5000;
     PRAGMA journal_mode=WAL;
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
       text                 TEXT,              -- derived from parts — the search column
       parts                TEXT,              -- the event body (JSON array); absent = merge-only
       payload              TEXT NOT NULL,     -- what the event MEANS: action · refs · turn keys (§3)
       extra                TEXT,              -- sidecar JSON, json_patch-merged (§3)
       status               TEXT               -- delivery lifecycle JSON, json_patch-merged
     );
     CREATE UNIQUE INDEX IF NOT EXISTS events_external
       ON events(external_id) WHERE external_id IS NOT NULL;
     CREATE INDEX IF NOT EXISTS events_conv ON events(conversation_address);
     CREATE INDEX IF NOT EXISTS events_timestamp ON events(timestamp);
     CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
     CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id);
     -- the update stream's cursor: rows whose lifecycle moved after they landed
     CREATE INDEX IF NOT EXISTS events_updated ON events(updated_at, id)
       WHERE updated_at > created_at;
     -- the sweeper's scan: the state is the one lifecycle key it selects on
     CREATE INDEX IF NOT EXISTS events_state ON events(json_extract(status, '$.state'));
     CREATE TABLE IF NOT EXISTS usage (   -- telemetry, NOT events (§2): append-only spend
       created_at         TEXT NOT NULL,
       agent_id           TEXT,
       turn_id            TEXT,              -- the call's turn: joins spend back to the log
       kind               TEXT,              -- what it paid for: a think, or a checkpoint
       model              TEXT NOT NULL,
       input_tokens       INTEGER NOT NULL,
       output_tokens      INTEGER NOT NULL,
       cache_read_tokens  INTEGER,
       cache_write_tokens INTEGER
     );
     ${LOCKS_DDL}
     ${AGENTS_DDL}
     ${RULES_DDL}
     ${CONNECTIONS_DDL}
     ${TIMERS_DDL}`,
  );
  migrate(db); // schema versions below the current one are rewritten in place, exactly once
  const connections = createConnections(db); // the gate below reads its table
  const registry = createRegistry(db);

  const upsert = db.prepare(
    `INSERT INTO events (id, external_id, type, service, connection_address,
       conversation_address, conversation_name, conversation_thread, conversation_kind, session_id,
       sender_address, sender_name, agent_id, timestamp, created_at, updated_at,
       text, parts, payload, extra, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       -- a BACKFILL (extra.backfill — an import of history) FILLS, never overwrites: the
       -- row it meets was written live, and live is the richer view (a history file part
       -- carries no uri; the live one names the bytes on disk), and its marks stay off a
       -- row that was never history. Anything else with parts is a re-statement of the
       -- body — a retry, an echo — and lands as said.
       parts      = CASE WHEN json_extract(excluded.extra, '$.backfill') = 1
                         THEN coalesce(events.parts, excluded.parts)
                         ELSE coalesce(excluded.parts, events.parts) END,
       payload    = json_patch(events.payload, excluded.payload),
       extra      = CASE WHEN excluded.extra IS NULL THEN events.extra
                         WHEN json_extract(excluded.extra, '$.backfill') = 1 THEN events.extra
                         ELSE json_patch(coalesce(events.extra, '{}'), excluded.extra) END,
       status     = CASE WHEN excluded.status IS NULL THEN events.status
                         ELSE json_patch(coalesce(events.status, '{}'), excluded.status) END,
       text       = CASE WHEN json_extract(excluded.extra, '$.backfill') = 1
                         THEN coalesce(events.text, excluded.text)
                         ELSE coalesce(excluded.text, events.text) END,
       -- identity FILLS, never overwrites (§3): write-once facts — the first NON-EMPTY
       -- writer wins. Overwrite is the openbsp Instagram-echo bug (the wire's view of our
       -- own message is peer-shaped, and merging it flipped direction — their
       -- preserve_message_direction trigger is the scar); pure insert-only was the
       -- inherited overcorrection that froze a stub's empty envelope onto the real
       -- message. Empty string counts as empty (stubs wrote '').
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
       agent_id   = CASE WHEN events.agent_id IS NULL THEN excluded.agent_id
                         ELSE events.agent_id END,
       session_id = CASE WHEN events.session_id IS NULL THEN excluded.session_id
                         ELSE events.session_id END,
       updated_at = excluded.updated_at
     RETURNING id`, // the STORED id: minted in write(), or the surviving row's on a merge
  );
  // the merge-only path (§3): a PARTLESS draft is a patch, not an event — receipts and
  // lifecycle stamps reference a message; if the message isn't here, there is nothing to
  // stamp and NOTHING is stored (out-of-order tolerance dropped on purpose: a delivery
  // stamp for a message never seen is worth nothing, and the stub it used to insert was
  // a message-shaped ghost that polluted search and froze its empty envelope onto the
  // real row when the message finally arrived)
  const patch = db.prepare(
    `UPDATE events SET
       payload    = json_patch(payload, ?1),
       extra      = CASE WHEN ?2 IS NULL THEN extra
                         ELSE json_patch(coalesce(extra, '{}'), ?2) END,
       status     = CASE WHEN ?3 IS NULL THEN status
                         ELSE json_patch(coalesce(status, '{}'), ?3) END,
       updated_at = ?4
     WHERE external_id = ?5
     RETURNING id`,
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
       -- sender FILLS, never overwrites (§3 identity rule) — the dispatcher's send-response
       -- stamp and the echo's later merge share one law: first non-empty wins
       sender_address = CASE WHEN coalesce(sender_address, '') = ''
                             THEN coalesce(?5, sender_address) ELSE sender_address END,
       sender_name    = CASE WHEN coalesce(sender_name, '') = ''
                             THEN coalesce(?6, sender_name) ELSE sender_name END,
       updated_at  = ?3
     WHERE id = ?4`,
  );
  const byExternal = db.prepare("SELECT id FROM events WHERE external_id = ?");
  const absorb = db.prepare(
    `UPDATE events SET
       parts      = coalesce((SELECT parts FROM events WHERE id = ?1), parts),
       payload    = json_patch(payload, (SELECT payload FROM events WHERE id = ?1)),
       status     = CASE WHEN (SELECT status FROM events WHERE id = ?1) IS NULL THEN status
                         ELSE json_patch(coalesce(status, '{}'),
                                         (SELECT status FROM events WHERE id = ?1)) END,
       updated_at = ?2
     WHERE id = ?3`,
  );
  const drop = db.prepare("DELETE FROM events WHERE id = ?");
  const unlock = db.prepare(RELEASE_SQL);
  const owns = db.prepare(OWNS_SQL);
  const locker = createLocker(db, opts.now);

  /** One upsert — or, for a PARTLESS draft, one patch (merge-only: nothing stored when the
   *  referenced row doesn't exist ⇒ null). Returns the STORED id (minted here, or the
   *  surviving row's on a merge). The id is minted in JS, not by the column default: on
   *  LOCAL events it doubles as the external_id, so references live in ONE space (§3).
   *  Wire-service events keep NULL until their platform names them — absence IS the
   *  "never confirmed" signal the dispatcher's echo-dedup and the mirror's absorb guard
   *  read. */
  const write = (event: Draft, now: string): Event | null => {
    const r = rowOf(event);
    // An agent's message bound for a wire is born an OFFER: `queued`, stamped now. The
    // dispatcher that serves the connection takes it off the stream, or off the rows if it
    // opens later — so no send waits on a process being there to see it land. `local`
    // rows are the mind's own traffic and go on no wire.
    const born = r.status === null && r.type === "message" && r.agent_id !== null &&
        r.external_id === null && r.service !== "local"
      ? { state: "queued" as const, queued_at: now }
      : undefined;
    if (born) r.status = JSON.stringify(born);
    if (r.parts === null && r.external_id !== null) {
      const hit = patch.get(r.payload, r.extra, r.status, now, r.external_id) as
        | { id: string }
        | undefined;
      return hit ? { ...event, id: hit.id } as Event : null;
    }
    const id = r.id ?? newId();
    const stored = upsert.get(
      id,
      r.external_id ?? (event.envelope.service === "local" ? id : null),
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
      r.parts,
      r.payload,
      r.extra,
      r.status,
    ) as { id: string };
    // the caller's copy carries what the row does: the offer it was born as
    return {
      ...event,
      id: stored.id,
      ...(born ? { status: born, envelope: { ...event.envelope, status: born.state } } : {}),
    } as Event;
  };

  /** Both writers, in one transaction: the batch (all or none) and, optionally, the lease
   *  release that ends a turn. Singles in ⇒ single (or null) out; a batch in ⇒ a batch
   *  out with unstored merge-only drafts omitted. */
  const commit = async (
    one: Draft | Draft[],
    lease?: Lease,
  ): Promise<Event | Event[] | null> => {
    const drafts = Array.isArray(one) ? one : [one];
    for (const d of drafts) {
      const { service, connection_address: address } = d.envelope;
      if (service !== "local" && registered.get(service, address) === undefined) {
        throw new Error(`connection not registered: ${service}:${address}`);
      }
    }
    const now = new Date().toISOString();
    // The transaction is one SYNCHRONOUS block — nothing yields between BEGIN and COMMIT,
    // so two publishes in this process can never interleave inside it. Only the wait for
    // the write lock can be sat out: `busy_timeout` waits out an ordinary contender inside
    // the engine, and a writer holding the lock longer than that (another process
    // mid-import) surfaces as BUSY from BEGIN itself, before anything was written. A
    // turn's finished work must not be dropped for it — one more wait, with the event
    // loop free in between so the lease heartbeat keeps the turn alive. Bounded, because
    // the loop blocks for the whole wait each time: two waits stay inside the lease TTL,
    // a third would not.
    for (let attempt = 0;; attempt++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if (attempt >= BUSY_RETRIES || !isBusy(err)) throw err;
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
      }
    }
    try {
      // a turn ending under a lease proves it still holds it, INSIDE the write transaction
      // so no steal can land between the check and the inserts. A holder declared dead has
      // a successor redoing this very window: its events would be that turn twice over.
      if (lease !== undefined && owns.get(lease.name, lease.born) === undefined) {
        throw new LeaseLost(lease);
      }
      const stored = drafts.map((e) => write(e, now)).filter((e): e is Event => e !== null);
      if (lease !== undefined) unlock.run(lease.name, lease.born);
      db.exec("COMMIT");
      return Array.isArray(one) ? stored : stored[0] ?? null;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  const spend = db.prepare(
    `INSERT INTO usage (created_at, agent_id, turn_id, kind, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    meter(row: UsageRow): void {
      spend.run(
        row.created_at,
        row.agent_id ?? null,
        row.turn_id ?? null,
        row.kind ?? null,
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens ?? null,
        row.cache_write_tokens ?? null,
      );
    },

    lock: locker.lock, // the turn lease lives HERE — same DB, so one transaction holds both
    //                    a turn's last writes and its release (`publishAndRelease`, §2)
    ...registry, // the agent registry (§9): folders declare, this table mirrors
    ...createTimers(db), // armed wakes (§10): the one non-log fact about the future
    ...createSweeper(db), // the harness-led retry (§5): a failed send re-offered as a state move
    ...createStanding(db), // remembered policies (§9): standing verdicts land here
    ...connections, // connections + memberships (§4, §6): what policy reads, live
    // the mind's surfaces (§4): the store's own bindings (self-talk, recorded self-DMs)
    // plus the DMs each principal holds with the agent's account — derived, not stored
    aliases: () => [
      ...connections.aliases(),
      ...dmAliases(registry.agents(), connections.connections()),
    ],
    principalsOf: (agentId) => principalsOf(agentId, registry.agents(), connections.connections()),

    async publish(one: Draft | Draft[]): Promise<Event & Event[]> {
      return await (commit(one) as Promise<Event & Event[]>);
    },

    async publishAndRelease(one: Draft | Draft[], lease: Lease): Promise<Event & Event[]> {
      return await (commit(one, lease) as Promise<Event & Event[]>);
    },
    // (the casts above serve the overload pairs; commit itself is honest about null)

    read(query: ReadQuery = {}): Promise<Event[]> {
      const { sql, params } = build(query);
      if (query.filter === undefined) {
        const rows = db.prepare(sql).all(...params) as unknown as Row[];
        if (query.limit !== undefined) rows.reverse(); // built as DESC LIMIT — restore order
        return Promise.resolve(rows.map(eventOf));
      }
      // the predicate applies BEFORE the limit (RLS `USING` runs before `LIMIT`): walk the
      // newest rows backward, fill the window with VISIBLE events, then restore append
      // order. The walk is a cursor, not a materialized result: it stops — and the engine
      // stops — as soon as the window is full. Postgres does all of this inside the engine.
      const out: Event[] = [];
      for (const r of db.prepare(sql).iterate(...params) as Iterable<Row>) {
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
          patch.sender?.address ?? null,
          patch.sender?.name ?? null,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return Promise.resolve();
    },

    close(): Promise<void> {
      locker.stop(); // no holder is left to speak for once the store is gone
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
  updated_at: string;
  text: string | null;
  parts: string | null;
  payload: string;
  extra: string | null;
  status: string | null;
}

/* ── migration: the typed-payload split (§3) ────────────────────────────────────────────
 *
 * v0 rows carried ONE residual bag in `payload` — {parts, re?, cause?, meta?, turnId?} —
 * with wire refs hiding in the service sidecar. v1 splits it: `parts` its own column,
 * `payload` the typed object (action · refs · turn keys), `extra` keeps {backfill,
 * consumed, <service>}, receipts move to `status`, and every row gets an external_id (its
 * own id when the wire never named it). One pass in a transaction, gated on PRAGMA
 * user_version, so it runs exactly once per database. */
function migrate(db: DatabaseSync) {
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v < 1) migrateV1(db);
  if (v < 2) migrateV2(db);
  if (v < 3) migrateV3(db);
  if (v < 4) migrateV4(db);
  if (v < 5) migrateV5(db);
  if (v < 6) migrateV6(db);
  if (v < 7) migrateV7(db);
  if (v < 8) migrateV8(db);
}

/** v8 — spend says what it paid for (§5): a turn, or the checkpoint that displaced one.
 *  Rows written before the kind existed keep a null: what they cost is known, what kind of
 *  call it was is not. */
function migrateV8(db: DatabaseSync) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('usage')").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "kind")) db.exec("ALTER TABLE usage ADD COLUMN kind TEXT");
  db.exec("PRAGMA user_version = 8");
}

/** v7 — the registry carries the roster's word for each member (`name`), who steers
 *  (`principals`) and whether a session runs (`runs`), §4. A projection re-synced at every
 *  boot: the columns need existing, not backfilling. */
function migrateV7(db: DatabaseSync) {
  const cols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[])
      .map((c) => c.name),
  );
  if (!cols.has("name")) db.exec("ALTER TABLE agents ADD COLUMN name TEXT");
  if (!cols.has("principals")) db.exec("ALTER TABLE agents ADD COLUMN principals TEXT");
  if (!cols.has("runs")) db.exec("ALTER TABLE agents ADD COLUMN runs INTEGER NOT NULL DEFAULT 1");
  db.exec("PRAGMA user_version = 7");
}

function migrateV1(db: DatabaseSync) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "parts")) db.exec("ALTER TABLE events ADD COLUMN parts TEXT");
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT id, external_id, service, payload, extra, status FROM events")
      .all() as {
        id: string;
        external_id: string | null;
        service: string | null;
        payload: string;
        extra: string | null;
        status: string | null;
      }[];
    const put = db.prepare(
      "UPDATE events SET external_id = ?, parts = ?, payload = ?, extra = ?, status = ? WHERE id = ?",
    );
    type Bag = Record<string, unknown>;
    for (const r of rows) {
      const old = JSON.parse(r.payload) as Bag;
      const extra = r.extra ? JSON.parse(r.extra) as Bag : {};
      const status = r.status ? JSON.parse(r.status) as Bag : {};
      const meta = (old.meta ?? {}) as Bag;
      const parts = old.parts as Bag[] | undefined;
      const p: Bag = {};
      if (old.turnId) p.turn_id = old.turnId;
      if (old.cause) p.ref_id = old.cause;
      else if (old.re) p.ref_id = old.re;
      if (meta.stop) p.stop_reason = meta.stop;
      if (meta.covers) p.covers = meta.covers;
      if (meta.control) p.control = meta.control;
      if (meta.consumed) extra.consumed = meta.consumed;
      // permission pairing: the request_id in the data part WAS the tool_use id
      for (const part of parts ?? []) {
        const data = part.data as Bag | undefined;
        if (part.type === "data" && data && typeof data.request_id === "string") {
          p.ref_id ??= data.request_id;
          delete data.request_id;
        }
      }
      // the whatsapp sidecar lift: refs, mentions, forwarded → payload; receipts → status
      const wa = extra.whatsapp as Bag | undefined;
      if (wa) {
        if (typeof wa.re === "string") {
          p.ref_external_id = wa.re;
          delete wa.re;
        }
        if (wa.forwarded) {
          p.action ??= "forward";
          delete wa.forwarded;
        }
        if (Array.isArray(wa.mentions)) {
          // sidecar entries carried {address, agent_id?, name?} — payload.mentions keeps
          // the wire facts (address + name), never our classification (§3)
          const lifted = (wa.mentions as { address?: string; name?: string }[])
            .filter((m): m is { address: string; name?: string } => !!m.address)
            .map((m) => ({ address: m.address, ...(m.name ? { name: m.name } : {}) }));
          if (lifted.length) p.mentions = lifted;
          delete wa.mentions;
        }
        const s = wa.status as Bag | undefined;
        if (s) {
          if (s.delivered !== undefined) status.delivered_at = s.delivered;
          if (s.read !== undefined) status.read_at = s.read;
          delete wa.status;
        }
        if (typeof wa.revoked_at === "string") {
          status.deleted_at = wa.revoked_at;
          delete wa.revoked_at;
        }
        if (Object.keys(wa).length === 0) delete extra.whatsapp;
      }
      // a reaction part names the event's action; a plain wire ref is a reply
      const reaction = (parts ?? []).find((x) => x.type === "data" && x.kind === "reaction");
      if (reaction) {
        const data = reaction.data as Bag;
        p.action = data.action === "removed" ? "remove" : "add";
        delete data.action;
      } else if (p.ref_external_id && !p.action) p.action = "reply";
      put.run(
        // LOCAL events adopt their id as external_id; wire rows keep NULL (never confirmed)
        r.external_id ?? (r.service === "local" ? r.id : null),
        parts !== undefined ? JSON.stringify(parts) : null,
        JSON.stringify(p),
        Object.keys(extra).length ? JSON.stringify(extra) : null,
        Object.keys(status).length ? JSON.stringify(status) : null,
        r.id,
      );
    }
    db.exec("PRAGMA user_version = 1");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** v2 — `turn_id` joins authorship (§3): the discriminator promotion (self(you) ⇔ turn_id
 *  present) re-reads any agent-authored message WITHOUT one as the principal's. Historical
 *  tool-dispatched sends and mirror voice-CCs carried only `ref_id`; backfill each with its
 *  referent's turn_id (the send's tool_use, the CC's mind original). Rows whose referent
 *  has none — a principal-replay CC — correctly stay unstamped. */
function migrateV2(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `UPDATE events SET payload = json_set(coalesce(payload, '{}'), '$.turn_id',
         (SELECT json_extract(u.payload, '$.turn_id') FROM events u
           WHERE u.id = json_extract(events.payload, '$.ref_id')))
       WHERE type = 'message' AND agent_id IS NOT NULL
         AND json_extract(payload, '$.turn_id') IS NULL
         AND (SELECT json_extract(u.payload, '$.turn_id') FROM events u
               WHERE u.id = json_extract(events.payload, '$.ref_id')) IS NOT NULL`,
    );
    // the referent-less remainder: pre-v2 a stamped message could ONLY be the voice (no
    // classifier, no principal stamps existed), so the reading is unambiguous — synthesize
    db.exec(
      `UPDATE events SET payload = json_set(coalesce(payload, '{}'), '$.turn_id', 'v2:' || id)
       WHERE type = 'message' AND agent_id IS NOT NULL AND session_id IS NOT NULL
         AND json_extract(payload, '$.turn_id') IS NULL`,
    );
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Spend gains the call's turn — telemetry that can be joined back to the log (§2). Old rows
 *  keep a null: what they cost is known, which conversation cost it is not. */
function migrateV3(db: DatabaseSync) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('usage')").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "turn_id")) {
    db.exec("ALTER TABLE usage ADD COLUMN turn_id TEXT");
  }
  db.exec("PRAGMA user_version = 3");
}

/** v6 — the stored rows settle on the session vocabulary (§4, §7). Pre-sessions logs
 *  stamped `session_id` with the agent id (one session per agent) and named the mind's
 *  room `mind:<agent>`; under pair semantics those rows would read as a foreign
 *  session's — the mind failing to recognize its own closings re-answers its backlog.
 *  So: a stamp equal to the agent id becomes `mind`, and the local `mind:` rooms take
 *  the `@` spelling, in events, memberships and timers alike. `extra.via` provenance
 *  keeps the old strings — nothing branches on a local via's conversation. */
function migrateV6(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `UPDATE events SET session_id = 'mind'
        WHERE agent_id IS NOT NULL AND session_id = agent_id;
       UPDATE events SET conversation_address = 'mind@' || substr(conversation_address, 6)
        WHERE service = 'local' AND conversation_address LIKE 'mind:%';
       UPDATE memberships SET conversation_address = 'mind@' || substr(conversation_address, 6)
        WHERE service = 'local' AND conversation_address LIKE 'mind:%';
       UPDATE timers SET conversation = 'mind@' || substr(conversation, 6)
        WHERE conversation LIKE 'mind:%';
       UPDATE timers SET session_id = 'mind' WHERE session_id = agent_id;`,
    );
    db.exec("PRAGMA user_version = 6");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** v5 — memberships enroll the (agent, session) PAIR (§4): the member is a session, so
 *  `session_id` joins the primary key. Pre-v5 rows enrolled agents with one session each
 *  — the mind — so `mind` is the honest backfill. SQLite cannot extend a primary key in
 *  place; the table is rebuilt. */
function migrateV5(db: DatabaseSync) {
  const cols = (db.prepare("SELECT name FROM pragma_table_info('memberships')").all() as {
    name: string;
  }[]).map((c) => c.name);
  if (!cols.includes("session_id")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `ALTER TABLE memberships RENAME TO memberships_old;
         CREATE TABLE memberships (
           service              TEXT NOT NULL,
           connection_address   TEXT NOT NULL,
           conversation_address TEXT NOT NULL,
           agent_id             TEXT NOT NULL,
           session_id           TEXT NOT NULL,
           created_at           TEXT NOT NULL,
           deleted_at           TEXT,
           PRIMARY KEY (service, connection_address, conversation_address, agent_id, session_id)
         );
         INSERT INTO memberships
           SELECT service, connection_address, conversation_address, agent_id, 'mind',
                  created_at, deleted_at
           FROM memberships_old;
         DROP TABLE memberships_old;`,
      );
      db.exec("PRAGMA user_version = 5");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } else {
    db.exec("PRAGMA user_version = 5");
  }
}

/** v4 — the vocabulary settles on SESSIONS (§4): an agent's row names its mind session
 *  (`agents.mind`), and an armed wake names the session that armed it (`timers.session_id`,
 *  §10). Pre-v4 rows had one session per agent, so the agent id is the honest backfill. */
function migrateV4(db: DatabaseSync) {
  const cols = (t: string) =>
    (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[])
      .map((c) => c.name);
  if (cols("agents").includes("home")) db.exec("ALTER TABLE agents RENAME COLUMN home TO mind");
  if (!cols("timers").includes("session_id")) {
    db.exec("ALTER TABLE timers ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE timers SET session_id = agent_id WHERE session_id = ''");
  }
  db.exec("PRAGMA user_version = 4");
}

/** ONE clock in the column (§3): whatever offset the producer wrote — WhatsApp stamps
 *  `-03:00`, the harness stamps `Z` — the stored sort key is UTC, because lexical order
 *  (`byTs`, the before/after bounds) only means time on a single zone. The producer's
 *  offset is presentation, and presentation is render's job (org config `timezone`, §5).
 *  Unparseable stamps pass through: an odd row beats a thrown insert. */
function utcOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

/** Flatten a draft into columns. `id` is null unless the caller named one — `write` mints
 *  it otherwise. `envelope.status` is the shorthand for `status.state`: both land in the
 *  same lifecycle column, the explicit object carrying the stamps (§3). */
function rowOf(e: Draft) {
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
function eventOf(r: Row): Event {
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
  let poll: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const maxId = db.prepare("SELECT MAX(id) AS m FROM events");
  const after = db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC");
  // the update stream (`opts.updates`): rows whose lifecycle moved after they landed, in
  // the order they moved. `updated_at > created_at` keeps a fresh insert off it — that row
  // is the append stream's — and `id` breaks the tie a batch stamp leaves, one
  // `updated_at` across every row it touched.
  const lastMoved = db.prepare(
    `SELECT updated_at, id FROM events WHERE updated_at > created_at
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
  );
  const movedAfter = db.prepare(
    `SELECT * FROM events WHERE updated_at > created_at
       AND (updated_at > ?1 OR (updated_at = ?1 AND id > ?2))
     ORDER BY updated_at ASC, id ASC`,
  );

  // Seed SYNCHRONOUSLY, here — not in the first pump. `subscribe()` returning is the
  // subscriber's guarantee: everything appended after it is delivered. A lazy seed would
  // read MAX(id) after the first publishes had landed and skip them as backlog.
  // live: skip what's already there · from: resume just after that id ("" ⇒ replay all).
  let cursor = opts.from ?? ((maxId.get() as { m: string | null }).m ?? "");
  // updates start live whatever `from` says: an offer made before this subscriber existed
  // stands in the row's state, and the subscriber reads it there (`read({state})`)
  const seed = opts.updates
    ? lastMoved.get() as { updated_at: string; id: string } | undefined
    : undefined;
  let moved: [string, string] = seed ? [seed.updated_at, seed.id] : ["", ""];

  const deliver = (r: Row) => {
    const e = eventOf(r);
    if (!opts.filter || opts.filter(e)) listener(e);
  };
  const pump = (): Promise<void> => (chain = chain.then(() => {
    if (closed) return;
    for (const r of after.all(cursor) as unknown as Row[]) {
      cursor = r.id;
      deliver(r);
    }
    if (!opts.updates) return;
    for (const r of movedAfter.all(moved[0], moved[1]) as unknown as Row[]) {
      moved = [r.updated_at, r.id];
      deliver(r);
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
  const like = (column: string, value?: string) => {
    if (value === undefined) return;
    where.push(`${column} IS NOT NULL AND lower(${column}) LIKE '%' || lower(?) || '%'`);
    params.push(value);
  };
  like("conversation_name", q.conversationName);
  like("sender_name", q.senderName);
  // time bounds compare EVENT time (the `timestamp` column), not ids: the callers that
  // filter by time (search, §6) mean the world's clock, and an ISO string compared against
  // a uuid would silently match everything or nothing (a real bug this replaced)
  if (q.after !== undefined) (where.push("timestamp > ?"), params.push(utcOf(q.after)));
  if (q.before !== undefined) (where.push("timestamp < ?"), params.push(utcOf(q.before)));
  if (q.types && q.types.length > 0) {
    where.push(`type IN (${q.types.map(() => "?").join(",")})`);
    params.push(...q.types);
  }
  eq("json_extract(status, '$.state')", q.state);
  if (q.text !== undefined) {
    where.push("text IS NOT NULL AND lower(text) LIKE '%' || lower(?) || '%'");
    params.push(q.text);
  }
  // in SQL, not in a `filter`: that field is the §6 scope's, and it runs in JS over every
  // materialized row — an import would be paged into memory only to be dropped
  if (q.silenced === false) {
    where.push(
      "json_extract(extra, '$.backfill') IS NOT 1 AND json_extract(extra, '$.muted') IS NOT 1 AND json_extract(extra, '$.archived') IS NOT 1",
    );
  }
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
function textOf(event: Draft): string | null {
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
