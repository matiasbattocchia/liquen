/**
 * store/lock.ts — the turn lock (§2 scheduling): at most one working xi per agent at a time.
 *
 * The lock is the ONLY scheduling state that outlives an event: everything else (pending
 * work, barriers, gates) is derived from the log. Discipline:
 *   • acquire only on a think/act decision — ignore never touches the lock
 *   • cannot acquire? exit — no retry; the holder's own output is the next poke
 *   • release when the work's events are published (write before release)
 *   • a crashed holder releases by TTL — the next acquire STEALS the stale lock, and
 *     reports it: a steal means the previous work's state is unknown, so the stealer
 *     sweeps pending tool uses (cancelled results) instead of blindly re-running them
 *
 * TWO STAMPS, because the row answers two questions. `born` is WHO holds it: minted once
 * per acquisition, quoted by every write the holder makes, never moved. `seen` is WHETHER
 * ANYONE IS THERE: re-stamped by a heartbeat while the holder lives, and the only thing the
 * TTL is measured against. Splitting them is what lets the TTL shrink. A single stamp has
 * to cover the longest turn imaginable — and a turn's length is not knowable here: `think`
 * spans a model call and its retry sleeps, `act` spans the slowest tool in a parallel batch,
 * whose timeout the MODEL chooses per call. Measured against a heartbeat instead, the TTL
 * asks only "did the process die?", which a timer answers in seconds: a dead process cannot
 * run one. Slow is no longer confusable with dead.
 *
 * WHAT A LOST LEASE MEANS. The steal is still a GUESS — a holder wedged for three straight
 * heartbeats is declared dead while alive. So the guess is made unfalsifiable after the
 * fact: every write quotes `born`, and a row whose stamp has moved on accepts none of them.
 * A holder that comes back cannot release the lease its successor is working under, and
 * cannot land its turn's events either — the successor is already redoing that work from
 * the same window, and two turns publishing one window is the one outcome the lock exists
 * to prevent. The zombie's work is dropped, loudly.
 *
 * It lives **in the store**, as a `locks` row beside the events — not in a file beside the
 * DB. That's what makes `publishAndRelease` reachable (§2): write the turn's events and drop
 * the lease in ONE transaction, so an observer sees neither or both and a wake derived from
 * those inserts can never find the lock still held. Two substrates can't share a transaction;
 * one can. On Postgres the same port is an advisory lock or this same row (§9).
 */

import type { DatabaseSync } from "node:sqlite";

/** How long without a HEARTBEAT before a holder is presumed dead and its lease stealable.
 *  Not a turn budget: a turn may run far longer than this and stay healthy, because the
 *  heartbeat keeps saying so. It sets how fast a real crash is recovered from, so it wants
 *  to be small — bounded below by how long a live process may be too busy to re-stamp. */
export const LOCK_TTL_MS = 20_000;

/** Heartbeats per TTL: three consecutive misses declare a holder dead. Enough slack for a
 *  renew that waits out `busy_timeout` behind another writer, or a turn's synchronous work
 *  (window render) holding the event loop past one beat. */
const BEATS = 3;

/** How an acquire went. "held" = a live holder exists — exit, their output will poke. */
export type Acquired = "acquired" | "stolen" | "held";

/** What a holder writes to claim the lease: the name, and the exact `born` it stamped.
 *  Every write quotes it, so authority is carried by the token rather than assumed. */
export interface Lease {
  name: string;
  born: number;
}

/** Raised when a write quotes a lease the row no longer carries: the holder was declared
 *  dead and stolen from, so its work is a duplicate of what the stealer is already doing. */
export class LeaseLost extends Error {
  constructor(lease: Lease) {
    super(`lease ${lease.name} was stolen — this turn's writes are refused`);
    this.name = "LeaseLost";
  }
}

export interface TurnLock {
  /** Take the lease, or steal one nobody has re-stamped within the TTL. A win starts the
   *  heartbeat; it stops on release, or the moment a beat finds the lease gone. */
  acquire(): Promise<Acquired>;
  /** The token of the last winning acquire — what a write quotes to prove it is the holder. */
  lease(): Lease;
  /** The interrupt of the lease held (§2): fires when a `control` row lands in the session's
   *  room while this holder has it — the STORE fires it, so a cancel from any surface and
   *  any process reaches the turn by the path everything else does. Marked on the row
   *  (`cancel`) by the publish that lands the control, read at once by this process's own
   *  publish, on the store's ring for one from another process, and by the heartbeat
   *  within a beat whatever the ring missed. Fresh per acquire; inert before one. */
  signal(): AbortSignal;
  /** Release. Drops the row only if this holder's stamp is still on it: a no-op after a
   *  steal, and safe to call when nothing is held. */
  release(): Promise<void>;
  /** A live, unexpired holder exists. Read-only — a caller's skip-the-invoke optimization;
   *  correctness never depends on it (xi's acquire is the authority). */
  held(): Promise<boolean>;
}

