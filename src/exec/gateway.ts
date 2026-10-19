/**
 * exec/gateway.ts — an agent's shell in a remote sandbox, through the gateway's HTTP API
 * (DESIGN §9; `sandbox/cloudflare/` is the Worker that serves it).
 *
 * The gateway runs one script per request and answers what it printed and how it exited;
 * the rest of a shell is carried by the scripts the harness sends, so the sandbox holds
 * nothing of ours but files and the jobs that write them:
 *
 *   • a call starts its job (jobs.ts) — the same job shell the local one runs, in a session
 *     of its own, writing its log and its status under the workspace's `.out/` — and waits
 *     for it up to its `wait` in the script. A job still running then, or one that left
 *     something running in its group, is answered async and followed: every
 *     `REMOTE_PROBE_MS` one script looks at all of a shell's jobs, and their news is told
 *     as the local shell tells it (late.ts). A followed job holds the sandbox on (`lease`)
 *   • the log is the spill when the output is past the window, and is removed with the
 *     job's other files when nothing of the job runs and it fits
 *   • the environment is `env -i` and the names the shell is issued, as the local shell's
 *     cleared pocket; where the shell stands is a `cd` the script makes, since the command
 *     may leave the workspace and the next call starts where it left
 *   • a container found new under a followed job (it slept, or the platform replaced it)
 *     took the job with it: told final, lost
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
import type { CallRef, ExecFacts, ExecOutcome, ExecTool } from "../xi.ts";
import type { Json } from "../types.ts";
import { newId } from "../store/id.ts";
import { MAX_BYTES, MAX_LINES } from "./truncate.ts";
import { DEFAULT_BASH_WAIT_MS } from "../config.ts";
import {
  answered,
  type BashInput,
  bashShape,
  type BashState,
  type ExecPlane,
  recovered,
  resumed,
  STICKY_CWD,
  wakeOf,
  windowOf,
} from "./bash.ts";
import {
  type Found,
  type Job,
  JOB_ENV,
  JOB_SHELL,
  jobCommand,
  type JobFiles,
  jobFiles,
  type JobHost,
  jobLines,
  Jobs,
  type Look,
  LOOK_BYTES,
  parseMembers,
  quote,
  type ShellUpdate,
  Spool,
  SPOOL_CAP,
  SPOOL_KEEP_MS,
} from "./jobs.ts";

export { quote };

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

/** Where a remote shell stands and what it is issued. */
export interface RemoteShellOptions {
  /** The agent's folder in the sandbox, where every session starts. */
  workspace: string;
  /** The environment every call runs with, alone (`env -i`): PATH, HOME, LANG, and what
   *  the egress proxy hands user space. */
  env: () => Record<string, string>;
  defaultWaitMs?: number;
  /** The sandbox's life by the harness's clock, shared by every session of its agent; the
   *  shell without one probes at every step and says nothing of a window. */
  lease?: Lease;
}

/** A sandbox's life, as the harness keeps it: a bash call starts it, and it stays on while
 *  a call runs or a job is followed, and for the window after the last of them ended. A
 *  step past the window stops it (`settle`), so a quiet harness stops nothing: the
 *  gateway's own sleep, the same window counted from any request, does — and a followed
 *  job's probe is a request every `REMOTE_PROBE_MS`, so the gateway keeps the container
 *  awake while one runs. Only bash moves the clock: the ambient probe and file reads keep
 *  the container awake at the gateway but never keep it on here. */
