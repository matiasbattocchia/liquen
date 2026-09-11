/**
 * entry.ts — how a liquen process ends when it cannot go on (§9).
 *
 * Every entry point runs its body through `entry`: the doors, the daemons, the file
 * binaries. One rule decides what reaches the terminal, and it turns on WHO raised it:
 *
 *   an `Error` this program modeled   a REFUSAL — a sentence written for the person at
 *                     the terminal ("pairing timed out — run the door again"), whether a
 *                     plain `Error` or a class of ours (`DispatchError`, `LeaseLost`). The
 *                     sentence is the whole message: no class name, no frames.
 *   the runtime's own   a `TypeError`, a `RangeError`, a `DOMException`, a `Deno.errors.*`,
 *                     a thrown string: the engine speaking, about a place the code did not
 *                     mean to reach. Nobody chose these to say something, so the stack is
 *                     the only useful thing to print, and it prints whole.
 *
 * A seam that meets the world translates at the seam: `fetch` reports an absent host as a
 * `TypeError`, and `connect/http.ts` turns that into the sentence it is — so the rule here
 * stays about classes, and the knowledge of which runtime error means what lives where
 * the error is caught.
 *
 * Both exit non-zero, and the CODE carries the same distinction the message does: a
 * refusal exits `REFUSAL`, a fault exits 1. That is for the reader that is a program —
 * `liquen start` restarts a child that crashed and gives up on one that refused, because a
 * refusal is a decision about the world as it is, and it will be made identically forever.
 *
 * The distinction costs nothing at the throw site — `throw new Error(...)` is already the
 * refusal, a modeled subclass is one too, and the engine's classes are already the fault —
 * so a door earns the short message by writing a sentence, and a bug keeps the frames.
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

/** The exit code of a refusal — a sentence was printed and nothing about rerunning the
 *  same command would change it. Anything else that fails exits 1. */
export const REFUSAL = 2;

/** Print one failure by the rule above and answer with the code it earns. Never throws —
 *  a reporter that fails would hide the failure it was called to name. */
/** The engine's own error classes. Nobody in this program chose one of these to say
 *  something: they are raised at a place the code did not mean to reach. */
const RUNTIME: readonly (new (...args: never[]) => Error)[] = [
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
  EvalError,
  URIError,
  AggregateError,
  ...(Object.values(Deno.errors) as (new (...args: never[]) => Error)[]),
];

/** Whether `err` is the runtime speaking — a fault — rather than a sentence someone wrote. */
export function fault(err: Error): boolean {
  return err instanceof DOMException || RUNTIME.some((c) => err instanceof c);
}

export function report(err: unknown): number {
  if (err instanceof Error && !fault(err)) {
    console.error(err.message);
    return REFUSAL;
  }
  if (err instanceof Error) {
    console.error(err.stack ?? `${err.name}: ${err.message}`);
    return 1;
  }
  console.error(String(err));
  return 1;
}

/** Run an entry point's body under the rule. Whatever the body returns is dropped — a
 *  process is the caller here, and its answer is the exit code. Returns only if the body
 *  does. */
export async function entry(run: () => unknown): Promise<void> {
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    Deno.exit(report(e.reason));
  });
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    Deno.exit(report(e.error));
  });
  try {
    await run();
  } catch (err) {
    Deno.exit(report(err));
  }
}
