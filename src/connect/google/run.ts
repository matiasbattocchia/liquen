/**
 * run.ts — the google connection as ONE process. Calendar is read-only, so the
 * connection is its poller: one half, same one-process contract `mu start` spawns
 * for every `connections.<name>`. SIGTERM stops it the way main stops: no new work,
 * drain what is in flight, exit.
 */

import { runIngest } from "./calendar.ts";
import { exitOnStop } from "../stop.ts";

exitOnStop([await runIngest()]);
