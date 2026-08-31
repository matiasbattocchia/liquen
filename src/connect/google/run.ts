/**
 * run.ts — the google connection as ONE process. Calendar is read-only, so the
 * connection is its poller: one half, same one-process contract `mu start` spawns
 * for every `connections.<name>`.
 */

import { runIngest } from "./calendar.ts";

await runIngest();
