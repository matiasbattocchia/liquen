/**
 * late.ts — what a call did after its answer, told against the call (§9).
 *
 * A call can go on after the turn that made it: a send is accepted, then refused by its
 * dispatcher a moment later; a command outlives its wait, or leaves a job behind. What the
 * turn was told is then not the end of it, and an agent that learns the end only if
 * something else wakes it goes on believing the beginning. An UPDATE is how the rest
 * arrives: a `tool_result` the harness writes against the call (`payload.update`, `ref_id`
 * its `tool_use`, `turn_id` its step), its output the news, its text the call as a person
 * reads it, `final` once nothing the call set in motion still runs. Render narrates it in
 * the harness's voice (§5), and it is news that wakes its session (§2): the agent takes a
 * turn to act on it — try again, try another way, or tell its principal.
 */

import type { Draft, Event, EventId, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { CallRef } from "./xi.ts";
import type { Log } from "./store/log.ts";
import { LOCAL_CONNECTION, MIND, sessionAddress } from "./session.ts";
import { describeCall, nameResolver } from "./describe.ts";
import type { SessionUpdate } from "./sandbox.ts";
import { RETRY_BACKOFF_MS } from "./store/sweep.ts";
import { took } from "./exec/jobs.ts";
import { shortId } from "./render.ts";

export interface Update {
  agentId: string;
  sessionId: string;
  /** The call it is about. */
  use: CallRef;
  /** The call as a person reads it: the line's subject. */
  call: string;
  output: string;
  is_error?: boolean;
  final?: boolean;
}

/** The update as the `tool_result` it travels as. */
export function updateDraft(u: Update, now: string): Draft<ToolResultEvent> {
  return {
    ts: now,
    type: "tool_result",
    payload: {
      turn_id: u.use.turn_id,
      ref_id: u.use.id,
      update: true,
      ...(u.final ? { final: true } : {}),
    },
    agent: { id: u.agentId, session_id: u.sessionId },
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: sessionAddress(u.agentId, u.sessionId) },
    },
    parts: [{
      type: "data",
      kind: "tool_result",
      data: { output: u.output, ...(u.is_error ? { is_error: true } : {}) },
      text: u.call,
    }],
  };
}

/** Why a send failed for good, in words: the service's refusal as the dispatcher wrote it,
 *  the ladder's end, or the wire's own word after it named the message. */
function whyUndelivered(e: Event): string {
  const status = e.status ?? {};
  const error = (status.error ?? "").replace(/^\w*Error: /, "");
  if (e.envelope.external_id && !error) return `${e.envelope.service} reported it failed`;
  if ((status.attempts ?? 0) > 0) {
    return `still failing after ${status.attempts} retries${error ? `: ${error}` : ""}`;
  }
  return error || "the service refused it";
}

/** The update of a send that failed for good: the call that sent it, and why. Final: a
 *  message that will not be delivered has nothing left to tell. */
export function undeliveredUpdate(e: Event, use: CallRef, call: string): Update | undefined {
  if (!e.agent) return undefined;
  return {
    agentId: e.agent.id,
    sessionId: e.agent.session_id ?? MIND,
    use,
    call,
    output: `not delivered: ${whyUndelivered(e)}`,
    is_error: true,
    final: true,
  };
}

/** How long an offer may stand with nobody taking it before the connector counts as
 *  absent: a post takes seconds, and a re-offer is taken as it lands. */
const UNTAKEN_MS = 60_000;

/** The update of a send still not out past `STALLED_AFTER_MS`: why, how much longer it is
 *  tried, and how to take it back. Not final: it may yet go out, and then it is told. */
export function stalledUpdate(
  e: Event,
  use: CallRef,
  call: string,
  now: number,
): Update | undefined {
  if (!e.agent) return undefined;
  const status = e.status ?? {};
  const service = e.envelope.service;
  const untaken = status.state === "queued" &&
    now - Date.parse(status.queued_at ?? e.ts) >= UNTAKEN_MS;
  const error = (status.error ?? "").replace(/^\w*Error: /, "");
  const why = untaken
    ? `nothing has taken it to ${service}: its connector is not running`
    : error || `${service} has not taken it yet`;
  // the rungs not yet climbed, from the last failure: when the ladder gives up
  const left = status.state === "failed" && status.failed_at
    ? Date.parse(status.failed_at) +
      RETRY_BACKOFF_MS.slice(status.attempts ?? 0).reduce((a, b) => a + b, 0) - now
    : undefined;
  const retried = left === undefined
    ? "It is offered again while it waits"
    : `It is retried for about ${took(Math.max(left, 0))} more`;
  return {
    agentId: e.agent.id,
    sessionId: e.agent.session_id ?? MIND,
    use,
    call,
    output: `not delivered yet, ${took(now - Date.parse(e.ts))} after it was sent: ${why}. ` +
      `${retried}, and you are told when it goes out or is given up. To keep it from ` +
      `going out late, take it back: cancel ${shortId(e.id)}.`,
    is_error: true,
  };
}

