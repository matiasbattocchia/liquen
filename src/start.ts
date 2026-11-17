/**
 * start.ts — `liquen start`: the org as one command (DESIGN §9).
 *
 * A keep-alive loop and little more: apply config.yaml to the store, read the org off it,
 * spawn one child per process the org runs — main (the tail + fan-out, hosting the
 * egress proxy), one per enabled `connections.<name>`, the edge (edge.ts) and the tunnel
 * the org runs itself (`edge.tunnel`, any argv) — and respawn whatever exits, with
 * backoff. The log is the bus, so there is no dependency order, no readiness probe, no
 * IPC: a child finds the org the way every process does (cwd walks up to config.yaml),
 * and env rides through untouched (secrets only).
 *
 * A child that CRASHES comes back; a child that REFUSES does not. The two are told apart
 * by the exit code `entry` chose (`REFUSAL` — a sentence was printed, and a port already
 * held or a key the file got wrong will be held and wrong again a second later), so the
 * org runs on with whatever is left instead of reprinting one complaint every minute
 * forever. When nothing is left, `liquen start` refuses too, naming who gave up.
 *
 * The file is applied at boot, before main is raised: the supervisor is the one who
 * raises it. From then on the store is the run's word. A poke on the run's socket,
 * `data/run/liquen.sock` (reload.ts), from `liquen reload` or a command that declared,
 * disabled or removed a connection, brings the run in line with the store as it is now:
 * a connection declared or enabled since starts, one removed or disabled stops, one that
 * refused gets another go (the world it refused may be what changed), and each process
 * the request NAMES restarts, for what it reads once at its start from somewhere else (a
 * connection's carrier, picked off the vault). Nothing else restarts: every process reads
 * the store on each use, but for what only a start takes up (`startOnly`): where the
 * store is, the edge's port, the tunnel, and the keys a connection's spec reads at its
 * start. A change to one of those is answered as owed, for `liquen restart` to take up.
 * The request is answered with what moved. SIGHUP stops the run as a restart does, main
 * leaving what the agents' commands run for the next main: `liquen restart` sends it, and
 * starts the run again.
 *
 * One of each role. A run holds `data/run/liquen.pid` for its life and its main holds
 * `data/run/main.pid` (stop.ts) — the locks that make them findable, so `liquen stop` has
 * pids to signal, and a second supervisor, or a start over a mind an interface already
 * raised, refuses instead of doubling every tail, fan-out and mirror over one log.
 *
 * Death is loud on stderr and nowhere else — the supervisor holds no handle on the
 * store between a boot and a reload; the outer layer (docker restart, systemd, the terminal) supervises `liquen start` itself.
 * SIGTERM fans out to the children, waits `STOP_TIMEOUT_MS`, then SIGKILLs. Main is asked
 * with SIGINT then, the signal that ends what the agents' commands left running; a reload
 * restarts it with SIGTERM, which leaves that running for the next main to adopt (§9).
 *
 * Every line a child writes arrives stamped — `YYYY-MM-DD HH:MM:SS [name] …` in the file,
 * the time alone on a terminal — so attribution is the harness's property, not a
 * convention each service must remember: panics and stack traces land tagged too. The
 * boot line names what runs, a checkout's commit included, so a line that follows a
 * restart can be read against the code that wrote it. Each goes to the run log (`runlog.ts`), and attached it
 * prints too, the stdout/stderr split riding through (stdout is data, stderr is
 * diagnostics). After the boot lines, silence means every process is up. On a terminal
 * each tag has a color of its own, so one process's lines read as a column in the
 * interleave, and a line reporting a failure is red, so it stands out of every column;
 * piped, or under NO_COLOR, the bytes are plain.
 *
 * `-D` runs the same supervisor detached: in a session of its own, writing the run log as
 * an attached run does, and the prompt back once the run holds its lock. A refusal before
 * that — a second start, a catalog boot rejects — is printed from the log with the code it
 * exited with, so a detached start that failed never reads like one that worked.
 */

