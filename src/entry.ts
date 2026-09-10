/**
 * entry.ts — how a liquen process ends when it cannot go on (§9).
 *
 * Every entry point runs its body through `entry`: the doors, the daemons, the file
 * binaries. One rule decides what reaches the terminal, and it turns on the error's own
 * type:
 *
 *   a plain `Error`   a REFUSAL — a sentence the code wrote for the person at the
 *                     terminal ("pairing timed out — run the door again"). The sentence
 *                     is the whole message: no class name, no frames, nothing above it.
 *   anything else     a `TypeError`, a `Deno.errors.*`, a thrown string: the runtime
 *                     speaking, about a place the code did not mean to reach. The stack
 *                     is the only useful thing to print, so it prints whole.
 *
 * Both exit 1. The distinction costs nothing at the throw site — `throw new Error(...)`
 * is already the refusal and every other class is already the fault — so a door earns the
 * short message by writing a sentence, and a bug keeps the frames that locate it.
 *
 * A body's own `Deno.exit` still ends the process where it stands: an entry that has
 * already said its piece (a usage line, a missing app) exits on its own terms, and only
 * what THROWS meets this rule.
 *
 * The rule reaches past the body too. A daemon's boot happens inside `entry` and its
 * serving does not, so `entry` listens for both ways a failure escapes a running process
 * — a rejected promise nobody awaited and a throw from a callback — and gives each the
 * same two-line treatment Deno would otherwise answer with `Uncaught (in promise)`.
 */

/** Print one failure by the rule above. Never throws — a reporter that fails would hide
 *  the failure it was called to name. */
export function report(err: unknown): void {
  if (err instanceof Error && err.constructor === Error) {
    console.error(err.message);
    return;
  }
  if (err instanceof Error) {
    console.error(err.stack ?? `${err.name}: ${err.message}`);
    return;
  }
  console.error(String(err));
}

/** Run an entry point's body under the rule. Whatever the body returns is dropped — a
 *  process is the caller here, and its answer is the exit code. Returns only if the body
 *  does. */
export async function entry(run: () => unknown): Promise<void> {
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    report(e.reason);
    Deno.exit(1);
  });
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    report(e.error);
    Deno.exit(1);
  });
  try {
    await run();
  } catch (err) {
    report(err);
    Deno.exit(1);
  }
}
