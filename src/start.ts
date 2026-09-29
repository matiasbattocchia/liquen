/**
 * start.ts — `liquen start`: the org as one command (DESIGN §9).
 *
 * A keep-alive loop and nothing more: read the catalog, spawn one child per process the
 * org declares — main (the tail + fan-out, hosting the egress proxy), one per
 * `connections.<name>`, the edge (edge.ts) and the tunnel the org runs itself
 * (`edge.tunnel`, any argv) — and respawn whatever exits, with
 * backoff. The log is the bus, so there is no dependency order, no readiness probe, no
 * IPC: a child finds the org the way every process does (cwd walks up to config.jsonc),
 * and env rides through untouched (secrets only).
 *
 * A child that CRASHES comes back; a child that REFUSES does not. The two are told apart
 * by the exit code `entry` chose (`REFUSAL` — a sentence was printed, and a port already
 * held or a key the file got wrong will be held and wrong again a second later), so the
 * org runs on with whatever is left instead of reprinting one complaint every minute
 * forever. When nothing is left, `liquen start` refuses too, naming who gave up.
 *
 * The file is read at boot and again on `RELOAD` (`liquen reload`, and every setup door
 * that writes it): the run is brought in line with the file as it is now. Each process
 * restarts when the part of the file it reads changed (`reads`), a connection declared
 * since starts, one no longer declared stops, and one that refused gets another go — the
 * world it refused may be what the edit changed. A file boot would reject changes nothing:
 * the supervisor says why and runs on as it was.
 *
 * One of each role. A run holds `data/run/liquen.pid` for its life and its main holds
 * `data/run/main.pid` (stop.ts) — the locks that make them findable, so `liquen stop` has
 * pids to signal, and a second supervisor, or a start over a mind an interface already
 * raised, refuses instead of doubling every tail, fan-out and mirror over one log.
 *
 * Death is loud on stderr and nowhere else — the supervisor never opens the log; the
 * outer layer (docker restart, systemd, the terminal) supervises `liquen start` itself.
 * SIGTERM fans out to the children, waits `STOP_TIMEOUT_MS`, then SIGKILLs.
 *
 * Every line a child writes arrives stamped — `HH:MM:SS [name] …` — so attribution is
 * the harness's property, not a convention each service must remember: panics and
 * stack traces land tagged too. The stdout/stderr split rides through (stdout is data,
 * stderr is diagnostics). After the boot lines, silence means every process is up. On a
 * terminal each tag has a color of its own, so one process's lines read as a column in the
 * interleave; piped, or under NO_COLOR, the bytes are plain.
 *
 * `-D` runs the same supervisor detached: in a session of its own, its every byte appended
 * to `data/run/liquen.log`, and the prompt back once the run holds its lock. A refusal
 * before that — a second start, a catalog boot rejects — is printed from the log with the
 * code it exited with, so a detached start that failed never reads like one that worked.
 */

import { TextLineStream } from "@std/streams";
import { findRoot, type OrgConfig, orgFlag, readConfig, STOP_TIMEOUT_MS } from "./config.ts";
import { entry, REFUSAL } from "./entry.ts";
import { claim, holder, MAIN, RELOAD, SUPERVISOR } from "./stop.ts";
import { RUNNING, SHIPPED } from "./connect/connect.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = `usage: liquen start [-D | --detach] [--dir <org>]

  Run the org: main and one process per declared connection, each restarted when it dies.

  -D, --detach   run in the background, its lines appended to data/run/liquen.log;
                 \`liquen stop\` ends it
  --dir <org>    the org, when run from elsewhere`;

/** How long a detached start waits for the run to hold its lock before handing back the
 *  prompt without that word. */
const DETACH_WAIT_MS = 15_000;

/** What a start over a running org is told. */
const RUNNING_HINT = "`liquen reload` takes up an edit to config.jsonc; `liquen stop` ends it";

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 60_000;
const HEALTHY_MS = 60_000; // uptime that forgives past crashes: the next backoff starts over

/** Whether a child that just exited earns another try. A REFUSAL is the one exit that
 *  does not: the child printed a sentence about the world as it is (a port already held, a
 *  key the file got wrong), and a second run reads the same world. Every other death —
 *  a fault, a signal, a clean exit nobody asked for — comes back. A signalled child is
 *  never a refusal whatever code it reports: the code is the killer's, not the child's. */
export function comesBack(status: Deno.CommandStatus): boolean {
  return !(status.code === REFUSAL && status.signal === null);
}

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

