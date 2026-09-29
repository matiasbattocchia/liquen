/**
 * run.ts — the google connection as ONE process: the calendar poll, the mail poll and the
 * mail dispatch, one restart unit. `liquen start` spawns this for `connections.google`;
 * any half dying takes the whole connection down and all come back together — half-alive
 * (inbound flowing, outbound silently dead) is not a representable state. SIGTERM stops
 * every half the way main stops: no new work, drain what is in flight, exit.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a REFUSAL — a port already
 * held, a config the file got wrong — and the person reading the supervisor's lines is owed
 * the sentence, not the frames. The listeners `entry` leaves behind outlive the boot, so a
 * rejection from the running halves reads the same way.
 *
 * `connections.google.listen` picks the ingests; the dispatch runs whatever it says, since
 * a send needs only the grant.
 */

import { runIngest as runCalendar } from "./calendar.ts";
import { runDispatch as runMailDispatch, runIngest as runMail } from "./mail.ts";
import { googleConfig } from "./config.ts";
import { exitOnStop, listening } from "../stop.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { entry } from "../../entry.ts";

await entry(async () => {
  const { listen } = await googleConfig(findRoot(orgFlag()));
  exitOnStop([
    ...await listening("google", listen, { calendar: runCalendar, mail: runMail }),
    await runMailDispatch(),
  ]);
});
