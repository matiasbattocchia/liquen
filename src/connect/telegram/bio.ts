/**
 * connect/telegram/bio.ts — what a stranger wrote about themselves: the about text of
 * their Telegram profile, read for a sender the account's address book does not hold.
 *
 * The read (`users.getFullUser`) is rate-limited on the account's own session, the one
 * that receives its messages, so the calls go out one at a time, `GAP_MS` apart, and a
 * refusal that names a wait holds every read until the wait is out. A person is read once
 * and remembered for `FRESH_MS`, an empty about included. Whoever asks waits as long as
 * they said and no longer: the answer is the text when it is known by then, and nothing
 * otherwise, while the read goes on for the next one who asks.
 */

import { DispatchError } from "../errors.ts";

/** How long a read stands: a profile is rewritten rarely. */
export const FRESH_MS = 7 * 24 * 60 * 60_000;
/** The pause between two reads on one session. */
export const GAP_MS = 3_000;
/** How many people may wait to be read; one more is turned away and asked again when they
 *  next write. */
export const QUEUE = 256;
/** How many people are remembered. */
const KEPT = 4096;

export interface BioDeps {
  /** One person's about text off the wire. A `DispatchError` of code 429 is a wait. */
  about: (user: string) => Promise<string>;
  /** The clock and the sleep the spacing reads (§9: the seam a test moves). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  onError?: (user: string, err: unknown) => void;
}

export interface Bios {
  /** The person's about text, waiting up to `waitMs` for a read still to be made.
   *  Undefined when it is not known by then; `""` when they wrote none. */
  of(user: string, waitMs?: number): Promise<string | undefined>;
  /** No more reads. */
  stop(): void;
}

/** The seconds a flood refusal asks for, off its message (`FLOOD_WAIT_17`). */
export function floodSeconds(err: unknown): number | undefined {
  const m = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/.exec(String(err instanceof Error ? err.message : err));
  return m ? Number(m[1]) : undefined;
}

export function createBios(deps: BioDeps): Bios {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = deps.gapMs ?? GAP_MS;
  const known = new Map<string, { about: string; at: number }>();
  const waiting = new Map<string, Promise<string | undefined>>();
  let chain: Promise<void> = Promise.resolve();
  let last = -Infinity;
  let stopped = false;

  const read = async (user: string): Promise<string | undefined> => {
    if (stopped) return undefined;
    const since = now() - last;
    if (since < gap) await sleep(gap - since);
    if (stopped) return undefined;
    last = now();
    try {
      const about = (await deps.about(user)).trim();
      known.set(user, { about, at: now() });
      // the oldest goes first: a Map keeps insertion order
      if (known.size > KEPT) known.delete(known.keys().next().value!);
      return about;
    } catch (err) {
      const wait = floodSeconds(err) ??
        (err instanceof DispatchError && err.code === 429 ? 60 : undefined);
      if (wait !== undefined) await sleep(wait * 1_000);
      deps.onError?.(user, err);
      return undefined;
    }
  };

  return {
    of(user, waitMs = 0) {
      const held = known.get(user);
      if (held && now() - held.at < FRESH_MS) return Promise.resolve(held.about);
      let asked = waiting.get(user);
      if (!asked) {
        if (waiting.size >= QUEUE) return Promise.resolve(undefined);
        const queued = chain.then(() => read(user));
        asked = queued;
        waiting.set(user, queued);
        chain = queued.then(() => {
          waiting.delete(user);
        });
      }
      if (waitMs <= 0) return Promise.resolve(undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), waitMs);
      });
      return Promise.race([asked, timeout]).finally(() => clearTimeout(timer));
    },
    stop() {
      stopped = true;
    },
  };
}
