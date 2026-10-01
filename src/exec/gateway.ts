/**
 * exec/gateway.ts — an agent's shell in a remote sandbox, through the gateway's HTTP API
 * (DESIGN §9; `sandbox/cloudflare/` is the Worker that serves it).
 *
 * The gateway runs one command per call and answers what it printed and how it exited; the
 * rest of a shell is carried by the script each call sends, so the sandbox holds nothing
 * of ours between calls but files:
 *
 *   • the command's output goes to a file under the workspace's `.out/`, both streams in
 *     arrival order — a job it leaves in the background holds that file, never the
 *     gateway's pipe, so the call returns when the command does; the file is the spill
 *     when the output is past the window, and is removed when it is not
 *   • `timeout -s KILL` bounds the call and, when it fires, kills the command's whole
 *     process group — the group whose id the script writes beside the output, so an abort
 *     kills it too and the ambient block can ask whether a job still runs in it
 *   • the environment is `env -i` and the names the shell is issued, as the local shell's
 *     cleared pocket; where the shell stands is a `cd` the script makes, since the command
 *     may leave the workspace and the next call starts where it left
 */

import { encodeBase32 } from "@std/encoding";
import { posix } from "node:path";
import {
  filePartOf,
  type Files,
  isExternal,
  kindOf,
  loadMediaBlock,
  mimeOf,
  pathOf,
  saveMedia,
  sniffMime,
} from "../store/media.ts";
import type { ExecOutcome, ExecTool } from "../xi.ts";
import type { Json } from "../types.ts";
import { newId } from "../store/id.ts";
import { MAX_BYTES, MAX_LINES } from "./truncate.ts";
import { DEFAULT_BASH_TIMEOUT_MS } from "../config.ts";
import {
  type BashInput,
  bashSpec,
  type BashState,
  CWD_MARK,
  type ExecPlane,
  type Job,
  jobLines,
  settle,
} from "./bash.ts";

/** One command's end, as the gateway reports it. */
export interface GatewayExec {
  stdout: string;
  stderr: string;
  code: number;
}

/** The gateway's API for one sandbox. */
export interface Gateway {
  /** Run `script` under bash; resolves when bash exits. */
  exec(script: string, signal?: AbortSignal): Promise<GatewayExec>;
  /** A file's bytes, by its absolute path under the workspace; null when there is none. */
  read(path: string): Promise<Uint8Array | null>;
  /** Stop the container: its processes and its files go with it. */
  destroy(): Promise<void>;
}

/** The sandbox id the gateway knows an agent's sandbox by: its id in the alphabet the
 *  bridge accepts (lowercase base32), so every agent names one sandbox and only its own. */
export function sandboxIdOf(agentId: string): string {
  return encodeBase32(new TextEncoder().encode(agentId)).replace(/=+$/, "").toLowerCase();
}

/** The gateway at `url` for the sandbox `id`, authenticated by `token`. With
 *  `sleepMinutes`, every call carries how long the sandbox lives after it
 *  (`x-sleep-after`), which the gateway sets on whichever container answered. */
export function gatewayFor(
  url: string,
  token: string,
  id: string,
  sleepMinutes?: number,
): Gateway {
  const base = `${url.replace(/\/$/, "")}/v1/sandbox/${id}`;
  const auth: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(sleepMinutes ? { "x-sleep-after": `${sleepMinutes}m` } : {}),
  };
  const refused = async (what: string, res: Response): Promise<never> => {
    throw new Error(`sandbox gateway: ${what} answered ${res.status}: ${await res.text()}`);
  };
  return {
    async exec(script, signal) {
      const res = await fetch(`${base}/exec`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ argv: ["bash", "-c", script] }),
        signal,
      });
      if (!res.ok) return refused("exec", res);
      return parseExecStream(await res.text());
    },
    async read(path) {
      const res = await fetch(`${base}/file/${path.replace(/^\/+/, "")}`, { headers: auth });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) return refused(`read ${path}`, res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // the bridge answers a missing file as an empty one: an empty body is asked again
      if (bytes.length === 0 && (await this.exec(`test -f ${quote(path)}`)).code !== 0) return null;
      return bytes;
    },
    async destroy() {
      const res = await fetch(base, { method: "DELETE", headers: auth });
      if (!res.ok && res.status !== 404) await refused("destroy", res);
      await res.body?.cancel();
    },
  };
}

/** The bridge's exec answer — server-sent events, `stdout`/`stderr` chunks in base64, then
 *  `exit` or `error` — as one end. */
