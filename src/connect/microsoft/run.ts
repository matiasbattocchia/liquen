/**
 * run.ts — the microsoft connection as ONE process: the calendar poll, the mail poll and
 * the mail dispatch, the Teams webhook with its subscription keeper and the Teams
 * dispatch, one restart unit. `liquen start` spawns this for `connections.microsoft`; any
 * half dying takes the whole connection down and all come back together — half-alive
 * (inbound flowing, outbound silently dead) is not a representable state. SIGTERM stops
 * every half the way main stops: no new work, drain what is in flight, exit.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a REFUSAL — a config the
 * file got wrong, a port already held — and the person reading the supervisor's lines is
 * owed the sentence, not the frames. The listeners `entry` leaves behind outlive the boot,
 * so a rejection from the running halves reads the same way.
 *
 * `connections.microsoft.listen` picks the ingests; the dispatches run whatever it says,
 * since a send needs only the grant. Teams left out serves no webhook and keeps no
 * subscription, so Graph's pushes stop when the ones it holds expire.
 */

import { runIngest as runCalendar } from "./calendar.ts";
import { runDispatch as runMailDispatch, runIngest as runMail } from "./mail.ts";
import { runDispatch as runTeamsDispatch, runIngest as runTeams } from "./teams.ts";
import { microsoftConfig } from "./config.ts";
import { exitOnStop, listening } from "../stop.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { entry } from "../../entry.ts";

await entry(async () => {
  const { listen } = await microsoftConfig(findRoot(orgFlag()));
  exitOnStop([
    ...await listening("microsoft", listen, {
      calendar: runCalendar,
      mail: runMail,
      teams: runTeams,
    }),
    await runMailDispatch(),
    await runTeamsDispatch(),
  ]);
});
