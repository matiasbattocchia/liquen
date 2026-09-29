/**
 * reload.ts — `liquen reload`: the running org takes up config.jsonc as it is now (§9).
 *
 *   liquen reload
 *
 * The file is read here first, so a key it gets wrong is this command's refusal and the run
 * goes on as it was. A file boot takes is handed to the supervisor as a signal (`RELOAD`),
 * and the supervisor brings the run in line with it (start.ts): a process whose part of the
 * file changed restarts, a connection declared since starts, one no longer declared stops,
 * and one that refused gets another go. What it did is in its own lines.
 *
 * The setup doors that write the file — `liquen connect`, `liquen agent` — reload the run
 * themselves, so the command is for an edit made by hand.
 */

import { findRoot, orgFlag, readConfig } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { holder, MAIN, RELOAD, SUPERVISOR } from "./stop.ts";

export const USAGE = `usage: liquen reload [--dir <org>]

  The running org takes up config.jsonc: what the edit touched restarts, a connection
  declared since starts, one removed stops.

  --dir <org>    the org, when run from elsewhere`;

/** Signal the org's run to read config.jsonc again, once the file reads. The run's pid, or
 *  null when no `liquen start` runs this org. */
export async function reload(root: string): Promise<number | null> {
  await readConfig(root);
  const pid = await holder(`${root}/data`, SUPERVISOR);
  if (pid === null) return null;
  try {
    Deno.kill(pid, RELOAD);
  } catch (err) {
    // it ended between the probe and the signal: the next start reads the file anyway
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return pid;
}

/** What a door says after it wrote the file: who takes the change up. */
export async function reloaded(root: string): Promise<string> {
  const pid = await reload(root);
  if (pid !== null) return `the running org (pid ${pid}) takes it up`;
  const mind = await holder(`${root}/data`, MAIN);
  return mind === null
    ? "`liquen start` runs it"
    : `main (pid ${mind}) runs without \`liquen start\`, which is what runs connections`;
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    if (org.args.length > 0) throw new Error(`unknown argument ${org.args[0]}\n${USAGE}`);
    const root = findRoot(org);
    const pid = await reload(root);
    console.log(
      pid === null
        ? `nothing running — ${root}; \`liquen start\` runs the file as it is`
        : `the run (pid ${pid}) reads config.jsonc again — its lines say what restarted`,
    );
  });
}