export interface Lease {
  readonly minutes: number;
  /** A bash call or a job is running, or one ended within the window. */
  on(): boolean;
  /** One ended within the window: the container holds what the calls left. */
  warm(): boolean;
  /** How long until the window closes, counted from the last end. */
  leftMs(): number;
  /** The gateway call of a bash command: in flight it holds the sandbox on, and an answer
   *  restarts the window. A call the gateway refused never reached the container. */
  bash<T>(call: () => Promise<T>): Promise<T>;
  /** A job followed holds the sandbox on; the return lets go, and restarts the window. */
  hold(): () => void;
  /** A followed job holds it now. */
  held(): boolean;
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
  let last: number | undefined; // when the last bash call or job ended; none ⇒ off
  let running = 0; // bash calls in flight
  let holds = 0; // jobs followed
  let restarts = 0;
  let generation = 0;
  const warm = () => last !== undefined && now() - last < windowMs;
  const busy = () => running > 0 || holds > 0;
  return {
    minutes,
    on: () => busy() || warm(),
    warm,
    leftMs: () => busy() || last === undefined ? windowMs : windowMs - (now() - last),
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
    hold() {
      holds++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        last = now();
        holds--;
      };
    },
    held: () => holds > 0,
    async settle() {
      if (busy() || last === undefined || warm()) return;
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

/** The file whose absence tells a script the container is new: the container's own scratch,
 *  which a stopped container does not keep. Every bash call and probe leaves it. */
const UP = "/tmp/.liquen-up";
/** The line a script opens with when it found no `UP`. */
const FRESH = "__MU_FRESH__";
/** The exit code the script answers when the shell cannot stand where it was. */
const LOST = 97;
/** How often a remote shell looks at its jobs: one round trip for all of them, and the
 *  request that keeps the container awake at the gateway while one runs. */
export const REMOTE_PROBE_MS = 5_000;
/** A call waits on its job in steps this long (s). */
const STEP_S = 0.2;

/** The test that a process still runs: present and not a zombie. The container's init
 *  leaves an orphan unreaped, so a finished process stays in the table as `Z` until the
 *  container goes, and would count as running by its presence alone. */
const running = (pid: string) => `ps -o stat= -p ${pid} 2>/dev/null | grep -q '^[^Z]'`;
/** The same of a whole group: a member that is not a zombie. */
const alive = (pgid: string) =>
  `ps -eo pgid=,stat= | awk -v g=${pgid} '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'`;

/** The lines that look at a job, as `parseLook` reads them: whether its shell and its group
 *  still run (also left in `$r` and `$a`), its status, and its log from `from` on — the
 *  older half dropped first past `SPOOL_CAP`, and only the last `LOOK_BYTES` when more than
 *  that is new. `pg` is the group as the script names it. The processes are asked first and
 *  the files after: a shell seen gone has written its status. */
function lookAt(f: JobFiles, pg: string, from: number): string[] {
  const [log, cut] = [quote(f.log), quote(`${f.log}~`)];
  return [
    `r=0; ${running(pg)} && r=1; a=0; ${alive(pg)} && a=1; echo "running $r"; echo "alive $a"`,
    `[ -f ${quote(f.rc)} ] && echo "rc $(cat ${quote(f.rc)})"`,
    `[ -f ${quote(f.end)} ] && echo told`,
    `from=${from}; size=$(stat -c %s ${log} 2>/dev/null || echo 0)`,
    // the newer half, from a line's start: the file emptied and appended to, as the job
    // writes it, so a line it adds meanwhile is never overwritten
    `if [ "$size" -gt ${SPOOL_CAP} ]; then tail -c ${
      SPOOL_CAP / 2
    } ${log} | tail -n +2 > ${cut}; ` +
    `: > ${log}; cat ${cut} >> ${log}; cut=$((size - $(stat -c %s ${cut}))); rm -f ${cut}; ` +
    `echo shifted; if [ "$from" -lt "$cut" ]; then from=0; echo skipped; ` +
    `else from=$((from - cut)); fi; size=$(stat -c %s ${log}); fi`,
    `if [ $((size - from)) -gt ${LOOK_BYTES} ]; then from=$((size - ${LOOK_BYTES})); ` +
    `echo skipped; fi`,
    `echo "size $size"`,
    `echo "bytes $(tail -c +$((from + 1)) ${log} 2>/dev/null | head -c $((size - from)) | ` +
    `base64 -w0)"`,
  ];
}

/** A look's lines → the look. */
function parseLook(lines: string[]): Look {
  const val = (key: string) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
  const rc = Number(val("rc"));
  const b64 = val("bytes") ?? "";
  return {
    bytes: b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(),
    size: Number(val("size") ?? 0),
    shifted: lines.includes("shifted"),
    skipped: lines.includes("skipped"),
    ...(val("rc") !== undefined && Number.isInteger(rc) ? { rc } : {}),
    ...(lines.includes("told") ? { told: true } : {}),
    running: val("running") === "1",
    alive: val("alive") === "1",
  };
}

/** The logs no job runs behind any more, removed once `SPOOL_KEEP_MS` passed since their
 *  last word: the sandbox's own sweep, as a script line. */
const sweep = (out: string) =>
  `for f in ${quote(out)}/bash-*.log; do b="\${f%.log}"; [ -e "$b.pgid" ] && continue; ` +
  `[ -n "$(find "$f" -mmin +${SPOOL_KEEP_MS / 60_000} 2>/dev/null)" ] && rm -f "$b".*; done`;

/** A remote sandbox as the host of one shell's jobs (jobs.ts): one script looks at all of
 *  them. A container found new, or one the lease has since stopped or seen restart, no
 *  longer has them. */
function remoteHost(gateway: Gateway, out: string, lease?: Lease): JobHost {
  const run = async (script: string) => (await gateway.exec(script)).stdout;
  /** The lease's generation each followed job started in. */
  const born = new WeakMap<Job, number>();
  const gone = "the sandbox it ran in stopped or was replaced, and the job with it";
  return {
    probeMs: REMOTE_PROBE_MS,
    async look(jobs) {
      const said = await run([
        `[ -f ${UP} ] || echo ${FRESH}; touch ${UP}`,
        ...jobs.flatMap((j, i) => [`echo "@@ ${i}"`, ...lookAt(j.files, String(j.pgid), j.read)]),
        "true",
      ].join("\n"));
      // under a followed job, a new container is one that restarted behind the harness
      const fresh = said.startsWith(`${FRESH}\n`);
      if (fresh && jobs.some((j) => born.has(j))) lease?.restarted();
      const blocks = new Map<number, string[]>();
      let at = -1;
      for (const line of said.split("\n")) {
        const m = /^@@ (\d+)$/.exec(line);
        if (m) blocks.set(at = Number(m[1]), []);
        else if (at >= 0) blocks.get(at)!.push(line);
      }
      const looks = new Map<Job, Look>();
      jobs.forEach((job, i) => {
        const look = parseLook(blocks.get(i) ?? []);
        const moved = lease !== undefined && born.has(job) &&
          born.get(job) !== lease.generation();
        looks.set(job, fresh || moved ? { ...look, running: false, alive: false, gone } : look);
      });
      return looks;
    },
    async find(id): Promise<Found | null> {
      const f = jobFiles(out, id);
      const said = await run([
        `[ -f ${quote(f.pgid)} ] || exit 0`,
        `pg=$(cat ${quote(f.pgid)}); echo "pgid $pg"; echo "since $(stat -c %Y ${quote(f.pgid)})"`,
        `for p in $(ps -eo pid=,pgid= | awk -v g="$pg" '$2 == g { print $1 }'); do ` +
        `tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx ${
          quote(`${JOB_ENV}=${id}`)
        } && { echo ours; break; }; done`,
        "true",
      ].join("\n"));
      const pgid = Number(/^pgid (\d+)$/m.exec(said)?.[1]);
      if (!Number.isInteger(pgid) || pgid <= 1) return null;
      const since = Number(/^since (\d+)$/m.exec(said)?.[1]) * 1000;
      return { pgid, since: since || Date.now(), ours: /^ours$/m.test(said) };
    },
    async told(job) {
      await run(`mv -f ${quote(job.files.rc)} ${quote(job.files.end)} 2>/dev/null; true`);
    },
    async done(job) {
      const f = job.files;
      await run(
        `rm -f ${[f.pgid, f.rc, `${f.rc}~`, f.end, f.cwd].map(quote).join(" ")}; ` +
          `touch -c ${quote(f.log)}; ${sweep(out)}; true`,
      );
    },
    async kill(jobs) {
      if (jobs.length === 0) return;
      await run(jobs.map((j) => `kill -KILL -${j.pgid} 2>/dev/null`).join("; ") + "; true");
    },
    hold(job) {
      if (!lease) return () => {};
      born.set(job, lease.generation());
      return lease.hold();
    },
  };
}

/** One session's shell in a remote sandbox: the same contract as the local one — the bash
 *  tool, its jobs, its ambient lines, `stand`, `reap` and `leave` — carried by the scripts
 *  it sends. */
export function remoteShell(
  gateway: Gateway,
  opts: RemoteShellOptions,
  tell?: (u: ShellUpdate) => void,
): ExecPlane {
  const waitMsDefault = opts.defaultWaitMs ?? DEFAULT_BASH_WAIT_MS;
  const { lease } = opts;
  let restarts = lease?.restarts() ?? 0;
  /** The sandbox's line in the ambient block, in the anchor's grammar: when it stops, and
   *  that jobs and files go with it — or that a restart this session has not yet been told
   *  of took them. */
  const sandboxLine = (): string => {
    const restarted = lease!.restarts() !== restarts;
    restarts = lease!.restarts();
    const stops = lease!.held()
      ? `on while a job runs, then ${lease!.minutes}m`
      : `stops in ${Math.max(1, Math.ceil(lease!.leftMs() / 60_000))}m`;
    return restarted
      ? `sandbox: restarted · ${stops} · earlier jobs and files are gone`
      : `sandbox: ${lease!.held() ? "busy" : "idle"} · ${stops} · jobs and files go with it`;
  };
  const state: BashState = { cwd: opts.workspace };
  const out = `${opts.workspace}/.out`;
  const jobs = new Jobs(remoteHost(gateway, out, lease), tell);

  const bash: ExecTool = {
    ...bashShape(waitMsDefault),
    async execute(
      input: Json,
      signal: AbortSignal,
      report?: (facts: ExecFacts) => void,
      use?: CallRef,
    ): Promise<Json | ExecOutcome> {
      const call = input as unknown as BashInput;
      const waitMs = call.wait !== undefined ? call.wait * 1000 : waitMsDefault;
      const wake = wakeOf(call.wake);
      // the call's id names its job: a harness that finds the call unanswered finds the job
      const id = use?.id ?? newId();
      const f = jobFiles(out, id);
      const env = Object.entries(opts.env()).map(([k, v]) => quote(`${k}=${v}`)).join(" ");
      const q = quote;
      // the log goes with the rest only when nothing of the job runs and its output fits
      // the window the call asked for: a truncation always finds its spill
      const lines = call.max_lines ?? MAX_LINES;
      const bytes = call.max_bytes ?? MAX_BYTES;
      const script = [
        `[ -f ${UP} ] || echo ${FRESH}; touch ${UP}`,
        `mkdir -p ${q(out)}; ${sweep(out)}`,
        `cd ${q(state.cwd)} 2>/dev/null || exit ${LOST}`,
        `setsid env -i ${env} ${JOB_ENV}=${q(id)} bash -c ${q(JOB_SHELL)} liquen-job ` +
        `${q(f.base)} ${q(jobCommand(call.command, f))} < /dev/null > /dev/null 2>&1 &`,
        // the job's shell records its group as it starts
        `n=50; while [ ! -s ${q(f.pgid)} ] && [ "$n" -gt 0 ]; do sleep 0.02; n=$((n - 1)); done`,
        `pg=$(cat ${q(f.pgid)} 2>/dev/null); echo "@@ answer"; echo "pgid $pg"`,
        `n=${Math.ceil(waitMs / 1000 / STEP_S)}`,
        `while [ "$n" -gt 0 ] && [ ! -f ${q(f.rc)} ] && ${running('"$pg"')}; do ` +
        `sleep ${STEP_S}; n=$((n - 1)); done`,
        ...lookAt(f, '"$pg"', 0),
        `[ -f ${q(f.cwd)} ] && echo "cwd $(cat ${q(f.cwd)})"`,
        `if [ "$r$a" = 00 ]; then ` +
        `if [ "$(wc -l < ${q(f.log)})" -lt ${lines} ] && ` +
        `[ "$(wc -c < ${q(f.log)})" -le ${bytes} ]; then rm -f ${q(f.log)}; fi; ` +
        `rm -f ${[f.pgid, f.rc, f.end, f.cwd].map(q).join(" ")}; fi 2>/dev/null`,
        "true",
      ].join("\n");

      // a container new under a warm lease restarted behind the harness; under a cold one,
      // this call is what starts it
      const warm = lease?.warm() ?? false;
      const started = Date.now();
      let end;
      try {
        const send = () => gateway.exec(script, signal);
        end = await (lease ? lease.bash(send) : send());
      } catch (err) {
        if (signal.aborted) {
          // the gateway's call is gone, the job is not: kill its group by the id it left
          await gateway.exec(`kill -KILL -"$(cat ${q(f.pgid)})" 2>/dev/null`).catch(() => {});
          throw new Error("Command aborted");
        }
        throw err;
      }
      let said = end.stdout;
      if (said.startsWith(`${FRESH}\n`)) {
        said = said.slice(FRESH.length + 1);
        if (warm) lease!.restarted();
      }
      if (end.code === LOST && !said.includes("@@ answer")) {
        const lost = state.cwd;
        state.cwd = opts.workspace;
        throw new Error(`${lost}: cannot stand there — the next call starts in ${opts.workspace}`);
      }
      const answer = said.slice(said.indexOf("@@ answer\n") + "@@ answer\n".length).split("\n");
      const pgid = Number(answer.find((l) => l.startsWith("pgid "))?.slice(5));
      if (!Number.isInteger(pgid) || pgid <= 1) {
        throw new Error(`the command did not start: ${end.stderr.trim() || "no job shell"}`);
      }
      const cwd = answer.find((l) => l.startsWith("cwd "))?.slice(4);
      if (STICKY_CWD && cwd) state.cwd = cwd;
      const job: Job = {
        id,
        files: f,
        pgid,
        command: call.command.trim(),
        since: started,
        ...(use ? { use } : {}),
        window: windowOf(call),
        read: 0,
        spool: new Spool(f.log),
        ended: false,
      };
      return await answered(jobs, job, parseLook(answer), {
        input: call,
        waitMs,
        ...(wake ? { wake } : {}),
        ...(report ? { report } : {}),
        aborted: signal.aborted,
        isolated: true,
      });
    },
    recover: (input, use) => recovered(jobs, out, input as unknown as BashInput, use),
  };

  return {
    exec: { bash },
    cwd: () => state.cwd,
    async ambient() {
      const lines = [`cwd: ${state.cwd}`];
      if (lease) {
        await lease.settle();
        // off, the probe would be what starts a container: the harness answers alone
        if (!lease.on()) return [...lines, "sandbox: off · a bash call starts it"];
      }
      await jobs.look().catch(() => {}); // an end this look sees first is told before the list
      const pgids = [...jobs].map((j) => j.pgid);
      const probe = [
        `[ -f ${UP} ] || echo fresh; touch ${UP}`,
        `cd ${quote(state.cwd)} 2>/dev/null || exit 0`,
        `b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) && ` +
        `echo "git: $b · $(git status --porcelain | grep -c .)"`,
        // the members of each job's group, for the job lines (none when ps is missing)
        ...(pgids.length
          ? [
            `ps -e -o pgid=,pid=,args= 2>/dev/null | awk '${
              pgids.map((p) => `$1 == ${p}`).join(" || ")
            } { print "member", $0 }'`,
          ]
          : []),
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
        lines.push(sandboxLine());
      }
      const git = /^git: (.+) · (\d+)$/m.exec(said);
      if (git) {
        const dirty = Number(git[2]);
        lines.push(`git: ${git[1]}${dirty ? ` · ${dirty} uncommitted` : " · clean"}`);
      }
      const members = [...said.matchAll(/^member (.*)$/gm)].map((m) => m[1]).join("\n");
      return [...lines, ...jobLines(jobs, parseMembers(members, pgids))];
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
    reap: () => jobs.reap(),
    leave: () => jobs.leave(),
    resume: (use, input) => resumed(jobs, out, input, use),
  };
}
