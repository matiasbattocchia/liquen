/**
 * exec/bash.ts — the filesystem substrate's one exec primitive (DESIGN §9).
 *
 * `bash(command, wait?, wake?)` in the agent's workspace, with the binaries on PATH.
 * Deliberately ungated — gates are for outward effects (`send`); the workspace is the
 * agent's own. Discipline (from the pi / Agent-SDK study):
 *
 *   • every call runs as a job (jobs.ts): its own shell, in a process group of its own,
 *     writes what it prints to `{workspace}/.out/bash-<call id>.log` and its exit status
 *     beside it, so the job outlives the harness as well as the call
 *   • the turn waits for the command up to `wait` (120s by default); one still running
 *     then is answered ASYNC with what it printed so far, and runs on: the harness follows
 *     its log, and tells its end — exit status and last lines — as an update on the call
 *     (late.ts)
 *   • stdout+stderr merged in arrival order
 *   • the middle cut (2000 lines / 50KB: its start and its end kept); the FULL output stays
 *     in the log and the footer names it — the gap says the `aread` that reads what went
 *   • non-zero exit ⇒ error result carrying the output + exit code (the agent's
 *     self-correction path)
 *   • `wake`, a regular expression: the lines a call's output prints after its answer
 *     that match it are told as updates, which wake the agent; the rest stay in the log,
 *     the latest of them standing under the job's line in the ambient block
 */

import type { CallRef, ExecFacts, ExecOutcome, ExecTool } from "../xi.ts";
import { type AgentUser, agentUser, own, ownTree } from "./user.ts";
import type { Bubble } from "./bubble.ts";
import type { BinDir, Json } from "../types.ts";
import { newId } from "../store/id.ts";
import { MEDIA_MARK } from "../store/media.ts";
import { MAX_BYTES, MAX_LINES, type MiddleCut, truncateMiddle, truncateTail } from "./truncate.ts";
import { DEFAULT_BASH_WAIT_MS } from "../config.ts";
import { USAGE } from "../bin/usage.ts";
import type { ToolShape } from "../tooldoc.ts";
import {
  type Found,
  type Job,
  JOB_ENV,
  JOB_SHELL,
  jobCommand,
  jobFiles,
  type JobHost,
  jobLines,
  Jobs,
  type Look,
  LOOK_BYTES,
  type Member,
  parseMembers,
  quote,
  type ShellUpdate,
  Spool,
  SPOOL_CAP,
  SPOOL_KEEP_MS,
} from "./jobs.ts";

const kb = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

/** Sticky cwd shared with the plane so it can report the current directory. */
export interface BashState {
  cwd: string;
}

export interface BashOptions {
  workspace: string; // the agent's cwd; created on install
  binPath?: string; // prepended to PATH — one or more dirs, `:`-joined (shipped, then org)
  defaultWaitMs?: number; // default 120s
  /** Per-SESSION jobs (§9): each command runs in its own process group, and a call still
   *  running past its wait, or a group that still has members after the call (a `cmd &`
   *  job), is followed here, so the shell can list it in the ambient block and tell its
   *  end. One set per shell → ownership. */
  jobs?: Jobs;
  state?: BashState; // sticky cwd, published for the plane's ambient snapshot
  /** Extra env ISSUED into every spawn (evaluated per call — placeholders can rotate).
   *  This is the ONLY channel besides the allowlist by which user space learns anything:
   *  the egress proxy's HTTPS_PROXY/SSL_CERT_FILE/placeholder-token land here (§9), and so
   *  do the variables an agent's `export` knob names. Never put a real secret in it — the
   *  whole point is that user space holds only handles. */
  env?: () => Promise<Record<string, string>>;
  /** The Linux user every spawn RUNS AS (§9, the container story): user space is not just
   *  an empty pocket but a different owner — the kernel enforces the data classification.
   *  Only meaningful when the harness runs as root; absent, spawns keep the process uid. */
  user?: AgentUser;
  /** The bubble every spawn runs inside (exec/bubble.ts): the classification enforced by
   *  what the shell can see, and the egress proxy its only network. */
  bubble?: Bubble;
}

// Process-group isolation (`setsid`) lets us kill a command's whole tree — including a
// backgrounded grandchild — by the group. Not on macOS; fall back to a bare spawn there.
let _hasSetsid: boolean | undefined;
function hasSetsid(): boolean {
  if (_hasSetsid === undefined) {
    try {
      new Deno.Command("setsid", { args: ["true"], stdout: "null", stderr: "null" }).outputSync();
      _hasSetsid = true;
    } catch {
      _hasSetsid = false;
    }
  }
  return _hasSetsid;
}

/** Whether a `cd` in a call moves where the next one starts: the job writes where its
 *  command ended (`.cwd`), and with this on that is the next call's start. Off: every call starts where
 *  the shell stands (the workspace, or the place `stand` was given), and a `cd` lasts its
 *  call. The model writes `cd dir && …` at the head of a call by habit; with the cwd kept,
 *  that `cd` fails on the next call from inside dir, silently in a `;` chain (a vibes
 *  session, 2026-10-09: four times, one false result). The sticky code stays for a second
 *  look. */
export const STICKY_CWD = false;

