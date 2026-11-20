/**
 * restart.ts — `liquen restart`: what only a start takes up, taken up (§9).
 *
 *   liquen restart [<process>…]
 *
 * Every process reads the store on each use, but for what it reads only at its start:
 * where the store is (`deployment`), the edge's port, the tunnel's argv, the keys a
 * connection's spec reads at its start, and its code. `liquen reload` names a change to
 * one of those with this command.
 *
 * Named, the processes restart under the running supervisor (`reconcile`). Bare, the whole
 * run does: the supervisor is asked with SIGHUP, which stops every child as a restart
 * does, main leaving what the agents' commands run for the next main to adopt, and once
 * its lock comes free the run starts again detached, from this process, so it takes up
 * this process's environment: `.env`, as the task reads it.
 */

import { findRoot, orgFlag } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { moved, reconcile } from "./reload.ts";
import { end, holder, SUPERVISOR } from "./stop.ts";
import { detach } from "./start.ts";

export const USAGE = `usage: liquen restart [<process>…] [--dir <org>]

  Stop and start the processes named, or the whole run when none is: what a process
  reads only at its start (deployment, edge.port, edge.publicUrl, edge.tunnel, a
  connection's start keys), and its code. The whole run takes up .env too, and goes on detached.

  --dir <org>    the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const stray = org.args.find((a) => a.startsWith("-"));
    if (stray !== undefined) throw new Error(`unknown argument ${stray}\n${USAGE}`);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const pid = await holder(dir, SUPERVISOR);
    if (pid === null) throw new Error(`nothing runs ${root} — \`liquen start\` runs it`);
    if (org.args.length > 0) {
      const moves = await reconcile(root, org.args);
      if (moves === null) throw new Error(`nothing runs ${root} — \`liquen start\` runs it`);
      console.log(moved(moves));
      return;
    }
    await end(dir, SUPERVISOR, pid, root, "SIGHUP");
    await detach(root);
  });
}
