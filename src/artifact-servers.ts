/**
 * artifact-servers.ts — the servers of the artifacts agents publish (artifacts.ts): each
 * `server.ts` run from its folder, on the ground of the agent that published it, while its
 * artifact lives.
 *
 * A server is `deno run` with what its artifact was published with and no more: its own
 * folder to read and write, the network toward the hosts it named and the socket it listens
 * on, and the environment the agent's shell is issued, where the egress proxy fronts the
 * agent's tokens, so a key is a placeholder there. Published `native`, it also loads the
 * native libraries npm packages ship (`--allow-ffi` on the npm cache, and the system's facts
 * their loaders read), which run outside Deno's checks (ARTIFACTS.md). It reads no config of
 * the org's: its imports resolve through a map that holds the package's `artifact` module
 * alone. It runs inside the agent's bubble when the org has one.
 *
 * Its output goes to the run's log, each line tagged `[artifact <slug>]`, and to
 * `.artifact.log` in its folder, where the agent reads it. A server that ends is started
 * again, later each time while it keeps ending soon after its start; a publish starts it
 * anew from the folder as it stands then.
 */

import { TextLineStream } from "@std/streams";
import { type Artifact, SERVER_FILE, SERVER_SOCKET } from "./artifacts.ts";
import { denoDir, type GroundCommand, hasSetsid } from "./exec/bash.ts";

/** The log a server's lines are kept in, beside its socket: dot-named, so no publish takes
 *  it. */
export const SERVER_LOG = ".artifact.log";
/** Past this, a server's log starts over at its next start. */
const LOG_MOST = 1024 * 1024;
/** The first wait before a server that ended is started again, and the longest. */
const RESTART_MS = 1_000;
const RESTART_MOST_MS = 60_000;
/** A server that ran this long before it ended starts again at once. */
const STEADY_MS = 60_000;
/** How long a stopped server has to end before it is killed. */
const STOP_MS = 5_000;

export interface ServersDeps {
  /** The org's data root: an artifact's folder is relative to it. */
  dir: string;
  /** How `argv` runs on an agent's ground (`Sandbox.command`). */
  ground: (agentId: string, argv: string[], cwd: string) => Promise<GroundCommand>;
  /** A line for the run log. */
  say?: (line: string) => void;
}

export interface Servers {
  /** Run an artifact's server, anew when it runs already. Throws when it can't start. */
  start(a: Artifact): Promise<void>;
  /** End an artifact's server; one not running is no error. */
  stop(slug: string): Promise<void>;
  /** Run exactly the servers of `live`: one missing started, one no longer there ended. */
  reconcile(live: Artifact[]): Promise<void>;
  close(): Promise<void>;
}

/** The socket a server listens on, absolute. */
export const socketOf = (dir: string, a: Pick<Artifact, "folder">) =>
  `${dir}/${a.folder}/${SERVER_SOCKET}`;

interface Running {
  id: string;
  /** The socket it listens on: gone once it is stopped. */
  sock: string;
  child?: Deno.ChildProcess;
  /** The process group to signal: the child's own under `setsid`. */
  group: boolean;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ended: Promise<void>;
}