// User space starts with an EMPTY pocket (clearEnv): the harness process's environment —
// API keys, bridge tokens, whatever it was launched with — never leaks into the agent's
// shell. What a tool binary legitimately needs is issued by NAME:
//   HOME        git/ssh/CLI config discovery
//   LANG/LC_ALL encoding — without them tools drop to C locale and mangle UTF-8
//   TMPDIR      honored where set
//   USER/LOGNAME/SHELL  identity fallbacks (git author guessing, whoami)
// PATH is built, TERM is fixed to `dumb` (no TTY to paint). Anything every org needs gets
// added here by name, with a reason; what one org's tools need from its machine (DISPLAY
// for a browser someone watches) is its agents' `export` knob, issued through `env` below.
// This list and that knob are what user space is allowed to know.
const ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL"];
/** How often the shell looks at its jobs with nothing else asking: a probe of each group (a
 *  `cmd &` grandchild is not ours to await), cheap enough to run often, so an end the files
 *  do not show — a group emptied by a kill — is told seconds after it happens. */
export const JOB_PROBE_MS = 2_000;
/** A job's files change in bursts: a look follows the first change by this long, and
 *  takes the rest of the burst with it. */
const WATCH_SETTLE_MS = 50;

function userSpaceEnv(binPath?: string): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const name of ENV_ALLOWLIST) {
    const v = Deno.env.get(name);
    if (v !== undefined) env[name] = v;
  }
  // the shims exec `deno` by name: the one that runs the harness is on the path, wherever
  // it was installed, ahead of whatever the box has
  const runtime = Deno.execPath().replace(/\/[^/]+$/, "");
  const inherited = Deno.env.get("PATH") ?? "";
  env.PATH = [binPath, runtime, inherited].filter(Boolean).join(":");
  return env;
}

/** The bash tool's schema and the numbers its doc names — the same contract wherever the
 *  shell runs; its words are `system/tools/bash.md` (tooldoc.ts). */
export function bashShape(waitMsDefault: number): ToolShape {
  return {
    spec: {
      name: "bash",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          wait: { type: "number" },
          wake: { type: "string" },
          max_lines: { type: "number" },
          max_bytes: { type: "number" },
        },
        required: ["command"],
      },
    },
    vars: {
      wait: waitMsDefault / 1000,
      max_lines: MAX_LINES,
      max_kb: MAX_BYTES / 1024,
      max_bytes: MAX_BYTES,
    },
  };
}

/** The input a bash call carries. */
export interface BashInput {
  command: string;
  wait?: number;
  wake?: string;
  max_lines?: number;
  max_bytes?: number;
}

/** A call's output as its answer has it: what the log held when the call answered. */
export interface Printed {
  output: string;
  /** The log's whole size, past any part of it this text leaves out. */
  bytes: number;
  /** The text is the log's end only: its head was too much to read (`LOOK_BYTES`), or was
   *  dropped at the cap. */
  partial: boolean;
  /** Where the whole of it lies. */
  log: string;
}

/** Output in the call's window: its start and its end, the middle left out where it does
 *  not fit and the gap saying what is gone and how to read it; the footer names the log
 *  when the window cut it — `spill` is told so, since the log is then the answer's to keep.
 *  A text that is the log's end only has no start to keep: its tail is what it shows. Empty
 *  when nothing was printed. */
export function windowed(printed: Printed, input: BashInput, spill?: () => void): string {
  // the model may widen/narrow the window
  const limits = { maxLines: input.max_lines, maxBytes: input.max_bytes };
  const output = printed.output.trimEnd();
  if (printed.partial) {
    const t = truncateTail(output, limits);
    if (!t.text) return "";
    spill?.();
    return `${t.text}\n\n[showing its last lines of ${
      kb(printed.bytes)
    } — full output: ${printed.log}]`;
  }
  const t = truncateMiddle(output, limits);
  if (!t.truncated || !t.gap) return t.head;
  spill?.();
  const footer = `[${t.totalLines} lines, ${kb(printed.bytes)} — full output: ${printed.log}]`;
  return [t.head, `[${gapNote(t.gap, printed.log)}]`, t.tail, footer].filter(Boolean).join("\n\n");
}

/** What a cut left out, and the read that brings it back: whole lines page through `aread`
 *  as any file does; a line read alone needs a window as wide as it is. */
function gapNote(gap: NonNullable<MiddleCut["gap"]>, log: string): string {
  const count = gap.to - gap.from + 1;
  const read = count === 1
    ? `aread ${log} ${gap.from} 1${gap.lineBytes > MAX_BYTES ? ` ${gap.lineBytes}` : ""}`
    : `aread ${log} ${gap.from} ${count}`;
  if (gap.edges && count === 1) {
    return `… ${kb(gap.bytes)} of line ${gap.from} left out — the whole line: ${read}`;
  }
  const lines = count === 1 ? `line ${gap.from}` : `lines ${gap.from}-${gap.to}`;
  return gap.edges
    ? `… ${kb(gap.bytes)} left out, within ${lines} — read them: ${read}`
    : `… ${lines} left out (${kb(gap.bytes)}) — read ${count === 1 ? "it" : "them"}: ${read}`;
}

/** A call's output and exit status → its result: the text in its window (`spill` told when
 *  the log must stay, the answer naming it), `note` after it, and a non-zero exit or an
 *  abort thrown as the error result carrying the output. Media marks (`aread` on a bytes
 *  file, §5) come off the text as the result's attachments. */
