/**
 * start.ts — `liquen start`: the org as one command (DESIGN §9).
 *
 * A keep-alive loop and nothing more: read the catalog, spawn one child per process the
 * org declares — main (the tail + fan-out, hosting the egress proxy) and one per
 * `connections.<name>` — and respawn whatever exits, with backoff. The log is the bus,
 * so there is no dependency order, no readiness probe, no IPC: a child finds the org the
 * way every process does (cwd walks up to config.jsonc), and env rides through untouched
 * (secrets only).
 *
 * Death is loud on stderr and nowhere else — the supervisor never opens the log; the
 * outer layer (docker restart, systemd, the terminal) supervises `liquen start` itself.
 * SIGTERM fans out to the children, waits `STOP_TIMEOUT_MS`, then SIGKILLs.
 *
 * Every line a child writes arrives stamped — `HH:MM:SS [name] …` — so attribution is
 * the harness's property, not a convention each service must remember: panics and
 * stack traces land tagged too. The stdout/stderr split rides through (stdout is data,
 * stderr is diagnostics). After the boot lines, silence means every process is up.
 */

import { TextLineStream } from "@std/streams";
import { findRoot, orgFlag, readConfig, STOP_TIMEOUT_MS } from "./config.ts";

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 60_000;
const HEALTHY_MS = 60_000; // uptime that forgives past crashes: the next backoff starts over

/** Doubling delay per consecutive early exit, capped. */
export function backoffMs(failures: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** Math.max(0, failures - 1), RESTART_CAP_MS);
}

/** The restart wait — cut short the moment the supervisor is told to stop, so a SIGTERM
 *  that lands mid-backoff ends the process now and not a minute later. */
export function pause(ms: number, halt: AbortSignal): Promise<void> {
  if (halt.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      halt.removeEventListener("abort", done);
      resolve();
    }
    halt.addEventListener("abort", done, { once: true });
  });
}

const enc = new TextEncoder();
const clock = () => new Date().toLocaleTimeString("en-GB");

/** One attributed line — the whole observability surface. */
function stamp(name: string, line: string, err = true): void {
  (err ? Deno.stderr : Deno.stdout).writeSync(enc.encode(`${clock()} [${name}] ${line}\n`));
}

async function pump(stream: ReadableStream<Uint8Array>, name: string, err: boolean): Promise<void> {
  const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) stamp(name, line, err);
}

/** name → entry module for everything the catalog says this org runs. A connection is
 *  ONE process, its folder's `run.ts`: `src/connect/<name>/` ships with core,
 *  `<root>/connectors/<name>/` is the org's own. A declared connection with no run.ts
 *  is a boot error, same law as an unknown config key. */
export function roster(root: string, connections: Record<string, unknown>): [string, string][] {
  const has = (p: string | URL) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const procs: [string, string][] = [["main", new URL("./main.ts", import.meta.url).href]];
  for (const name of Object.keys(connections)) {
    const bundled = new URL(`./connect/${name}/run.ts`, import.meta.url);
    const local = `${root}/connectors/${name}/run.ts`;
    if (has(bundled)) procs.push([name, bundled.href]);
    else if (has(local)) procs.push([name, local]);
    else {
      throw new Error(
        `connection "${name}" is declared in config.jsonc but has no process: ` +
          `no run.ts under src/connect/${name}/ or ${root}/connectors/${name}/`,
      );
    }
  }
  return procs;
}

if (import.meta.main) {
  const root = findRoot(orgFlag());
  const catalog = await readConfig(root);
  const procs = roster(root, catalog.connections);
  const live = new Map<string, Deno.ChildProcess>();
  const halt = new AbortController();
  const stopping = () => halt.signal.aborted;

  const keepAlive = async ([name, module]: [string, string]) => {
    let failures = 0;
    while (!stopping()) {
      const started = Date.now();
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", module],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      live.set(name, child);
      const pumps = [pump(child.stdout, name, false), pump(child.stderr, name, true)];
      const status = await child.status;
      await Promise.all(pumps); // the streams end at exit; drain the tail before reporting
      live.delete(name);
      if (stopping()) return;
      const uptime = Date.now() - started;
      failures = uptime >= HEALTHY_MS ? 1 : failures + 1;
      const wait = backoffMs(failures);
      stamp(
        "liquen",
        // the signal is the whole diagnosis when a child dies quietly: a killed process
        // reports code 0, so the code alone reads like a clean exit
        `${name} exited (${status.signal ?? `code ${status.code}`}) after ` +
          `${Math.round(uptime / 1000)}s — restarting in ${wait / 1000}s`,
      );
      await pause(wait, halt.signal);
    }
  };

  const stop = () => {
    if (stopping()) return;
    halt.abort();
    stamp("liquen", `stopping ${live.size} process(es)`);
    for (const c of live.values()) {
      try {
        c.kill("SIGTERM");
      } catch { /* already gone */ }
    }
    const hammer = setTimeout(() => {
      for (const c of live.values()) {
        try {
          c.kill("SIGKILL");
        } catch { /* already gone */ }
      }
    }, STOP_TIMEOUT_MS);
    Deno.unrefTimer(hammer); // children all exiting cleanly must let the process end
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);

  stamp("liquen", `${procs.map(([n]) => n).join(" · ")} — root ${root}`);
  await Promise.all(procs.map(keepAlive));
}
