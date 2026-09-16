/**
 * stop.ts — `liquen stop`: the org's off switch, and the lock that makes a run findable (§9).
 *
 *   liquen stop
 *
 * A supervisor has no address: `liquen start` is a pid nobody wrote down, over children that
 * come and go. So it takes a LOCK on `data/liquen.pid` for its whole life and writes its pid
 * inside. The lock is what answers "is this org running" — the kernel drops it the moment the
 * holder dies, however it dies — and the number inside only says who to signal. Nothing here
 * reasons about a stale file: a crashed run leaves its number behind and its lock open, and
 * the number alone is never believed.
 *
 * Stopping is one SIGTERM to that pid. The supervisor's own handler fans it out to the
 * children, waits `STOP_TIMEOUT_MS` and SIGKILLs what is left (§9), so this command's work
 * after the signal is to WAIT for the lock to come free — the run actually gone, not merely
 * asked, which is what makes `liquen stop && liquen start` safe to say in one breath. A run
 * that will not go is named, never escalated: SIGKILLing a wedged supervisor leaves its
 * children orphaned and still holding its ports, which is worse than the sentence saying so.
 */

import { findRoot, orgFlag, STOP_TIMEOUT_MS } from "./config.ts";
import { entry } from "./entry.ts";

/** The run lock, under the org's data root. */
export const LOCK = "liquen.pid";

/** How long a signalled run gets to let go: the supervisor's own grace, and as long again
 *  for the drain it spends that grace on. */
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

/** Take the org's run lock for this process's life, or report the pid already holding it.
 *  A win's file is deliberately never closed: the lock ends when the process does, and that
 *  is precisely the fact `stop` reads. */
export function claim(dir: string): { held: Deno.FsFile } | { taken: number | null } {
  const file = Deno.openSync(`${dir}/${LOCK}`, { read: true, write: true, create: true });
  if (!file.tryLockSync(true)) {
    const taken = named(file);
    file.close();
    return { taken };
  }
  file.truncateSync(0);
  file.writeSync(enc.encode(`${Deno.pid}\n`));
  return { held: file };
}

/** The pid of the run holding this org, or null when none does. Probing is taking the lock
 *  and handing it straight back: only a live holder refuses it. */
export async function holder(dir: string): Promise<number | null> {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(`${dir}/${LOCK}`, { read: true, write: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null; // nothing has ever run here
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
    throw new Error(`something holds ${dir}/${LOCK} without naming itself — stop it by hand`);
  } finally {
    file.close();
  }
}

if (import.meta.main) {
  await entry(async () => {
    const root = findRoot(orgFlag());
    const dir = `${root}/data`;
    const pid = await holder(dir);
    if (pid === null) {
      console.log(`nothing running — ${root}`);
      return;
    }
    try {
      Deno.kill(pid, "SIGTERM");
    } catch (err) {
      // it let go between the probe and the signal: asked and gone is what was wanted
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    const deadline = Date.now() + GONE_MS;
    while (await holder(dir) !== null) {
      if (Date.now() >= deadline) {
        throw new Error(
          `pid ${pid} still holds ${root} ${GONE_MS / 1000}s after SIGTERM — it is wedged, ` +
            `and killing it would orphan the children still holding its ports`,
        );
      }
      await rest(POLL_MS);
    }
    console.log(`stopped — ${root} (pid ${pid})`);
  });
}