export function settle(
  printed: Printed,
  end: { exitCode: number; aborted?: boolean },
  input: BashInput,
  spill?: () => void,
  report?: (facts: ExecFacts) => void,
  note?: string,
): Json | ExecOutcome {
  const { exitCode } = end;
  // the run's facts, said before any window narrows the output or a failure throws it
  report?.({ exit_code: exitCode, bytes: printed.bytes });

  let text = windowed(printed, input, spill) || "(no output)";
  if (note) text += `\n\n${note}`;

  if (end.aborted) throw new Error(`${text}\n\nCommand aborted`);
  if (exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);

  const files: string[] = [];
  const kept = text.split("\n").filter((line) => {
    if (!line.startsWith(MEDIA_MARK)) return true;
    files.push(line.slice(MEDIA_MARK.length));
    return false;
  });
  if (files.length === 0) return text;
  const outcome: ExecOutcome = { output: kept.join("\n").trimEnd() || "(no output)", files };
  return outcome;
}

/** The window an update's tail is cut to: the call's own. */
export const windowOf = (input: BashInput): Job["window"] => ({
  ...(input.max_lines !== undefined ? { max_lines: input.max_lines } : {}),
  ...(input.max_bytes !== undefined ? { max_bytes: input.max_bytes } : {}),
});

/** What a look found in a job's log, as the answer reads it. */
const printedOf = (look: Look, log: string): Printed => ({
  output: new TextDecoder().decode(look.bytes),
  bytes: look.size,
  partial: look.skipped || look.shifted,
  log,
});

/** An answer whose job runs on: its end is owed, so the result is async (late.ts), an error
 *  one included — a thrown error carries no such word. */
function asAsync(answer: () => Json | ExecOutcome): ExecOutcome {
  try {
    const a = answer();
    return typeof a === "string"
      ? { output: a, files: [], async: true }
      : { ...(a as ExecOutcome), async: true };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    return { output, files: [], async: true, is_error: true };
  }
}

/** Follow a job on, waking on what the call asked to be woken by. */
function follow(jobs: Jobs, job: Job, wake?: RegExp): void {
  jobs.follow(job);
  if (wake) jobs.wake(job, wake);
}

/** How a call's wait ended, beside the look at its job. */
export interface Waited {
  input: BashInput;
  waitMs: number;
  wake?: RegExp;
  report?: (facts: ExecFacts) => void;
  aborted: boolean;
  /** Its shell's own status, where the harness awaited it: the exit status when the job
   *  wrote none (it was killed). */
  code?: number;
  /** The job leads a group of its own: what it leaves running is told by the group. */
  isolated: boolean;
}

/** A call's answer once its wait is over (§9), wherever its job ran: what it printed and how
 *  it exited — or, still running, or with something left running in its group, the job
 *  followed on and the answer async. `spill` is told when the answer names the log, which
 *  then stays. A failure throws, as `settle` does. */
export async function answered(
  jobs: Jobs,
  job: Job,
  look: Look,
  w: Waited,
  spill?: () => void,
): Promise<Json | ExecOutcome> {
  job.read = look.size;
  job.spool.feed(look.bytes, false); // what it printed is the answer's; its last line, the glance
  const printed = printedOf(look, job.files.log);
  const group = w.isolated ? ` as group ${job.pgid}` : "";
  if (look.rc === undefined && look.running && !w.aborted) {
    // still running at the end of its wait: answered with what it printed so far, and
    // followed on
    w.report?.({ bytes: printed.bytes });
    follow(jobs, job, w.wake);
    const text = windowed(printed, w.input) || "(no output yet)";
    return {
      output: `${text}\n\n[still running after ${w.waitMs / 1000}s${group}: what it prints ` +
        `goes on in ${job.files.log}, and you are told when it ends]`,
      files: [],
      async: true,
    };
  }
  // its shell exited, or was killed: the exit status is the one it wrote, unless the kill
  // came first
  const exitCode = look.rc ?? w.code;
  if (exitCode === undefined) {
    w.report?.({ bytes: printed.bytes });
    throw new Error(
      `${windowed(printed, w.input, spill) || "(no output)"}\n\n[killed before its exit ` +
        "status was written]",
    );
  }
  // a group that still has members after its shell exited is a job the command left
  // (`cmd &`): the OS says so, never a parse of the command
  if (w.isolated && !w.aborted && look.alive) {
    job.ended = true;
    await jobs.host.told(job);
    follow(jobs, job, w.wake);
    const note = `[left running${group}: what it prints goes on in ${job.files.log}; you are ` +
      "told when it ends]";
    // what it left is told later, so the answer is async like one past its wait: a
    // harness that goes down first owes its end (late.ts)
    return asAsync(() => settle(printed, { exitCode }, w.input, undefined, w.report, note));
  }
  return settle(printed, { exitCode, aborted: w.aborted }, w.input, spill, w.report);
}

/** A call's `wake`, as a job found again follows it: one that will not compile was refused
 *  when the call was made, and is none here. */
function wakeAgain(pattern: string | undefined): RegExp | undefined {
  try {
    return wakeOf(pattern);
  } catch {
    return undefined;
  }
}

const WENT = "the harness went down while it ran";

/** What a call the last harness never answered left, as the call's answer (§9): how its job
 *  ended, or — still running — answered async and followed on, its end told later.
 *  Undefined when the call left no job. */
