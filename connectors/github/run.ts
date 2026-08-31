/**
 * run.ts — the github connection as ONE process: both halves of the wire, one restart
 * unit. `mu start` spawns this for `connections.github`; either half dying takes the
 * whole connection down and both come back together — half-alive (inbound flowing,
 * outbound silently dead) is not a representable state.
 */

import { runIngest } from "./ingest.ts";
import { runDispatch } from "./dispatch.ts";

await runIngest();
await runDispatch();