export function createServers(deps: ServersDeps): Servers {
  const say = deps.say ?? ((line: string) => console.error(line));
  const running = new Map<string, Running>();
  let map: Promise<string> | undefined;
  /** The import map every server resolves through, written once a run. */
  const importMap = () =>
    map ??= (async () => {
      const path = `${deps.dir}/system/artifact-imports.json`;
      await Deno.mkdir(`${deps.dir}/system`, { recursive: true });
      const helper = new URL("./artifact.ts", import.meta.url).href;
      await Deno.writeTextFile(
        path,
        JSON.stringify({ imports: { "@liquen/liquen/artifact": helper } }, null, 2) + "\n",
      );
      return path;
    })();

  const argvOf = async (a: Artifact, folder: string, sock: string): Promise<string[]> => {
    const server = a.server!;
    const net = [...server.hosts, `unix:${sock}`].join(",");
    return [
      Deno.execPath(),
      "run",
      "--no-config",
      "--no-lock",
      "--no-prompt",
      `--import-map=${await importMap()}`,
      `--allow-read=${folder}`,
      `--allow-write=${folder}`,
      `--allow-net=${net}`,
      "--allow-env",
      ...(server.native ? [`--allow-ffi=${await denoDir()}/npm`, "--allow-sys"] : []),
      `${folder}/${SERVER_FILE}`,
    ];
  };

  /** Each line of a stream, said and kept. */
  const pipe = async (stream: ReadableStream<Uint8Array>, slug: string, log: Deno.FsFile) => {
    const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
    const enc = new TextEncoder();
    for await (const line of lines) {
      say(`[artifact ${slug}] ${line}`);
      await log.write(enc.encode(`${line}\n`)).catch(() => {});
    }
  };

  const spawn = async (a: Artifact, r: Running, quick: number): Promise<void> => {
    const folder = `${deps.dir}/${a.folder}`;
    const sock = socketOf(deps.dir, a);
    // the socket the last server left: Deno binds no path that is there
    await Deno.remove(sock).catch(() => {});
    const logPath = `${folder}/${SERVER_LOG}`;
    if (((await Deno.stat(logPath).catch(() => null))?.size ?? 0) > LOG_MOST) {
      await Deno.remove(logPath).catch(() => {});
    }
    const log = await Deno.open(logPath, { append: true, create: true });
    await log.write(new TextEncoder().encode(`--- started ${new Date().toISOString()}\n`));
    const cmd = await deps.ground(a.agentId, await argvOf(a, folder, sock), folder);
    r.group = hasSetsid();
    const argv = r.group ? ["setsid", ...cmd.argv] : cmd.argv;
    const child = new Deno.Command(argv[0], {
      args: argv.slice(1),
      cwd: folder,
      clearEnv: true,
      env: { ...cmd.env, NO_COLOR: "1", LIQUEN_ARTIFACT_SOCKET: sock, LIQUEN_ARTIFACT: a.slug },
      ...(cmd.uid !== undefined ? { uid: cmd.uid, gid: cmd.gid } : {}),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    r.child = child;
    const began = Date.now();
    r.ended = (async () => {
      const [status] = await Promise.all([
        child.status,
        pipe(child.stdout, a.slug, log),
        pipe(child.stderr, a.slug, log),
      ]);
      log.close();
      if (r.stopped || running.get(a.slug) !== r) return;
      const steady = Date.now() - began >= STEADY_MS;
      const n = steady ? 0 : quick + 1;
      const wait = steady ? 0 : Math.min(RESTART_MOST_MS, RESTART_MS * 2 ** (n - 1));
      say(
        `[artifact ${a.slug}] ended (exit ${status.code}); ` +
          (wait ? `starting again in ${wait / 1000}s` : "starting again"),
      );
      r.timer = setTimeout(() => {
        r.timer = undefined;
        if (r.stopped || running.get(a.slug) !== r) return;
        spawn(a, r, n).catch((err) => say(`[artifact ${a.slug}] could not start again: ${err}`));
      }, wait);
    })();
  };

  const stop = async (slug: string): Promise<void> => {
    const r = running.get(slug);
    if (!r) return;
    running.delete(slug);
    r.stopped = true;
    if (r.timer !== undefined) clearTimeout(r.timer);
    const child = r.child;
    if (!child) return await Deno.remove(r.sock).catch(() => {});
    const signal = (sig: Deno.Signal) => {
      try {
        if (r.group) Deno.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* ended already */ }
    };
    signal("SIGTERM");
    const killed = setTimeout(() => signal("SIGKILL"), STOP_MS);
    await r.ended.catch(() => {});
    clearTimeout(killed);
    await Deno.remove(r.sock).catch(() => {});
  };

  const start = async (a: Artifact): Promise<void> => {
    await stop(a.slug);
    if (!a.server) return;
    const r: Running = {
      id: a.id,
      sock: socketOf(deps.dir, a),
      group: false,
      stopped: false,
      ended: Promise.resolve(),
    };
    running.set(a.slug, r);
    try {
      await spawn(a, r, 0);
    } catch (err) {
      running.delete(a.slug);
      throw err;
    }
  };

  return {
    start,
    stop,
    async reconcile(live) {
      const wanted = new Map(live.filter((a) => a.server).map((a) => [a.slug, a]));
      for (const [slug, r] of [...running]) {
        if (wanted.get(slug)?.id !== r.id) await stop(slug);
      }
      for (const a of wanted.values()) {
        if (running.has(a.slug)) continue;
        await start(a).catch((err) => say(`[artifact ${a.slug}] could not start: ${err}`));
      }
    },
    async close() {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}