import { TextLineStream } from "@std/streams";
import {
  type ConnectorSpec,
  enabledIn,
  findRoot,
  type OrgConfig,
  orgFlag,
  readFile,
  STOP_TIMEOUT_MS,
  valueAt,
} from "./config.ts";
import { conflictLines, readConfig } from "./org.ts";
import { entry, REFUSAL } from "./entry.ts";
import { claim, holder, MAIN, SUPERVISOR } from "./stop.ts";
import { applied, moved, type Moves, type Owed, owedLines, runSocket } from "./reload.ts";
import { RUNNING, SHIPPED } from "./connect/connect.ts";
import { helpFlag } from "./connect/help.ts";
import { serveSocket } from "./connect/serve.ts";
import { openRunLog, RUN_LOG, type RunLog, sayConsole } from "./runlog.ts";
import { running } from "./package.ts";

export const USAGE = `usage: liquen start [-D | --detach] [--dir <org>]

  Run the org: main and one process per declared connection, each restarted when it dies.

  -D, --detach   run in the background, its lines in data/run/liquen.log only;
                 \`liquen stop\` ends it
  --dir <org>    the org, when run from elsewhere`;

/** How long a detached start waits for the run to hold its lock before handing back the
 *  prompt without that word. */
const DETACH_WAIT_MS = 15_000;

/** What a start over a running org is told. */
const RUNNING_HINT = "`liquen reload` applies an edit to config.yaml, `liquen restart` " +
  "restarts it, `liquen stop` ends it";

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

/** A line that reports a failure, by what failures print: the harness's own `FAILED` and
 *  `failed`, an error's `SomeError:` head, a stack frame, a Go panic, and the error levels
 *  of the Go loggers a tunnel writes with (`ERR`, `FTL`). */
const FAILURE = /\bFAILED\b|\bfailed\b|\b\w*Error:|^\s+at |\bpanic:|\b(ERR|FTL)\b/;

/** Whether a child's line is a failure: one by `FAILURE`, or an indented line under one —
 *  the rest of a trace or a cause the runtime printed beneath it. */
export function failing(line: string, under: boolean): boolean {
  return FAILURE.test(line) || (under && /^\s/.test(line));
}

/** `-D`: this module again, as a child in a session of its own, writing the run log as an
 *  attached run does, its own last words included. Answers once the child holds the
 *  supervisor's lock, or with the child's code when it exits first. The lock is read, not
 *  probed: a probe takes the lock for an instant, and the child's claim landing in that
 *  instant would refuse. */
export async function detach(root: string): Promise<void> {
  const log = `${root}/data/${RUN_LOG}`;
  const pidFile = `${root}/data/run/${SUPERVISOR}.pid`;
  await Deno.mkdir(`${root}/data/run`, { recursive: true });
  const from = await Deno.stat(log).then((s) => s.size, () => 0);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", import.meta.url],
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

async function pump(
  run: RunLog,
  stream: ReadableStream<Uint8Array>,
  name: string,
  err: boolean,
): Promise<void> {
  const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  let under = false;
  for await (const line of lines) {
    run.say(name, line, { err, failure: under = failing(line, under) });
  }
}

/** One process of the org's run: its tag, the command that is it, and for a connection
 *  the module its spec is in (`SPEC`, the connector's `config.ts`). */
export interface Proc {
  name: string;
  argv: string[];
  spec?: string;
}

/** A liquen module as a process: this deno, the module, every permission. */
function module(name: string, url: string, spec?: string): Proc {
  return { name, argv: [Deno.execPath(), "run", "-A", url], ...(spec ? { spec } : {}) };
}

/** Everything the store says this org runs. A connection is ONE process, its folder's
 *  `run.ts`: `src/connect/<name>/` ships with core, `<root>/connectors/<name>/` is the
 *  org's own; a disabled one runs nothing. A shipped service that only grants a
 *  credential is declared for its knobs and runs nothing; a custom connection with no
 *  run.ts is a boot error, same law as an unknown config key. The edge is every
 *  connector's door and always stands; the tunnel is whatever argv the catalog says,
 *  verbatim. */
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
    if (!enabledIn(cfg, name)) continue;
    const bundled = new URL(`./connect/${name}/`, import.meta.url);
    const local = `${root}/connectors/${name}`;
    if (RUNNING.includes(name)) {
      procs.push(module(name, new URL("run.ts", bundled).href, new URL("config.ts", bundled).href));
    } else if (SHIPPED.includes(name)) continue;
    else if (has(`${local}/run.ts`)) {
      const spec = has(`${local}/config.ts`) ? `file://${local}/config.ts` : undefined;
      procs.push(module(name, `${local}/run.ts`, spec));
    } else {
      throw new Error(
        `connection "${name}" is declared but has no process: ` +
          `no run.ts under src/connect/${name}/ or ${root}/connectors/${name}/`,
      );
    }
  }
  procs.push(module("edge", new URL("./edge.ts", import.meta.url).href));
  if (cfg.edge.tunnel) procs.push({ name: "tunnel", argv: cfg.edge.tunnel });
  return procs;
}

