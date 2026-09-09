/**
 * exec/bash.ts — the filesystem substrate's one exec primitive (DESIGN §9).
 *
 * `bash(command, timeout?)` in the agent's workspace, with the binaries on PATH.
 * Deliberately ungated — gates are for outward effects (`send`); the workspace is the
 * agent's own. Discipline (from the pi / Agent-SDK study):
 *
 *   • default timeout 120s — a hung command would otherwise hold the turn lock
 *   • stdout+stderr merged in arrival order
 *   • tail-truncation (2000 lines / 50KB); the FULL output is persisted to
 *     {workspace}/.out/<id>.log and the footer says so — `aread` pages the rest
 *   • non-zero exit ⇒ error result carrying the output + exit code (the agent's
 *     self-correction path)
 */

import type { ExecOutcome, ExecTool } from "../xi.ts";
import { type AgentUser, agentUser, own, ownTree } from "./user.ts";
import type { Json } from "../types.ts";
import { newId } from "../store/id.ts";
import { MEDIA_MARK } from "../store/media.ts";
import { MAX_BYTES, MAX_LINES, truncateTail } from "./truncate.ts";
import { DEFAULT_BASH_TIMEOUT_MS } from "../config.ts";

/** A background job the agent left running: its process group + a hint of what it is. */
export interface Job {
  pgid: number; // == the setsid child's pid: `kill <pgid>` the leader, `kill -<pgid>` the tree
  command: string; // the FULL launch command — the ambient line truncates; a UI/control
  //                  client shows it whole (§9). Kept verbatim, never parsed.
  since: number; // Date.now() at launch — age + the future TTL reaper (§9)
}

/** Sticky cwd shared with the plane so it can report the current directory. */
export interface BashState {
  cwd: string;
}

export interface BashOptions {
  workspace: string; // the agent's cwd; created on install
  binPath?: string; // prepended to PATH — one or more dirs, `:`-joined (shipped, then org)
  defaultTimeoutMs?: number; // default 120s
  /** Per-SESSION background-job registry (§9): each command runs in its own process group;
   *  a group that still has members after the call (a `cmd &` job) is recorded here so the
   *  shell can reap it on shutdown AND report it in the ambient block. Jobs outlive the
   *  CALL, never the harness. One set per shell → ownership. */
  jobs?: Set<Job>;
  state?: BashState; // sticky cwd, published for the plane's ambient snapshot
  /** Extra env ISSUED into every spawn (evaluated per call — placeholders can rotate).
   *  This is the ONLY channel besides the allowlist by which user space learns anything:
   *  the egress proxy's HTTPS_PROXY/SSL_CERT_FILE/placeholder-token land here (§9). Never
   *  put a real secret in it — the whole point is that user space holds only handles. */
  env?: () => Record<string, string>;
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

// Sticky cwd: fresh subprocess per call, but the working directory persists between calls
// like a real terminal — a tail sentinel reports the shell's final pwd + exit code, so the
// model never re-`cd`s and its true exit status survives the appended print (§9 audit find).
const CWD_MARK = "__MU_CWD__";

// User space starts with an EMPTY pocket (clearEnv): the harness process's environment —
// API keys, bridge tokens, whatever it was launched with — never leaks into the agent's
// shell. What a tool binary legitimately needs is issued by NAME:
//   HOME        git/ssh/CLI config discovery
//   LANG/LC_ALL encoding — without them tools drop to C locale and mangle UTF-8
//   TMPDIR      honored where set
//   USER/LOGNAME/SHELL  identity fallbacks (git author guessing, whoami)
// PATH is built, TERM is fixed to `dumb` (no TTY to paint). Anything else gets added
// here by name, with a reason — this list is what user space is allowed to know.
const ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL"];
/** How long the readers are given once bash itself has exited. A backgrounded child holds
 *  the pipe open, so the race has to be cut for the call to return at all. */
const GRACE_MS = 150;

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

export function bashTool(opts: BashOptions): ExecTool {
  const timeoutMsDefault = opts.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  // sticky cwd lives in the shared state when the plane provides one (so it can report it),
  // else in a local closure var
  const state = opts.state ?? { cwd: opts.workspace };

  return {
    spec: {
      name: "bash",
      description: "Run a bash command. The working directory PERSISTS between calls like a " +
        "terminal (cd once, it sticks), but " +
        "shell/env state (exported vars, activated venvs) does not, so re-export or chain those. " +
        `stdout+stderr merged; output truncated to the last ${MAX_LINES} lines / ${
          MAX_BYTES / 1024
        }KB (override with max_lines/max_bytes when you deliberately need more or less); ` +
        "when truncated, the full output is saved to a file the footer names (page it with aread). " +
        `Default timeout ${timeoutMsDefault / 1000}s; run long work in the background ` +
        "(cmd > out.log 2>&1 &) and poll with tail. Prefer fat commands: chain independent steps " +
        "with && or ; in ONE call, and emit multiple bash calls in one turn when they don't depend " +
        "on each other; every separate call is a full round-trip. " +
        "File helpers on PATH: aread <path> [offset] [limit] [maxBytes]; on an image or PDF it " +
        "attaches the file itself, so you see it · " +
        "awrite <path> (content on stdin/heredoc) · " +
        "aedit <path> (conflict-marker blocks on stdin: <<<<<<< old ======= new >>>>>>>). " +
        "rg and fd are available for search when installed.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "bash command to execute" },
          timeout: {
            type: "number",
            description: `seconds (optional; default ${timeoutMsDefault / 1000})`,
          },
          max_lines: {
            type: "number",
            description:
              `output truncation: keep the last N lines (optional; default ${MAX_LINES})`,
          },
          max_bytes: {
            type: "number",
            description: `output truncation: byte cap (optional; default ${MAX_BYTES})`,
          },
        },
        required: ["command"],
      },
    },

