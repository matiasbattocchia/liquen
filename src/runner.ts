/**
 * runner.ts — what a session of an agent runs with (DESIGN §4, §9).
 *
 * One builder serves the mind and every named session, from three things no process
 * owns: the store, the agent's row, and the host's ports. The identity is shared — one
 * metered transport, one address book, one history, one ground — and the log view, the
 * lease, the stream and the shell (where it stands, what it left running) are the
 * session's. A runner is built once per session and kept: an attachment's `tune` writes
 * into it, and the next invocation reads what it wrote.
 */

import type { AgentConfig, Decision, XiPorts } from "./xi.ts";
import type { Log } from "./store/log.ts";
import { type Policy, scoped } from "./policy.ts";
import type { DocContext, Docs } from "./store/docs.ts";
import type { DocCalls } from "./store/pg/docs.ts";
import { docTools } from "./exec/docs.ts";
import { sessionAddress } from "./session.ts";
import type { MediaLoader } from "./store/media.ts";
import type { ModelTransport } from "./transport/mod.ts";
import type { Sandbox } from "./sandbox.ts";
import type { AgentRow } from "./store/agents.ts";
import type { About, Delta, Effort } from "./types.ts";

/** What a host wires once, for every runner it builds. */
export interface Host {
  log: Log;
  docs: Docs;
  /** The agent's own reach into the docs, where they live in the table (§9): the session's
   *  `read · write · edit` tools are built over it. Absent: the docs are files, and the
   *  shell's binaries reach them. */
  reach?: (ctx: DocContext) => DocCalls;
  /** The session's view of the log (§6): the law the store applies to its reads, its
   *  writes and its tail. */
  policy: (agentId: string, sessionId: string) => Policy;
  /** The agent's history (§6): the law `search` reads under, whichever of its sessions
   *  is asking. Absent: the session's own view answers. */
  history?: (agentId: string) => Policy;
  /** The agent's stock transport, metered in its name (§2 telemetry). */
  transport: (agentId: string) => ModelTransport;
  /** The exec plane (§9). Absent: no shell, no ambient lines, no file scope — an edge host. */
  sandbox?: Sandbox;
  contact?: XiPorts["contact"];
  media?: MediaLoader;
  onDelta?: (agentId: string, sessionId: string, delta: Delta) => void;
  onDecision?: (
    agentId: string,
    sessionId: string,
    verdict: Decision,
    cursor: string | undefined,
    about: About[],
  ) => void;
}

/** A session, built: its config and ports for `xi`, and its view of the log for the
 *  host's own use (the tail, the door). Mutable on purpose — `tune` writes here. */
export interface Runner {
  config: AgentConfig;
  log: Log;
  ports: XiPorts;
}

/** What rides in code beside the row (§9): a compiled gate, a retry pace — a function and
 *  a pace, which no row holds. Tests pass them; a deployment's row is enough. */
export type Seams = Pick<AgentConfig, "gate" | "retryDelaysMs">;

/** The config a session of the agent runs with, from its row (§9): the identity columns
 *  and the row's `settings`, whole. A row with no settings or no model is one no session
 *  can run on. */
export function configOf(row: AgentRow, sessionId: string): AgentConfig {
  if (!row.settings || row.model === undefined) {
    throw new Error(`agent ${row.agentId}: its row carries no settings`);
  }
  return {
    agentId: row.agentId,
    sessionId,
    model: row.model,
    ...(row.effort ? { effort: row.effort as Effort } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...row.settings,
  };
}

/** The runner (§4): a session of the agent its row describes, on the host's ports. `home`
 *  is the sandbox's fact — where the agent's folder is on the ground it stands on. */
export function runnerFor(
  host: Host,
  row: AgentRow,
  sessionId: string,
  seams: Seams = {},
): Runner {
  const { agentId } = row;
  const box = host.sandbox?.forAgent(agentId).session(sessionId);
  const slog = scoped(host.log, host.policy(agentId, sessionId));
  // the session's docs tools, where the docs are the table's: its conversation is the
  // one the session speaks in (§4), which is where a conversation doc is looked for
  const reach = host.reach?.({
    agent: agentId,
    conversation: sessionAddress(agentId, sessionId),
  });
  const exec = box || reach ? { exec: { ...box?.exec, ...(reach ? docTools(reach) : {}) } } : {};
  return {
    config: { ...configOf(row, sessionId), ...(box ? { home: box.home } : {}), ...seams },
    log: slog,
    ports: {
      log: slog,
      ...(host.history ? { history: scoped(host.log, host.history(agentId)) } : {}),
      docs: host.docs,
      transport: host.transport(agentId),
      ...exec,
      ...(box ? { files: box.files, ambient: box.ambient } : {}),
      ...(host.contact ? { contact: host.contact } : {}),
      ...(host.media ? { media: host.media } : {}),
      ...(host.onDelta ? { onDelta: (d: Delta) => host.onDelta!(agentId, sessionId, d) } : {}),
      ...(host.onDecision
        ? {
          onDecision: (v: Decision, cursor: string | undefined, about: About[]) =>
            host.onDecision!(agentId, sessionId, v, cursor, about),
        }
        : {}),
    },
  };
}
