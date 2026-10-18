/**
 * exec/bash.ts — the filesystem substrate's one exec primitive (DESIGN §9).
 *
 * `bash(command, wait?, wake?)` in the agent's workspace, with the binaries on PATH.
 * Deliberately ungated — gates are for outward effects (`send`); the workspace is the
 * agent's own. Discipline (from the pi / Agent-SDK study):
 *
 *   • the turn waits for the command up to `wait` (120s by default); one still running
 *     then is answered ASYNC with what it printed so far, and runs on as a job: the
 *     harness keeps reading its output into the spool, and tells its end — exit status
 *     and last lines — as an update on the call (late.ts)
 *   • stdout+stderr merged in arrival order
 *   • tail-truncation (2000 lines / 50KB); the FULL output is persisted to
 *     {workspace}/.out/<id>.log and the footer says so — `aread` pages the rest
 *   • non-zero exit ⇒ error result carrying the output + exit code (the agent's
 *     self-correction path)
 *   • `wake`, a regular expression: the lines a call's output prints after its answer
 *     that match it are told as updates, which wake the agent; the rest stay in the
 *     spool, the latest of them standing under the job's line in the ambient block
 */

import type { CallRef, ExecFacts, ExecOutcome, ExecTool } from "../xi.ts";
import { type AgentUser, agentUser, own, ownTree } from "./user.ts";
import type { BinDir, Json } from "../types.ts";
import { newId } from "../store/id.ts";
import { MEDIA_MARK } from "../store/media.ts";
import { clipEnd, MAX_BYTES, MAX_LINES, truncateTail } from "./truncate.ts";
import { DEFAULT_BASH_WAIT_MS } from "../config.ts";
import { USAGE } from "../bin/usage.ts";
import type { ToolShape } from "../tooldoc.ts";

const kb = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

/** A background job: a call still running past its wait, or the process group a call left
 *  running after its command ended. */
export interface Job {
  pgid: number; // == the setsid child's pid. The leader is often gone by the time the job
  //                is seen (a `cmd &` from a subshell outlives its bash): `kill -- -<pgid>`
  //                stops the tree, `kill <pid>` a member the ambient line names.
  command: string; // the FULL launch command — the ambient line truncates; a UI/control
  //                  client shows it whole (§9). Kept verbatim, never parsed.
  since: number; // Date.now() at launch — the age its line and its end say
  use?: CallRef; // the call that started it, which its updates are told against (late.ts)
  /** The call's output, still read off its pipe: absent when nothing the call left holds
   *  the pipe (a job that sent its output elsewhere). */
  spool?: Spool;
  /** The pipe's readers, settled once it closes. */
  pipe?: Promise<unknown>;
  /** The call's own bash is still running: its end is the call's answer, told by the call
   *  (an update with the exit status), not by the probe. */
  running?: boolean;
  /** Stops reading the pipe and anything still pending for the call: run once it is told
   *  final. */
  release?: () => void;
}

/** What a shell tells of a call after its answer (late.ts), against the call. */
export interface ShellUpdate {
  use: CallRef;
  command: string;
  output: string;
  is_error?: boolean;
  final?: boolean;
}

/** Sticky cwd shared with the plane so it can report the current directory. */
export interface BashState {
  cwd: string;
}

