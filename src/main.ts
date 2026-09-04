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
 *
 * One subscription is not an agent's: the mind-alias mirror (§4), which rides the RAW log
 * because it joins across a boundary the scoped ports hide from each other. It lives here
 * for the same reason the agents do — it needs a log and nothing else, no socket and no
 * credential, so a process of its own would only be a lifetime nobody watches. The
 * connectors are the opposite case and stay outside: an ingest holds a port, a dispatcher
 * holds a token.
 */

import { type AgentConfig, type Decision, relevant, xi, type XiPorts } from "./xi.ts";
import { ownComplex } from "./render.ts";
import { MIND, parseSession, sessionAddress } from "./session.ts";
import { type Policy, policyFor, scoped } from "./policy.ts";
import { type Log, openLog } from "./store/log.ts";
import type { ConnectionRow } from "./store/connections.ts";
import { openFileDocs } from "./store/docs.ts";
import { seedDocs } from "./store/seed.ts";
import { anthropicClient, anthropicTransport, metered, type ModelTransport } from "./transport.ts";
import { type ExecPlane, installExecPlane } from "./exec/bash.ts";
import { openCredentials } from "./store/credentials.ts";
import { createGrantBroker, frontedFor } from "./proxy/grants.ts";
import { openCA } from "./proxy/ca.ts";
import { startProxy } from "./proxy/proxy.ts";
import { createMirror } from "./connect/mirror.ts";
import { createTranscriber } from "./processors.ts";
import { installDoors, type Status } from "./door.ts";
import type { AlarmEvent, Delta, Draft, Event } from "./types.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  findRoot,
  type OrgConfig,
  readConfig,
  STOP_TIMEOUT_MS,
  TICK_MS,
} from "./config.ts";

/** Start the egress proxy — the org's MANDATORY single egress point — and return the env
 *  provider bash issues into every spawn (§9), PER AGENT. HTTPS_PROXY/SSL_CERT_FILE always
 *  ride; the proxy rewrites requests carrying a placeholder and passes everything else
 *  through untouched. Which placeholders ride is the VAULT's say, not this file's: a
 *  credential row that declares `extra.env` (the connect doors write it) is fronted under
 *  that var, and which row fronts which agent is `frontedFor` — the org's, or the agent's
 *  own, never a peer's. So the handle in an agent's pocket names a grant that agent holds,
 *  and the audit line's agent is the caller. */
interface ProxyHandle {
  env: (agentId: string) => Record<string, string>;
  close(): Promise<void>;
}

async function installProxy(dir: string): Promise<ProxyHandle> {
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const ca = await openCA();
  const proxy = startProxy({ ca, broker });
  const base: Record<string, string> = {
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    SSL_CERT_FILE: proxy.caPath,
  };
  const rows = await creds.list("");
  const pockets = new Map<string, Record<string, string>>();
  console.error(`egress proxy on :${proxy.port}`);
  return {
    env: (agentId) => {
      let env = pockets.get(agentId);
      if (!env) {
        env = { ...base };
        const fronted = frontedFor(rows, agentId);
        for (const r of fronted) env[r.extra!.env as string] = broker.issue(r.key, r.agentId);
        if (fronted.length) {
          console.error(`[proxy] ${agentId} fronted: ${fronted.map((r) => r.key).join(", ")}`);
        }
        pockets.set(agentId, env);
      }
      return env;
    },
    async close() {
      await proxy.shutdown();
      await creds.close();
    },
  };
}

export interface MainConfig {
  dir: string; // the org's data root (§9): log/ · system/ · org/ · agents/
  /** One agent per principal. The `Policy` half (readable/writable, §6) never reaches xi:
   *  main lifts it into the agent's scoped log — locally a wrapper, on Postgres a credential.
   *  OMIT to create agents "the framework way": the catalog's `agents` roster declares
   *  them — agentId = the entry's name, the session's conversation = `mind@<name>`,
   *  model/effort/maxTokens from the defaults below. */
  principals?: (AgentConfig & Policy)[];
  /** The resolved catalog (readConfig at the entry point) — the roster and every funneled
   *  knob when `principals` is omitted; ignored when it is given. */
  catalog?: OrgConfig;
  model?: string; // defaults for roster-declared agents (ignored when `principals` is given)
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
  /** Dev/test seam: the shutdown grace (`STOP_TIMEOUT_MS`) — so a test can watch a wedged
   *  turn be abandoned without sitting out the real one. */
  stopTimeoutMs?: number;
  /** How long a world trigger waits for the rest of its burst before the turn runs, in ms
   *  (§2); 0 disables. Default 5s — see the debounce in the fan-out. */
  debounceMs?: number;
}