export function parseExecStream(text: string): GatewayExec {
  const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const out = { stdout: "", stderr: "" };
  for (const block of text.split("\n\n")) {
    const event = /^event: (\w+)/m.exec(block)?.[1];
    const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6))
      .join("\n");
    if (event === "stdout" || event === "stderr") {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      out[event] += decoder[event].decode(bytes, { stream: true });
    } else if (event === "exit") {
      return { ...out, code: Number(JSON.parse(data).exit_code) };
    } else if (event === "error") {
      throw new Error(`sandbox gateway: ${JSON.parse(data).error}`);
    }
  }
  throw new Error("sandbox gateway: the exec stream ended without an exit");
}

/** The files port over a remote sandbox (§9): a reference is a path in the agent's folder
 *  there — relative to where the shell stands (`cwd`, else the folder), or absolute, and
 *  either way under the folder — and resolving one moves its bytes onto the
 *  conversation's media shelf under `dataDir`, content-named, so the part it answers is a
 *  local file every reader already takes and the snapshot is of bytes that never change.
 *  A link passes through untouched. */
export function gatewayFiles(
  gateway: Gateway,
  { home, cwd, dataDir, conversation }: {
    home: string;
    cwd?: () => string;
    dataDir: string;
    conversation: string;
  },
): Files {
  return {
    async resolve(ref) {
      if (isExternal(ref)) return filePartOf(ref);
      const path = posix.resolve(cwd?.() ?? home, pathOf(ref));
      if (path !== home && !path.startsWith(`${home}/`)) {
        throw new Error(`${ref}: outside your files — attach from your folder`);
      }
      const bytes = await gateway.read(path);
      if (bytes === null) throw new Error(`${ref}: no such file in your folder`);
      const named = mimeOf(path) ?? sniffMime(bytes) ?? undefined;
      const file = await saveMedia(dataDir, conversation, bytes, {
        name: posix.basename(path),
        ...(named ? { mime_type: named } : {}),
      });
      return { type: "file", kind: kindOf(file.mime_type), file };
    },
    snapshot: (part) => loadMediaBlock(part.file.uri),
  };
}

/** Single-quoted for bash: the one quoting that needs no escaping but of `'` itself. */
export const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Where a remote shell stands and what it is issued. */
export interface RemoteShellOptions {
  /** The agent's folder in the sandbox, where every session starts. */
  workspace: string;
  /** The environment every call runs with, alone (`env -i`): PATH, HOME, LANG, and what
   *  the egress proxy hands user space. */
  env: () => Record<string, string>;
  defaultTimeoutMs?: number;
  /** The sandbox's life by the harness's clock, shared by every session of its agent; the
   *  shell without one probes at every step and says nothing of a window. */
  lease?: Lease;
}

/** A sandbox's life, as the harness keeps it: a bash call starts it, and it stays on while
 *  one runs and for the window after the last one ended. A step past the window stops it
 *  (`settle`), so a quiet harness stops nothing: the gateway's own sleep, the same window
 *  counted from any request, does. Only bash moves the clock — the ambient probe and file
 *  reads keep the container awake at the gateway but never keep it on here. */
export interface Lease {
  readonly minutes: number;
  /** A bash call is running, or one ended within the window. */
  on(): boolean;
  /** A bash call ended within the window: the container holds what the calls left. */
  warm(): boolean;
  /** How long until the window closes, counted from the last bash call's end. */
  leftMs(): number;
  /** The gateway call of a bash command: in flight it holds the sandbox on, and an answer
   *  restarts the window. A call the gateway refused never reached the container. */
  bash<T>(call: () => Promise<T>): Promise<T>;
  /** Past the window with no call running: the container is stopped, once. */
  settle(): Promise<void>;
  /** The container turned out new under a warm lease: what it held is gone. */
  restarted(): void;
  /** Counts every restart; a shell says the ones it has not yet said. */
  restarts(): number;
  /** Moves at every stop and restart: a job from an earlier generation is gone. */
  generation(): number;
}

export function lease(gateway: Gateway, minutes: number, now = Date.now): Lease {
  const windowMs = minutes * 60_000;
  let last: number | undefined; // when the last bash call ended; none ⇒ off
  let running = 0;
  let restarts = 0;
  let generation = 0;
  const warm = () => last !== undefined && now() - last < windowMs;
  return {
    minutes,
    on: () => running > 0 || warm(),
    warm,
    leftMs: () => running > 0 || last === undefined ? windowMs : windowMs - (now() - last),
    async bash(call) {
      running++;
      try {
        const answer = await call();
        last = now();
        return answer;
      } finally {
        running--;
      }
    },
    async settle() {
      if (running > 0 || last === undefined || warm()) return;
      last = undefined;
      generation++;
      await gateway.destroy().catch(() => {}); // the gateway's own sleep stops it otherwise
    },
    restarted() {
      restarts++;
      generation++;
    },
    restarts: () => restarts,
    generation: () => generation,
  };
}