/** The store's locking capability — one named lease per session (`turn-<session address>`). */
export interface Locker {
  lock(name: string, ttlMs?: number): TurnLock;
}

export const LOCKS_DDL = `CREATE TABLE IF NOT EXISTS locks (
  name   TEXT PRIMARY KEY,
  born   INTEGER NOT NULL,  -- WHO: minted per acquisition, quoted by the holder's writes
  seen   INTEGER NOT NULL,  -- WHETHER: the heartbeat the TTL is measured against
  cancel INTEGER NOT NULL DEFAULT 0  -- STILL WANTED: a control row landed for the holder
);`;

/** The lease of a session's turn, by the session's room (§2): what a `control` row landing
 *  there names. */
export const turnLockOf = (conversation: string): string => `turn-${conversation}`;

/** A control row landing marks the holder's lease, whoever holds it: the heartbeat reads
 *  the mark. Run by the publish that lands the row, inside its transaction. */
export const CANCEL_SQL = "UPDATE locks SET cancel = 1 WHERE name = ?1";

/** Releasing is one statement, so `publishAndRelease` can run it inside the SAME transaction
 *  as a turn's last writes (§2) — that atomicity is the whole reason the lease lives here. */
export const RELEASE_SQL = "DELETE FROM locks WHERE name = ?1 AND born = ?2";

/** The same question a release asks, without answering it: is this token still the holder?
 *  Read inside the writing transaction, so a steal cannot land between check and write. */
export const OWNS_SQL = "SELECT 1 AS x FROM locks WHERE name = ?1 AND born = ?2";

/** The six statements a locker runs, as its engine answers them. Every one quotes what
 *  it needs — the name, the token, the clock's reading — so the rows are the whole state
 *  and any process's locker reads the same lease. */
export interface LeaseRows {
  /** Insert the row when there is none: whether this call inserted it. */
  take(name: string, t: number): Promise<boolean>;
  /** Re-stamp, unmarked, a row nobody has beaten since `cutoff`: whether this call did. One
   *  statement, so two stealers cannot both win. */
  steal(name: string, t: number, cutoff: number): Promise<boolean>;
  /** The heartbeat under the token: the row's mark, or `undefined` when the row is no longer
   *  this token's. */
  beat(name: string, born: number, t: number): Promise<{ cancel: boolean } | undefined>;
  /** Drop the row, if it still carries the token. */
  free(name: string, born: number): Promise<void>;
  /** A row beaten after `cutoff` exists. */
  live(name: string, cutoff: number): Promise<boolean>;
  /** The row under this token carries the mark. */
  marked(name: string, born: number): Promise<boolean>;
}

