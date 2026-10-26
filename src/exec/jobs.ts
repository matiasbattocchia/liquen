/**
 * exec/jobs.ts — what a bash call runs, past its answer (DESIGN §9).
 *
 * Every call runs as a JOB from its start, and the job's record is files, not the harness's
 * memory. The job's own shell writes them under the workspace's `.out/`, named by the
 * call's id (`jobFiles`): what the command prints (`.log`, both streams in arrival order),
 * the job's process group as the shell starts (`.pgid`), where the command ended (`.cwd`)
 * and its exit status once it did (`.rc`, renamed `.end` once told). Every process of the
 * job carries the call's id in its environment (`JOB_ENV`), which is how a group found
 * again is known to be this job's and not a stranger's that took its number.
 *
 * The call waits on the job up to its `wait`. A job still running then, or one that left
 * something running in its group, is FOLLOWED (`Jobs`): its log read on into the spool —
 * the glance, the lines a `wake` matches, the tail an update carries — and its end told
 * against the call (late.ts). A harness that goes down leaves the job running and its files
 * written; the next one finds it by the call's id and follows it on (`adopt`). A job ends
 * when its group does: by itself, by a kill, or by `liquen stop` (`reap`).
 *
 * Where the files lie is a `JobHost`'s: this machine (bash.ts) or a remote sandbox
 * (gateway.ts). The host is looked at on its own clock (`probeMs`) and, where it can say
 * so, whenever a job's files change.
 */

import type { CallRef } from "../xi.ts";
import { clipEnd, MAX_BYTES, truncateTail } from "./truncate.ts";

/** The variable every process of a job carries: the id of the call that started it. */
export const JOB_ENV = "LIQUEN_JOB";
/** A spool past this drops its older half, and the agent is told once. */
export const SPOOL_CAP = 50 * 1024 * 1024;
/** How long a finished job's log stays, from its last word. */
export const SPOOL_KEEP_MS = 7 * 24 * 3_600_000;
/** The most of a log one look reads: a job further ahead has the bytes between skipped, and
 *  its next tail says so. */
export const LOOK_BYTES = 4 * 1024 * 1024;
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
 *  log holds all of it, and a tail never shows more than the byte window. */
const SINCE_CHARS = 4 * MAX_BYTES;

/** Single-quoted for bash: the one quoting that needs no escaping but of `'` itself. */
export const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** A job's files, side by side under the workspace's `.out/`. */
export interface JobFiles {
  base: string;
  /** What the command prints: the spool, and the spill when its answer is cut. */
  log: string;
  /** The job's process group, written by its shell as it starts: the job's record. */
  pgid: string;
  /** The command's exit status, written by its shell once the command ended. */
  rc: string;
  /** The `.rc` once its status was told. */
  end: string;
  /** Where the command ended. */
  cwd: string;
}

export function jobFiles(out: string, id: string): JobFiles {
  const base = `${out}/bash-${id}`;
  return {
    base,
    log: `${base}.log`,
    pgid: `${base}.pgid`,
    rc: `${base}.rc`,
    end: `${base}.end`,
    cwd: `${base}.cwd`,
  };
}

/** The job's shell, run as `bash -c JOB_SHELL liquen-job <base> <command>` in a session of
 *  its own: it records its group, runs the command with the log for its output, and writes
 *  the command's exit status — the rename makes the status appear whole or not at all. A
 *  group already recorded was written by what entered a bubble for it (bash.ts), outside
 *  the bubble's pid namespace, and stands. */
export const JOB_SHELL = [
  `[ -s "$1.pgid" ] || echo "$$" > "$1.pgid"`,
  `bash -c "$2" < /dev/null >> "$1.log" 2>&1`,
  `printf '%s\\n' "$?" > "$1.rc~" && mv -f "$1.rc~" "$1.rc"`,
].join("\n");

/** The command as the job's shell runs it: followed by the line that writes where it ended
 *  and hands its exit status back as the shell's own. */
export function jobCommand(command: string, files: JobFiles): string {
  return `${command}\n__mu_rc=$?; pwd > ${quote(files.cwd)}; exit "$__mu_rc"`;
}

/** What a shell tells of a call after its answer (late.ts), against the call. */
export interface ShellUpdate {
  use: CallRef;
  command: string;
  output: string;
  is_error?: boolean;
  final?: boolean;
}

