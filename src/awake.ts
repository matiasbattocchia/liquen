/**
 * awake.ts — since when this machine has been awake.
 *
 * A suspend stops every process at once. The wall clock runs on through it and the
 * monotonic one (`performance.now`) does not, so the gap between them grows only while the
 * machine sleeps. Each look compares that gap with the last look's; grown past `SLEPT_MS`,
 * the machine slept in between, and the look stamps the wake. A loop held busy moves both
 * clocks alike and stamps nothing. Before any wake, the process's own start stands in.
 *
 * Silence read from the log counts only from here: nothing beats while the machine
 * sleeps, the reader included. A read looks first, so the first read after a wake already
 * knows of it; the clock's tick looks too, so a wake is stamped within a tick of it even
 * when nothing reads.
 */

/** How far the wall clock may run ahead of the monotonic one between two looks before the
 *  machine counts as having slept: past a clock's own drift, and past an NTP step. */
export const SLEPT_MS = 10_000;

export interface Awake {
  /** Compare the clocks; a grown gap stamps a wake. */
  look(): void;
  /** When the machine last woke, or the watch began: wall-clock ms. */
  since(): number;
}

export function awake(
  wall: () => number = Date.now,
  mono: () => number = () => performance.now(),
): Awake {
  let since = wall();
  let gap = since - mono();
  const look = () => {
    const now = wall();
    const g = now - mono();
    if (g - gap > SLEPT_MS) since = now;
    gap = g;
  };
  return {
    look,
    since() {
      look();
      return since;
    },
  };
}

/** This process's watch. */
export const machine: Awake = awake();
