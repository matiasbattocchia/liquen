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

import type { Draft, Event, EventId, ToolResultEvent } from "./types.ts";
import type { CallRef } from "./xi.ts";
import type { Log } from "./store/log.ts";
import { MIND, sessionAddress } from "./session.ts";
import { describeCall, nameResolver } from "./describe.ts";
import type { SessionUpdate } from "./sandbox.ts";

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
      connection_address: "agent",
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

/** One row by id, off the log's id-ordered read. */
async function rowOf(log: Pick<Log, "read">, id: EventId): Promise<Event | undefined> {
  const [row] = await log.read({ beforeId: `${id}0`, limit: 1 });
  return row?.id === id ? row : undefined;
}

/** The clock's undelivered pass (§10): every send that failed for good since the last pass
 *  is claimed once and told to the call that sent it. Safe from more than one clock: the
 *  claim is the store's, so a row is told once. Returns how many were told. */
export async function reportUndelivered(
  log: Pick<Log, "undelivered" | "read" | "publish">,
  now: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  let told = 0;
  for (const id of await log.undelivered(nowIso)) {
    const row = await rowOf(log, id);
    const ref = row?.payload?.ref_id;
    const use = ref ? await rowOf(log, ref) : undefined;
    if (!row || use?.type !== "tool_use") continue;
    // the card's rendering, addresses named: the line says who it did not reach
    const call = use.parts[0].data;
    const resolve = await nameResolver(log.read, [call]);
    const update = undeliveredUpdate(
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
