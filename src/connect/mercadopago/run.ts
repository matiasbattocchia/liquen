/**
 * run.ts — the mercadopago connection as ONE process: the webhook and the poll, one restart
 * unit. `liquen start` spawns this for `connections.mercadopago`; either half dying takes
 * the whole connection down and both come back together. There is no dispatch: nothing is
 * said back on this wire, and what an agent asks of the account it asks through `mpcli`.
 * SIGTERM stops both halves the way main stops: no new work, drain what is in flight, exit.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a REFUSAL, owed as the
 * sentence, not the frames.
 */

import { runWebhook } from "./ingest.ts";
import { runPoll } from "./payments.ts";
import { entry, exitOnStop, heartbeat } from "../../connector.ts";

await entry(async () =>
  exitOnStop([
    await runWebhook(),
    await runPoll(),
    await heartbeat("mercadopago", { pushed: true }),
  ])
);