/** A connection's spec, off the module its `config.ts` is; none when it exports none. */
export async function specOf(proc: Proc): Promise<ConnectorSpec | undefined> {
  if (!proc.spec) return undefined;
  try {
    return (await import(proc.spec)).SPEC as ConnectorSpec | undefined;
  } catch {
    return undefined;
  }
}

/** What a process reads only at its start, by path, each value as JSON: every liquen
 *  process reads where the store is; the edge its port; the tunnel is its argv; and a
 *  connection the keys its spec names (`ConnectorSpec.start`). Everything else every
 *  process reads on each use. */
export function startOnly(
  name: string,
  cfg: OrgConfig,
  spec?: ConnectorSpec,
): Record<string, string> {
  const at = (paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, JSON.stringify(valueAt(cfg, p, spec) ?? null)]));
  if (name === "edge") return at(["edge.port"]);
  if (name === "tunnel") return at(["edge.tunnel"]);
  return at(["deployment", ...(spec?.start ?? [])]);
}

/** What a process of the run is to a poke: what it read only at its start, and whether
 *  it refused (down for good until a poke gives it another go). */
export interface Kept {
  reads: Record<string, string>;
  refused: boolean;
}

/** A poke's moves, from what the run keeps to what the store says now: what stops (no
 *  longer declared, or disabled), what restarts (it refused, or the poke named it), what
 *  starts (declared or enabled since), and what is owed a restart (a key it read at its
 *  start that has changed since). */