/** The file whose absence tells a call the container is new: the container's own scratch,
 *  which a stopped container does not keep. Every bash call and probe leaves it. */
const UP = "/tmp/.liquen-up";
/** The line a bash call's script opens with when it found no `UP`. */
const FRESH = "__MU_FRESH__";

/** The exit code `timeout` answers when it had to kill the command. */
const TIMED_OUT = 137;
/** The exit code the script answers when the shell cannot stand where it was. */
const LOST = 97;

/** The test that a process group still runs something: a member that is not a zombie. The
 *  container's init leaves an orphan unreaped, so a finished job stays in the table as
 *  `Z` until the container goes, and would count as running by its presence alone. */
const alive = (pgid: string) =>
  `ps -eo pgid=,stat= | awk -v g=${pgid} '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'`;

/** One session's shell in a remote sandbox: the same contract as the local one — the
 *  bash tool, its ambient lines, `stand` and `reap` — carried by the script each call
 *  sends. */
export function remoteShell(gateway: Gateway, opts: RemoteShellOptions): ExecPlane {
  const timeoutMsDefault = opts.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const { lease } = opts;
  let generation = lease?.generation() ?? 0;
  let restarts = lease?.restarts() ?? 0;
  /** This session's jobs ran in a container the lease has since stopped or seen restart:
   *  they are gone with it, and a pgid of theirs may name a new process there. */
  const forgetGone = () => {
    if (!lease || lease.generation() === generation) return;
    generation = lease.generation();
    jobs.clear();
  };
  /** The sandbox's line in the ambient block, in the anchor's grammar: when it stops, and
   *  that jobs and files go with it — or that a restart this session has not yet been told
   *  of took them. */
  const sandboxLine = (): string => {
    const restarted = lease!.restarts() !== restarts;
    restarts = lease!.restarts();
    const stops = `stops in ${Math.max(1, Math.ceil(lease!.leftMs() / 60_000))}m`;
    return restarted
      ? `sandbox: restarted · ${stops} · earlier jobs and files are gone`
      : `sandbox: idle · ${stops} · jobs and files go with it`;
  };
  const state: BashState = { cwd: opts.workspace };
  const jobs = new Set<Job>();
  const out = `${opts.workspace}/.out`;

  const bash: ExecTool = {
    spec: bashSpec(timeoutMsDefault),
    async execute(input: Json, signal: AbortSignal): Promise<Json | ExecOutcome> {
      const call = input as unknown as BashInput;
      const timeoutMs = call.timeout !== undefined ? call.timeout * 1000 : timeoutMsDefault;
      const log = `${out}/bash-${newId()}.log`;
      const env = Object.entries(opts.env()).map(([k, v]) => quote(`${k}=${v}`)).join(" ");
      // the command's end — where it stood, how it exited — goes beside the log, so the log
      // is the output alone and the spill it may become is the output alone
      const inner = `${call.command}\n__mu_rc=$?; printf '%s:%s' "$(pwd)" "$__mu_rc" > ` +
        quote(`${log}.end`);
      // the log is removed only when its output fits the window the call asked for: a
      // truncation (past the lines or the bytes) always finds its spill
      const lines = call.max_lines ?? MAX_LINES;
      const bytes = call.max_bytes ?? MAX_BYTES;
      const script = [
        `[ -f ${UP} ] || echo ${FRESH}; touch ${UP}`,
        `mkdir -p ${quote(out)}`,
        `cd ${quote(state.cwd)} 2>/dev/null || exit ${LOST}`,
        `env -i ${env} timeout -s KILL ${Math.ceil(timeoutMs / 1000)} ` +
        `bash -c ${quote(inner)} < /dev/null > ${quote(log)} 2>&1 &`,
        `pgid=$!; echo "$pgid" > ${quote(`${log}.pgid`)}; wait "$pgid"; rc=$?`,
        `cat ${quote(log)}`,
        `if [ -f ${quote(`${log}.end`)} ]; then ` +
        `printf '\\n${CWD_MARK}%s\\n' "$(cat ${quote(`${log}.end`)})"; fi`,
        `if ${alive('"$pgid"')}; then echo "__MU_JOB__$pgid"; fi`,
        `if [ "$(wc -l < ${quote(log)})" -lt ${lines} ] && ` +
        `[ "$(wc -c < ${quote(log)})" -le ${bytes} ]; then rm -f ${quote(log)}; fi`,
        `rm -f ${quote(`${log}.pgid`)} ${quote(`${log}.end`)}`,
        `exit "$rc"`,
      ].join("\n");

      // a container new under a warm lease restarted behind the harness; under a cold one,
      // this call is what starts it
      const warm = lease?.warm() ?? false;
      let end;
      try {
        const send = () => gateway.exec(script, signal);
        end = await (lease ? lease.bash(send) : send());
      } catch (err) {
        if (signal.aborted) {
          // the gateway's call is gone, the command is not: kill its group by the id it left
          await gateway.exec(`kill -KILL -"$(cat ${quote(`${log}.pgid`)})" 2>/dev/null`)
            .catch(() => {});
          throw new Error("Command aborted");
        }
        throw err;
      }
      if (end.stdout.startsWith(`${FRESH}\n`)) {
        end = { ...end, stdout: end.stdout.slice(FRESH.length + 1) };
        if (warm) lease!.restarted();
      }
      forgetGone();
      if (end.code === LOST && end.stdout === "") {
        const lost = state.cwd;
        state.cwd = opts.workspace;
        throw new Error(`${lost}: cannot stand there — the next call starts in ${opts.workspace}`);
      }
      let raw = end.stdout;
      const job = /\n?__MU_JOB__(\d+)\n?$/.exec(raw);
      if (job) {
        raw = raw.slice(0, job.index);
        jobs.add({ pgid: Number(job[1]), command: call.command.trim(), since: Date.now() });
      }
      const timedOut = end.code === TIMED_OUT && !raw.includes(CWD_MARK);
      return await settle(
        raw,
        { code: end.code, timedOut, aborted: signal.aborted, timeoutMs },
        call,
        state,
        () => Promise.resolve(log),
      );
    },
  };

  return {
    exec: { bash },
    cwd: () => state.cwd,
    async ambient() {
      const lines = [`cwd: ${state.cwd}`];
      if (lease) {
        await lease.settle();
        forgetGone();
        // off, the probe would be what starts a container: the harness answers alone
        if (!lease.on()) return [...lines, "sandbox: off · a bash call starts it"];
      }
      const pgids = [...jobs].map((j) => j.pgid);
      const probe = [
        `[ -f ${UP} ] || echo fresh; touch ${UP}`,
        `cd ${quote(state.cwd)} 2>/dev/null || exit 0`,
        `b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) && ` +
        `echo "git: $b · $(git status --porcelain | grep -c .)"`,
        ...pgids.map((p) => `${alive(String(p))} && echo "live ${p}"`),
        "true",
      ].join("\n");
      let said = "";
      try {
        said = (await gateway.exec(probe)).stdout;
      } catch {
        // the sandbox is unreachable: the ambient block is not where to say so
        return lease ? [...lines, sandboxLine()] : lines;
      }
      if (lease) {
        if (/^fresh$/m.test(said) && lease.warm()) lease.restarted();
        forgetGone();
        lines.push(sandboxLine());
      }
      const git = /^git: (.+) · (\d+)$/m.exec(said);
      if (git) {
        const dirty = Number(git[2]);
        lines.push(`git: ${git[1]}${dirty ? ` · ${dirty} uncommitted` : " · clean"}`);
      }
      const live = new Set([...said.matchAll(/^live (\d+)$/gm)].map((m) => Number(m[1])));
      for (const j of jobs) if (!live.has(j.pgid)) jobs.delete(j);
      return [...lines, ...jobLines(jobs)];
    },
    async stand(path?: string) {
      if (path === undefined) {
        state.cwd = opts.workspace;
        return;
      }
      const end = await gateway.exec(`cd ${quote(path)}`);
      if (end.code !== 0) {
        throw new Error(`${path}: the agent cannot stand there (${end.stderr.trim()})`);
      }
      state.cwd = path;
    },
    async reap() {
      forgetGone();
      const pgids = [...jobs].map((j) => j.pgid);
      jobs.clear();
      if (pgids.length === 0 || (lease && !lease.on())) return;
      await gateway.exec(pgids.map((p) => `kill -KILL -${p} 2>/dev/null`).join("; ") + "; true")
        .catch(() => {});
    },
  };
}
