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

/** The gateway at `url` for the sandbox `id`, authenticated by `token`. */
export function gatewayFor(url: string, token: string, id: string): Gateway {
  const base = `${url.replace(/\/$/, "")}/v1/sandbox/${id}`;
  const auth = { authorization: `Bearer ${token}` };
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
 *  there — relative to it, or absolute under it — and resolving one moves its bytes onto the
 *  conversation's media shelf under `dataDir`, content-named, so the part it answers is a
 *  local file every reader already takes and the snapshot is of bytes that never change.
 *  A link passes through untouched. */
export function gatewayFiles(
  gateway: Gateway,
  { home, dataDir, conversation }: { home: string; dataDir: string; conversation: string },
): Files {
  return {
    async resolve(ref) {
      if (isExternal(ref)) return filePartOf(ref);
      const path = posix.resolve(home, pathOf(ref));
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
}

/** The exit code `timeout` answers when it had to kill the command. */
const TIMED_OUT = 137;
/** The exit code the script answers when the shell cannot stand where it was. */
const LOST = 97;

/** One session's shell in a remote sandbox: the same contract as the local one — the
 *  bash tool, its ambient lines, `stand` and `reap` — carried by the script each call
 *  sends. */
/** The test that a process group still runs something: a member that is not a zombie. The
 *  container's init leaves an orphan unreaped, so a finished job stays in the table as
 *  `Z` until the container goes, and would count as running by its presence alone. */
const alive = (pgid: string) =>
  `ps -eo pgid=,stat= | awk -v g=${pgid} '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'`;

export function remoteShell(gateway: Gateway, opts: RemoteShellOptions): ExecPlane {
  const timeoutMsDefault = opts.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
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

      let end;
      try {
        end = await gateway.exec(script, signal);
      } catch (err) {
        if (signal.aborted) {
          // the gateway's call is gone, the command is not: kill its group by the id it left
          await gateway.exec(`kill -KILL -"$(cat ${quote(`${log}.pgid`)})" 2>/dev/null`)
            .catch(() => {});
          throw new Error("Command aborted");
        }
        throw err;
      }
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
    async ambient() {
      const pgids = [...jobs].map((j) => j.pgid);
      const probe = [
        `cd ${quote(state.cwd)} 2>/dev/null || exit 0`,
        `b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) && ` +
        `echo "git: $b · $(git status --porcelain | grep -c .)"`,
        ...pgids.map((p) => `${alive(String(p))} && echo "live ${p}"`),
        "true",
      ].join("\n");
      const lines = [`cwd: ${state.cwd}`];
      let said = "";
      try {
        said = (await gateway.exec(probe)).stdout;
      } catch {
        return lines; // the sandbox is unreachable: the ambient block is not where to say so
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
      const pgids = [...jobs].map((j) => j.pgid);
      jobs.clear();
      if (pgids.length === 0) return;
      await gateway.exec(pgids.map((p) => `kill -KILL -${p} 2>/dev/null`).join("; ") + "; true")
        .catch(() => {});
    },
  };
}