/** The update of a send told stalled or undelivered, or withdrawn, that went out after
 *  all: when, against when it was sent. Final: it is out. */
export function correctedUpdate(e: Event, use: CallRef, call: string): Update | undefined {
  if (!e.agent) return undefined;
  const status = e.status ?? {};
  const out = status.dispatched_at ??
    (typeof status.delivered_at === "string" ? status.delivered_at : undefined);
  const late = out ? `, ${took(Date.parse(out) - Date.parse(e.ts))} after it was sent` : "";
  return {
    agentId: e.agent.id,
    sessionId: e.agent.session_id ?? MIND,
    use,
    call,
    output: `delivered after all${late}` +
      (status.withdrawn_at ? ": it was already on its way when you took it back" : ""),
    final: true,
  };
}

/** A shell's word on one of its session's calls (exec/bash.ts: the lines a call woke on,
 *  its end, what it left running ending), the call named the way its row reads. */
export function shellUpdate(u: SessionUpdate): Update {
  return {
    agentId: u.agentId,
    sessionId: u.sessionId,
    use: u.use,
    call: describeCall({ name: "bash", input: { command: u.command } }),
    output: u.output,
    ...(u.is_error ? { is_error: true } : {}),
    ...(u.final ? { final: true } : {}),
  };
}

/** What a harness can say of a command whose job it cannot find: nothing it knows. */
export const LOST =
  "lost when the harness went down while it ran: it left nothing to find it by, so it may " +
  "have ended or may still run, and nothing more is told of it";

/** The boot's pass over the shell's calls left owed (§9): each command answered async whose
 *  final word never came was followed by a harness that is gone. Its job is followed on
 *  where its shell runs (`resume`, which tells its end when it comes, at once when it came
 *  meanwhile); one that left no job to find is told final, lost. A shell that could not be
 *  asked leaves the call owed, for the next boot. Runs before any turn does. */
export async function resumeUnended(
  log: Pick<Log, "unended" | "publish">,
  resume: (use: ToolUseEvent) => Promise<boolean>,
  now: number = Date.now(),
): Promise<{ followed: number; lost: number }> {
  const nowIso = new Date(now).toISOString();
  const count = { followed: 0, lost: 0 };
  for (const use of await log.unended("bash")) {
    if (!use.agent) continue;
    let found: boolean;
    try {
      found = await resume(use);
    } catch (err) {
      console.error(`[late] ${use.id}: its job could not be looked for:`, err);
      continue;
    }
    if (found) {
      count.followed++;
      continue;
    }
    const { command } = use.parts[0].data.input as { command?: string };
    await log.publish(updateDraft(
      shellUpdate({
        agentId: use.agent.id,
        sessionId: use.agent.session_id ?? MIND,
        use: { id: use.id, turn_id: use.payload.turn_id },
        command: command ?? "",
        output: LOST,
        final: true,
      }),
      nowIso,
    ));
    count.lost++;
  }
  return count;
}

/** One row by id, off the log's id-ordered read. */
async function rowOf(log: Pick<Log, "read">, id: EventId): Promise<Event | undefined> {
  const [row] = await log.read({ beforeId: `${id}0`, limit: 1 });
  return row?.id === id ? row : undefined;
}

/** The clock's report passes over the agent's sends (§10), in the order a send's tale
 *  runs: failed for good, still not out past `STALLED_AFTER_MS`, out after all. Each row is
 *  claimed once by the store and told to the call that sent it. Safe from more than one
 *  clock: the claim is the store's, so a row is told once. Returns how many were told. */
export async function reportSends(
  log: Pick<Log, "undelivered" | "stalled" | "corrected" | "read" | "publish">,
  now: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  return await tellOf(log, await log.undelivered(nowIso), undeliveredUpdate, nowIso) +
    await tellOf(log, await log.stalled(nowIso), (e, u, c) => stalledUpdate(e, u, c, now), nowIso) +
    await tellOf(log, await log.corrected(nowIso), correctedUpdate, nowIso);
}

/** Each claimed send told to its call, the call named the way its card reads. */
async function tellOf(
  log: Pick<Log, "read" | "publish">,
  ids: EventId[],
  compose: (e: Event, use: CallRef, call: string) => Update | undefined,
  nowIso: string,
): Promise<number> {
  let told = 0;
  for (const id of ids) {
    const row = await rowOf(log, id);
    const ref = row?.payload?.ref_id;
    const use = ref ? await rowOf(log, ref) : undefined;
    if (!row || use?.type !== "tool_use") continue;
    // the card's rendering, addresses named: the line says who it did or did not reach
    const call = use.parts[0].data;
    const resolve = await nameResolver(log.read, [call]);
    const update = compose(
      row,
      { id: use.id, turn_id: use.payload.turn_id },
      describeCall(call, { resolve }),
    );
    if (!update) continue;
    await log.publish(updateDraft(update, nowIso));
    told++;
  }
  return told;
}
