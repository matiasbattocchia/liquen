/**
 * schedule.ts — `liquen schedule`: a STANDING wake the org arms (§10).
 *
 * The agent's `schedule` tool writes a row for a wake it chose; this writes the ones a
 * DEPLOYMENT owns — the quarter-hour poll a tenant's org exists to run, armed before
 * anybody has said a word to the agent. Same table, same alarm, same reading of `at` ·
 * `in` · `cron`: at the moment it says, the note arrives in the agent's mind session as
 * an alarm and the agent decides then what to do about it. Nothing is executed for it,
 * because what is stored is words, never a call.
 *
 * The `--name` is the whole difference. An operator's row is re-armed by handle —
 * unique per session, so an entrypoint that runs at every boot keeps ONE wake instead of
 * stacking one per restart — and the handle rides on the alarm (`extra.timer.name`) and
 * on the agent's own list of what is armed, so a wake it did not choose says so.
 *
 * The row lands under the agent's MIND session, which means the agent sees it and can
 * cancel it: a wake reaching an agent that cannot name it is worse than one it may
 * unset. A cancelled standing wake comes back at the next arming, not at the next boot.
 *
 * Nothing restarts: the clock's next sweep reads the table. Env: none.
 */

import { openLog } from "./store/log.ts";
import { fireAtOf, type When } from "./store/timers.ts";
import { MIND, sessionAddress } from "./session.ts";
import { resolveAgent } from "./attach.ts";
import { orgFlag } from "./config.ts";
import { hhmm, shortId } from "./render.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

/** A handle is a key, not a sentence: what an entrypoint can repeat exactly. */
const HANDLE = /^[a-z0-9][a-z0-9-]*$/;

export interface ScheduleArgs extends When {
  agent?: string;
  name?: string;
  cancel?: string;
  note: string;
}

/** The command line, `--dir` already taken. One of two shapes: an arming — a handle, one
 *  way of saying when, and the note — or a `--cancel`, which takes nothing else. */
export function parseScheduleArgs(argv: string[]): ScheduleArgs {
  const out: ScheduleArgs = { note: "" };
  const words: string[] = [];
  const value = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") out.agent = value(a, i++);
    else if (a === "--name") out.name = value(a, i++);
    else if (a === "--cron") out.cron = value(a, i++);
    else if (a === "--at") out.at = value(a, i++);
    else if (a === "--in") out.in = value(a, i++);
    else if (a === "--cancel") out.cancel = value(a, i++);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else words.push(a);
  }
  out.note = words.join(" ").trim();
  if (out.cancel !== undefined) {
    const also = (["name", "cron", "at", "in"] as const).filter((k) => out[k] !== undefined);
    if (also.length || out.note) {
      throw new Error(
        `--cancel takes a handle or an id and nothing else — drop ${
          [...also.map((k) => `--${k}`), ...(out.note ? ["the note"] : [])].join(", ")
        }`,
      );
    }
    return out;
  }
  if (!out.name) {
    throw new Error(
      "--name is required — the handle this wake is re-armed and cancelled by, so a " +
        "second run replaces it instead of arming a second",
    );
  }
  if (!HANDLE.test(out.name)) {
    throw new Error(`--name is lowercase letters, digits, dashes — got "${out.name}"`);
  }
  if (!out.note) {
    throw new Error("a note is required — what the agent reads when the wake fires");
  }
  return out;
}

const USAGE = `usage: liquen schedule --name <handle> (--cron <expr> | --at <moment> | --in <delay>)
                       [--agent <name>] [--dir <org>] <note…>
       liquen schedule --cancel <handle|id> [--agent <name>] [--dir <org>]

  Arm a standing wake for an agent. At the time it says, the note arrives as an alarm in
  that agent's session and the agent decides then what to do about it — nothing is
  executed for it, so the note is written as instructions to be read cold.

  --name <handle>   the handle the wake is re-armed and cancelled by: arming the same name
                    again REPLACES the row, so a boot script never stacks a second
  --cron <expr>     five fields on the org's clock — \`*/15 8-21 * * 1-5\` is every quarter
                    hour through the working day, weekdays
  --at <moment>     one moment: \`2026-09-01T17:00\` on the org's clock, or a stamp carrying
                    its own offset
  --in <delay>      one wake, that far out: \`90s\`, \`20m\`, \`3h\`, \`2d\`, \`1w\`
  --cancel <h|id>   unset a standing wake by handle — or any of the agent's wakes by the id
                    \`liquen status\` shows
  --agent <name>    whose wake it is (a roster name); default: your username
  --dir <org>       the org, when run from elsewhere
  <note…>           what the agent reads when it fires

  The next sweep of the clock picks it up — nothing restarts. \`liquen status\` lists what
  is armed.`;

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    // said bare, the command is a question about itself — the flags ARE the explanation
    if (org.args.length === 0) {
      console.error(USAGE);
      Deno.exit(2);
    }
    const args = parseScheduleArgs(org.args);
    // the roster is the catalog's say: `resolveAgent` refuses a name it does not hold, so a
    // typo cannot arm a wake for an agent that will never read it
    const { dir, target, timezone, paused } = await resolveAgent(args.agent, org.dir);
    const log = await openLog(`${dir}/log`);
    try {
      const armed = await log.timers(target, MIND);
      if (args.cancel !== undefined) {
        const gone = armed.find((t) =>
          t.name === args.cancel || t.id === args.cancel || shortId(t.id) === args.cancel
        );
        if (!gone) {
          throw new Error(
            `no wake "${args.cancel}" armed for ${target} — have: ${
              armed.map((t) => t.name ?? shortId(t.id)).join(" · ") || "(none)"
            }`,
          );
        }
        await log.disarm(gone.id, target, MIND);
        console.error(`✓ cancelled: ${gone.name ?? shortId(gone.id)} — ${gone.note}`);
        return;
      }
      const fireAt = fireAtOf(args, timezone);
      const held = armed.find((t) => t.name === args.name);
      const row = await log.arm({
        agentId: target,
        sessionId: MIND,
        fireAt,
        ...(args.cron ? { cron: args.cron } : {}),
        note: args.note,
        name: args.name,
        conversation: sessionAddress(target, MIND),
      });
      console.error(
        `✓ ${held ? "re-armed" : "armed"}: ${args.name} → ${target}\n` +
          `  fires ${hhmm(fireAt, timezone)} (${fireAt})${
            args.cron ? `, repeats \`${args.cron}\`` : ""
          }\n  id ${shortId(row.id)} · the next sweep of the clock picks it up`,
      );
      if (held) console.error(`  (replaced the wake armed ${hhmm(held.armedAt!, timezone)})`);
      // a paused agent (mind: false, §4) is still armed for: the alarm lands in the log and
      // is owed when the mind comes back, so the wake is late rather than lost
      if (paused) {
        console.error(`  note: ${target} is paused — the alarm waits in the log until it runs`);
      }
    } finally {
      await log.close();
    }
  });
}