export async function recovered(
  jobs: Jobs,
  out: string,
  input: BashInput,
  use: CallRef,
): Promise<Json | ExecOutcome | undefined> {
  const found = await jobs.adopt(use.id, out, use, input.command, windowOf(input));
  if (!found) return undefined;
  const { job, look } = found;
  job.spool.take(); // the answer is what it printed so far
  const printed = printedOf(look, job.files.log);
  const runs = `it runs on as group ${job.pgid}: what it prints goes on in ${job.files.log}, ` +
    "and you are told when it ends";
  if (look.gone) throw new Error(`[${WENT}; ${look.gone}]`);
  if (look.rc !== undefined && !look.running) {
    const exitCode = look.rc;
    job.ended = true;
    if (look.alive) {
      await jobs.host.told(job);
      follow(jobs, job, wakeAgain(input.wake));
      return asAsync(() =>
        settle(printed, { exitCode }, input, undefined, undefined, `[${WENT}; what ${runs}]`)
      );
    }
    await jobs.host.done(job);
    return settle(printed, { exitCode }, input, undefined, undefined, `[${WENT}, and it ended]`);
  }
  if (look.running || look.alive) {
    job.unseen = false; // seen running, by this answer
    follow(jobs, job, wakeAgain(input.wake));
    const text = windowed(printed, input) || "(no output yet)";
    return { output: `${text}\n\n[${WENT}; ${runs}]`, files: [], async: true };
  }
  await jobs.host.done(job);
  throw new Error(
    `${windowed(printed, input) || "(no output)"}\n\n[${WENT}, and it was killed before its ` +
      "exit status was written]",
  );
}

/** A call the last harness answered async and never told the end of, followed on (§9):
 *  its end is told when it comes — at once, when it came while nobody followed it. False
 *  when the call left no job. */
export async function resumed(
  jobs: Jobs,
  out: string,
  input: BashInput,
  use: CallRef,
): Promise<boolean> {
  const found = await jobs.adopt(use.id, out, use, input.command, windowOf(input));
  if (!found) return false;
  follow(jobs, found.job, wakeAgain(input.wake));
  await jobs.look();
  return true;
}