/** ANSI foregrounds for the children's tags, handed out in the order the names first speak:
 *  cyan, green, magenta, blue, yellow, then the bright ones. */
const PALETTE = [36, 32, 35, 34, 33, 96, 92, 95, 94, 93];
const tints = new Map<string, number>();

/** A name's tag as a terminal shows it: the supervisor's own bold, each child its color. */
export function tag(name: string): string {
  if (name === SUPERVISOR) return `\x1b[1m[${name}]\x1b[22m`;
  let tint = tints.get(name);
  if (tint === undefined) tints.set(name, tint = PALETTE[tints.size % PALETTE.length]);
  return `\x1b[${tint}m[${name}]\x1b[39m`;
}

const painted = {
  out: !Deno.noColor && Deno.stdout.isTerminal(),
  err: !Deno.noColor && Deno.stderr.isTerminal(),
};

/** One attributed line — the whole observability surface. */
function stamp(name: string, line: string, err = true): void {
  const text = painted[err ? "err" : "out"]
    ? `\x1b[2m${clock()}\x1b[22m ${tag(name)} ${line}\n`
    : `${clock()} [${name}] ${line}\n`;
  (err ? Deno.stderr : Deno.stdout).writeSync(enc.encode(text));
}

/** `-D`: this module again, as a child in a session of its own with the shell's redirect
 *  appending its every byte — its own last words included — to the log. Answers once the
 *  child holds the supervisor's lock, or with the child's code when it exits first. The
 *  lock is read, not probed: a probe takes the lock for an instant, and the child's claim
 *  landing in that instant would refuse. */
