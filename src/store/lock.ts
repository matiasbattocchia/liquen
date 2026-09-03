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
  name TEXT PRIMARY KEY,
  born INTEGER NOT NULL,  -- WHO: minted per acquisition, quoted by the holder's writes
  seen INTEGER NOT NULL   -- WHETHER: the heartbeat the TTL is measured against
);`;

/** Releasing is one statement, so `publishAndRelease` can run it inside the SAME transaction
 *  as a turn's last writes (§2) — that atomicity is the whole reason the lease lives here. */
export const RELEASE_SQL = "DELETE FROM locks WHERE name = ?1 AND born = ?2";

/** The same question a release asks, without answering it: is this token still the holder?
 *  Read inside the writing transaction, so a steal cannot land between check and write. */
export const OWNS_SQL = "SELECT 1 AS x FROM locks WHERE name = ?1 AND born = ?2";

/** Bind the locker to an open DB. Statements are prepared ONCE — `lock()` is called per xi
 *  invocation, and with a fan-out that invokes every agent per event that adds up. */
export function createLocker(db: DatabaseSync, now: () => number = Date.now): Locker {
  const take = db.prepare(
    "INSERT INTO locks (name, born, seen) VALUES (?1, ?2, ?2) ON CONFLICT(name) DO NOTHING",
  );
  // one atomic statement, so two stealers can't both win: only the row whose heartbeat is
  // still older than the cutoff is updated, and `changes` says whether it was us
  const steal = db.prepare("UPDATE locks SET born = ?2, seen = ?2 WHERE name = ?1 AND seen <= ?3");
  // the heartbeat, quoting the token: a holder that was stolen from re-stamps nothing
  const beat = db.prepare("UPDATE locks SET seen = ?3 WHERE name = ?1 AND born = ?2");
  const free = db.prepare(RELEASE_SQL);
  const live = db.prepare("SELECT 1 AS x FROM locks WHERE name = ? AND seen > ?");

  return {
    lock(name: string, ttlMs: number = LOCK_TTL_MS): TurnLock {
      let born = 0; // no acquire yet — a stamp that matches no row
      let heart: number | undefined;
      const stop = () => {
        if (heart !== undefined) clearInterval(heart);
        heart = undefined;
      };
      const start = () => {
        stop();
        let misses = 0;
        heart = setInterval(() => {
          try {
            // gone: we were declared dead, or the turn already ended (publishAndRelease
            // drops the row itself). Either way there is nothing left to keep alive, and a
            // zombie that kept re-stamping would only fight its own successor.
            if (Number(beat.run(name, born, now()).changes) === 0) return stop();
            misses = 0;
          } catch {
            // the store is unreachable — closing down, or wedged behind a writer past
            // `busy_timeout`. A holder that cannot re-stamp for a whole TTL has already
            // lost the lease by definition, so stop claiming otherwise.
            if (++misses >= BEATS) stop();
          }
        }, Math.max(1, Math.floor(ttlMs / BEATS)));
        // the heartbeat must never be a reason for the process to stay up: a supervisor's
        // SIGTERM has to end it, and a leaked lock has to stop holding the test open
        Deno.unrefTimer(heart);
      };
      return {
        acquire(): Promise<Acquired> {
          const t = now();
          if (Number(take.run(name, t).changes) > 0) {
            born = t;
            start();
            return Promise.resolve("acquired");
          }
          // held — steal only if the heartbeat stopped (the holder died without releasing)
          if (Number(steal.run(name, t, t - ttlMs).changes) > 0) {
            born = t;
            start();
            return Promise.resolve("stolen");
          }
          return Promise.resolve("held");
        },
        lease(): Lease {
          return { name, born };
        },
        release(): Promise<void> {
          stop();
          free.run(name, born);
          return Promise.resolve();
        },
        held(): Promise<boolean> {
          return Promise.resolve(live.get(name, now() - ttlMs) !== undefined);
        },
      };
    },
  };
}