export interface Main {
  log: Log; // producers (connections, the CLI) publish here
  /** Live door connections — what an attachment-derived lifetime reads (the ephemeral
   *  entry below; `mu start`'s daemon never reads it). */
  attachments(): number;
  stop(): Promise<void>;
}

/** Boot the org: open the substrate, poke every agent, tail the log, fan out. */
export async function start(
  config: MainConfig,
  overrides: { transport?: ModelTransport } = {}, // tests inject a scripted model edge
): Promise<Main> {
  // resolve the data root to ABSOLUTE once: every path that reaches the model (the bash
  // workspace, doc pull paths) must survive a cwd change — the data root is a relative path
  await Deno.mkdir(config.dir, { recursive: true });
  const dir = await Deno.realPath(config.dir);
  const log = await openLog(`${dir}/log`);
  const docs = openFileDocs(dir); // the doc cascade lives on the data root itself (§8, §9)
  // the framework way (§9): no explicit principals ⇒ the catalog's roster IS the org
  const derived = config.principals === undefined; // …and gets the connections-map policy (§6)
  // the catalog: the entry point read the file once (readConfig) and hands main the VALUE —
  // main funnels the resolved values down the chain. Explicit principals (tests) carry
  // their own settings and need no catalog at all.
  const catalog = derived ? config.catalog ?? null : null;
  const principals: Principal[] = config.principals ??
    await compileRoster(dir, config, catalog!, Date.now());
  // config → tables → folders (§9): the declaration compiles into the registry — the table
  // exists because policy derives from rows (RLS later, §6) and the ingest classifier
  // scans the declared handles (email/phone → principal)
  log.syncAgents(principals.map((p) => ({
    agentId: p.agentId,
    mind: sessionAddress(p.agentId, MIND),
    provider: p.provider,
    model: p.model,
    effort: p.effort,
    email: p.email,
    phone: p.phone,
  })));
  // the mind is a ONE-MEMBER conversation (§6): seeding it as membership is what makes
  // "own mind readable, others' invisible" plain branch-3 policy, no special case
  log.upsertMemberships(principals.map((p) => (
    {
      service: "local",
      connection: "agent",
      conversation: sessionAddress(p.agentId, MIND),
      agentId: p.agentId,
      sessionId: MIND,
    }
  )));
  if (config.connections) log.upsertConnections(config.connections);
  for (const agent of principals) await seedDocs(dir, agent.agentId);
  const transport = overrides.transport ?? anthropicTransport(anthropicClient(config.apiKey));
  // the egress proxy (§9): front every credential row that declares an env var — user space
  // gets the placeholder + proxy env, never a real credential (see installProxy).
  const proxy = await installProxy(dir);
  // ONE PLANE PER AGENT: the shell is the agent's, not the org's — its cwd IS `agents/<id>`,
  // the folder that already holds its docs and memories, and its background jobs are reaped
  // with it. The binaries on PATH stay org-wide; what is private is the cwd and the job set.
  const planes = new Map<string, ExecPlane>();
  // the org's language reaches user space as MU_LOCALE — the same name the processors get
  // (§9), so a script the agent runs by hand speaks the org's language too
  const locale = catalog?.org.locale;
  for (const p of principals) {
    const userEnv = () => ({ ...proxy.env(p.agentId), ...(locale ? { MU_LOCALE: locale } : {}) });
    planes.set(
      p.agentId,
      await installExecPlane(dir, p.agentId, userEnv, catalog?.system.bashTimeoutMs),
    );
  }
  // what an agent may ATTACH (§9 data classification): its own folder, the shared floor,
  // the system docs, and the media store — the same ground its uid can read. A `send`
  // naming a path elsewhere is refused broker-side, before any byte is read.
  const filesOf = (agentId: string) => {
    const home = `${dir}/agents/${agentId}`;
    return { home, roots: [home, `${dir}/org`, `${dir}/system`, `${dir}/conversations`] };
  };

  let stopped = false;
  // the fan-outs' late half: ports close over `cast`/`castStatus` before the doors exist,
  // and the doors — which know who is tailing — take them over once they are up
  let cast: (agentId: string, sessionId: string, delta: Delta) => void = () => {};
  let castStatus: (agentId: string, sessionId: string, line: Status) => void = () => {};
  // the status push is EDGE-triggered (§2): one line per change of what the daemon would
  // say — per SESSION, so siblings' edges never collide — and a quiet org tails quietly:
  // the ticker's steady `ignore`s all collapse here
  const reported = new Map<string, string>();
  const disclose = (
    agentId: string,
    sessionId: string,
    verdict: Decision,
    cursor: string | undefined,
  ) => {
    const line: Status = verdict === "ignore"
      ? { status: "idle", ...(cursor !== undefined ? { after: cursor } : {}) }
      : { status: "busy" };
    const who = sessionAddress(agentId, sessionId);
    const key = line.status + (line.after ?? "");
    if (reported.get(who) === key) return;
    reported.set(who, key);
    castStatus(agentId, sessionId, line);
  };
  const agents = principals.map(({ readable, writable, ...agent }) => {
    // the agent's VIEW of the log (§6): reads, writes, and the tail below all go through it.
    // Folder-declared agents get the connections-map policy (live read-through lookups);
    // explicit principals stay allow-all unless they carry their own (tests).
    const policy = derived
      ? policyFor({ agentId: agent.agentId, id: agent.sessionId }, log)
      : { readable, writable };
    const slog = scoped(log, policy);
    return {
      config: agent,
      log: slog,
      ports: {
        log: slog,
        docs,
        // metered per agent: every model call this agent makes lands in the usage table
        // attributed to it (§2 telemetry) — also the seam where per-agent providers plug in
        transport: metered(transport, (row) => log.meter(row), agent.agentId),
        exec: planes.get(agent.agentId)!.exec,
        files: filesOf(agent.agentId),
        onDelta: (d) => cast(agent.agentId, agent.sessionId, d),
        onDecision: (v, cursor) => disclose(agent.agentId, agent.sessionId, v, cursor),
        ambient: planes.get(agent.agentId)!.ambient,
      } satisfies XiPorts,
    };
  });

  // The whole fan-out: each agent tails ITS OWN view of the log — the scoped subscription
  // only delivers what the agent may see (Realtime-on-RLS, §6), and xi's `relevant` keeps
  // the class gate. No poke payload (the invocation IS the poke), no queue (the turn lock
  // is the concurrency control). `outstanding` is lifecycle, not scheduling: teardown must
  // not close the log or reap the exec plane under a live turn.
  const outstanding = new Set<Promise<unknown>>();
  const invoke = (a: { config: AgentConfig; ports: XiPorts }) => (trigger?: Event) => {
    if (stopped) return; // teardown, not routing — main takes no other decision
    const run = xi(a.config, a.ports, trigger)
      // a failed invocation never affects the next one — but it is SAID: a swallowed throw
      // reads as a healthy agent that chose silence
      .catch((err) => console.error(`${a.config.agentId} invocation failed:`, err))
      .finally(() => outstanding.delete(run));
    outstanding.add(run);
  };

  // The debounce (§2): people type the way they talk — three lines two seconds apart are one
  // thing said, and a turn per line reads the first two without their point and pays a full
  // window each time. So a world trigger arms a timer instead of a turn, and the rest of the
  // burst joins it; the turn that finally runs sees the whole thought. The trigger itself is
  // dropped, not queued (the invocation IS the poke): what the turn reads is the window, and
  // by then it holds every message that landed while the timer ran.
  //
  // ONE timer per agent, not one per conversation, because a timer wakes the AGENT, not the
  // conversation that armed it: it fires trigger-less and the invoke reads the whole window.
  // So the earliest pending timer already sweeps every room, and a second timer could only
  // add wakes — never give a burst a longer window than the first one leaves it. Which is
  // the honest limit here: this bounds how long a burst may WAIT, not how little.
  //
  // Only world triggers wait. A trigger-less poke (boot, the clock) has no burst to wait for,
  // and the agent's own writes are how a turn CHAINS to the next one — delaying those would
  // put the debounce between every step of a single piece of work.
  const debounceMs = config.debounceMs ?? catalog?.system.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const settling = new Map<string, number>();
  const wake = (a: (typeof agents)[number]) => {
    const fire = invoke(a);
    return (trigger?: Event) => {
      const own = trigger !== undefined &&
        ownComplex(trigger, { agentId: a.config.agentId, id: a.config.sessionId });
      // the class gate, run here too: an irrelevant event must not even arm a timer, or
      // main would turn xi's free exit into a window read on a metronome
      if (!trigger || own || debounceMs <= 0 || !relevant(a.config, trigger)) return fire(trigger);
      if (settling.has(a.config.agentId)) return; // its burst already has a timer
      settling.set(
        a.config.agentId,
        setTimeout(() => {
          settling.delete(a.config.agentId);
          fire();
        }, debounceMs),
      );
    };
  };

  // NAMED sessions (§4): reactive — no standing subscription and no registry. The
  // trigger's own address names the session to invoke (its room, or a dm: it is an end
  // of), so main builds a runner on first contact and a quiet session costs nothing.
  // Bursts bounce off the session's own turn lease; the mind's ladder never applies.
  const named = new Map<string, { config: AgentConfig; ports: XiPorts; log: Log }>();
  const runnerOf = (agentId: string, sessionId: string) => {
    const key = sessionAddress(agentId, sessionId);
    const hit = named.get(key);
    if (hit) return hit;
    const base = agents.find((a) => a.config.agentId === agentId);
    if (!base) return undefined; // an address wearing a name the roster doesn't
    // born when first named (§4): the session's own room is a one-member conversation,
    // and this enrollment is what lets its closing messages land there (WITH CHECK)
    log.upsertMemberships([
      { service: "local", connection: "agent", conversation: key, agentId, sessionId },
    ]);
    const slog = scoped(log, policyFor({ agentId, id: sessionId }, log));
    // the identity is shared (§4): one exec plane, one metered transport, one home —
    // only the log view, the lease, and the stream are the session's
    const r = {
      config: { ...base.config, sessionId },
      log: slog,
      ports: {
        log: slog,
        docs,
        transport: base.ports.transport,
        exec: base.ports.exec,
        files: base.ports.files,
        onDelta: (d: Delta) => cast(agentId, sessionId, d),
        onDecision: (v: Decision, cursor: string | undefined) =>
          disclose(agentId, sessionId, v, cursor),
        ambient: base.ports.ambient,
      } satisfies XiPorts,
    };
    named.set(key, r);
    return r;
  };

  // the door (§9): a script's syscalls, as gated tool_use events in the caller's name. The
  // one boundary piece that HOLDS something in main — the sockets ARE the boundary; each
  // serves its agent's scoped ports, so even the door writes under §6 visibility. A
  // request that names a session speaks through THAT session's port — asking for one is
  // what births it.
  const doors = await installDoors(
    dir,
    agents.map((a) => ({
      agentId: a.config.agentId,
      sessionId: a.config.sessionId,
      port: (sessionId: string) =>
        sessionId === a.config.sessionId ? a.log : runnerOf(a.config.agentId, sessionId)!.log,
    })),
  );
  cast = (agentId, sessionId, delta) => doors.emit(agentId, sessionId, delta);
  castStatus = (agentId, sessionId, line) => doors.status(agentId, sessionId, line);

  const unsubs = agents.map((a) => a.log.subscribe(wake(a)));
  /** The named sessions an event's address names — its own room, or the dm: ends. */
  const namedIn = (e: Event): { agentId: string; sessionId: string }[] => {
    const address = e.envelope.conversation.address;
    if (e.envelope.service !== "local") return [];
    const parts = address.startsWith("dm:") ? address.slice(3).split(":") : [address];
    return parts.map(parseSession)
      .filter((p): p is { agentId: string; sessionId: string } => p !== null)
      .filter((p) => p.sessionId !== MIND); // the minds tail their own scoped views
  };
  unsubs.push(log.subscribe((e) => {
    for (const p of namedIn(e)) {
      const r = runnerOf(p.agentId, p.sessionId);
      if (r) invoke(r)(e);
    }
  }));
  // the mirror rides the RAW log (§4): it copies between a mind and its alias surfaces, and
  // an agent's own alias conversation is invisible to that agent's scoped port (§6) — the
  // join has to happen where visibility isn't filtered. Inert until a surface is bound, so
  // it costs nothing in an org that has none.
  unsubs.push(createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onError: (e, err) => console.error(`mirror FAILED on ${e.envelope.conversation.address}:`, err),
  }));
  // the transcriber rides the RAW log too (§5): connector-neutral — an audio message is an
  // audio message whatever surface it landed on, including alias conversations the scoped
  // ports hide. Inert unless the org configured an audio processor.
  if (catalog?.processors.audio) {
    unsubs.push(createTranscriber({
      subscribe: (l, o) => log.subscribe(l, o),
      publish: log.publish,
      command: catalog.processors.audio,
      locale: catalog.org.locale,
      onError: (e, err) =>
        console.error(`transcriber FAILED on ${e.envelope.conversation.address}:`, err),
    }));
  }
  for (const a of agents) invoke(a)(); // boot: no trigger ⇒ look at whatever the log owes
  // …and every enrolled named session gets the same look (§4): the backlog rule applies
  // to it as to the mind, and its enrollments are the only record it leaves
  for (const p of log.enrolled()) {
    if (p.sessionId === MIND) continue; // the roster's own runners just looked
    const r = runnerOf(p.agentId, p.sessionId);
    if (r) invoke(r)();
  }

  // The scheduler's half of the clock (§10): a timer row whose moment has come becomes an
  // `alarm` carrying its note, and the alarm's own fan-out is the wake — no direct invoke,
  // so a scheduled wake reaches the agent by exactly the path everything else does. Firing
  // is idempotent-ish by construction: `settle` consumes the row in the same pass (one-shot
  // ⇒ gone, cron ⇒ advanced past now), so a long outage fires each cron once, late.
  // Due wakes → alarms (§10). The alarm lands in the conversation the arming session
  // speaks in, and says where it came from: `ref_id` the `schedule` call, `extra.timer` the
  // row — a note read cold leads back to the moment it was written, and a repeating one
  // says so. Firing consumes the row in the same pass (`settle`).
  // One sweep at a time: a tick that lands while a pass is still publishing joins that
  // pass instead of opening a second. Across processes the same guarantee is `claim`'s —
  // the scan lists, the claim wins, and only what this sweep won gets an alarm.
  let sweep: Promise<void> | undefined;
  const fireDue = (): Promise<void> =>
    sweep ??= (async () => {
      const now = new Date().toISOString();
      for (const due of log.due(now)) {
        const t = log.claim(due.id, now);
        if (!t) continue; // another sweep fired it
        await log.publish(
          {
            ts: now,
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
                ...(t.armedAt ? { armed_at: t.armedAt } : {}),
              },
            },
            parts: [{ type: "text", kind: "alarm", text: t.note }],
          } satisfies Draft<AlarmEvent>,
        );
        // a cron advances on the clock it was armed against — the agent's zone, not UTC
        log.settle(t.id, now, agents.find((a) => a.config.agentId === t.agentId)?.config.timezone);
      }
    })().finally(() => sweep = undefined);

  // the clock poke (§2 attention): deferred ambient news needs someone to re-ask once the
  // digest comes due, and the log cannot wake on time passing — so the clock is a poke
  // source like the log, a trigger-less invoke on a metronome. Cheap: decide() re-reads
  // one window and mostly answers `ignore`. A constant, not a knob: it is the resolution
  // of the attention intervals, not one of them.
  const ticker = setInterval(() => {
    fireDue().catch((err) => console.error("firing scheduled wakes failed:", err));
    agents.forEach((a) => invoke(a)());
  }, TICK_MS);

  return {
    log,
    attachments: () => doors.attachments(),
    async stop() {
      stopped = true;
      clearInterval(ticker);
      for (const t of settling.values()) clearTimeout(t); // a burst still settling: drop it
      settling.clear();
      for (const unsub of unsubs) unsub();
      await doors.close(); // stop taking syscalls before the log goes away
      // Bound the settle. A turn wedged on a hung model connection (e.g. a network
      // outage during shutdown) must not block teardown forever — the exec-plane reap
      // and log.close have to run so no background job or file handle is left behind.
      // The orphaned in-flight turn is swallowed by drive's catch (and, in task
      // mode, killed outright by the process exit that follows).
      await withTimeout(
        Promise.all([...outstanding]),
        config.stopTimeoutMs ?? STOP_TIMEOUT_MS,
      );
      // each agent's own jobs, reaped with its own plane (§9)
      for (const plane of planes.values()) await plane.reap();
      await proxy?.close(); // stop the egress proxy and close its vault handle
      await log.close();
    },
  };
}