export interface BashOptions {
  workspace: string; // the agent's cwd; created on install
  binPath?: string; // prepended to PATH — one or more dirs, `:`-joined (shipped, then org)
  defaultWaitMs?: number; // default 120s
  /** Per-SESSION job registry (§9): each command runs in its own process group, and a
   *  call still running past its wait, or a group that still has members after the call
   *  (a `cmd &` job), is recorded here, so the shell can list it in the ambient block,
   *  tell its end, and reap it on shutdown. Jobs outlive the CALL, never the harness. One
   *  registry per shell → ownership. */
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

// Fresh subprocess per call; a tail sentinel reports the shell's final pwd + exit code, so
// the true exit status survives the appended print (§9 audit find), and the pwd can be kept
// as the next call's start — the sticky cwd, off below.
export const CWD_MARK = "__MU_CWD__";

/** Whether a `cd` in a call moves where the next one starts. Off: every call starts where
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
/** How long the readers are given once bash itself has exited, to flush what is already
 *  written. A job the call left running may hold the pipe for hours, so the answer cannot
 *  wait for the pipe to close: the harness reads on into the spool instead. */
const GRACE_MS = 150;
/** How often the shell looks for jobs whose group has no member left: a probe of each live
 *  group (a `cmd &` grandchild is not ours to await), cheap enough to run often, so an end
 *  is told seconds after it happens. */
export const JOB_PROBE_MS = 2_000;
/** The lines a `wake` matches within this long ride one update… */
const WAKE_BATCH_MS = 500;
/** …and one call's wake updates are at least this far apart, the lines between gathered: a
 *  flood wakes the agent every few seconds, never on every line. */
const WAKE_GAP_MS = 5_000;
/** The most lines one wake update carries; the rest are counted. */
const WAKE_LINES = 20;
/** A line as a wake or a glance shows it, at most. */
const LINE_CHARS = 300;
/** The output kept since the last thing told of a call, for the next update's tail: the
 *  spool holds all of it, and a tail never shows more than the byte window. */
const SINCE_CHARS = 4 * MAX_BYTES;

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

/** The command as the shell runs it: followed by a sentinel line that prints the shell's
 *  final pwd and the command's REAL exit code (the appended print would otherwise mask a
 *  non-zero exit). The pwd it reports is the next call's start only with STICKY_CWD on. */
export function wrapCommand(command: string): string {
  return `${command}\n__mu_rc=$?; printf '\\n${CWD_MARK}%s:%s\\n' "$(pwd)" "$__mu_rc"`;
}

/** How a call ended, beside what it printed. */
export interface BashEnd {
  code: number; // the process's own status, when the sentinel never printed (`exit`)
  /** A shell that kills the command at its wait (the gateway's) did. */
  timedOut: boolean;
  aborted: boolean;
  waitMs: number;
}

/** The sentinel peeled off a call's output: the output itself, and the exit code it
 *  carried (`code` when it never printed: the command called `exit`, or was killed).
 *  Moves `state.cwd` with STICKY_CWD on. */
export function peel(raw: string, code: number, state?: BashState): {
  output: string;
  exitCode: number;
} {
  const mark = raw.lastIndexOf(`\n${CWD_MARK}`);
  if (mark === -1) return { output: raw, exitCode: code };
  let exitCode = code;
  const line = raw.slice(mark + 1 + CWD_MARK.length).trim();
  const sep = line.lastIndexOf(":");
  if (sep !== -1) {
    const dir = line.slice(0, sep);
    const rc = Number(line.slice(sep + 1));
    if (dir && STICKY_CWD && state) state.cwd = dir;
    if (Number.isFinite(rc)) exitCode = rc;
  }
  return { output: raw.slice(0, mark), exitCode };
}

/** Output in the call's window: tail-truncated, the footer naming where the whole of it
 *  lies (`spill` answers that) when the window cut it. Empty when nothing was printed. */
async function windowed(
  output: string,
  input: BashInput,
  spill: (output: string) => Promise<string>,
): Promise<string> {
  // the raw output is what gets persisted; the model may widen/narrow the window
  const t = truncateTail(output.trimEnd(), {
    maxLines: input.max_lines,
    maxBytes: input.max_bytes,
  });
  if (!t.truncated) return t.text;
  const path = await spill(output);
  const shown = t.clippedLineBytes === undefined
    ? `showing lines ${t.startLine}-${t.totalLines} of ${t.totalLines}`
    : `showing only the end of line ${t.startLine} of ${t.totalLines}: its last ${
      kb(new TextEncoder().encode(t.text).length)
    } of ${kb(t.clippedLineBytes)}`;
  return `${t.text}\n\n[${shown} — full output: ${path}]`;
}

/** A call's raw output → its result: the sentinel peeled off the tail (recovering the exit
 *  code), the text tail-truncated — the whole of it handed to `spill`, which answers where
 *  it now lies — `note` after it, and a non-zero exit, a timeout or an abort thrown as the
 *  error result carrying the output. Media marks (`aread` on a bytes file, §5) come off
 *  the text as the result's attachments. */
export async function settle(
  raw: string,
  end: BashEnd,
  input: BashInput,
  state: BashState,
  spill: (output: string) => Promise<string>,
  report?: (facts: ExecFacts) => void,
  note?: string,
): Promise<Json | ExecOutcome> {
  const { output, exitCode } = peel(raw, end.code, state);
  // the run's facts, said before any window narrows the output or a failure throws it
  report?.({ exit_code: exitCode, bytes: new TextEncoder().encode(output).length });

  let text = (await windowed(output, input, spill)) || "(no output)";
  if (note) text += `\n\n${note}`;

  if (end.aborted) throw new Error(`${text}\n\nCommand aborted`);
  if (end.timedOut) throw new Error(`${text}\n\nCommand timed out after ${end.waitMs / 1000}s`);
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

export function bashTool(opts: BashOptions): ExecTool {
  const waitMsDefault = opts.defaultWaitMs ?? DEFAULT_BASH_WAIT_MS;
  // the cwd lives in the shared state when the plane provides one (so it can report it),
  // else in a local closure var
  const state = opts.state ?? { cwd: opts.workspace };
  const jobs = opts.jobs ?? new Jobs();
  // the spool and the spill sit in the agent's own folder wherever the shell stands —
  // never in a repo it walked into; written by the harness, the agent's to keep
  const outPath = async () => {
    await Deno.mkdir(`${opts.workspace}/.out`, { recursive: true });
    await own(`${opts.workspace}/.out`, opts.user);
    return `${opts.workspace}/.out/bash-${newId()}.log`;
  };
  const spill = async (output: string) => {
    const path = await outPath();
    await Deno.writeTextFile(path, output);
    await own(path, opts.user);
    return path;
  };

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

      const wrapped = wrapCommand(command);
      // isolate the command in its own process group (setsid) so a runaway foreground tree
      // OR a leftover background job can be reaped by the group — see killGroup / opts.jobs
      const isolated = hasSetsid();
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(isolated ? "setsid" : "bash", {
          args: isolated ? ["bash", "-c", wrapped] : ["-c", wrapped],
          cwd: state.cwd,
          clearEnv: true,
          env,
          ...(opts.user ? { uid: opts.user.uid, gid: opts.user.gid } : {}),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
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
      const pgid = isolated ? child.pid : undefined; // setsid exec's bash → pid == group id
      const killGroup = () => {
        try {
          if (pgid !== undefined) Deno.kill(-pgid, "SIGKILL"); // the whole tree
          else child.kill("SIGKILL");
        } catch { /* already gone */ }
      };

      // Merge both streams in arrival order, into the spool. A job the command leaves
      // running (`cmd &`) may hold the pipe long after bash exits, so the answer never
      // waits for the pipe to close: it waits for bash's OWN exit and a short grace, and
      // the readers go on into the spool for as long as anything writes.
      const spool = new Spool();
      const r1 = child.stdout.getReader();
      const r2 = child.stderr.getReader();
      const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            spool.push(value);
          }
        } catch { /* cancelled: nothing is told of the call any more */ }
      };
      const pumps = Promise.allSettled([pump(r1), pump(r2)]).finally(() => spool.close());
      const release = () => {
        r1.cancel().catch(() => {});
        r2.cancel().catch(() => {});
      };

      const onAbort = () => killGroup();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<undefined>((r) => {
        waitTimer = setTimeout(() => r(undefined), waitMs);
      });
      const started = Date.now();
      const status = await Promise.race([child.status, waited]);
      clearTimeout(waitTimer);
      signal.removeEventListener("abort", onAbort);

      if (status === undefined) {
        // still running at the end of its wait: the call is answered with what it printed
        // so far, and the command runs on as a job, its output into the spool
        const path = await outPath();
        const so = spool.open(path);
        await own(path, opts.user);
        report?.({ bytes: new TextEncoder().encode(so).length });
        const job: Job = {
          pgid: pgid ?? child.pid,
          command: command.trim(),
          since: started,
          ...(use ? { use } : {}),
          spool,
          pipe: pumps,
          running: true,
          release,
        };
        if (pgid !== undefined) jobs.add(job);
        if (wake) jobs.wake(job, wake);
        child.status.then((s) => jobs.answer(job, s, call))
          .catch((err) => console.error(`[bash] group ${pgid}:`, err));
        const text = (await windowed(so, call, () => Promise.resolve(path))) || "(no output yet)";
        const where = pgid !== undefined ? ` as group ${pgid}` : "";
        return {
          output: `${text}\n\n[still running after ${waitMs / 1000}s${where}: what it prints ` +
            `goes on in ${path}, and you are told when it ends]`,
          files: [],
          async: true,
        };
      }

      // bash itself exited (or was killed). Normal command: the pumps are already done (the
      // pipe closed) and they win at once; a job holding the pipe leaves them reading, and
      // the grace flushes what is already written
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"grace">((r) => {
        graceTimer = setTimeout(() => r("grace"), GRACE_MS);
      });
      const held = (await Promise.race([pumps, grace])) === "grace";
      clearTimeout(graceTimer);
      // a group that still has members after bash exited is a job the command left (`cmd
      // &`): the OS says so, never a parse of the command
      const left = pgid !== undefined && !signal.aborted && groupAlive(pgid);
      let note: string | undefined;
      let raw: string | undefined;
      if (left) {
        const job: Job = {
          pgid: pgid!,
          command: command.trim(),
          since: started,
          ...(use ? { use } : {}),
        };
        if (held) {
          // it writes to the pipe: read on into the spool, so it lives past the call
          const path = await outPath();
          raw = spool.open(path);
          await own(path, opts.user);
          job.spool = spool;
          job.pipe = pumps;
          job.release = release;
          if (wake) jobs.wake(job, wake);
        }
        jobs.add(job);
        note = `[left running as group ${pgid}${
          job.spool ? `: what it prints goes on in ${job.spool.path}` : ""
        }; you are told when it ends]`;
      } else if (held) {
        // something outside the group holds the pipe (a daemon that left it): nothing
        // tracks it, so the readers stop here
        release();
      }
      const end = { code: status.code, timedOut: false, aborted: signal.aborted, waitMs };
      const answer = await settle(raw ?? spool.answered(), end, call, state, spill, report, note);
      if (!left) return answer;
      // what it left is told later, so the answer is async like one past its wait: a
      // harness that goes down first owes its end (late.ts)
      return typeof answer === "string"
        ? { output: answer, files: [], async: true }
        : { ...(answer as ExecOutcome), async: true };
    },
  };
}

