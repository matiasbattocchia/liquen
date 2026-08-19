/**
 * main.ts — the process (DESIGN §2). The only long-running piece.
 *
 * main holds the subscriptions, and does NOTHING else:
 *
 *   for (const agent of agents) agent.log.subscribe((event) => xi(agent, ports, event))
 *
 * EACH agent tails the log through its own scoped port (§6) — so delivery itself is policy-
 * filtered, the way a Supabase Realtime socket only carries rows RLS lets you see. main is a
 * MESSENGER between the log and the agents: it does not inspect events and takes no decision
 * — the visibility filter belongs to the store boundary (`scoped`), and the class gate
 * (`relevant`, free: no read, no lease) belongs to xi. No queue and no coalescing either: the
 * turn lease is the concurrency control, redundant invocations bounce off it, and the
 * survivor's window read sees everything. At boot main invokes with no trigger; from then on
 * **the loop is the log** — a turn's own writes are the next wake, and they land atomically
 * with its lease release (§2), so the cycle never depends on anything main remembers.
 *
 * That's one delivery per readable event per agent, and only what passes `relevant` costs
 * anything — both filters are pure predicates over one row, exactly what the DB tier splits
 * into RLS + a trigger's `WHEN` clause to skip the invocation itself (§9). Where the WORK is
 * decided never moves: it is always a log query, in xi.
 *
 * The one thing main keeps is `outstanding`: the in-flight invocations, so `stop()` can await
 * them. Lifecycle, not scheduling — teardown closes the log and reaps the exec plane, and
 * neither may happen under a live turn.
 */

import { type AgentConfig, type ExecTool, xi, type XiPorts } from "./xi.ts";
import { type Policy, policyFor, scoped } from "./policy.ts";
import { type Log, openLog } from "./store/log.ts";
import type { ConnectionRow } from "./store/connections.ts";
import { openFileDocs } from "./store/docs.ts";
import { seedDocs } from "./store/seed.ts";
import { anthropicClient, anthropicTransport, metered, type ModelTransport } from "./transport.ts";
import { installExecPlane } from "./exec/bash.ts";
import type { Emit, Event } from "./types.ts";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_TICK_MS,
  ensureOrgConfig,
  type OrgConfig,
  readAgentOverrides,
} from "./config.ts";

export interface MainConfig {
  dir: string; // the org's data root (§9): log/ · credentials/ · system/ · org/ · agents/
  /** One agent per principal. The `Policy` half (readable/writable, §6) never reaches xi:
   *  main lifts it into the agent's scoped log — locally a wrapper, on Postgres a credential.
   *  OMIT to create agents "the framework way": every folder under `agents/` declares one
   *  (a blank folder is a blank agent) — agentId = the folder name, home = `mind:<name>`,
   *  model/effort/maxTokens from the defaults below. */
  principals?: (AgentConfig & Policy)[];
  model?: string; // defaults for folder-declared agents (ignored when `principals` is given)
  effort?: AgentConfig["effort"];
  maxTokens?: number;
  /** The backlog an agent INHERITS when it comes up, in hours (§5); default 24. Read once,
   *  at start: it becomes a fixed floor (`since`), not a distance that follows the clock. */
  backlogHours?: number;
  /** Dev/test seam: connection rows UPSERTED at boot (never deleted — connections are
   *  runtime data, §4: an OAuth callback or pairing flow binds them while the org runs;
   *  `mu connect` is the real writer). */
  connections?: ConnectionRow[];
  apiKey?: string; // default: env ANTHROPIC_API_KEY
  exec?: Record<string, ExecTool>; // default: the filesystem exec plane (bash + binaries, §9)
  onDelta?: Emit; // → the Stream (the CLI attaches here)
  ambient?: () => Promise<string[]>; // env lines when config.exec is supplied (task mode)
  lockTtlMs?: number;
  seed?: boolean; // install the doc cascade at boot (default true; task mode skips it)
  stopTimeoutMs?: number; // cap on how long stop() waits for an in-flight turn (default 5s)
  tickMs?: number; // the clock poke (§2 attention): the digest's metronome (default 60s)
}

export interface Main {
  log: Log; // producers (connections, the CLI) publish here
  stop(): Promise<void>;
}

