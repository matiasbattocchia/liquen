/**
 * run.ts — the google connection as ONE process. Calendar is read-only, so the
 * connection is its poller: one half, same one-process contract `liquen start` spawns
 * for every `connections.<name>`. SIGTERM stops it the way main stops: no new work,
 * drain what is in flight, exit.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a REFUSAL — a port already
 * held, a config the file got wrong — and the person reading the supervisor's lines is owed
 * the sentence, not the frames. The listeners `entry` leaves behind outlive the boot, so a
 * rejection from the running halves reads the same way.
 */

import { runIngest } from "./calendar.ts";
import { exitOnStop } from "../stop.ts";
import { entry } from "../../entry.ts";

await entry(async () => exitOnStop([await runIngest()]));