    async execute(input: Json, signal: AbortSignal): Promise<Json | ExecOutcome> {
      const { command, timeout, max_lines, max_bytes } = input as {
        command: string;
        timeout?: number;
        max_lines?: number;
        max_bytes?: number;
      };
      const timeoutMs = timeout !== undefined ? timeout * 1000 : timeoutMsDefault;
      const env = { ...userSpaceEnv(opts.binPath), ...opts.env?.() };
      if (opts.user) {
        // the identity trio follows the uid, not the harness process
        Object.assign(env, { HOME: opts.user.home, USER: opts.user.name, LOGNAME: opts.user.name });
      }

      // append a sentinel that prints the shell's final pwd + the command's REAL exit code
      // (the appended print would otherwise mask a non-zero exit). `cd` at start is honored,
      // and `${cwd}` may have drifted from a previous call — that's the sticky-cwd behavior.
      const wrapped = `${command}\n__mu_rc=$?; printf '\\n${CWD_MARK}%s:%s\\n' "$(pwd)" "$__mu_rc"`;
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

      // Merge both streams in arrival order. A BACKGROUNDED job (`cmd &`) holds the pipe
      // open after bash exits, so we can't wait for stream-close — we pump via readers,
      // wait for bash's OWN exit, flush a short grace window, then cancel the readers to
      // cut any detached descendant loose (the tbench qemu-hang find).
      const chunks: Uint8Array[] = [];
      const r1 = child.stdout.getReader();
      const r2 = child.stderr.getReader();
      const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } catch { /* cancelled — a background job kept the pipe */ }
      };
      const pumps = Promise.allSettled([pump(r1), pump(r2)]);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(); // a timed-out foreground drags its whole tree down (not just bash)
      }, timeoutMs);
      const onAbort = () => killGroup();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      try {
        const status = await child.status; // bash itself exited (or was killed)
        // normal command: the pumps are already done (pipe closed) and this wins instantly;
        // backgrounded: they're hanging, so the grace flushes buffered output then cuts
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<void>((r) => (graceTimer = setTimeout(r, GRACE_MS)));
        await Promise.race([pumps, grace]);
        clearTimeout(graceTimer);
        await r1.cancel().catch(() => {});
        await r2.cancel().catch(() => {});
        await pumps; // let the readers settle so no stream resource leaks

        let size = 0;
        for (const c of chunks) size += c.length;
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        const raw = new TextDecoder().decode(all);

        // peel the sentinel off the tail: update sticky cwd, recover the real exit code.
        // If it's missing (the command called `exit`), fall back to the process status.
        let output = raw;
        let exitCode = status.code;
        const mark = raw.lastIndexOf(`\n${CWD_MARK}`);
        if (mark !== -1) {
          const line = raw.slice(mark + 1 + CWD_MARK.length).trim();
          const sep = line.lastIndexOf(":");
          if (sep !== -1) {
            const dir = line.slice(0, sep);
            const rc = Number(line.slice(sep + 1));
            if (dir) state.cwd = dir;
            if (Number.isFinite(rc)) exitCode = rc;
          }
          output = raw.slice(0, mark);
        }

        // the raw output is what gets persisted; the model may widen/narrow the window
        const t = truncateTail(output.trimEnd(), { maxLines: max_lines, maxBytes: max_bytes });
        let text = t.text || "(no output)";
        if (t.truncated) {
          // the spill sits in the agent's own folder wherever the shell stands — never in a
          // repo it walked into; written by the harness, the agent's to keep
          const path = `${opts.workspace}/.out/bash-${newId()}.log`;
          await Deno.mkdir(`${opts.workspace}/.out`, { recursive: true });
          await Deno.writeTextFile(path, output);
          await own(`${opts.workspace}/.out`, opts.user);
          await own(path, opts.user);
          text +=
            `\n\n[showing lines ${t.startLine}-${t.totalLines} of ${t.totalLines} — full output: ${path}]`;
        }

        if (signal.aborted) throw new Error(`${text}\n\nCommand aborted`);
        if (timedOut) throw new Error(`${text}\n\nCommand timed out after ${timeoutMs / 1000}s`);
        if (exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);

        // peel media marks (`aread` on a bytes file, §5 — the CWD_MARK pattern): the mark
        // line carries the path; the file rides the tool_result as an attachment
        const files: string[] = [];
        const kept = text.split("\n").filter((line) => {
          if (!line.startsWith(MEDIA_MARK)) return true;
          files.push(line.slice(MEDIA_MARK.length));
          return false;
        });
        if (files.length === 0) return text;
        const outcome: ExecOutcome = { output: kept.join("\n").trimEnd() || "(no output)", files };
        return outcome;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        // if the group still has members, a `cmd &` outlived the call → track it for
        // reaping; an empty group (foreground-only, bash exited) throws NotFound. We infer
        // "a background job was launched" from the OS, never by parsing the command.
        if (pgid !== undefined && opts.jobs && !timedOut && !signal.aborted) {
          try {
            Deno.kill(-pgid, "SIGWINCH"); // harmless probe: succeeds ⇒ live members
            opts.jobs.add({ pgid, command: command.trim(), since: Date.now() });
          } catch { /* group empty — nothing left running */ }
        }
      }
    },
  };
}