/** A job past its call's answer, as the harness follows it. */
export interface Job {
  /** The call's id: what its files are named by and its processes carry. */
  id: string;
  files: JobFiles;
  /** The group its shell leads. A member the ambient line names is `kill <pid>`; the
   *  whole job is `kill -- -<pgid>`. */
  pgid: number;
  /** The FULL launch command: the ambient line clips it, a UI shows it whole. */
  command: string;
  /** When the job started (ms): the age its line and its end say. */
  since: number;
  /** The call that started it, which its updates are told against (late.ts). */
  use?: CallRef;
  /** The window an update's tail is cut to: the call's own. */
  window: { max_lines?: number; max_bytes?: number };
  /** How much of its log has been read. */
  read: number;
  spool: Spool;
  /** The command's exit status was told: by the answer, or by an update. */
  ended: boolean;
  /** Its log held more than `SPOOL_CAP`: the next word says so. */
  dropped?: boolean;
  /** What following it holds — its watch, its wake's timer, its host — let go once it is
   *  told final. */
  release?: () => void;
  /** Found again by a harness that did not see it run: its first word says it ended while
   *  nobody watched, not when. */
  unseen?: boolean;
  /** Its group's number was taken by a stranger: nothing of the job runs. */
  stranger?: boolean;
}

/** A job's files and group as one look finds them. */
export interface Look {
  /** Its log from `job.read` on. */
  bytes: Uint8Array;
  /** The log's size: where the next look reads from. */
  size: number;
  /** The host dropped the log's older half at the cap since the last look. */
  shifted: boolean;
  /** Bytes between `job.read` and `bytes` were never read (`LOOK_BYTES`, or the cap). */
  skipped: boolean;
  /** The command's exit status, written and not yet told. */
  rc?: number;
  /** Its status was told already (`.end`). */
  told?: boolean;
  /** The job's own shell still runs: its command has not ended. */
  running: boolean;
  /** Anything of its group still runs. */
  alive: boolean;
  /** The host no longer has the job, and why: told final. */
  gone?: string;
}

/** A job's record, found by the call's id. */
export interface Found {
  pgid: number;
  since: number;
  /** A process of its group carries the call's id: the group is the job's. */
  ours: boolean;
}

/** Where a shell's jobs run, and how the harness reads them there. */
export interface JobHost {
  /** How often the jobs are looked at with nothing else asking. */
  readonly probeMs: number;
  /** Each job's news since its last look. A host drops a log's older half past
   *  `SPOOL_CAP` as it looks. */
  look(jobs: Job[]): Promise<Map<Job, Look>>;
  /** The record a call's job left, by the call's id; null when it left none. */
  find(id: string, out: string): Promise<Found | null>;
  /** Its exit status was told: `.rc` becomes `.end`. */
  told(job: Job): Promise<void>;
  /** Nothing more is told of it: its record goes, its log stays the agent's for
   *  `SPOOL_KEEP_MS`, counted from now. */
  done(job: Job): Promise<void>;
  /** Kill each job's whole group. */
  kill(jobs: Job[]): Promise<void>;
  /** Calls `changed` whenever the job's files change, where the host can see that; the
   *  return stops it. */
  watch?(job: Job, changed: () => void): () => void;
  /** A followed job holds what it runs on (a remote sandbox stays on); the return lets
   *  go. */
  hold?(job: Job): () => void;
}

