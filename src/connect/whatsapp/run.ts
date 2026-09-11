/**
 * run.ts — the whatsapp connection as ONE process: both halves of the bridge seam, one
 * restart unit. `liquen start` spawns this for `connections.whatsapp`; either half dying
 * takes the whole connection down and both come back together — half-alive (inbound
 * flowing, outbound silently dead) is not a representable state. SIGTERM stops both
 * halves the way main stops: no new work, drain what is in flight, exit.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a REFUSAL — a port already
 * held, a config the file got wrong — and the person reading the supervisor's lines is owed
 * the sentence, not the frames. The listeners `entry` leaves behind outlive the boot, so a
 * rejection from the running halves reads the same way.
 */

import { runIngest } from "./ingest.ts";
import { runDispatch } from "./dispatch.ts";
import { exitOnStop } from "../stop.ts";
import { entry } from "../../entry.ts";

await entry(async () => exitOnStop([await runIngest(), await runDispatch()]));