export function plan(
  kept: Map<string, Kept>,
  next: Proc[],
  reads: Map<string, Record<string, string>>,
  named: string[] = [],
): { stop: string[]; restart: Proc[]; start: Proc[]; owed: Owed[] } {
  const wanted = new Set(next.map((p) => p.name));
  const restart = next.filter((p) => {
    const one = kept.get(p.name);
    return one !== undefined && (one.refused || named.includes(p.name));
  });
  const owing = new Map<string, string[]>();
  for (const p of next) {
    const one = kept.get(p.name);
    if (!one || restart.includes(p)) continue;
    const now = reads.get(p.name) ?? {};
    for (const [path, value] of Object.entries(now)) {
      if (one.reads[path] !== undefined && one.reads[path] !== value) {
        owing.set(path, [...owing.get(path) ?? [], p.name]);
      }
    }
  }
  return {
    stop: [...kept.keys()].filter((name) => !wanted.has(name)),
    restart,
    start: next.filter((p) => !kept.has(p.name)),
    owed: [...owing].map(([path, processes]) => ({ path, processes })),
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
    const dir = `${root}/data`;
    // the run's every line, its own and its children's, goes to the run log from here on,
    // a refusal included; a detached start says its piece at the terminal and hands over
    let run: RunLog | undefined;
    if (!background) sayConsole(run = openRunLog(dir, true), SUPERVISOR);
    // the file applied to the store before main is raised (§9), and the run made from what
    // the store then holds. A detached start leaves both to the child it spawns
    await readFile(root);
    if (run) { for (const line of conflictLines(await applied(root))) run.say(SUPERVISOR, line); }
    const cfg = await readConfig(root);
    const procs = roster(root, cfg);
    // ONE OF EACH ROLE (stop.ts). The locks are taken after the catalog is read, so a
    // manifest this run cannot serve refuses on its own terms and not on a lock it went
    // on to drop
    await Deno.mkdir(dir, { recursive: true });
    if (background || run === undefined) {
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
    const lines: RunLog = run;
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
    let reconciling = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // the run is over once every process is down — stopped, or refused — and no poke is
    // about to bring one back
    const settle = () => {
      if (!reconciling && [...kept.values()].every((k) => k.down)) finish();
    };

    /** Keep one process alive until `off`; true when it refused instead. `respawn` runs
     *  before each spawn after the first: what the new child reads at its start. */
    const keepAlive = async (
      { name, argv: [cmd, ...args] }: Proc,
      off: AbortSignal,
      respawn: () => Promise<void>,
    ): Promise<boolean> => {
      let failures = 0;
      let first = true;
      while (!off.aborted) {
        if (!first) await respawn().catch(() => {});
        first = false;
        const started = Date.now();
        const child = new Deno.Command(cmd, {
          args,
          cwd: root,
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        live.set(name, child);
        const pumps = [
          pump(lines, child.stdout, name, false),
          pump(lines, child.stderr, name, true),
        ];
        const status = await child.status;
        await Promise.all(pumps); // the streams end at exit; drain the tail before reporting
        live.delete(name);
        if (off.aborted) return false;
        const uptime = Date.now() - started;
        // a refusal is a decision about the world, not a stumble in it: the child already
        // said what it wants, and saying it again on a timer teaches nobody anything
        if (!comesBack(status)) {
          lines.say(
            SUPERVISOR,
            `${name} refused after ${Math.round(uptime / 1000)}s — down until \`liquen reload\``,
            { failure: true },
          );
          return true;
        }
        failures = uptime >= HEALTHY_MS ? 1 : failures + 1;
        const wait = backoffMs(failures);
        lines.say(
          SUPERVISOR,
          // the signal is the whole diagnosis when a child dies quietly: a killed process
          // reports code 0, so the code alone reads like a clean exit
          `${name} exited (${status.signal ?? `code ${status.code}`}) after ` +
            `${Math.round(uptime / 1000)}s — restarting in ${wait / 1000}s`,
          { failure: true },
        );
        await pause(wait, off);
      }
      return false;
    };

    /** What each process reads only at its start, by name, off the org as it stands. */
    const readsOf = async (procs: Proc[], cfg: OrgConfig) =>
      new Map(
        await Promise.all(
          procs.map(async (p) => [p.name, startOnly(p.name, cfg, await specOf(p))] as const),
        ),
      );

    const launch = (proc: Proc, reads: Record<string, string>) => {
      const off = new AbortController();
      const held: Held = { reads, refused: false, down: false, off, loop: Promise.resolve() };
      // a child respawned reads the store as it stands then
      const respawn = async () => {
        held.reads = (await readsOf([proc], await readConfig(root))).get(proc.name)!;
      };
      held.loop = keepAlive(proc, off.signal, respawn).then((refused) => {
        held.refused = refused;
        held.down = true;
        settle();
      });
      kept.set(proc.name, held);
    };

    /** End one process: its loop told to stop, its child asked, then made to. Resolves once
     *  the child is gone, so what replaces it never meets it on a socket or a port. The ask
     *  is SIGTERM, a restart; `stopping` asks main with SIGINT, which ends what the agents'
     *  commands left running with it (§9). */
    const retire = async (name: string, stopping = false): Promise<void> => {
      const held = kept.get(name);
      if (!held) return;
      held.off.abort();
      try {
        live.get(name)?.kill(stopping && name === MAIN ? "SIGINT" : "SIGTERM");
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

    /** End the run: a stop asks main with SIGINT, ending what the agents' commands left
     *  running; a restart (`liquen restart`, SIGHUP) asks it with SIGTERM, which leaves
     *  that for the next main to adopt. */
    let restarting = false;
    const stop = (restart = false) => {
      if (halting) return;
      halting = true;
      restarting = restart;
      lines.say(SUPERVISOR, `${restart ? "restarting" : "stopping"} ${live.size} process(es)`);
      for (const name of kept.keys()) void retire(name, !restart);
    };

    /** Bring the run in line with the store as it stands, restarting `named` besides;
     *  what moved. One at a time, each on the store as it reads when its turn comes. A
     *  name the run does not have is refused, thrown to the asker and said in the run's
     *  lines, and the run goes on as it was. */
    let turns = Promise.resolve();
    const reconcile = (named: string[]): Promise<Moves> => {
      const turn = turns.then(async () => {
        if (halting) throw new Error("the run is stopping");
        reconciling = true;
        try {
          const cfg = await readConfig(root);
          const next = roster(root, cfg);
          const stray = named.filter((name) => !next.some((p) => p.name === name));
          if (stray.length > 0) {
            throw new Error(
              `no process named ${stray.join(", ")} — the run is ` +
                next.map((p) => p.name).join(" · "),
            );
          }
          const reads = await readsOf(next, cfg);
          const moves = plan(kept, next, reads, named);
          await Promise.all(
            [...moves.stop, ...moves.restart.map((p) => p.name)].map((name) => retire(name)),
          );
          for (const name of moves.stop) kept.delete(name);
          if (halting) throw new Error("the run is stopping");
          for (const proc of [...moves.restart, ...moves.start]) {
            launch(proc, reads.get(proc.name)!);
          }
          const made: Moves = {
            stop: moves.stop,
            restart: moves.restart.map((p) => p.name),
            start: moves.start.map((p) => p.name),
            owed: moves.owed,
          };
          lines.say(SUPERVISOR, `in line with the store: ${moved(made)}`);
          for (const line of owedLines(made.owed)) lines.say(SUPERVISOR, line);
          return made;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          lines.say(SUPERVISOR, `not brought in line: ${why}; running on as it was`, {
            failure: true,
          });
          throw err;
        } finally {
          reconciling = false;
          settle();
        }
      });
      turns = turn.then(() => {}, () => {});
      return turn;
    };

    // the run's socket: a poke is asked here and answered with what it moved
    const asked = await serveSocket(runSocket(root), async (req) => {
      let named: string[];
      try {
        const body = req.method === "POST" ? await req.json() : {};
        named = Array.isArray(body.restart) ? body.restart.map(String) : [];
      } catch {
        return new Response("a poke is a POST of { restart?: string[] }", { status: 400 });
      }
      try {
        return Response.json(await reconcile(named));
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
      }
    });

    Deno.addSignalListener("SIGTERM", () => stop());
    Deno.addSignalListener("SIGINT", () => stop());
    Deno.addSignalListener("SIGHUP", () => stop(true));

    lines.say(
      SUPERVISOR,
      `${procs.map((p) => p.name).join(" · ")} — root ${root} · ${await running()}`,
    );
    const reads = await readsOf(procs, cfg);
    for (const proc of procs) launch(proc, reads.get(proc.name)!);
    await finished;
    await asked.shutdown();
    if (restarting) lines.say(SUPERVISOR, "down for a restart");
    // every process is down and none was asked to be — each one refused
    if (!halting) {
      const refused = [...kept].filter(([, k]) => k.refused).map(([name]) => name);
      throw new Error(`nothing left running — ${refused.join(", ")} refused (said why above)`);
    }
  });
}
