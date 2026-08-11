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
 * It lives **in the store**, as a `locks` row beside the events — not in a file beside the
 * DB. That's what makes `publishAndRelease` reachable (§2): write the turn's events and drop
 * the lease in ONE transaction, so an observer sees neither or both and a wake derived from
 * those inserts can never find the lock still held. Two substrates can't share a transaction;
 * one can. On Postgres the same port is an advisory lock or this same row (§9).
 */

import type { DatabaseSync } from "node:sqlite";

/** How an acquire went. "held" = a live holder exists — exit, their output will poke. */
export type Acquired = "acquired" | "stolen" | "held";

export interface TurnLock {
  acquire(): Promise<Acquired>;
  /** Release. Safe to call when not held (a stale steal may have removed it). */
  release(): Promise<void>;
  /** A live, unexpired holder exists. Read-only — a caller's skip-the-invoke optimization;
   *  correctness never depends on it (xi's acquire is the authority). */
  held(): Promise<boolean>;
}

/** The store's locking capability — one named lease per agent (`turn-<agentId>`). */
export interface Locker {
  lock(name: string, ttlMs?: number): TurnLock;
}

export const DEFAULT_TTL_MS = 120_000;

export const LOCKS_DDL = `CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  born INTEGER NOT NULL   -- acquisition epoch ms; the TTL is what makes a crash releasable
);`;

/** Releasing is one statement, so `publishAndRelease` can run it inside the SAME transaction
 *  as a turn's last writes (§2) — that atomicity is the whole reason the lease lives here. */
export const RELEASE_SQL = "DELETE FROM locks WHERE name = ?";

/** Bind the locker to an open DB. Statements are prepared ONCE — `lock()` is called per xi
 *  invocation, and with a fan-out that invokes every agent per event that adds up. */
export function createLocker(db: DatabaseSync, now: () => number = Date.now): Locker {
  const take = db.prepare(
    "INSERT INTO locks (name, born) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
  );
  // one atomic statement, so two stealers can't both win: only the row still older than the
  // cutoff is updated, and `changes` says whether it was us
  const steal = db.prepare("UPDATE locks SET born = ?2 WHERE name = ?1 AND born <= ?3");
  const free = db.prepare(RELEASE_SQL);
  const live = db.prepare("SELECT 1 AS x FROM locks WHERE name = ? AND born > ?");

  return {
    lock(name: string, ttlMs: number = DEFAULT_TTL_MS): TurnLock {
      return {
        acquire(): Promise<Acquired> {
          const t = now();
          if (Number(take.run(name, t).changes) > 0) return Promise.resolve("acquired");
          // held — steal only if the lease expired (the holder crashed without releasing)
          if (Number(steal.run(name, t, t - ttlMs).changes) > 0) return Promise.resolve("stolen");
          return Promise.resolve("held");
        },
        release(): Promise<void> {
          free.run(name);
          return Promise.resolve();
        },
        held(): Promise<boolean> {
          return Promise.resolve(live.get(name, now() - ttlMs) !== undefined);
        },
      };
    },
  };
}