/** The `wake` pattern a call carries, compiled; absent when it carries none. */
function wakeOf(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern === "") return undefined;
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(`wake: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const took = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** A line as it last stood on a terminal: what follows its last carriage return (a
 *  progress bar redraws itself on one line), clipped. */
function lineOf(raw: string): string {
  const line = raw.slice(raw.lastIndexOf("\r") + 1).trimEnd();
  return line.length > LINE_CHARS ? `${clipEnd(line, LINE_CHARS - 1)}…` : line;
}

/**
 * A call's output as the harness reads it off the pipe (§9). Until the call is answered it
 * is held for the answer. From then on, while anything still writes to the pipe, every byte
 * goes to the spool file — what was held first, so the file is the whole output — and the
 * harness keeps three things of it: the text since the last thing told of the call (the
 * next update's tail), the latest line (the job's glance), and each line, for a `wake`.
 * Reading on is what lets a job outlive its call: a writer whose pipe nobody reads dies on
 * its next write.
 */
export class Spool {
  private held: Uint8Array[] = [];
  private file?: Deno.FsFile;
  private decoder = new TextDecoder();
  private partial = "";
  private since = "";
  private cut = false;
  /** Where the output goes once the call is answered. */
  path?: string;
  /** The latest line printed after the answer. */
  glance = "";
  onLine?: (line: string) => void;

  push(bytes: Uint8Array): void {
    if (!this.file) {
      if (this.path === undefined) this.held.push(bytes);
      return;
    }
    for (let at = 0; at < bytes.length;) at += this.file.writeSync(bytes.subarray(at));
    this.read(this.decoder.decode(bytes, { stream: true }));
  }

  /** What was printed before the answer, whole. */
  answered(): string {
    const all = new Uint8Array(this.held.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.held) {
      all.set(c, at);
      at += c.length;
    }
    return new TextDecoder().decode(all);
  }

  /** From now on the output goes to `path`, after everything printed so far — which is
   *  handed back for the answer, and no longer held. */
  open(path: string): string {
    const so = this.answered();
    this.path = path;
    this.file = Deno.openSync(path, { write: true, create: true, truncate: true });
    for (const c of this.held) {
      for (let at = 0; at < c.length;) at += this.file.writeSync(c.subarray(at));
    }
    this.held = [];
    // what it printed so far is the answer's, but its last line is the glance until a
    // newer one comes
    this.read(so, false);
    return so;
  }

  /** The text since the last take, and whether its head was dropped (the file has it). */
  take(): { text: string; cut: boolean } {
    const taken = { text: this.since, cut: this.cut };
    this.since = "";
    this.cut = false;
    return taken;
  }

  close(): void {
    if (this.file) this.read(this.decoder.decode());
    this.file?.close();
    this.file = undefined;
  }

  /** `told`: the text is news after the answer — kept for the next update, and offered to
   *  a wake. */
  private read(text: string, told = true): void {
    if (told) this.since += text;
    if (this.since.length > SINCE_CHARS) {
      this.since = this.since.slice(-SINCE_CHARS);
      this.cut = true;
    }
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop()!;
    for (const raw of lines) {
      const line = lineOf(raw);
      if (!line || line.startsWith(CWD_MARK)) continue; // the shell's end, not the command's
      this.glance = line;
      if (told) this.onLine?.(line);
    }
    const now = lineOf(this.partial);
    if (now && !now.startsWith(CWD_MARK)) this.glance = now;
  }
}

/** Output told after the answer: its tail in the call's window, the footer naming the
 *  spool when the window (or the kept text) does not hold all of it. */
function tailOf(
  taken: { text: string; cut: boolean },
  input: Pick<BashInput, "max_lines" | "max_bytes">,
  path?: string,
): string {
  const t = truncateTail(taken.text.trimEnd(), {
    maxLines: input.max_lines,
    maxBytes: input.max_bytes,
  });
  if (!t.text) return "";
  return t.truncated || taken.cut ? `${t.text}\n\n[its last lines — full output: ${path}]` : t.text;
}

/**
 * One shell's jobs (§9): the calls still running past their wait, and the process groups
 * calls left running. Each is told against the call that started it (`tell`, late.ts) —
 * the lines it was asked to wake on, the call's own end with its exit status, and the end
 * of everything it started, final — and reaped with the shell.
 */
export class Jobs {
  private live = new Set<Job>();
  private probe?: ReturnType<typeof setInterval>;
  constructor(private tell?: (u: ShellUpdate) => void) {}

  get size(): number {
    return this.live.size;
  }
  [Symbol.iterator](): Iterator<Job> {
    return this.live.values();
  }

  add(job: Job): void {
    this.live.add(job);
    this.probe ??= setInterval(() => {
      this.settle().catch((err) => console.error("[bash] job probe:", err));
    }, JOB_PROBE_MS);
  }

  private say(job: Job, output: string, flags: { is_error?: boolean; final?: boolean } = {}) {
    if (!job.use || !this.tell) return;
    this.tell({ use: job.use, command: job.command, output, ...flags });
  }

  /** The job's last word, told final, and the job off the list. Once: false when another
   *  path told it already. */
  private end(job: Job, output: string, is_error?: boolean): boolean {
    if (!this.live.delete(job)) return false;
    job.release?.();
    this.say(job, output, { ...(is_error ? { is_error } : {}), final: true });
    if (this.live.size === 0) {
      clearInterval(this.probe);
      this.probe = undefined;
    }
    return true;
  }

  /** The call's own bash exited after its answer: its exit status and what it printed
   *  since, final when its group went with it. A group that lives on stays a job, and the
   *  probe tells its end. */
  async answer(job: Job, status: Deno.CommandStatus, input: BashInput): Promise<void> {
    await drained(job.pipe);
    job.running = false;
    if (!this.live.has(job)) return; // reaped: the harness said so already
    const taken = job.spool!.take();
    const { output, exitCode } = peel(taken.text, status.code);
    const killed = status.signal !== null && exitCode === status.code;
    const how = `${killed ? `killed by ${status.signal}` : `exited ${exitCode}`} after ${
      took(Date.now() - job.since)
    }`;
    const body = tailOf({ text: output, cut: taken.cut }, input, job.spool!.path);
    const said = body ? `${how}\n${body}` : `${how}, printing nothing more`;
    if (groupAlive(job.pgid)) {
      this.say(job, `${said}\n\n[what it started runs on as group ${job.pgid}]`, {
        ...(exitCode !== 0 ? { is_error: true } : {}),
      });
    } else this.end(job, said, exitCode !== 0);
  }

  /** The jobs whose group has no member left, told ended. A call whose own bash still
   *  runs is the call's to tell (`answer`). */
  async settle(): Promise<void> {
    for (const job of [...this.live]) {
      if (job.running || groupAlive(job.pgid)) continue;
      await drained(job.pipe);
      if (!this.live.has(job)) continue;
      const head = `what it left running ended after ${took(Date.now() - job.since)} ` +
        `(group ${job.pgid}); its exit status is not known`;
      const tail = job.spool ? tailOf(job.spool.take(), {}, job.spool.path) : "";
      this.end(
        job,
        job.spool
          ? (tail ? `${head}; it printed:\n${tail}` : `${head}, and it printed nothing more`)
          : `${head}: what it wrote holds the outcome`,
      );
    }
  }

  /** The lines of the job's output that match `re` are told as they come, a few at a time
   *  (`WAKE_BATCH_MS`, `WAKE_GAP_MS`, `WAKE_LINES`): news that wakes the agent. Lines still
   *  waiting when the job ends are dropped — its last word carries its tail. */
  wake(job: Job, re: RegExp): void {
    if (!job.spool) return;
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const flush = () => {
      timer = undefined;
      const lines = pending;
      pending = [];
      if (!this.live.has(job) || lines.length === 0) return;
      last = Date.now();
      const more = lines.length - WAKE_LINES;
      this.say(
        job,
        lines.slice(0, WAKE_LINES).join("\n") +
          (more > 0 ? `\n[and ${more} more line${more === 1 ? "" : "s"} like these]` : ""),
      );
    };
    job.spool.onLine = (line) => {
      if (!re.test(line)) return;
      pending.push(line);
      timer ??= setTimeout(flush, Math.max(WAKE_BATCH_MS, last + WAKE_GAP_MS - Date.now()));
    };
    const release = job.release;
    job.release = () => {
      clearTimeout(timer);
      pending = [];
      release?.();
    };
  }

  /** Kill every job (§9), each told final: nothing outlives the harness, and the agent
   *  learns at its next turn what stopped with it. */
  reap(): void {
    for (const job of [...this.live]) {
      try {
        Deno.kill(-job.pgid, "SIGKILL");
      } catch { /* already gone */ }
      this.end(
        job,
        `stopped with the harness after ${took(Date.now() - job.since)} (group ${job.pgid})`,
      );
    }
  }
}

/** Waits for the pipe to close, at most the grace: what is already written is read. */
async function drained(pumps: Promise<unknown> | undefined): Promise<void> {
  if (!pumps) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pumps, new Promise((r) => (timer = setTimeout(r, GRACE_MS)))]);
  clearTimeout(timer);
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
  /** Kill every background job this shell left running (§9): called on harness shutdown so
   *  nothing outlives the process that spawned it. Each is told stopped, where the shell
   *  tells its jobs. */
  reap(): Promise<void>;
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

const ageOf = (since: number): string => {
  const s = Math.floor((Date.now() - since) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** A shell's ambient lines (§5): cwd · git (if a repo) · background jobs. Settles dead
 *  groups out of `jobs` here too — the every-think place — so a death this look sees first
 *  is told before the list leaves it out. */
export async function bashAmbient(state: BashState, jobs: Jobs): Promise<string[]> {
  const lines = [`cwd: ${state.cwd}`];
  const git = await gitLine(state.cwd);
  if (git) lines.push(git);
  await jobs.settle();
  return [...lines, ...jobLines(jobs, await groupMembers(jobs))];
}

/** A process alive in a job's group: its pid, the kill handle, and its command line. */
export interface Member {
  pid: number;
  args: string;
}

/** `ps -e -o pgid=,pid=,args=` lines (Linux and macOS print the same three columns) → the
 *  members of each group asked for, by pid. A group with no line has no entry. */
export function parseMembers(ps: string, pgids: Iterable<number>): Map<number, Member[]> {
  const want = new Set(pgids);
  const members = new Map<number, Member[]>();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !want.has(Number(m[1]))) continue;
    const pgid = Number(m[1]);
    const list = members.get(pgid) ?? [];
    list.push({ pid: Number(m[2]), args: m[3].trim() });
    members.set(pgid, list.sort((a, b) => a.pid - b.pid));
  }
  return members;
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

/** A command line for the ambient line: the program by its basename, one line, and when
 *  long, its head and its tail (the tail is where a script's name is). */
function brief(args: string): string {
  const one = args.replace(/\s+/g, " ").trim().replace(/^\S*\//, "");
  return one.length > 72 ? `${one.slice(0, 44)}…${one.slice(-27)}` : one;
}

/** The background section of the ambient block, one section in the anchor's grammar (xi's
 *  standing lists): `· what — when · handle`. What runs is the group's live members, not
 *  the call that launched them (a write that ended with `vite &` would otherwise be listed
 *  as the write, running on, and get killed for it): the first member's command line, and
 *  how many more; `pid` is the first member, `kill <pid>` stops it, and with more than one
 *  the group is named too, `kill -- -<group>` stops them all. Without members (no ps), the
 *  launch command clipped, and the group as the handle. The full launch text lives on the
 *  Job. A job whose output the harness reads wears its GLANCE beside its age: the latest
 *  line it printed. None when nothing runs. */
export function jobLines(jobs: Iterable<Job>, members = new Map<number, Member[]>()): string[] {
  const all = [...jobs];
  if (all.length === 0) return [];
  const line = (j: Job) => {
    const live = members.get(j.pgid) ?? [];
    const glance = j.spool?.glance;
    const said = glance && glance.length > 60 ? `${clipEnd(glance, 59)}…` : glance;
    const when = `running ${ageOf(j.since)}${said ? `, last line "${said}"` : ""}`;
    if (live.length === 0) return `· ${brief(j.command)} — ${when} · group ${j.pgid}`;
    const more = live.length > 1 ? `, and ${live.length - 1} more` : "";
    const group = live.length > 1 ? ` · group ${j.pgid}` : "";
    return `· ${brief(live[0].args)}${more} — ${when} · pid ${live[0].pid}${group}`;
  };
  return [`background — ${all.length} job${all.length === 1 ? "" : "s"}:`, ...all.map(line)];
}

/** This process's module cache — the one the shims read. Asked of the deno that runs the
 *  harness (once per process), since the default is per user and the shims run as the
 *  agent's uid. */
let harnessDenoDir: Promise<string> | undefined;
function denoDir(): Promise<string> {
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
 *  What is per SESSION — the cwd, the job set — is the shell's, opened per session
 *  on this ground. */
export async function installExecGround(
  dir: string,
  agentId: string,
  env?: () => Promise<Record<string, string>>,
  defaultWaitMs?: number, // the system.bashWaitMs knob, funneled by main
): Promise<ExecGround> {
  const workspace = `${dir}/agents/${agentId}`;
  const shipped = await layShims(dir);
  const binDirs = [shipped, `${dir}/shared/bin`, `${workspace}/bin`];
  const binPath = binDirs.join(":");
  await Deno.mkdir(workspace, { recursive: true });
  await Deno.mkdir(`${dir}/shared/bin`, { recursive: true });
  await Deno.mkdir(`${workspace}/bin`, { recursive: true });
  const user = agentUser(agentId);
  // the folder is the agent's: the seeded docs and `bin/` were laid by the harness, and
  // the uid that works here must be able to edit them
  await ownTree(workspace, user);
  if (user) console.error(`[exec] ${agentId}: spawns run as uid ${user.uid}`);
  return {
    shell(tell?: (u: ShellUpdate) => void): ExecPlane {
      const jobs = new Jobs(tell);
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
            await new Deno.Command("bash", {
              args: ["-c", ":"],
              cwd: path,
              clearEnv: true,
              ...(user ? { uid: user.uid, gid: user.gid } : {}),
              stdin: "null",
              stdout: "null",
              stderr: "null",
            }).spawn().status;
          } catch (err) {
            throw new Error(
              `${path}: the agent cannot stand there (${
                err instanceof Error ? err.message : String(err)
              })`,
            );
          }
          state.cwd = path;
        },
        reap() {
          jobs.reap();
          return Promise.resolve();
        },
      };
    },
  };
}