export function bashTool(opts: BashOptions): ExecTool {
  const waitMsDefault = opts.defaultWaitMs ?? DEFAULT_BASH_WAIT_MS;
  // the cwd lives in the shared state when the plane provides one (so it can report it),
  // else in a local closure var
  const state = opts.state ?? { cwd: opts.workspace };
  const jobs = opts.jobs ?? new Jobs(localHost());
  // the jobs' files sit in the agent's own folder wherever the shell stands — never in a
  // repo it walked into; written by the job as the agent's uid, the agent's to keep
  const out = `${opts.workspace}/.out`;

  return {
    ...bashShape(waitMsDefault),

    async execute(
      input: Json,
      signal: AbortSignal,
      report?: (facts: ExecFacts) => void,
      use?: CallRef,
    ): Promise<Json | ExecOutcome> {
      const call = input as unknown as BashInput;
      const { command } = call;
      const waitMs = call.wait !== undefined ? call.wait * 1000 : waitMsDefault;
      const wake = wakeOf(call.wake);
      const env = { ...userSpaceEnv(opts.binPath), ...(await opts.env?.()) };
      if (opts.user) {
        // the identity trio follows the uid, not the harness process
        Object.assign(env, { HOME: opts.user.home, USER: opts.user.name, LOGNAME: opts.user.name });
      }
      // a bubble shows neither the user's home nor their temp dir: the agent's folder is
      // HOME and the bubble's own /tmp is TMPDIR
      if (opts.bubble) Object.assign(env, { HOME: opts.workspace, TMPDIR: "/tmp" });
      await Deno.mkdir(out, { recursive: true });
      await own(out, opts.user);
      // the call's id names its job: a harness that finds the call unanswered finds the job
      const id = use?.id ?? newId();
      const files = jobFiles(out, id);

      // the job's shell in a session and process group of its own (setsid): an abort kills
      // the whole tree, a background job the command leaves is told by the group, and
      // nothing of it dies with the harness
      const isolated = hasSetsid();
      const args = ["-c", JOB_SHELL, "liquen-job", files.base, jobCommand(command, files)];
      let child: Deno.ChildProcess;
      try {
        // in a bubble the job's shell has the bubble's own pid: its group is written from
        // outside, where the number is the one the harness probes and kills
        const entry = opts.bubble
          ? ["sh", "-c", `echo "$$" > ${quote(files.pgid)} && exec "$@"`, "liquen-job"]
            .concat(await opts.bubble.enter(state.cwd))
          : [];
        const shell = [...entry, "bash", ...args];
        child = new Deno.Command(isolated ? "setsid" : shell[0], {
          args: isolated ? shell : shell.slice(1),
          cwd: state.cwd,
          clearEnv: true,
          env: { ...env, [JOB_ENV]: id },
          ...(opts.user ? { uid: opts.user.uid, gid: opts.user.gid } : {}),
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
      } catch (err) {
        // the shell could not stand where it was: the directory is gone, or this uid may
        // not enter it. Said once, and the next call starts from the workspace — a place
        // the shell can always stand — instead of every call failing before `cd` can run.
        if (state.cwd === opts.workspace) throw err;
        const lost = state.cwd;
        state.cwd = opts.workspace;
        throw new Error(
          `${lost}: cannot stand there (${err instanceof Error ? err.message : String(err)})` +
            ` — the next call starts in ${opts.workspace}`,
        );
      }
      const pgid = child.pid; // setsid exec's bash → pid == group id
      const killGroup = () => {
        try {
          Deno.kill(isolated ? -pgid : pgid, "SIGKILL"); // the whole tree
        } catch { /* already gone */ }
      };

      const started = Date.now();
      const onAbort = () => killGroup();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<undefined>((r) => {
        waitTimer = setTimeout(() => r(undefined), waitMs);
      });
      const status = await Promise.race([child.status, waited]);
      clearTimeout(waitTimer);
      signal.removeEventListener("abort", onAbort);

      const job: Job = {
        id,
        files,
        pgid,
        command: command.trim(),
        since: started,
        ...(use ? { use } : {}),
        window: windowOf(call),
        read: 0,
        spool: new Spool(files.log),
        ended: false,
      };
      if (status === undefined) {
        child.status.then(() => jobs.look())
          .catch((err) => console.error(`[bash] group ${pgid}:`, err));
      } else if (STICKY_CWD && !signal.aborted) {
        const dir = (await Deno.readTextFile(files.cwd).catch(() => "")).trim();
        if (dir) state.cwd = dir;
      }
      const look = (await jobs.host.look([job])).get(job)!;
      const how: Waited = {
        input: call,
        waitMs,
        ...(wake ? { wake } : {}),
        ...(report ? { report } : {}),
        aborted: signal.aborted,
        ...(status ? { code: status.code } : {}),
        isolated,
      };
      let spilled = false;
      try {
        return await answered(jobs, job, look, how, () => spilled = true);
      } finally {
        // nothing of it runs: the job is over and its files go, the log kept when the
        // answer names it
        if (!jobs.has(job)) await forget(files, spilled);
      }
    },

    recover: (input, use) => recovered(jobs, out, input as unknown as BashInput, use),
  };
}

/** The `wake` pattern a call carries, compiled; absent when it carries none. */
export function wakeOf(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern === "") return undefined;
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(`wake: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const ignoreGone = (err: unknown) => {
  if (!(err instanceof Deno.errors.NotFound)) throw err;
};

/** A job's record gone, its log kept (touched: its days count from now) or removed. */
async function forget(files: ReturnType<typeof jobFiles>, keepLog: boolean): Promise<void> {
  for (const path of [files.pgid, files.rc, `${files.rc}~`, files.end, files.cwd]) {
    await Deno.remove(path).catch(ignoreGone);
  }
  if (!keepLog) await Deno.remove(files.log).catch(ignoreGone);
  else {
    const now = new Date();
    await Deno.utime(files.log, now, now).catch(ignoreGone);
  }
}

/** The logs no job runs behind any more, removed once `SPOOL_KEEP_MS` passed since their
 *  last word. */
export async function sweepLogs(out: string, now = Date.now()): Promise<void> {
  try {
    for await (const entry of Deno.readDir(out)) {
      const m = /^bash-(.+)\.log$/.exec(entry.name);
      if (!m) continue;
      const files = jobFiles(out, m[1]);
      const stat = await Deno.stat(files.log).catch(() => undefined);
      if (!stat?.mtime || now - stat.mtime.getTime() < SPOOL_KEEP_MS) continue;
      // a group file left by a harness gone before it cleaned up holds no job: the group
      // must still carry the call's mark
      const pgid = await Deno.readTextFile(files.pgid).then((s) => Number(s.trim()), () => NaN);
      if (Number.isInteger(pgid) && await marked(pgid, m[1])) continue;
      await forget(files, false);
    }
  } catch (err) {
    ignoreGone(err);
  }
}

async function readAt(file: Deno.FsFile, start: number, end: number): Promise<Uint8Array> {
  const buf = new Uint8Array(Math.max(0, end - start));
  await file.seek(start, Deno.SeekMode.Start);
  let at = 0;
  while (at < buf.length) {
    const n = await file.read(buf.subarray(at));
    if (n === null) break;
    at += n;
  }
  return buf.subarray(0, at);
}

/** A job's log from `from` on, as one look reads it: its older half dropped first when it
 *  holds more than `SPOOL_CAP` on disk, and only its last `LOOK_BYTES` when more than that
 *  is new. */
async function readLog(
  path: string,
  from: number,
): Promise<Pick<Look, "bytes" | "size" | "shifted" | "skipped">> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (err) {
    ignoreGone(err);
    return { bytes: new Uint8Array(), size: 0, shifted: false, skipped: false };
  }
  try {
    const stat = await file.stat();
    const size = stat.size;
    let shifted = false;
    let skipped = false;
    if ((stat.blocks ?? 0) * 512 > SPOOL_CAP) {
      // a hole punched up to the newer half's first line: the offsets stay, and what the
      // job appends meanwhile lies past `size`, out of the hole's reach
      const start = size - SPOOL_CAP / 2;
      const head = await readAt(file, start, Math.min(size, start + 64 * 1024));
      const cut = start + head.indexOf(10) + 1;
      shifted = await punch(path, cut);
      if (shifted && from < cut) [from, skipped] = [cut, true];
    }
    if (size - from > LOOK_BYTES) {
      from = size - LOOK_BYTES;
      skipped = true;
    }
    const bytes = await readAt(file, from, size);
    return { bytes, size: from + bytes.length, shifted, skipped };
  } finally {
    file.close();
  }
}

/** The file's first `bytes` given back to the disk; they read as zeros after. */
async function punch(path: string, bytes: number): Promise<boolean> {
  const args = ["--punch-hole", "--offset", "0", "--length", String(bytes), path];
  const { success } = await new Deno.Command("fallocate", { args, stderr: "null" }).output();
  return success;
}

/** Is the process still running? (harmless probe.) */
function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGWINCH");
    return true;
  } catch {
    return false;
  }
}

/** Does a process of group `pgid` carry the call's id (`JOB_ENV`)? What tells a job's group
 *  from a stranger's that took its number — read off `/proc`, so never where there is
 *  none. */
async function marked(pgid: number, id: string): Promise<boolean> {
  const mark = `${JOB_ENV}=${id}`;
  try {
    for await (const entry of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(entry.name)) continue;
      try {
        const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
        // `pid (comm) state ppid pgrp …`: the command may hold spaces and parentheses
        if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !== pgid) continue;
        const environ = await Deno.readTextFile(`/proc/${entry.name}/environ`);
        if (environ.split("\0").includes(mark)) return true;
      } catch { /* gone meanwhile, or not ours to read */ }
    }
  } catch { /* no /proc */ }
  return false;
}

/** This machine as the jobs' host (jobs.ts): the files read where they lie, the group asked
 *  of the kernel, and every change to the files seen as it happens (inotify). */
export function localHost(): JobHost {
  return {
    probeMs: JOB_PROBE_MS,
    async look(jobs) {
      const looks = new Map<Job, Look>();
      for (const job of jobs) {
        // the processes first, the files after: a shell seen gone has written its status
        const running = pidAlive(job.pgid);
        const alive = running || groupAlive(job.pgid);
        const rc = await Deno.readTextFile(job.files.rc).then((s) => Number(s.trim()), () => NaN);
        const told = await Deno.stat(job.files.end).then(() => true, () => false);
        const log = await readLog(job.files.log, job.read);
        looks.set(job, {
          ...log,
          ...(Number.isInteger(rc) ? { rc } : {}),
          ...(told ? { told } : {}),
          running,
          alive,
        });
      }
      return looks;
    },
    async find(id, out): Promise<Found | null> {
      const files = jobFiles(out, id);
      try {
        const [text, stat] = await Promise.all([
          Deno.readTextFile(files.pgid),
          Deno.stat(files.pgid),
        ]);
        const pgid = Number(text.trim());
        if (!Number.isInteger(pgid) || pgid <= 1) return null;
        return {
          pgid,
          since: stat.mtime?.getTime() ?? Date.now(),
          ours: await marked(pgid, id),
        };
      } catch (err) {
        ignoreGone(err);
        return null;
      }
    },
    told: (job) => Deno.rename(job.files.rc, job.files.end).catch(ignoreGone),
    async done(job) {
      await forget(job.files, true);
      await sweepLogs(job.files.base.slice(0, job.files.base.lastIndexOf("/")));
    },
    kill(jobs) {
      for (const job of jobs) {
        try {
          Deno.kill(-job.pgid, "SIGKILL");
        } catch {
          try {
            Deno.kill(job.pgid, "SIGKILL"); // no group of its own (no setsid)
          } catch { /* already gone */ }
        }
      }
      return Promise.resolve();
    },
    watch(job, changed) {
      let watcher: Deno.FsWatcher;
      try {
        watcher = Deno.watchFs(job.files.base.slice(0, job.files.base.lastIndexOf("/")), {
          recursive: false,
        });
      } catch {
        return () => {}; // the probe alone, then
      }
      const name = `bash-${job.id}.`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      (async () => {
        for await (const e of watcher) {
          if (timer !== undefined || !e.paths.some((p) => p.includes(name))) continue;
          timer = setTimeout(() => {
            timer = undefined;
            changed();
          }, WATCH_SETTLE_MS);
        }
      })().catch(() => {});
      return () => {
        clearTimeout(timer);
        watcher.close();
      };
    },
  };
}

/** One SESSION's shell on its agent's ground (§9): its own cwd and its own job set.
 *  Two sessions of one agent stand in one folder but never in one place — a client placing
 *  one session's shell, or a `cd` in it, moves nothing for its siblings. */
export interface ExecPlane {
  exec: Record<string, ExecTool>;
  /** Where the shell stands now: where its next call starts, and what a relative file
   *  reference is from. */
  cwd(): string;
  /** Live environment lines for the ambient block (§5): cwd · git (if a repo) · background
   *  jobs (dead ones pruned here — the reliable, every-think place, not at registration). */
  ambient(): Promise<string[]>;
  /** Kill every job this shell follows (§9): the org was stopped (`liquen stop`). Each is
   *  told killed, where the shell tells its jobs. */
  reap(): Promise<void>;
  /** Stop following this shell's jobs and leave them running: the harness restarts, and
   *  the next one adopts them (`resume`). */
  leave(): void;
  /** Follow on a job a call left, which the last harness answered async and never told
   *  the end of (late.ts): false when the call left none. */
  resume(use: CallRef, input: BashInput): Promise<boolean>;
  /** Where the next call starts: the principal's own directory while an interface attached
   *  from one is connected (the door passes it along), the workspace when none is given.
   *  The place is tried first, by the same spawn a call makes and as the same uid, so a
   *  directory the agent cannot stand in is refused here — at the attach — and the shell
   *  never moves. A `cd` in a call lasts the call (STICKY_CWD). */
  stand(path?: string): Promise<void>;
  /** The programs the org's folder puts on PATH, by directory in PATH order — the prefix
   *  lists them after the docs (§5). */
  bins?(): Promise<BinDir[]>;
}

/** One AGENT's ground (§9): the workspace, the PATH cascade, the uid — prepared once.
 *  `shell()` opens a session's shell on it; `tell` is where it tells what its calls do
 *  after their answers (late.ts). */
export interface ExecGround {
  shell(tell?: (u: ShellUpdate) => void): ExecPlane;
  /** Let go of the ground's bubbles: with `jobs: "end"` they end, and what runs in them;
   *  else they stay for the next harness, holding the jobs it adopts. Nothing to do
   *  without a bubble. */
  close(jobs: "end" | "leave"): Promise<void>;
}

/** Is a process group still alive? (harmless probe.) */
function groupAlive(pgid: number): boolean {
  try {
    Deno.kill(-pgid, "SIGWINCH");
    return true;
  } catch {
    return false;
  }
}

async function gitLine(cwd: string): Promise<string | null> {
  try {
    const branch = new TextDecoder().decode(
      (await new Deno.Command("git", {
        args: ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ).trim();
    if (!branch) return null; // not a repo (or git absent)
    const dirty = new TextDecoder().decode(
      (await new Deno.Command("git", {
        args: ["-C", cwd, "status", "--porcelain"],
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ).trim().split("\n").filter((l) => l.length > 0).length;
    return `git: ${branch}${dirty ? ` · ${dirty} uncommitted` : " · clean"}`;
  } catch {
    return null; // git not installed / not a repo
  }
}

/** A shell's ambient lines (§5): cwd · git (if a repo) · background jobs. Looks at the jobs
 *  here too — the every-think place — so an end this look sees first is told before the
 *  list leaves it out. */
export async function bashAmbient(state: BashState, jobs: Jobs): Promise<string[]> {
  const lines = [`cwd: ${state.cwd}`];
  const git = await gitLine(state.cwd);
  if (git) lines.push(git);
  await jobs.look();
  return [...lines, ...jobLines(jobs, await groupMembers(jobs))];
}

/** The live members of the jobs' groups, from one `ps`. Empty when there are no jobs, or
 *  when ps is missing: the job lines then fall back to the launch command. */
async function groupMembers(jobs: Jobs): Promise<Map<number, Member[]>> {
  if (jobs.size === 0) return new Map();
  try {
    const out = await new Deno.Command("ps", {
      args: ["-e", "-o", "pgid=,pid=,args="],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return parseMembers(new TextDecoder().decode(out.stdout), [...jobs].map((j) => j.pgid));
  } catch {
    return new Map();
  }
}

/** This process's module cache — the one the shims read. Asked of the deno that runs the
 *  harness (once per process), since the default is per user and the shims run as the
 *  agent's uid. */
let harnessDenoDir: Promise<string> | undefined;
export function denoDir(): Promise<string> {
  return harnessDenoDir ??= new Deno.Command("deno", {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output().then((o) => JSON.parse(new TextDecoder().decode(o.stdout)).denoDir as string);
}

/** The harness's own tools, on disk where a shell can exec them: `aread`/`awrite`/`aedit`
 *  under `<dir>/system/bin`, each a shim running `bin/afs.ts` by the URL this package
 *  resolves it at, and `fetch` running `bin/fetch.ts` the same way. Laid on every boot —
 *  the shims are the package's, not the org's, and a package upgrade must reach them.
 *
 *  A shim runs as the agent's uid, which has no module cache of its own and no way to fill
 *  one (the egress proxy does not front the registry, §9), so it reads THIS process's cache
 *  — `DENO_DIR` pinned in the shim line, `--cached-only` so an agent's `aread` never reaches
 *  for the network — and every boot warms that cache first (`deno cache` of the module by
 *  its URL: a no-op once it is there; a fetch the harness, not the agent, makes). The pin
 *  lives in the shim, not the agent's environment: a script the agent writes runs on the
 *  agent's own deno, with its own cache and the proxy's network. `fetch` dials the world
 *  through the proxy the environment names, trusting the liquen CA the same environment
 *  names as `DENO_CERT`. Returns the directory. */
async function layShims(dir: string): Promise<string> {
  const bin = `${dir}/system/bin`;
  await Deno.mkdir(bin, { recursive: true });
  const afs = import.meta.resolve("../bin/afs.ts");
  const http = import.meta.resolve("../bin/fetch.ts");
  const warmed = (url: string) =>
    new Deno.Command("deno", { args: ["cache", url], stdout: "null", stderr: "piped" }).output()
      .then((o) => {
        if (!o.success) {
          throw new Error(
            `cannot cache ${url} for the shims: ${new TextDecoder().decode(o.stderr).trim()}`,
          );
        }
      });
  const [cache] = await Promise.all([denoDir(), warmed(afs), warmed(http)]);
  const shim = async (name: string, line: string) => {
    const path = `${bin}/${name}`;
    await Deno.writeTextFile(path, `#!/bin/sh\n${line}\n`);
    await Deno.chmod(path, 0o755);
  };
  for (const [name, verb] of [["aread", "read"], ["awrite", "write"], ["aedit", "edit"]]) {
    await shim(
      name,
      `exec env DENO_DIR='${cache}' deno run --cached-only --allow-read --allow-write '${afs}' ${verb} "$@"`,
    );
  }
  await shim(
    "fetch",
    `exec env DENO_DIR='${cache}' deno run --cached-only --allow-net --allow-env --allow-read --allow-write '${http}' "$@"`,
  );
  return bin;
}

/** The executables in each directory, sorted; a directory with none is left out. Those in
 *  `shipped`, the harness's own, carry their usage from the package's source — nothing on
 *  PATH is ever run to describe it. Read fresh on every turn, so a program installed
 *  mid-session is listed on the next one. */
export async function binsIn(dirs: string[], shipped?: string): Promise<BinDir[]> {
  const out: BinDir[] = [];
  for (const dir of dirs) {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) continue;
        const stat = await Deno.stat(`${dir}/${entry.name}`).catch(() => undefined);
        if (stat?.isFile && ((stat.mode ?? 0) & 0o111) !== 0) names.push(entry.name);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    if (names.length === 0) continue;
    const programs = names.sort().map((name) =>
      dir === shipped && USAGE[name] ? { name, usage: USAGE[name] } : { name }
    );
    out.push({ dir, programs });
  }
  return out;
}

