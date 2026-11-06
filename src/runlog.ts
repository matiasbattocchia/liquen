/**
 * runlog.ts — the org's run log, `data/run/liquen.log` (§9): every line whatever runs the
 * org says, stamped `HH:MM:SS [name]`. The supervisor writes its own lines and its
 * children's here, attached or detached, and main raised alone by an interface writes its
 * own; `say` is the one way a line gets there. Attached, the same line prints to the
 * terminal too, each tag in a color of its own and a failure in red, while the file is
 * always plain.
 *
 * The file is bounded as a background job's output is (`halve`): past `RUN_LOG_CAP` on
 * disk, its older half becomes a hole up to the newer half's first line, so the offsets
 * stay and a `tail -f` reads on.
 */

import { halve } from "./hole.ts";
import { SUPERVISOR } from "./stop.ts";

/** The run log, under the data root. */
export const RUN_LOG = "run/liquen.log";

/** What the run log may hold on disk before its older half is given back. */
export const RUN_LOG_CAP = 16 * 1024 * 1024;

/** How many bytes are written between two looks at what the file holds on disk. */
const LOOK_EVERY = 256 * 1024;

const enc = new TextEncoder();
const clock = () => new Date().toLocaleTimeString("en-GB");

/** ANSI foregrounds for the tags, handed out in the order the names first speak: cyan,
 *  green, magenta, blue, yellow, then the bright ones. */
const PALETTE = [36, 32, 35, 34, 33, 96, 92, 95, 94, 93];
const tints = new Map<string, number>();

/** A name's tag as a terminal shows it: the supervisor's own bold, each child its color. */
export function tag(name: string): string {
  if (name === SUPERVISOR) return `\x1b[1m[${name}]\x1b[22m`;
  let tint = tints.get(name);
  if (tint === undefined) tints.set(name, tint = PALETTE[tints.size % PALETTE.length]);
  return `\x1b[${tint}m[${name}]\x1b[39m`;
}

export interface RunLog {
  /** The file's path. */
  path: string;
  /** One line `name` said: to the file, and attached to stderr (`err`, the default) or
   *  stdout, red when it reports a `failure`. */
  say(name: string, line: string, opts?: { err?: boolean; failure?: boolean }): void;
}

/** The run log of the data root `dir`, opened to append; `terminal` when the lines print
 *  there too. */
export function openRunLog(dir: string, terminal: boolean): RunLog {
  const path = `${dir}/${RUN_LOG}`;
  Deno.mkdirSync(`${dir}/run`, { recursive: true });
  const file = Deno.openSync(path, { append: true, create: true });
  const painted = {
    out: terminal && !Deno.noColor && Deno.stdout.isTerminal(),
    err: terminal && !Deno.noColor && Deno.stderr.isTerminal(),
  };
  let written = LOOK_EVERY; // the first line looks
  let halving = false;
  const write = (sink: { writeSync(p: Uint8Array): number }, bytes: Uint8Array) => {
    try {
      for (let at = 0; at < bytes.length;) at += sink.writeSync(bytes.subarray(at));
    } catch { /* a closed terminal or a full disk: the line is lost, the run goes on */ }
  };
  return {
    path,
    say(name, line, { err = true, failure = false } = {}) {
      const at = clock();
      const plain = enc.encode(`${at} [${name}] ${line}\n`);
      write(file, plain);
      written += plain.length;
      if (written >= LOOK_EVERY && !halving) {
        written = 0;
        halving = true;
        void halve(path, RUN_LOG_CAP).finally(() => halving = false);
      }
      if (!terminal) return;
      const shown = painted[err ? "err" : "out"]
        ? enc.encode(
          `\x1b[2m${at}\x1b[22m ${tag(name)} ${failure ? `\x1b[31m${line}\x1b[39m` : line}\n`,
        )
        : plain;
      write(err ? Deno.stderr : Deno.stdout, shown);
    },
  };
}

/** Every line this process prints through `console` goes to the run log as `name`'s: what
 *  a process with no terminal and nobody pumping its output says, its last words
 *  included (`entry` reports through `console.error`). */
export function sayConsole(log: RunLog, name: string): void {
  const text = (args: unknown[]) =>
    args.map((a) =>
      typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : Deno.inspect(a)
    ).join(" ");
  const to = (err: boolean) => (...args: unknown[]) => {
    for (const line of text(args).split("\n")) log.say(name, line, { err });
  };
  console.log = console.info = console.debug = to(false);
  console.error = console.warn = to(true);
}
