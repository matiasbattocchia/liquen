/**
 * tick.ts — the clock's statement (§2, §10): what one beat of the metronome owes the store.
 *
 * Four passes, each a read off the store and a write back into it, none of them needing
 * anything a process remembers: reminders that came due become `alarm` events, unanswered
 * asks lapse, transiently failed sends are re-offered, and a send's tale is reported to the
 * session that sent it: failed for good, still not out, or out after all. main runs them on
 * its ticker; a host whose clock is the database's (pg_cron) runs the same function. Every
 * pass is safe to run from more than one clock at once — a reminder's alarm is keyed by its
 * doc and minute, a card lapses once because the settling verdict closes it, the sweep and
 * the report's claim are each one conditional UPDATE — so two ticks overlapping cost a
 * second scan, never a second alarm.
 */

import type { Log } from "./store/log.ts";
import type { Docs } from "./store/docs.ts";
import type { AlarmEvent, Draft, PermissionResponseEvent } from "./types.ts";
import { reportSends } from "./late.ts";
import { LOCAL_CONNECTION, MIND, sessionAddress } from "./session.ts";
import { GATE_HOURS } from "./config.ts";
import { dayOf, docName, remindersDue, wallOf, wallStamp } from "./agenda.ts";

/** What the clock reads reminders off: the agents it sweeps, each on its own clock, the
 *  docs that hold their lines, and the backlog an agent inherits at boot. The backlog is
 *  also how late a reminder may still fire: a clock that was down that long fires what came
 *  due meanwhile, and a line written just past its reminder fires at once, so one number
 *  says how far back a waking agent looks, for lines and reminders alike. */
export interface Clock {
  agents(): { agentId: string; timezone?: string }[];
  docs: Pick<Docs, "list" | "read">;
  backlogHours: number;
}

/** What one beat did: how many each pass settled, and which passes failed. A pass that
 *  threw counts nothing and names itself here; the others still ran. */
export interface Beat {
  fired: number;
  lapsed: number;
  swept: number;
  reported: number;
  failed: { pass: "fire" | "lapse" | "sweep" | "report"; error: unknown }[];
}

/** One beat: due reminders → alarms, unanswered asks → lapsed, failed sends → queued, sends
 *  failed for good, stalled or out after all → reports. The passes are independent — each
 *  is its own scan and its own writes — so one that fails is reported in the beat and the
 *  next still runs. */
export async function tick(
  log: Pick<
    Log,
    | "gates"
    | "publish"
    | "sweep"
    | "undelivered"
    | "stalled"
    | "corrected"
    | "read"
  >,
  clock: Clock,
  now: number = Date.now(),
): Promise<Beat> {
  const beat: Beat = { fired: 0, lapsed: 0, swept: 0, reported: 0, failed: [] };
  const pass = async (name: Beat["failed"][number]["pass"], run: () => Promise<number>) => {
    try {
      return await run();
    } catch (error) {
      beat.failed.push({ pass: name, error });
      return 0;
    }
  };
  beat.fired = await pass("fire", () => remindDue(log, clock, now));
  beat.lapsed = await pass("lapse", () => lapseGates(log, now));
  beat.swept = await pass("sweep", () => log.sweep(new Date(now).toISOString()));
  // after the sweep: a row it just re-offered is not failed, and one past the ceiling is
  beat.reported = await pass("report", () => reportSends(log, now));
  return beat;
}

/** Due reminders → alarms (§10): the lines of every doc an agent reads, whatever its scope,
 *  whose reminder came due in the backlog before now, read on the agent's clock; a shared
 *  line reminds each agent that reads it. One alarm per doc and minute,
 *  carrying each line it reminds of, lands in the agent's mind session; its fan-out is the
 *  wake, so a reminder reaches the agent by exactly the path everything else does. The
 *  alarm's `external_id` is its doc and minute, so it is stored once whoever sweeps: a
 *  second clock, a later beat inside the backlog, a line edited after it fired. */
export async function remindDue(
  log: Pick<Log, "read" | "publish">,
  clock: Clock,
  now: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  const grace = clock.backlogHours * 60;
  let fired = 0;
  for (const { agentId, timezone } of clock.agents()) {
    const to = wallOf(nowIso, timezone), today = dayOf(nowIso, timezone);
    if (to === undefined || !today) continue;
    const ctx = { agent: agentId };
    for (const d of await clock.docs.list(ctx)) {
      const name = docName(d.header);
      const body = d.body ?? await clock.docs.read(ctx, d.header) ?? "";
      const byMinute = new Map<number, string[]>();
      for (const due of remindersDue(name, body, to - grace, to, today)) {
        byMinute.set(due.fire, [...byMinute.get(due.fire) ?? [], due.text]);
      }
      for (const [fire, lines] of byMinute) {
        const key = `remind:${agentId}:${name}:${wallStamp(fire)}`;
        if ((await log.read({ externalId: key, limit: 1 })).length > 0) continue;
        await log.publish(
          {
            ts: nowIso,
            type: "alarm", // harness-authored: no `agent`, so the relational rule wakes on it (§2)
            envelope: {
              service: "local",
              connection_address: LOCAL_CONNECTION,
              conversation: { address: sessionAddress(agentId, MIND) },
              external_id: key,
            },
            extra: { reminder: { doc: name, at: wallStamp(fire) } },
            parts: [{ type: "text", kind: "alarm", text: lines.join("\n") }],
          } satisfies Draft<AlarmEvent>,
        );
        fired++;
      }
    }
  }
  return fired;
}

/** An ask nobody answered lapses (§9): past `GATE_HOURS` the harness settles the card with
 *  a deny that says `lapsed` — a row like any verdict, so the anchor drops the line, a late
 *  `/y` is told the card was answered, and the response reaches the model as news in its
 *  room, like any deny: the call did not run. Read off the store, not a window: a card
 *  stands open however much traffic has passed it. */
export async function lapseGates(
  log: Pick<Log, "gates" | "publish">,
  now: number = Date.now(),
): Promise<number> {
  const hours = GATE_HOURS;
  let settled = 0;
  for (const card of await log.gates()) {
    if (Date.parse(card.ts) > now - hours * 3_600_000) continue;
    // a card answered since the scan read it keeps its answer: the store stores no second
    // ruling (§9)
    const lapsed = await log.publish(
      {
        ts: new Date(now).toISOString(),
        type: "permission_response", // harness-authored: no `agent`, no turn_id (§3)
        payload: { ref_id: card.payload.ref_id },
        // the card's coordinates, rebuilt — its stored envelope carries an external_id,
        // and reusing that would upsert-merge this settlement INTO the card's row
        envelope: {
          service: card.envelope.service,
          connection_address: card.envelope.connection_address,
          conversation: { address: card.envelope.conversation.address },
        },
        parts: [{
          type: "data",
          kind: "permission_response",
          data: {
            behavior: "deny",
            scope: "once",
            lapsed: true,
            reason: `unanswered for ${hours}h`,
          },
          text: card.parts[0].data.call, // the card's own rendering — what the notice names
        }],
      } satisfies Draft<PermissionResponseEvent>,
    );
    if (lapsed !== null) settled++;
  }
  return settled;
}