/** A synchronous statement's answer as a promise — a throw becomes a rejection. */
function settled<T>(f: () => T): Promise<T> {
  try {
    return Promise.resolve(f());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** The lease rows on SQLite: statements prepared once, since `lock()` is called per xi
 *  invocation, and a fan-out that invokes every agent per event adds that up. */
export function sqliteLeases(db: DatabaseSync): LeaseRows {
  const take = db.prepare(
    "INSERT INTO locks (name, born, seen) VALUES (?1, ?2, ?2) ON CONFLICT(name) DO NOTHING",
  );
  // only the row whose heartbeat is still older than the cutoff is updated, and `changes`
  // says whether it was us. A stolen lease starts unmarked: the cancel was the dead holder's.
  const steal = db.prepare(
    "UPDATE locks SET born = ?2, seen = ?2, cancel = 0 WHERE name = ?1 AND seen <= ?3",
  );
  // the heartbeat, quoting the token: a holder that was stolen from re-stamps nothing —
  // and reads the mark a control row left, which is how a cancel from another process
  // reaches this holder
  const beat = db.prepare(
    "UPDATE locks SET seen = ?3 WHERE name = ?1 AND born = ?2 RETURNING cancel",
  );
  const free = db.prepare(RELEASE_SQL);
  const live = db.prepare("SELECT 1 AS x FROM locks WHERE name = ? AND seen > ?");
  const marked = db.prepare("SELECT cancel FROM locks WHERE name = ?1 AND born = ?2");
  return {
    take: (name, t) => settled(() => Number(take.run(name, t).changes) > 0),
    steal: (name, t, cutoff) => settled(() => Number(steal.run(name, t, cutoff).changes) > 0),
    beat: (name, born, t) =>
      settled(() => {
        const row = beat.get(name, born, t) as { cancel: number } | undefined;
        return row === undefined ? undefined : { cancel: row.cancel === 1 };
      }),
    free: (name, born) => settled(() => void free.run(name, born)),
    live: (name, cutoff) => settled(() => live.get(name, cutoff) !== undefined),
    marked: (name, born) =>
      settled(() => (marked.get(name, born) as { cancel: number } | undefined)?.cancel === 1),
  };
}

/** Bind a locker to its lease rows. `now` is the clock every stamp and every comparison
 *  reads (§9: the seam a test moves). `stop()` ends every heartbeat this locker started —
 *  a closing store has no holder left to speak for, and an abandoned turn's beat must not
 *  outlive the store it beats into.
 *
 *  `watch` is the store's change stream, rung on every `control` row that lands from any
 *  process: while this locker holds a lease it is subscribed, and each ring has every
 *  holder read its mark at once. The mark stays the one truth — a ring only makes it read
 *  sooner than the heartbeat would, and a missed ring costs a beat, never the cancel. */
export function createLocker(
  rows: LeaseRows,
  now: () => number = Date.now,
  watch?: (ring: () => void) => () => void,
): Locker & { stop(): void; cancel(name: string): void } {
  const hearts = new Set<ReturnType<typeof setInterval>>();
  // the interrupts of the leases THIS process holds, by name: a control row this process
  // lands fires the holder at once, no beat to wait for
  const holding = new Map<string, { ctl: AbortController; born: number }>();
  let unwatch: (() => void) | undefined;
  const ring = () => {
    for (const [name, h] of holding) {
      // the store is closing or wedged when this fails: the heartbeat speaks for the holder
      rows.marked(name, h.born).then((m) => m && h.ctl.abort(), () => {});
    }
  };
  const unhold = (name: string, ctl: AbortController) => {
    if (holding.get(name)?.ctl === ctl) holding.delete(name);
    if (holding.size === 0 && unwatch !== undefined) {
      unwatch();
      unwatch = undefined;
    }
  };

  return {
    stop() {
      for (const h of hearts) clearInterval(h);
      hearts.clear();
      holding.clear();
      unwatch?.();
      unwatch = undefined;
    },
    cancel(name: string) {
      holding.get(name)?.ctl.abort();
    },
    lock(name: string, ttlMs: number = LOCK_TTL_MS): TurnLock {
      let born = 0; // no acquire yet — a stamp that matches no row
      let ctl = new AbortController();
      let heart: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (heart !== undefined) {
          clearInterval(heart);
          hearts.delete(heart);
        }
        heart = undefined;
        unhold(name, ctl);
      };
      const start = () => {
        stop();
        ctl = new AbortController();
        holding.set(name, { ctl, born });
        if (watch !== undefined && unwatch === undefined) unwatch = watch(ring);
        let misses = 0;
        let beating = false;
        const mine = setInterval(() => {
          if (beating) return; // the last beat is still out: one at a time
          beating = true;
          const signal = ctl;
          rows.beat(name, born, now()).then(
            (row) => {
              if (heart !== mine) return; // this heart was stopped while the beat was out
              // gone: we were declared dead, or the turn already ended (publishAndRelease
              // drops the row itself). Either way there is nothing left to keep alive, and
              // a zombie that kept re-stamping would only fight its own successor.
              if (row === undefined) return stop();
              if (row.cancel) signal.abort();
              misses = 0;
            },
            () => {
              // the store is unreachable — closing down, or wedged behind a writer. A
              // holder that cannot re-stamp for a whole TTL has already lost the lease by
              // definition, so stop claiming otherwise.
              if (heart === mine && ++misses >= BEATS) stop();
            },
          ).finally(() => (beating = false));
        }, Math.max(1, Math.floor(ttlMs / BEATS)));
        heart = mine;
        // the heartbeat must never be a reason for the process to stay up: a supervisor's
        // SIGTERM has to end it, and a leaked lock has to stop holding the test open
        Deno.unrefTimer(mine);
        hearts.add(mine);
      };
      return {
        async acquire(): Promise<Acquired> {
          const t = now();
          if (await rows.take(name, t)) {
            born = t;
            start();
            return "acquired";
          }
          // held — steal only if the heartbeat stopped (the holder died without releasing)
          if (await rows.steal(name, t, t - ttlMs)) {
            born = t;
            start();
            return "stolen";
          }
          return "held";
        },
        lease(): Lease {
          return { name, born };
        },
        signal(): AbortSignal {
          return ctl.signal;
        },
        async release(): Promise<void> {
          stop();
          await rows.free(name, born);
        },
        held(): Promise<boolean> {
          return rows.live(name, now() - ttlMs);
        },
      };
    },
  };
}