export const took = (ms: number): string => {
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
 * A job's log as the harness reads it (§9). It keeps three things of it: the text since
 * the last thing told of the call (the next update's tail), the latest line (the job's
 * glance), and each line, for a `wake`. The log itself holds everything.
 */
export class Spool {
  private decoder = new TextDecoder();
  private partial = "";
  private since = "";
  private cut = false;
  /** The latest line printed. */
  glance = "";
  onLine?: (line: string) => void;

  constructor(readonly path: string) {}

  /** Bytes read off the log, in order. `told`: they came after the answer — news, kept for
   *  the next update and offered to a wake. */
  feed(bytes: Uint8Array, told = true): void {
    this.read(this.decoder.decode(bytes, { stream: true }), told);
  }

  /** Part of the log was never read: the next tail does not reach back to the last. */
  skip(): void {
    this.decoder = new TextDecoder();
    this.partial = "";
    this.cut = true;
  }

  /** The text since the last take, and whether its head was dropped (the log has it). */
  take(): { text: string; cut: boolean } {
    const taken = { text: this.since, cut: this.cut };
    this.since = "";
    this.cut = false;
    return taken;
  }

  private read(text: string, told: boolean): void {
    if (told) this.since += text;
    if (this.since.length > SINCE_CHARS) {
      this.since = this.since.slice(-SINCE_CHARS);
      this.cut = true;
    }
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop()!;
    for (const raw of lines) {
      const line = lineOf(raw);
      if (!line) continue;
      this.glance = line;
      if (told) this.onLine?.(line);
    }
    const now = lineOf(this.partial);
    if (now) this.glance = now;
  }
}

/** Output told after the answer: its tail in the call's window, the footer naming the log
 *  when the window (or the kept text) does not hold all of it. A tail, not the call's
 *  middle cut: this is news since the last thing told, its start already followed from
 *  there, and a slice of the log has no line numbers a gap could name. */
function tailOf(
  taken: { text: string; cut: boolean },
  window: Job["window"],
  path: string,
): string {
  const t = truncateTail(taken.text.trimEnd(), {
    maxLines: window.max_lines,
    maxBytes: window.max_bytes,
  });
  if (!t.text) return "";
  return t.truncated || taken.cut ? `${t.text}\n\n[its last lines — full output: ${path}]` : t.text;
}

/** A job's record and a first look at it, found again by the call's id: `text` is its log
 *  as the look read it. */
export interface Adopted {
  job: Job;
  look: Look;
  text: string;
}

/**
 * One shell's jobs (§9): the calls still running past their answer, and the groups calls
 * left running. Each is told against the call that started it (`tell`, late.ts) — the
 * lines it was asked to wake on, the command's end with its exit status, and the end of
 * everything it started, final.
 */
export class Jobs {
  private live = new Set<Job>();
  private probe?: ReturnType<typeof setInterval>;
  private looking?: Promise<void>;
  private again = false;

  constructor(readonly host: JobHost, private tell?: (u: ShellUpdate) => void) {}

  get size(): number {
    return this.live.size;
  }
  has(job: Job): boolean {
    return this.live.has(job);
  }
  [Symbol.iterator](): Iterator<Job> {
    return this.live.values();
  }

  /** Follow a job past its call's answer: its news is told from here on. */
  follow(job: Job): void {
    this.live.add(job);
    const unwatch = this.host.watch?.(job, () => this.nudge());
    const unhold = this.host.hold?.(job);
    const release = job.release;
    job.release = () => {
      unwatch?.();
      unhold?.();
      release?.();
    };
    this.probe ??= setInterval(() => this.nudge(), this.host.probeMs);
  }

  /** A job a call started, found again by the call's id and looked at once: null when the
   *  call left no record. Not followed yet: the caller says what the look means first. */
  async adopt(
    id: string,
    out: string,
    use: CallRef,
    command: string,
    window: Job["window"],
  ): Promise<Adopted | null> {
    const found = await this.host.find(id, out);
    if (!found) return null;
    const files = jobFiles(out, id);
    const job: Job = {
      id,
      files,
      pgid: found.pgid,
      command: command.trim(),
      since: found.since,
      use,
      window,
      read: 0,
      spool: new Spool(files.log),
      ended: false,
      unseen: true,
    };
    const look = (await this.host.look([job])).get(job)!;
    // a group that took the number is a stranger's: nothing of the job runs
    if (!found.ours) job.stranger = true;
    if (job.stranger) Object.assign(look, { running: false, alive: false });
    job.ended = look.told === true;
    job.read = look.size;
    if (look.skipped) job.spool.skip();
    // all of it is news to the next update: the harness that read it before is gone
    job.spool.feed(look.bytes);
    return { job, look, text: new TextDecoder().decode(look.bytes) };
  }

  private nudge(): void {
    this.look().catch((err) => console.error("[bash] job look:", err));
  }

  /** Look at every job once, and tell what changed. A look asked while one runs is run
   *  again after it, and both callers wait for that. */
  look(): Promise<void> {
    if (this.looking) {
      this.again = true;
      return this.looking;
    }
    this.looking = (async () => {
      do {
        this.again = false;
        const jobs = [...this.live];
        if (jobs.length === 0) break;
        const looks = await this.host.look(jobs);
        for (const job of jobs) {
          const look = looks.get(job);
          if (look && this.live.has(job)) await this.news(job, look);
        }
      } while (this.again);
    })().finally(() => this.looking = undefined);
    return this.looking;
  }

  private say(job: Job, output: string, flags: { is_error?: boolean; final?: boolean } = {}) {
    if (!job.use || !this.tell) return;
    const note = job.dropped
      ? `\n\n[its output passed ${
        SPOOL_CAP / 1024 / 1024
      } MB: the older half of ${job.files.log} was dropped and reads as zero bytes]`
      : "";
    job.dropped = false;
    this.tell({ use: job.use, command: job.command, output: output + note, ...flags });
  }

  /** The job's last word, told final, and the job off the list. */
  private async end(job: Job, output: string, is_error?: boolean): Promise<void> {
    if (!this.live.delete(job)) return;
    job.release?.();
    this.say(job, output, { ...(is_error ? { is_error } : {}), final: true });
    if (this.live.size === 0) {
      clearInterval(this.probe);
      this.probe = undefined;
    }
    await this.host.done(job).catch((err) => console.error(`[bash] job ${job.id}:`, err));
  }

  private async news(job: Job, look: Look): Promise<void> {
    const age = job.unseen ? "while the harness was down" : `after ${took(Date.now() - job.since)}`;
    job.unseen = false;
    if (job.stranger) Object.assign(look, { running: false, alive: false });
    if (look.gone) return this.end(job, `lost ${age}: ${look.gone}`, true);
    if (look.shifted) job.dropped = true;
    if (look.skipped) job.spool.skip();
    job.read = look.size;
    job.spool.feed(look.bytes);
    const tail = () => tailOf(job.spool.take(), job.window, job.files.log);
    if (!job.ended && look.rc !== undefined && !look.running) {
      job.ended = true;
      await this.host.told(job);
      const body = tail();
      const said = `exited ${look.rc} ${age}${body ? `\n${body}` : ", printing nothing more"}`;
      if (look.alive) {
        this.say(job, `${said}\n\n[what it started runs on as group ${job.pgid}]`, {
          ...(look.rc !== 0 ? { is_error: true } : {}),
        });
      } else await this.end(job, said, look.rc !== 0);
      return;
    }
    if (look.alive || look.running) return;
    const body = tail();
    if (job.ended) {
      const head = `what it left running ended ${age} (group ${job.pgid}); its exit status ` +
        "is not known";
      return this.end(
        job,
        body ? `${head}; it printed:\n${body}` : `${head}, and it printed nothing more`,
      );
    }
    const head = `killed ${age} (group ${job.pgid}), before its exit status was written`;
    return this.end(job, body ? `${head}; it printed:\n${body}` : head, true);
  }

  /** The lines of the job's log that match `re` are told as they come, a few at a time
   *  (`WAKE_BATCH_MS`, `WAKE_GAP_MS`, `WAKE_LINES`): news that wakes the agent. Lines still
   *  waiting when the job ends are dropped — its last word carries its tail. */
  wake(job: Job, re: RegExp): void {
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

  /** Kill every job, each told final: the org was stopped (`liquen stop`). */
  async reap(): Promise<void> {
    const jobs = [...this.live];
    await this.host.kill(jobs).catch((err) => console.error("[bash] reap:", err));
    for (const job of jobs) {
      await this.end(
        job,
        `killed after ${took(Date.now() - job.since)} when the org was stopped (group ${job.pgid})`,
      );
    }
  }

  /** Stop following, and leave every job running: the next harness adopts them. */
  leave(): void {
    for (const job of this.live) job.release?.();
    this.live.clear();
    clearInterval(this.probe);
    this.probe = undefined;
  }
}

const ageOf = (since: number): string => took(Date.now() - since);

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

/** A command line for the ambient line: the program by its basename, one line, and when
 *  long, its head and its tail (the tail is where a script's name is). */
function brief(args: string): string {
  const one = args.replace(/\s+/g, " ").trim().replace(/^\S*\//, "");
  return one.length > 72 ? `${one.slice(0, 44)}…${one.slice(-27)}` : one;
}

/** The job's own shells, which run the command rather than being it: the leader (the
 *  job's shell) and the bash running the command's text. */
const shellOf = (job: Job, m: Member): boolean => m.pid === job.pgid || m.args.includes("__mu_rc=");

/** The background section of the ambient block, one section in the anchor's grammar (xi's
 *  standing lists): `· what — when · handle`. What runs is the group's live members, not
 *  the call that launched them (a write that ended with `vite &` would otherwise be listed
 *  as the write, running on, and get killed for it): the first member's command line, and
 *  how many more; `pid` is the first member, `kill <pid>` stops it, and with more than one
 *  the group is named too, `kill -- -<group>` stops them all. The job's own shells are not
 *  members here; with none left besides (or no ps), the launch command clipped, and the
 *  group as the handle. The full launch text lives on the Job. Each job wears its GLANCE
 *  beside its age: the latest line it printed. None when nothing runs. */
export function jobLines(jobs: Iterable<Job>, members = new Map<number, Member[]>()): string[] {
  const all = [...jobs];
  if (all.length === 0) return [];
  const line = (j: Job) => {
    const live = (members.get(j.pgid) ?? []).filter((m) => !shellOf(j, m));
    const glance = j.spool.glance;
    const said = glance && glance.length > 60 ? `${clipEnd(glance, 59)}…` : glance;
    const when = `running ${ageOf(j.since)}${said ? `, last line "${said}"` : ""}`;
    if (live.length === 0) return `· ${brief(j.command)} — ${when} · group ${j.pgid}`;
    const more = live.length > 1 ? `, and ${live.length - 1} more` : "";
    const group = live.length > 1 ? ` · group ${j.pgid}` : "";
    return `· ${brief(live[0].args)}${more} — ${when} · pid ${live[0].pid}${group}`;
  };
  return [`background — ${all.length} job${all.length === 1 ? "" : "s"}:`, ...all.map(line)];
}
