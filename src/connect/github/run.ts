/**
 * run.ts — the github connection as ONE process: both halves of the wire, one restart
 * unit. `liquen start` spawns this for `connections.github`; either half dying takes the
 * whole connection down and both come back together — half-alive (inbound flowing,
 * outbound silently dead) is not a representable state. SIGTERM stops both halves the
 * way main stops: no new work, drain what is in flight, exit.
 */

import { runIngest } from "./ingest.ts";
import { runDispatch } from "./dispatch.ts";
import { exitOnStop } from "../../connector.ts";

exitOnStop([await runIngest(), await runDispatch()]);