/** What runs plus what the registry mirrors: the runtime config, the policy seam, and the
 *  declared facts (`provider` for the transport seam, `email`/`phone` for the classifier). */
type Principal = AgentConfig & Policy & { provider?: string; email?: string; phone?: string };

/** The framework way (§9): the catalog's `agents` roster declares the org — each entry
 *  becomes a registry row and a home folder, config → tables → folders. agentId = the
 *  entry's name, sessionId = `mind` (the pair is the identity, §4), the session's
 *  conversation = `mind@<name>`: the mind session is the one world traffic routes to,
 *  where the agent is steered; the principal talks straight into it (the REPL needs no
 *  identity map — principal name = agent name), and platform DMs alias onto it at ingest
 *  ("principal handle → principal-DM alias", the special wiring).
 *
 *  Resolution, most specific wins: agents.<name> → MainConfig (the process: tests) →
 *  org.agent — every key has a default, so nothing falls through. The clock and locale
 *  are the ORG's alone: one deployment, one wall time. */
async function compileRoster(
  dir: string,
  defaults: Pick<MainConfig, "model" | "effort" | "maxTokens" | "backlogHours">,
  catalog: OrgConfig,
  startedAt: number,
): Promise<Principal[]> {
  // the backlog is resolved ONCE, into an instant: every agent in this org comes up owing
  // the same stretch of history, and no later read re-decides where that stretch begins
  const hours = defaults.backlogHours ?? catalog.org.backlogHours;
  const since = new Date(startedAt - hours * 3_600_000).toISOString();
  const org = catalog.org.agent;
  const found: Principal[] = [];
  for (const [name, entry] of Object.entries(catalog.agents)) {
    await Deno.mkdir(`${dir}/agents/${name}`, { recursive: true }); // the home is derived
    const { identity = {}, ...cfg } = entry;
    found.push({
      agentId: name,
      sessionId: MIND,
      model: cfg.model ?? defaults.model ?? org.model,
      effort: cfg.effort ?? defaults.effort ?? org.effort ?? undefined,
      maxTokens: cfg.maxTokens ?? defaults.maxTokens ?? org.maxTokens,
      // null survives the funnel: it means "every tool", not "unset"
      tools: (cfg.tools !== undefined ? cfg.tools : org.tools) ?? undefined,
      rules: cfg.rules ?? org.rules,
      since,
      timezone: catalog.org.timezone || undefined,
      locale: catalog.org.locale ?? undefined,
      // attention (§2): the wake policy is the agent's — hot, summoned, or on the digest
      engagedMinutes: cfg.engagedMinutes ?? org.engagedMinutes,
      digestAfterMessages: cfg.digestAfterMessages ?? org.digestAfterMessages,
      digestMinutes: cfg.digestMinutes ?? org.digestMinutes,
      // null survives the funnel: it means "never sleeps", not "unset" (Wake, §2)
      sleepHours: cfg.sleepHours !== undefined ? cfg.sleepHours : org.sleepHours,
      // the system half funnels too — org-wide, no per-agent seat (harness machinery)
      windowLimit: catalog.system.windowLimit,
      compactAt: catalog.system.compactAt,
      keepRecent: catalog.system.keepRecent,
      provider: cfg.provider ?? org.provider ?? undefined,
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

/** An interface-raised daemon reaps itself after this long with nothing attached — long
 *  enough that consecutive `mu cli` runs reuse one org instead of re-paying seeding,
 *  the exec planes and the proxy each time. */
const LINGER_MS = 30_000;
const REAP_POLL_MS = 1_000;

// Headless entry: the deployment's main. `mu start` spawns it bare; an attach client
// (the REPL) that found no daemon spawns it with `--ephemeral`, and that daemon's life
// is its ATTACHMENTS: the count is the door's live connections, so a killed interface
// and a clean quit are the same hang-up, and zero held for the linger means nobody is
// coming back — stop and exit. A bare daemon never reads the count.
if (import.meta.main) {
  const root = findRoot();
  const dir = `${root}/data`;
  const catalog = await readConfig(root);
  const main = await start({ dir, catalog });
  console.error(`agents: ${Object.keys(catalog.agents).join(", ")} · log: ${dir}/log`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sig, () => {
      main.stop().finally(() => Deno.exit(0));
    });
  }
  if (Deno.args.includes("--ephemeral")) {
    let occupied = Date.now(); // boot counts as occupied: the raiser gets the linger to arrive
    const reaper = setInterval(() => {
      if (main.attachments() > 0) occupied = Date.now();
      else if (Date.now() - occupied >= LINGER_MS) {
        clearInterval(reaper);
        main.stop().finally(() => Deno.exit(0));
      }
    }, REAP_POLL_MS);
  }
}
