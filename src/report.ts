/**
 * report.ts — work that ended after its turn, told to the session it belongs to (§10).
 *
 * A tool can finish after the turn that called it: a send is accepted, then delivered or
 * refused by a dispatcher a moment later; a background job outlives the bash call that
 * started it. What the turn was told ("sent", the job's line in the ambient block) is then
 * not the end of it, and an agent that learns the end only if something else wakes it
 * goes on believing the beginning. A REPORT is how the end arrives: an `alarm` the harness
 * writes into the session that did the work, its text the outcome in words,
 * `extra.report` what kind of end it is, `payload.ref_id` the row it is about when there
 * is one. An alarm wakes wherever it lands (§2), so the agent takes a turn to recover:
 * try again, try another way, or tell its principal.
 */

import type { AlarmEvent, Draft, Event, EventId, MessageEvent } from "./types.ts";
import type { Log } from "./store/log.ts";
import { MIND, sessionAddress } from "./session.ts";
import { shortId, textOf } from "./render.ts";

/** What kind of end a report tells: a send that will not be delivered, a job that ended. */
export type ReportKind = "undelivered" | "job_ended";

export interface Report {
  agentId: string;
  sessionId: string;
  kind: ReportKind;
  text: string;
  refId?: EventId;
  /** What the report is about, beyond its words: the job's group and command. */
  data?: Record<string, string | number>;
}

/** The report as the alarm it travels as. */
export function reportDraft(r: Report, now: string): Draft<AlarmEvent> {
  return {
    ts: now,
    type: "alarm", // harness-authored: no `agent`, so the relational rule wakes on it (§2)
    payload: { ...(r.refId ? { ref_id: r.refId } : {}) },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: sessionAddress(r.agentId, r.sessionId) },
    },
    extra: { report: { kind: r.kind, ...(r.data ?? {}) } },
    parts: [{ type: "text", kind: "alarm", text: r.text }],
  };
}

const quote = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `"${t.slice(0, 59)}…"` : `"${t}"`;
};

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

/** The report of a send that failed for good: which message, to whom, and why. */
export function undeliveredReport(e: Event): Report | undefined {
  if (!e.agent) return undefined;
  const conv = e.envelope.conversation;
  const to = conv.name ? `${conv.name} (${conv.address})` : conv.address;
  const words = textOf(e as MessageEvent);
  return {
    agentId: e.agent.id,
    sessionId: e.agent.session_id ?? MIND,
    kind: "undelivered",
    refId: e.id,
    text: `your message ${shortId(e.id)}${words ? ` ${quote(words)}` : ""} to ${to} ` +
      `was not delivered: ${whyUndelivered(e)}`,
  };
}

/** How often main looks for background jobs that ended: a probe of each live group, cheap
 *  enough to run often, so an end arrives seconds after it happens. */
export const JOB_PROBE_MS = 2_000;

const took = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** The report of a background job that ended: what it ran and for how long. Its exit
 *  status is unknowable (a `cmd &` grandchild is not the harness's to wait on), so the
 *  report says where the outcome is: whatever the job wrote. */
export function jobReport(
  ended: {
    agentId: string;
    sessionId: string;
    job: { pgid: number; command: string; since: number };
  },
  now: number = Date.now(),
): Report {
  const { job } = ended;
  const command = job.command.replace(/\s+/g, " ").trim();
  const brief = command.length > 120 ? `${command.slice(0, 119)}…` : command;
  return {
    agentId: ended.agentId,
    sessionId: ended.sessionId,
    kind: "job_ended",
    data: { pgid: job.pgid, command },
    text: `your background job ended after ${took(now - job.since)} (group ${job.pgid}): ` +
      `${brief}. Its exit status is not known; what it wrote holds the outcome.`,
  };
}

/** The clock's report pass (§10): every send that failed for good since the last pass is
 *  claimed once and told to the session that sent it. Safe from more than one clock: the
 *  claim is the store's, so a row is told once. Returns how many were told. */
export async function reportUndelivered(
  log: Pick<Log, "undelivered" | "read" | "publish">,
  now: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  let told = 0;
  for (const id of await log.undelivered(nowIso)) {
    const [row] = await log.read({ beforeId: `${id}0`, limit: 1 });
    const report = row?.id === id ? undeliveredReport(row) : undefined;
    if (!report) continue;
    await log.publish(reportDraft(report, nowIso));
    told++;
  }
  return told;
}