/** Boot the org: open the substrate, poke every agent, tail the log, fan out. */
export async function start(
  config: MainConfig,
  overrides: { transport?: ModelTransport } = {}, // tests inject a scripted model edge
): Promise<Main> {
  // resolve the data root to ABSOLUTE once: every path that reaches the model (the bash
  // workspace, doc pull paths) must survive a cwd change — MU_DIR is often relative
  await Deno.mkdir(config.dir, { recursive: true });
  const dir = await Deno.realPath(config.dir);
  const log = await openLog(`${dir}/log`);
  const docs = openFileDocs(dir); // the doc cascade lives on the data root itself (§8, §9)
  // the framework way (§9): no explicit principals ⇒ every folder under agents/ IS an agent
  const derived = config.principals === undefined; // …and gets the connections-map policy (§6)
  // the catalog (config.ts): read once, here — main is the only reader, and it funnels the
  // resolved values down the chain. Explicit principals (tests, task mode) skip the files.
  const org = derived ? await ensureOrgConfig(dir) : null;
  const principals: Principal[] = config.principals ??
    await scanAgents(dir, config, org!, Date.now());
  // the registry mirrors what runs (§9): folders + config.jsonc are the source of truth, the
  // table is their projection — it exists because policy derives from rows (RLS later, §6)
  // and the ingest classifier scans the declared handles (email/phone → principal)
  log.syncAgents(principals.map((p) => ({
    agentId: p.agentId,
    home: p.home,
    provider: p.provider,
    model: p.model,
    effort: p.effort,
    email: p.email,
    phone: p.phone,
  })));
  // the mind is a ONE-MEMBER conversation (§6): seeding it as membership is what makes
  // "own mind readable, others' invisible" plain branch-3 policy, no special case
  log.upsertMemberships(principals.map((p) => (
    { service: "local", connection: "agent", conversation: p.home, agentId: p.agentId }
  )));
  if (config.connections) log.upsertConnections(config.connections);
  if (config.seed !== false) {
    for (const agent of principals) await seedDocs(dir, agent.agentId);
  }
  const transport = overrides.transport ?? anthropicTransport(anthropicClient(config.apiKey));
  const plane = config.exec ? null : await installExecPlane(dir);
  const exec = config.exec ?? plane!.exec;
  const ambient = plane?.ambient ?? config.ambient; // per-agent planes arrive with multi-principal

  let stopped = false;
  const agents = principals.map(({ readable, writable, ...agent }) => {
    // the agent's VIEW of the log (§6): reads, writes, and the tail below all go through it.
    // Folder-declared agents get the connections-map policy (live read-through lookups);
    // explicit principals stay allow-all unless they carry their own (tests, task mode).
    const policy = derived ? policyFor(agent.agentId, log) : { readable, writable };
    const slog = scoped(log, policy);
    return {
      config: { ...agent, lockTtlMs: agent.lockTtlMs ?? config.lockTtlMs },
      log: slog,
      ports: {
        log: slog,
        docs,
        // metered per agent: every model call this agent makes lands in the usage table
        // attributed to it (§2 telemetry) — also the seam where per-agent providers plug in
        transport: metered(transport, (row) => log.meter(row), agent.agentId),
        exec,
        onDelta: config.onDelta,
        ambient,
      } satisfies XiPorts,
    };
  });

  // The whole fan-out: each agent tails ITS OWN view of the log — the scoped subscription
  // only delivers what the agent may see (Realtime-on-RLS, §6), and xi's `relevant` keeps
  // the class gate. No poke payload (the invocation IS the poke), no queue (the turn lock
  // is the concurrency control). `outstanding` is lifecycle, not scheduling: teardown must
  // not close the log or reap the exec plane under a live turn.
  const outstanding = new Set<Promise<void>>();
  const invoke = (a: (typeof agents)[number]) => (trigger?: Event) => {
    if (stopped) return; // teardown, not routing — main takes no other decision
    const run = xi(a.config, a.ports, trigger)
      .catch(() => {}) // a failed invocation never affects the next one
      .finally(() => outstanding.delete(run));
    outstanding.add(run);
  };

  const unsubs = agents.map((a) => a.log.subscribe(invoke(a)));
  for (const a of agents) invoke(a)(); // boot: no trigger ⇒ look at whatever the log owes

  // the clock poke (§2 attention): deferred ambient news needs someone to re-ask once the
  // digest comes due, and the log cannot wake on time passing — so the clock is a poke
  // source like the log, a trigger-less invoke on a metronome. Cheap: decide() re-reads
  // one window and mostly answers `ignore`.
  const ticker = setInterval(
    () => agents.forEach((a) => invoke(a)()),
    config.tickMs ?? org?.system.tickMs ?? DEFAULT_TICK_MS,
  );

  return {
    log,
    async stop() {
      stopped = true;
      clearInterval(ticker);
      for (const unsub of unsubs) unsub();
      // Bound the settle. A turn wedged on a hung model connection (e.g. a network
      // outage during shutdown) must not block teardown forever — the exec-plane reap
      // and log.close have to run so no background job or file handle is left behind.
      // The orphaned in-flight turn is swallowed by drive's catch (and, in task
      // mode, killed outright by the process exit that follows).
      await withTimeout(
        Promise.all([...outstanding]),
        config.stopTimeoutMs ?? org?.system.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      );
      await plane?.reap(); // kill any background jobs the agents left running (§9)
      await log.close();
    },
  };
}