/** The harness's own programs where an image lays them rather than a boot: every one of
 *  them, with its usage. */
export function shippedAt(dir: string): BinDir {
  return { dir, programs: Object.keys(USAGE).sort().map((name) => ({ name, usage: USAGE[name] })) };
}

/** Prepare ONE agent's ground: its workspace, PATH shims, uid. The workspace IS
 *  the agent's own folder — `agents/<id>`, the same tree its docs and memories live in —
 *  because a shell is not org furniture: two agents sharing a cwd share half-written files,
 *  clobber each other's scratch, and read each other's notes with no policy in the way (§6
 *  stops at the log, not at the filesystem). Landing ON the folder rather than in a subdir
 *  of it is what makes the docs reachable by relative path: the agent's notes are where it
 *  already stands, so writing one is `awrite memories/x.md`, not a path it must be told.
 *  PATH is the doc cascade in binary form — the same widening scopes, narrowest FIRST so
 *  nothing below can shadow a contract the layer above must keep:
 *    `<dir>/system/bin`       the harness's own — `aread`/`awrite`/`aedit`/`fetch`, shims
 *                             every boot lays, each running the package's `bin/afs.ts` or
 *                             `bin/fetch.ts` where the package is (a checkout's file, the
 *                             registry's URL) out of the harness's own module cache, so the
 *                             tool answers for the version that booted and never fetches
 *                             its own code from an agent's uid.
 *    `<dir>/shared/bin`          what the org installs for all its agents (`gws`).
 *    `<dir>/agents/<id>/bin`  what THIS agent installed for itself — its own folder, so a
 *                             binary it fetched is as private as its notes.
 *    the process's own PATH   inherited verbatim: the system underneath.
 *  `env` (optional) is issued into every spawn — the egress proxy's handoff vars (§9).
 *  `openBubble` (optional) opens the agent's bubble on this ground: every spawn runs
 *  inside it.
 *  What is per SESSION — the cwd, the job set — is the shell's, opened per session
 *  on this ground. */
