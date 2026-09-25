/**
 * tick.ts — the clock's statement (§2, §10): what one beat of the metronome owes the store.
 *
 * Three passes, each a read off the store and a write back into it, none of them needing
 * anything a process remembers: due timers become `alarm` events, unanswered asks lapse,
 * transiently failed sends are re-offered. main runs them on its ticker; a host whose
 * clock is the database's (pg_cron) runs the same function. Every pass is safe to run
 * from more than one clock at once — a timer is won by `claim`, a card lapses once
 * because the settling verdict closes it, the sweep is one conditional UPDATE — so two
 * ticks overlapping cost a second scan, never a second alarm.
 */

import type { Log } from "./store/log.ts";
import type { AlarmEvent, Draft, PermissionResponseEvent } from "./types.ts";

/** The two per-agent settings the clock reads: the zone a cron advances in, and how long
 *  its asks stand. `undefined` for an agent the clock does not know (a paused one, a row
 *  that is gone): its crons advance in UTC and its cards stand. */
export type ClockSettings = (
  agentId: string,
) => { timezone?: string; gateHours?: number | null } | undefined;

/** What one beat did: how many each pass settled, and which passes failed. A pass that
 *  threw counts nothing and names itself here; the others still ran. */
export interface Beat {
  fired: number;
  lapsed: number;
  swept: number;
  failed: { pass: "fire" | "lapse" | "sweep"; error: unknown }[];
}

/** One beat: due wakes → alarms, unanswered asks → lapsed, failed sends → queued. The
 *  passes are independent — each is its own scan and its own writes — so one that fails
 *  is reported in the beat and the next still runs. */
export async function tick(
  log: Pick<Log, "due" | "claim" | "settle" | "gates" | "publish" | "sweep">,
  settings: ClockSettings,
  now: number = Date.now(),
): Promise<Beat> {
  const beat: Beat = { fired: 0, lapsed: 0, swept: 0, failed: [] };
  const pass = async (name: Beat["failed"][number]["pass"], run: () => Promise<number>) => {
    try {
      return await run();
    } catch (error) {
      beat.failed.push({ pass: name, error });
      return 0;
    }
  };
  beat.fired = await pass("fire", () => fireDue(log, (id) => settings(id)?.timezone, now));
  beat.lapsed = await pass("lapse", () => lapseGates(log, (id) => settings(id)?.gateHours, now));
  beat.swept = await pass("sweep", () => log.sweep(new Date(now).toISOString()));
  return beat;
}

/** Due wakes → alarms (§10). The alarm lands in the conversation the arming session
 *  speaks in, and says where it came from: `ref_id` the `schedule` call, `extra.timer` the
 *  row — a note read cold leads back to the moment it was written, and a repeating one
 *  says so. The alarm's own fan-out is the wake — no direct invoke, so a scheduled wake
 *  reaches the agent by exactly the path everything else does. Firing consumes the row in
 *  the same pass (`settle`: one-shot ⇒ gone, cron ⇒ advanced past now), so a long outage
 *  fires each cron once, late. Across clocks the guarantee is `claim`'s — the scan lists,
 *  the claim wins, and only what this pass won gets an alarm. `tzOf` is the zone a cron
 *  advances in: the clock it was armed against, the agent's, not UTC. */
export async function fireDue(
  log: Pick<Log, "due" | "claim" | "settle" | "publish">,
  tzOf: (agentId: string) => string | undefined,
  now: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  let fired = 0;
  for (const due of await log.due(nowIso)) {
    const t = await log.claim(due.id, nowIso);
    if (!t) continue; // another clock fired it
    await log.publish(
      {
        ts: nowIso,
        type: "alarm", // harness-authored: no `agent`, so the relational rule wakes on it (§2)
        payload: { ...(t.refId ? { ref_id: t.refId } : {}) },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: t.conversation },
        },
        extra: {
          timer: {
            id: t.id,
            session_id: t.sessionId,
            ...(t.cron ? { cron: t.cron } : {}),
            ...(t.name ? { name: t.name } : {}),
            ...(t.armedAt ? { armed_at: t.armedAt } : {}),
          },
        },
        parts: [{ type: "text", kind: "alarm", text: t.note }],
      } satisfies Draft<AlarmEvent>,
    );
    await log.settle(t.id, nowIso, tzOf(t.agentId));
    fired++;
  }
  return fired;
}

/** An ask nobody answered lapses (§9): past its agent's `gateHours` the harness settles the
 *  card with a deny that says `lapsed` — a row like any verdict, so the anchor drops the
 *  line, a late `/y` is told the card was answered, and the outcome reaches the model by
 *  the errand every ruling takes (`act`), telling it the call did not run. Read off the
 *  store, not a window: a card stands open however much traffic has passed it. `hoursOf`
 *  is the agent's knob — null or unknown (a paused agent) ⇒ its cards stand. */
export async function lapseGates(
  log: Pick<Log, "gates" | "publish">,
  hoursOf: (agentId: string) => number | null | undefined,
  now: number = Date.now(),
): Promise<number> {
  let settled = 0;
  for (const card of await log.gates()) {
    const hours = card.agent ? hoursOf(card.agent.id) : undefined;
    if (hours == null || Date.parse(card.ts) > now - hours * 3_600_000) continue;
    await log.publish(
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
    settled++;
  }
  return settled;
}