/** What runs plus what the registry mirrors: the runtime config, the policy seam, and the
 *  declared facts (`provider` for the transport seam, `email`/`phone` for the classifier). */
type Principal = AgentConfig & Policy & { provider?: string; email?: string; phone?: string };

/** The framework way (§9): every directory under `agents/` declares one agent — a blank
 *  folder is a blank agent, and an optional `config.jsonc` inside it overrides the catalog
 *  key by key (config.ts). agentId = sessionId = the folder name (v0: session ≈ agent, §7),
 *  home = `mind:<name>` — the HOME IS THE MIND SESSION (§4): the main session is the one
 *  with tools, where the agent is steered; the principal talks straight into it (the REPL
 *  needs no identity map — principal name = agent name), and platform DMs alias onto it at
 *  ingest ("principal handle → principal-DM alias", the special wiring).
 *
 *  Resolution, most specific wins: agent config.jsonc → MainConfig (the process: tests) →
 *  org config.jsonc — which always exposes the whole catalog, so nothing falls through. */
async function scanAgents(
  dir: string,
  defaults: Pick<MainConfig, "model" | "effort" | "maxTokens" | "backlogHours" | "lockTtlMs">,
  org: OrgConfig,
  startedAt: number,
): Promise<Principal[]> {
  await Deno.mkdir(`${dir}/agents`, { recursive: true });
  // the backlog is resolved ONCE, into an instant: every agent in this org comes up owing
  // the same stretch of history, and no later read re-decides where that stretch begins
  const hours = defaults.backlogHours ?? org.organization.backlogHours;
  const since = new Date(startedAt - hours * 3_600_000).toISOString();
  const found: Principal[] = [];
  for await (const entry of Deno.readDir(`${dir}/agents`)) {
    if (!entry.isDirectory) continue;
    const overrides = await readAgentOverrides(dir, entry.name);
    const cfg = overrides.agent ?? {};
    const identity = overrides.identity ?? {};
    found.push({
      agentId: entry.name,
      sessionId: entry.name,
      home: `mind:${entry.name}`,
      model: cfg.model ?? defaults.model ?? org.agent.model,
      effort: cfg.effort ?? defaults.effort ?? org.agent.effort ?? undefined,
      maxTokens: cfg.maxTokens ?? defaults.maxTokens ?? org.agent.maxTokens,
      rules: cfg.rules ?? org.agent.rules,
      since,
      timezone: (cfg.timezone ?? org.agent.timezone) || undefined,
      locale: cfg.locale ?? org.agent.locale ?? undefined,
      // attention (§2): the wake policy is the agent's — hot, summoned, or on the digest
      engagedMinutes: cfg.engagedMinutes ?? org.agent.engagedMinutes,
      digestAfterMessages: cfg.digestAfterMessages ?? org.agent.digestAfterMessages,
      digestMinutes: cfg.digestMinutes ?? org.agent.digestMinutes,
      digestQuietMinutes: cfg.digestQuietMinutes ?? org.agent.digestQuietMinutes,
      // null survives the funnel: it means "never quiet", not "unset" (Wake, §2)
      quietHours: cfg.quietHours !== undefined ? cfg.quietHours : org.agent.quietHours,
      // the system half funnels too — org-wide, no per-agent seat (harness machinery)
      lockTtlMs: defaults.lockTtlMs ?? org.system.lockTtlMs,
      windowLimit: org.system.windowLimit,
      retryDelaysMs: org.system.retryDelaysMs,
      compactAt: org.system.compactAt,
      keepRecent: org.system.keepRecent,
      provider: cfg.provider ?? org.agent.provider ?? undefined,
      email: identity.email,
      phone: identity.phone,
    });
  }
  return found.sort((a, b) => a.agentId < b.agentId ? -1 : 1);
}

/** Resolve when `p` settles or `ms` elapses, whichever comes first — and never leave the
 *  timer dangling (an uncleared setTimeout would keep the event loop alive on a clean stop). */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.finally(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