export async function installExecGround(
  dir: string,
  agentId: string,
  env?: () => Promise<Record<string, string>>,
  defaultWaitMs?: number, // the system.bashWaitMs knob, funneled by main
  openBubble?: () => Promise<Bubble>,
): Promise<ExecGround> {
  const workspace = `${dir}/agents/${agentId}`;
  const shipped = await layShims(dir);
  const binDirs = [shipped, `${dir}/shared/bin`, `${workspace}/bin`];
  const binPath = binDirs.join(":");
  await Deno.mkdir(workspace, { recursive: true });
  await Deno.mkdir(`${dir}/shared/bin`, { recursive: true });
  await Deno.mkdir(`${workspace}/bin`, { recursive: true });
  const user = agentUser(agentId);
  if (user && openBubble) {
    throw new Error(
      `agent ${agentId}: a bubble runs as the harness's own user, and this harness drops to ` +
        `${user.name}'s — deployment.sandbox "bwrap" is for a harness that is not root`,
    );
  }
  // the folders the bubble binds exist before it opens
  await Deno.mkdir(`${dir}/system`, { recursive: true });
  const bubble = await openBubble?.();
  // the folder is the agent's: the seeded docs and `bin/` were laid by the harness, and
  // the uid that works here must be able to edit them
  await ownTree(workspace, user);
  if (user) console.error(`[exec] ${agentId}: spawns run as uid ${user.uid}`);
  await sweepLogs(`${workspace}/.out`);
  const host = localHost();
  return {
    shell(tell?: (u: ShellUpdate) => void): ExecPlane {
      const jobs = new Jobs(host, tell);
      const state: BashState = { cwd: workspace };
      return {
        exec: {
          bash: bashTool({
            workspace,
            binPath,
            defaultWaitMs,
            jobs,
            state,
            ...(env ? { env } : {}),
            ...(user ? { user } : {}),
            ...(bubble ? { bubble } : {}),
          }),
        },
        cwd: () => state.cwd,
        ambient: () => bashAmbient(state, jobs),
        bins: () => binsIn(binDirs, shipped),
        async stand(path?: string) {
          if (path === undefined) {
            state.cwd = workspace;
            return;
          }
          try {
            const shell = [...(await bubble?.enter(path) ?? []), "bash", "-c", ":"];
            const o = await new Deno.Command(shell[0], {
              args: shell.slice(1),
              cwd: path,
              clearEnv: true,
              ...(user ? { uid: user.uid, gid: user.gid } : {}),
              stdin: "null",
              stdout: "null",
              stderr: "piped",
            }).output();
            if (!o.success) throw new Error(new TextDecoder().decode(o.stderr).trim());
          } catch (err) {
            throw new Error(
              `${path}: the agent cannot stand there (${
                err instanceof Error ? err.message : String(err)
              })`,
            );
          }
          state.cwd = path;
        },
        reap: () => jobs.reap(),
        leave: () => jobs.leave(),
        resume: (use, input) => resumed(jobs, `${workspace}/.out`, input, use),
      };
    },
    close: (jobs) => bubble?.close(jobs) ?? Promise.resolve(),
  };
}
