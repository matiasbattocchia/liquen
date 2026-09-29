/**
 * stop.ts — `liquen stop`: the org's off switch, and the locks that make a run findable (§9).
 *
 *   liquen stop
 *
 * A ROLE IS A LOCK. Every process that is part of an org's run takes an exclusive lock on
 * `data/run/<role>.pid` for its whole life and writes its pid inside: `liquen` is the
 * supervisor, `main` is the mind — the tail, the fan-out, the doors — whoever raised it.
 * The lock is what answers "is this role running", because the kernel drops it the moment
 * the holder dies, however it dies, so nothing here reasons about a stale file: a crashed
 * run leaves its number behind and its lock open, and the number alone is never believed.
 * It only says who to signal.
 *
 * Two rules fall out, and they are the same rule:
 *
 *   ONE OF EACH ROLE. A main finding `main` taken refuses instead of becoming the second
 *   mind over one log — two tails, two fan-outs, two mirrors of every line the agent
 *   speaks. An interface raises an ephemeral main only when nothing answers its door, so
 *   the duplicate arrives the other way round: `liquen start` while a REPL holds the mind.
 *   It refuses too, and says which.
 *
 *   A STOP IS ABOUT THE ORG. `liquen stop` ends the run, not a process: the supervisor
 *   first and alone — its own SIGTERM fans out to the children it keeps alive, and a child
 *   stopped ahead of its parent earns nothing but a restart — and then whatever is still
 *   standing, which was nobody's child. An ephemeral main a REPL raised is stopped like the
 *   rest; the interface attached to it hangs up, which is what an explicit order means.
 *
 * Each signal is followed by a WAIT for that lock to come free — the process actually gone,
 * not merely asked, which is what makes `liquen stop && liquen start` safe to say in one
 * breath. A holder that will not go is named, never escalated: SIGKILLing a wedged
 * supervisor orphans children that still hold its ports, which is worse than the sentence
 * saying so.
 */

import { findRoot, orgFlag, STOP_TIMEOUT_MS } from "./config.ts";
import { entry } from "./entry.ts";

/** Where the locks live, under the org's data root, and what names one. */
const RUN = "run";
const SUFFIX = ".pid";

/** The supervisor: `liquen start` itself, the only role with children. */
export const SUPERVISOR = "liquen";
/** The mind: main.ts, bare under the supervisor or ephemeral under an interface. */
export const MAIN = "main";

/** How long a signalled holder gets to let go: the supervisor's own grace, and as long
 *  again for the drain it spends that grace on. */
const GONE_MS = STOP_TIMEOUT_MS * 2;
const POLL_MS = 100;

const enc = new TextEncoder();
const dec = new TextDecoder();
const rest = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The number the holder wrote, or null while it is still between the lock and saying so. */
function named(file: Deno.FsFile): number | null {
  file.seekSync(0, Deno.SeekMode.Start);
  const buf = new Uint8Array(32);
  const pid = Number.parseInt(dec.decode(buf.subarray(0, file.readSync(buf) ?? 0)), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Take a role for this process's life, or report the pid already holding it. A win's file
 *  is deliberately never closed: the lock ends when the process does, and that is precisely
 *  the fact a stop reads. */
export function claim(dir: string, role: string): { held: Deno.FsFile } | { taken: number | null } {
  Deno.mkdirSync(`${dir}/${RUN}`, { recursive: true });
  const file = Deno.openSync(`${dir}/${RUN}/${role}${SUFFIX}`, {
    read: true,
    write: true,
    create: true,
  });
  if (!file.tryLockSync(true)) {
    const taken = named(file);
    file.close();
    return { taken };
  }
  file.truncateSync(0);
  file.writeSync(enc.encode(`${Deno.pid}\n`));
  return { held: file };
}

/** The pid holding a role, or null when nobody does. Probing is taking the lock and handing
 *  it straight back: only a live holder refuses it. */
export async function holder(dir: string, role: string): Promise<number | null> {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(`${dir}/${RUN}/${role}${SUFFIX}`, { read: true, write: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null; // the role has never run here
    throw err;
  }
  try {
    if (file.tryLockSync(true)) {
      file.unlockSync();
      return null;
    }
    // a holder locks before it writes; a probe that lands in that window waits it out
    for (let i = 0; i < 20; i++) {
      const pid = named(file);
      if (pid !== null) return pid;
      await rest(POLL_MS / 10);
    }
    throw new Error(`something holds ${role}${SUFFIX} without naming itself — stop it by hand`);
  } finally {
    file.close();
  }
}

/** Every role with a live holder, the supervisor first: the order a stop has to use. */
export async function running(dir: string): Promise<Map<string, number>> {
  let roles: string[];
  try {
    roles = [...Deno.readDirSync(`${dir}/${RUN}`)]
      .filter((e) => e.isFile && e.name.endsWith(SUFFIX))
      .map((e) => e.name.slice(0, -SUFFIX.length));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Map();
    throw err;
  }
  roles.sort((a, b) => (a === SUPERVISOR ? -1 : b === SUPERVISOR ? 1 : a.localeCompare(b)));
  const live = new Map<string, number>();
  for (const role of roles) {
    const pid = await holder(dir, role);
    if (pid !== null) live.set(role, pid);
  }
  return live;
}

/** SIGTERM one role's holder and wait for its lock to come free. */
async function end(dir: string, role: string, pid: number, root: string): Promise<void> {
  try {
    Deno.kill(pid, "SIGTERM");
  } catch (err) {
    // it let go between the probe and the signal: asked and gone is what was wanted
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const deadline = Date.now() + GONE_MS;
  while (await holder(dir, role) !== null) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${role} (pid ${pid}) still holds ${root} ${GONE_MS / 1000}s after SIGTERM — it is ` +
          `wedged, and killing it would orphan whatever still holds its ports`,
      );
    }
    await rest(POLL_MS);
  }
}

if (import.meta.main) {
  await entry(async () => {
    const root = findRoot(orgFlag());
    const dir = `${root}/data`;
    const stopped: string[] = [];
    // the supervisor first and alone — it respawns what it outlives
    const supervisor = (await running(dir)).get(SUPERVISOR);
    if (supervisor !== undefined) {
      await end(dir, SUPERVISOR, supervisor, root);
      stopped.push(`${SUPERVISOR} (${supervisor})`);
    }
    // then what was nobody's child: an ephemeral main under an interface, an orphan a hard
    // kill left holding a port. A stop is an order about the org, so it reaches those too
    for (const [role, pid] of await running(dir)) {
      await end(dir, role, pid, root);
      stopped.push(`${role} (${pid})`);
    }
    console.log(
      stopped.length === 0
        ? `nothing running — ${root}`
        : `stopped ${stopped.join(" · ")} — ${root}`,
    );
  });
}