/** One SESSION's shell on its agent's ground (§9): its own sticky cwd and its own job set.
 *  Two sessions of one agent stand in one folder but never in one place — a client placing
 *  one session's shell, or a `cd` in it, moves nothing for its siblings. */
export interface ExecPlane {
  exec: Record<string, ExecTool>;
  /** Live environment lines for the ambient block (§5): cwd · git (if a repo) · background
   *  jobs (dead ones pruned here — the reliable, every-think place, not at registration). */
  ambient(): Promise<string[]>;
  /** Kill every background job this shell left running (§9): called on harness shutdown so
   *  nothing outlives the process that spawned it. */
  reap(): Promise<void>;
  /** Where the next call starts: the principal's own directory while an interface attached
   *  from one is connected (the door passes it along), the workspace when none is given.
   *  The place is tried first, by the same spawn a call makes and as the same uid, so a
   *  directory the agent cannot stand in is refused here — at the attach — and the shell
   *  never moves. The shell's own `cd`s stick from there as ever. */
  stand(path?: string): Promise<void>;
}

/** One AGENT's ground (§9): the workspace, the PATH cascade, the uid — prepared once.
 *  `shell()` opens a session's shell on it. */
export interface ExecGround {
  shell(): ExecPlane;
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

/** A shell's ambient lines (§5): cwd · git (if a repo) · background jobs. Prunes dead
 *  groups from `jobs` here — the reliable, every-think place. Shared by the shell and task mode. */
export async function bashAmbient(state: BashState, jobs: Set<Job>): Promise<string[]> {
  const lines = [`cwd: ${state.cwd}`];
  const git = await gitLine(state.cwd);
  if (git) lines.push(git);
  for (const j of jobs) if (!groupAlive(j.pgid)) jobs.delete(j);
  if (jobs.size > 0) {
    // one section in the anchor's grammar (xi's standing lists): `· what — when · handle`.
    // pid is the kill handle: `kill <pid>` stops the leader, `kill -<pid>` the whole tree.
    // command is collapsed to one line and clipped — the full text lives on the Job.
    const brief = (c: string) => {
      const one = c.replace(/\s+/g, " ").trim();
      return one.length > 60 ? `${one.slice(0, 59)}…` : one;
    };
    lines.push(`background — ${jobs.size} job${jobs.size === 1 ? "" : "s"}:`);
    for (const j of jobs) {
      lines.push(`· ${brief(j.command)} — running ${ageOf(j.since)} · pid ${j.pgid}`);
    }
  }
  return lines;
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
 *    `src/bin`                SHIPPED — `aread`/`awrite`/`aedit`, committed shims that
 *                             locate `afs.ts` beside themselves, so the harness's own tools
 *                             are code, versioned with what answers for them, never written
 *                             out by a boot.
 *    `<dir>/org/bin`          what the org installs for all its agents (`gws`).
 *    `<dir>/agents/<id>/bin`  what THIS agent installed for itself — its own folder, so a
 *                             binary it fetched is as private as its notes.
 *    the process's own PATH   inherited verbatim: the system underneath.
 *  `env` (optional) is issued into every spawn — the egress proxy's handoff vars (§9).
 *  What is per SESSION — the sticky cwd, the job set — is the shell's, opened per session
 *  on this ground. */
export async function installExecGround(
  dir: string,
  agentId: string,
  env?: () => Record<string, string>,
  defaultTimeoutMs?: number, // the system.bashTimeoutMs knob, funneled by main
): Promise<ExecGround> {
  const workspace = `${dir}/agents/${agentId}`;
  const shipped = new URL("../bin", import.meta.url).pathname;
  const binPath = `${shipped}:${dir}/org/bin:${workspace}/bin`;
  await Deno.mkdir(workspace, { recursive: true });
  await Deno.mkdir(`${dir}/org/bin`, { recursive: true });
  await Deno.mkdir(`${workspace}/bin`, { recursive: true });
  const user = agentUser(agentId);
  // the folder is the agent's: the seeded docs and `bin/` were laid by the harness, and
  // the uid that works here must be able to edit them
  await ownTree(workspace, user);
  if (user) console.error(`[exec] ${agentId}: spawns run as uid ${user.uid}`);
  return {
    shell(): ExecPlane {
      const jobs = new Set<Job>();
      const state: BashState = { cwd: workspace };
      return {
        exec: {
          bash: bashTool({
            workspace,
            binPath,
            defaultTimeoutMs,
            jobs,
            state,
            ...(env ? { env } : {}),
            ...(user ? { user } : {}),
          }),
        },
        ambient: () => bashAmbient(state, jobs),
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
          for (const { pgid } of jobs) {
            try {
              Deno.kill(-pgid, "SIGKILL");
            } catch { /* already gone */ }
          }
          jobs.clear();
          return Promise.resolve();
        },
      };
    },
  };
}