async function detach(root: string): Promise<void> {
  const log = `${root}/data/run/liquen.log`;
  const pidFile = `${root}/data/run/${SUPERVISOR}.pid`;
  await Deno.mkdir(`${root}/data/run`, { recursive: true });
  const from = await Deno.stat(log).then((s) => s.size, () => 0);
  const child = new Deno.Command("sh", {
    args: ["-c", 'exec "$@" >>"$0" 2>&1', log, Deno.execPath(), "run", "-A", import.meta.url],
    cwd: root,
    stdin: "null",
    stdout: "null",
    stderr: "null",
    detached: true,
  }).spawn();
  let exited: Deno.CommandStatus | null = null;
  child.status.then((s) => exited = s);
  const holds = () =>
    Deno.readTextFile(pidFile).then((t) => Number.parseInt(t, 10) === child.pid, () => false);
  const deadline = Date.now() + DETACH_WAIT_MS;
  while (exited === null && !(await holds()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = exited as Deno.CommandStatus | null;
  if (status !== null) {
    const file = await Deno.open(log);
    await file.seek(from, Deno.SeekMode.Start);
    await file.readable.pipeTo(Deno.stderr.writable, { preventClose: true });
    Deno.exit(status.signal === null && status.code !== 0 ? status.code : 1);
  }
  child.unref();
  const rel = log.slice(root.length + 1);
  console.log(
    (await holds() ? `running as pid ${child.pid}` : `started as pid ${child.pid}`) +
      ` — its lines go to ${rel}; \`liquen stop\` ends it`,
  );
}

async function pump(stream: ReadableStream<Uint8Array>, name: string, err: boolean): Promise<void> {
  const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) stamp(name, line, err);
}

/** One process of the org's run: its tag, and the command that is it. */
export interface Proc {
  name: string;
  argv: string[];
}

/** A liquen module as a process: this deno, the module, every permission. */
function module(name: string, url: string): Proc {
  return { name, argv: [Deno.execPath(), "run", "-A", url] };
}

/** Everything the catalog says this org runs. A connection is ONE process, its folder's
 *  `run.ts`: `src/connect/<name>/` ships with core, `<root>/connectors/<name>/` is the
 *  org's own. A shipped service that only grants a credential is declared for its knobs
 *  and runs nothing; a custom connection with no run.ts is a boot error, same law as an
 *  unknown config key. The edge is every connector's door and always stands; the tunnel
 *  is whatever argv the catalog says, verbatim. */
export function roster(root: string, cfg: Pick<OrgConfig, "connections" | "edge">): Proc[] {
  const has = (p: string | URL) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const procs: Proc[] = [module("main", new URL("./main.ts", import.meta.url).href)];
  for (const name of Object.keys(cfg.connections)) {
    const bundled = new URL(`./connect/${name}/run.ts`, import.meta.url);
    const local = `${root}/connectors/${name}/run.ts`;
    if (RUNNING.includes(name)) procs.push(module(name, bundled.href));
    else if (SHIPPED.includes(name)) continue;
    else if (has(local)) procs.push(module(name, local));
    else {
      throw new Error(
        `connection "${name}" is declared in config.jsonc but has no process: ` +
          `no run.ts under src/connect/${name}/ or ${root}/connectors/${name}/`,
      );
    }
  }
  procs.push(module("edge", new URL("./edge.ts", import.meta.url).href));
  if (cfg.edge.tunnel) procs.push({ name: "tunnel", argv: cfg.edge.tunnel });
  return procs;
}

/** The part of the file a process reads, as a reload compares it. Every liquen process
 *  reads the shared sections (where the store is, the org's clock); main reads the roster
 *  too, and the WhatsApp bridge's address, because it speaks to the bridge itself (the
 *  address book, the rooms); a connection reads the edge and its own section; the edge its
 *  section; the tunnel is its argv. */
export function reads(name: string, cfg: OrgConfig): string {
  const { agents, connections, edge, ...shared } = cfg;
  if (name === "main") {
    return JSON.stringify({ ...shared, agents, bridge: connections.whatsapp?.bridgeUrl });
  }
  if (name === "edge") return JSON.stringify(edge);
  if (name === "tunnel") return JSON.stringify(edge.tunnel);
  return JSON.stringify({ ...shared, edge, own: connections[name] });
}

/** What a process of the run is to a reload: what it read of the file when it started, and
 *  whether it refused (down for good until a reload gives it another go). */
export interface Kept {
  reads: string;
  refused: boolean;
}

/** A reload's moves, from what the run keeps to what the file says now: what stops (no
 *  longer declared), what restarts (its part of the file changed, or it refused), what
 *  starts (declared since). A process the edit left alone is in none of them. */
export function plan(
  kept: Map<string, Kept>,
  next: Proc[],
  cfg: OrgConfig,
): { stop: string[]; restart: Proc[]; start: Proc[] } {
  const wanted = new Set(next.map((p) => p.name));
  return {
    stop: [...kept.keys()].filter((name) => !wanted.has(name)),
    restart: next.filter((p) => {
      const one = kept.get(p.name);
      return one !== undefined && (one.refused || one.reads !== reads(p.name, cfg));
    }),
    start: next.filter((p) => !kept.has(p.name)),
  };
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const background = org.args.some((a) => a === "-D" || a === "--detach");
    const stray = org.args.find((a) => a !== "-D" && a !== "--detach");
    if (stray !== undefined) throw new Error(`unknown argument ${stray}\n${USAGE}`);
    const root = findRoot(org);
    const cfg = await readConfig(root);
    const procs = roster(root, cfg);
    // ONE OF EACH ROLE (stop.ts). The locks are taken after the catalog is read, so a
    // manifest this run cannot serve refuses on its own terms and not on a lock it went
    // on to drop
    const dir = `${root}/data`;
    await Deno.mkdir(dir, { recursive: true });
    if (background) {
      // the probe is safe here, with no child yet to claim; the child checks again for real
      const pid = await holder(dir, SUPERVISOR);
      if (pid !== null) {
        throw new Error(`${root} is already running as pid ${pid} — ${RUNNING_HINT}`);
      }
      return await detach(root);
    }
    const lock = claim(dir, SUPERVISOR);
    if ("taken" in lock) {
      const who = lock.taken === null ? "" : ` as pid ${lock.taken}`;
      throw new Error(`${root} is already running${who} — ${RUNNING_HINT}`);
    }
    // the mind may already be up without a supervisor: an interface that found no daemon
    // raised an ephemeral one. Main refuses the duplicate on its own lock either way — this
    // is only so the sentence arrives before a single child is spawned
    const mind = await holder(dir, MAIN);
    if (mind !== null) {
      throw new Error(
        `a main already runs ${root} (pid ${mind}) — an interface raised it; ` +
          `\`liquen stop\` first`,
      );
    }
    /** A process the run keeps: its `Kept` facts, the switch that retires it, and its
     *  keep-alive loop, `down` once that loop has ended (retired, or refused). */
    interface Held extends Kept {
      down: boolean;
      off: AbortController;
      loop: Promise<void>;
    }
    const kept = new Map<string, Held>();
    const live = new Map<string, Deno.ChildProcess>();
    let halting = false;
    let reloading = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // the run is over once every process is down — stopped, or refused — and no reload is
    // about to bring one back
    const settle = () => {
      if (!reloading && [...kept.values()].every((k) => k.down)) finish();
    };

    /** Keep one process alive until `off`; true when it refused instead. */
    const keepAlive = async (
      { name, argv: [cmd, ...args] }: Proc,
      off: AbortSignal,
    ): Promise<boolean> => {
      let failures = 0;
      while (!off.aborted) {
        const started = Date.now();
        const child = new Deno.Command(cmd, {
          args,
          cwd: root,
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        live.set(name, child);
        const pumps = [pump(child.stdout, name, false), pump(child.stderr, name, true)];
        const status = await child.status;
        await Promise.all(pumps); // the streams end at exit; drain the tail before reporting
        live.delete(name);
        if (off.aborted) return false;
        const uptime = Date.now() - started;
        // a refusal is a decision about the world, not a stumble in it: the child already
        // said what it wants, and saying it again on a timer teaches nobody anything
        if (!comesBack(status)) {
          stamp(
            SUPERVISOR,
            `${name} refused after ${Math.round(uptime / 1000)}s — down until \`liquen reload\``,
          );
          return true;
        }
        failures = uptime >= HEALTHY_MS ? 1 : failures + 1;
        const wait = backoffMs(failures);
        stamp(
          SUPERVISOR,
          // the signal is the whole diagnosis when a child dies quietly: a killed process
          // reports code 0, so the code alone reads like a clean exit
          `${name} exited (${status.signal ?? `code ${status.code}`}) after ` +
            `${Math.round(uptime / 1000)}s — restarting in ${wait / 1000}s`,
        );
        await pause(wait, off);
      }
      return false;
    };

    const launch = (proc: Proc, cfg: OrgConfig) => {
      const off = new AbortController();
      const held: Held = {
        reads: reads(proc.name, cfg),
        refused: false,
        down: false,
        off,
        loop: Promise.resolve(),
      };
      held.loop = keepAlive(proc, off.signal).then((refused) => {
        held.refused = refused;
        held.down = true;
        settle();
      });
      kept.set(proc.name, held);
    };

    /** End one process: its loop told to stop, its child asked, then made to. Resolves once
     *  the child is gone, so what replaces it never meets it on a socket or a port. */
    const retire = async (name: string): Promise<void> => {
      const held = kept.get(name);
      if (!held) return;
      held.off.abort();
      try {
        live.get(name)?.kill("SIGTERM");
      } catch { /* already gone */ }
      const hammer = setTimeout(() => {
        try {
          live.get(name)?.kill("SIGKILL");
        } catch { /* already gone */ }
      }, STOP_TIMEOUT_MS);
      Deno.unrefTimer(hammer); // children all exiting cleanly must let the process end
      await held.loop;
      clearTimeout(hammer);
    };

    const stop = () => {
      if (halting) return;
      halting = true;
      stamp(SUPERVISOR, `stopping ${live.size} process(es)`);
      for (const name of kept.keys()) void retire(name);
    };

    // one reload at a time, each on the file as it reads when its turn comes
    let reloads = Promise.resolve();
    const reload = () => {
      reloads = reloads.then(async () => {
        if (halting) return;
        reloading = true;
        try {
          let cfg: OrgConfig;
          let next: Proc[];
          try {
            cfg = await readConfig(root);
            next = roster(root, cfg);
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            stamp(SUPERVISOR, `config.jsonc not taken up — ${why}; running on as it was`);
            return;
          }
          const moves = plan(kept, next, cfg);
          await Promise.all([...moves.stop, ...moves.restart.map((p) => p.name)].map(retire));
          for (const name of moves.stop) kept.delete(name);
          if (halting) return;
          for (const proc of [...moves.restart, ...moves.start]) launch(proc, cfg);
          const said = [
            ...moves.stop.map((name) => `${name} stopped`),
            ...moves.restart.map((p) => `${p.name} restarted`),
            ...moves.start.map((p) => `${p.name} started`),
          ];
          stamp(
            SUPERVISOR,
            `config.jsonc taken up — ${said.length > 0 ? said.join(" · ") : "nothing changed"}`,
          );
        } finally {
          reloading = false;
          settle();
        }
      });
    };

    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener(RELOAD, reload);

    stamp(SUPERVISOR, `${procs.map((p) => p.name).join(" · ")} — root ${root}`);
    for (const proc of procs) launch(proc, cfg);
    await finished;
    // every process is down and none was asked to be — each one refused
    if (!halting) {
      const refused = [...kept].filter(([, k]) => k.refused).map(([name]) => name);
      throw new Error(`nothing left running — ${refused.join(", ")} refused (said why above)`);
    }
  });
}
