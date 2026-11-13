/**
 * runner.ts — what a session of an agent runs with (DESIGN §4, §9).
 *
 * One builder serves the mind and every named session, from three things no process
 * owns: the store, the agent's row with the org's configuration, and the host's ports. The identity is shared — one
 * metered transport, one address book, one history, one ground — and the log view, the
 * lease, the stream and the shell (where it stands, what it left running) are the
 * session's. A runner is built once per session and kept: an attachment's `tune` writes
 * into it, and the next invocation reads what it wrote.
 */

import type { AgentConfig, Decision, XiPorts } from "./xi.ts";
import type { Log } from "./store/log.ts";
import { type Policy, scoped } from "./policy.ts";
import type { DocCalls, DocContext, Docs } from "./store/docs.ts";
import { docTools } from "./exec/docs.ts";
import type { MediaLoader } from "./store/media.ts";
import { ANTHROPIC, type ModelTransport, providerOf, type Warmth } from "./transport/mod.ts";
import type { Sandbox } from "./sandbox.ts";
import { MIND } from "./session.ts";
import type { AgentRow } from "./store/agents.ts";
import { type OrgConfig, settingsOf } from "./config.ts";
import type { Cause, Delta } from "./types.ts";

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
  /** A keeper for each mind's cache (§5). Absent: a quiet mind's cache lapses. */
  warmth?: (agentId: string) => Warmth;
  /** The exec plane (§9). Absent: no shell, no ambient lines, no file scope — an edge host. */
  sandbox?: Sandbox;
  contact?: XiPorts["contact"];
  rooms?: XiPorts["rooms"];
  media?: MediaLoader;
  onDelta?: (agentId: string, sessionId: string, delta: Delta) => void;
  onDecision?: (
    agentId: string,
    sessionId: string,
    verdict: Decision,
    cursor: string | undefined,
    cause?: Cause,
  ) => void;
}

/** A session, built: its config and ports for `xi`, and its view of the log for the
 *  host's own use (the tail, the door). Mutable on purpose — `tune` writes here. */
export interface Runner {
  config: AgentConfig;
  log: Log;
  ports: XiPorts;
  /** The mind's keeper, whichever transport it thinks through. */
  warmth?: Warmth;
}

/** What a session thinks through: `transport`, through the session's keeper, which holds
 *  the cache warm where the provider keeps it an hour and reads it far below a write. */
export function thinkingThrough(
  r: Pick<Runner, "warmth">,
  provider: string | null | undefined,
  transport: ModelTransport,
): ModelTransport {
  return r.warmth ? r.warmth.through(transport, providerOf(provider) === ANTHROPIC) : transport;
}

/** What rides in code beside the row (§9): a compiled gate, a retry pace — a function and
 *  a pace, which no row holds. Tests pass them; a deployment's rows are enough. */
export type Seams = Pick<AgentConfig, "gate" | "retryDelaysMs">;

/** The config a session of the agent runs with (§9): its row's identity and backlog
 *  floor, and its settings as they resolve when this is read — its own scope over the
 *  org's, over the catalog's constants — beside what every agent of the org shares: the
 *  clock, the locale, the media a processor makes readable. */
export function configOf(row: AgentRow, org: OrgConfig, sessionId: string): AgentConfig {
  const s = settingsOf(org, row.agentId);
  return {
    agentId: row.agentId,
    sessionId,
    model: s.model,
    ...(s.effort ? { effort: s.effort } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    maxTokens: s.maxTokens,
    // null is "every tool": the offer is left unnamed
    ...(s.tools !== null ? { tools: s.tools } : {}),
    rules: s.rules,
    ...(row.since ? { since: row.since } : {}),
    ...(org.shared.timezone ? { timezone: org.shared.timezone } : {}),
    ...(org.shared.locale ? { locale: org.shared.locale } : {}),
    // attention (§2): the wake policy is the agent's — hot, summoned, or on the digest
    engagedMinutes: s.engagedMinutes,
    digestAfterMessages: s.digestAfterMessages,
    digestMinutes: s.digestMinutes,
    sleepHours: s.sleepHours, // null is "never sleeps" (Wake, §2)
    // the media kinds a processor makes readable — org-wide, one fact for every agent (§5)
    processors: Object.entries(org.processors).filter(([, cmd]) => !!cmd).map(([kind]) => kind),
    // the window (§5): what the agent holds in view is its work's shape
    compactAt: s.compactAt,
    keepRecent: s.keepRecent,
    cache: providerOf(s.provider).cache,
  };
}

/** The runner (§4): a session of an agent on the host's ports, running with `config` and
 *  thinking through `provider`'s transport. `home` is the sandbox's fact — where the
 *  agent's folder is on the ground it stands on. */
export function runnerFor(
  host: Host,
  config: AgentConfig,
  provider: string | null | undefined,
  seams: Seams = {},
): Runner {
  const { agentId, sessionId } = config;
  const box = host.sandbox?.forAgent(agentId).session(sessionId);
  const slog = scoped(host.log, host.policy(agentId, sessionId));
  // the session's docs tools, where the docs are the table's
  const reach = host.reach?.({ agent: agentId });
  const exec = box || reach ? { exec: { ...box?.exec, ...(reach ? docTools(reach) : {}) } } : {};
  // the mind's next turn is always coming; a named session's work ends, and its cache with it
  const warmth = sessionId === MIND ? host.warmth?.(agentId) : undefined;
  return {
    config: { ...config, ...(box ? { home: box.home } : {}), ...seams },
    log: slog,
    ...(warmth ? { warmth } : {}),
    ports: {
      log: slog,
      ...(host.history ? { history: scoped(host.log, host.history(agentId)) } : {}),
      docs: host.docs,
      transport: thinkingThrough({ warmth }, provider, host.transport(agentId)),
      ...exec,
      ...(box ? { files: box.files, ambient: box.ambient } : {}),
      ...(box?.bins ? { bins: box.bins } : {}),
      ...(host.contact ? { contact: host.contact } : {}),
      ...(host.rooms ? { rooms: host.rooms } : {}),
      ...(host.media ? { media: host.media } : {}),
      ...(host.onDelta ? { onDelta: (d: Delta) => host.onDelta!(agentId, sessionId, d) } : {}),
      ...(host.onDecision
        ? {
          onDecision: (v: Decision, cursor: string | undefined, cause?: Cause) =>
            host.onDecision!(agentId, sessionId, v, cursor, cause),
        }
        : {}),
    },
  };
}
