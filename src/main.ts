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
import { MIND, sessionAddress } from "./session.ts";
import { historyFor, type Policy, policyFor, scoped } from "./policy.ts";
import { type Log, openLog } from "./store/log.ts";
import { type ClockSettings, tick } from "./tick.ts";
import { enroll, route } from "./route.ts";
import type { ConnectionRow } from "./store/connections.ts";
import type { AgentRow } from "./store/agents.ts";
import { openFileDocs } from "./store/docs.ts";
import { seedAgent, seedOrg } from "./store/seed.ts";
import {
  checkProvider,
  metered,
  type ModelTransport,
  providerOf,
  transports,
} from "./transport/mod.ts";
import { type ExecGround, type ExecPlane, installExecGround } from "./exec/bash.ts";
import { whatsappContact } from "./connect/whatsapp/contact.ts";
import { DEFAULT_BRIDGE_URL } from "./connect/whatsapp/config.ts";
import { entry } from "./entry.ts";
import { claim, MAIN } from "./stop.ts";
import { openCredentials } from "./store/credentials.ts";
import { createGrantBroker, frontedFor, hostAllowed } from "./proxy/grants.ts";
import { openCA } from "./proxy/ca.ts";
import { startProxy } from "./proxy/proxy.ts";
import { createMirror } from "./connect/mirror.ts";
import { createPresence } from "./connect/presence.ts";
import { createTranscriber } from "./processors.ts";
import { type DoorAgent, installDoors, type Status, type Tune } from "./door.ts";
import { loadMediaBlock, memoizedLoader } from "./store/media.ts";
import type { About, Delta, Effort, Event } from "./types.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  findRoot,
  type OrgConfig,
  orgFlag,
  readConfig,
  STOP_TIMEOUT_MS,
  TICK_MS,
} from "./config.ts";

/** Start the egress proxy — the org's single credential-bearing egress — and return the
 *  env provider bash issues into every spawn (§9), PER AGENT. HTTPS_PROXY always rides;
 *  the proxy terminates only the authorities a fronted grant binds (where a placeholder
 *  can ride and the swap has to see plaintext) and bridges every other tunnel blind, so
 *  the world answers with its own certificates. The trust file user space is handed is
 *  the system bundle plus the liquen CA, under every name the common clients read it by:
 *  a tool verifying against its own roots still reaches the world, and one honoring the
 *  file reaches the fronted hosts too. Which placeholders ride is the VAULT's say, not
 *  this file's: a credential row that declares `extra.env` (the connect doors write it)
 *  is fronted under that var, and which row fronts which agent is `frontedFor` — the
 *  org's, or the agent's own, never a peer's. So the handle in an agent's pocket names
 *  a grant that agent holds, and the audit line's agent is the caller. */
interface ProxyHandle {
  env: (agentId: string) => Record<string, string>;
  close(): Promise<void>;
}

// where a Linux system keeps its CA bundle, by distribution; the first that exists is it
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/** The trust file user space is handed: the system's roots followed by the liquen CA, written
 *  under the org at boot. It replaces the roots of every tool that reads it, so a machine
 *  with no system bundle refuses to start: the liquen CA alone would leave curl, git and
 *  python trusting nothing but the fronted hosts. */
async function writeTrustBundle(dir: string, caPath: string): Promise<string> {
  let system = "";
  for (const path of SYSTEM_CA_BUNDLES) {
    try {
      system = await Deno.readTextFile(path);
      break;
    } catch { /* not this distribution */ }
  }
  if (!system) {
    throw new Error(
      `no system CA bundle at ${SYSTEM_CA_BUNDLES.join(", ")}: the agents' tools would trust ` +
        `nothing but the fronted hosts. Install ca-certificates.`,
    );
  }
  const out = `${dir}/system/ca-bundle.pem`;
  await Deno.mkdir(`${dir}/system`, { recursive: true });
  await Deno.writeTextFile(out, `${system.trimEnd()}\n${await Deno.readTextFile(caPath)}`);
  return out;
}

async function installProxy(dir: string): Promise<ProxyHandle> {
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const ca = await openCA(dir);
  const rows = await creds.list("");
  const fronted = rows.filter((r) => typeof r.extra?.env === "string");
  const proxy = startProxy({
    ca,
    broker,
    terminates: (authority) => fronted.some((r) => hostAllowed(r.extra?.hosts, authority)),
  });
  const bundle = await writeTrustBundle(dir, proxy.caPath);
  const base: Record<string, string> = {
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    SSL_CERT_FILE: bundle, // OpenSSL-based tools: curl, git, wget, Go
    REQUESTS_CA_BUNDLE: bundle, // python requests, and pip through it
    PIP_CERT: bundle,
    NODE_EXTRA_CA_CERTS: proxy.caPath, // node adds to its own roots — the CA alone suffices
    DENO_CERT: proxy.caPath, // so does deno
  };
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
  /** One agent per principal. The `Policy` half (using/check, §6) never reaches xi:
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
   *  `liquen connect` is the real writer). */
  connections?: ConnectionRow[];
  apiKey?: string; // Anthropic; default: env ANTHROPIC_API_KEY (Google reads GEMINI_API_KEY)
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
   *  entry below; `liquen start`'s daemon never reads it). */
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
  // the media port (§5): the file adapter, remembered across every agent this process renders
  const media = memoizedLoader(loadMediaBlock);
  // the framework way (§9): no explicit principals ⇒ the catalog's roster IS the org
  const derived = config.principals === undefined; // …and gets the connections-map policy (§6)
  // the catalog: the entry point read the file once (readConfig) and hands main the VALUE —
  // main funnels the resolved values down the chain. Explicit principals (tests) carry
  // their own settings and need no catalog at all.
  const catalog = derived ? config.catalog ?? null : null;
  // config → tables → folders (§9): the declaration compiles into the registry — the table
  // exists because policy derives from rows (RLS later, §6), the ingest classifier scans
  // the declared handles (email/phone → member), and render names members by it (§5).
  // Every entry is a row, a person alone included: they steer, they are named, no session
  // of theirs ever runs (`mind: false`, §4). Explicit principals (tests) compile the same
  // way, from what they carry.
  await log.syncAgents(
    derived
      ? await compileRoster(dir, config, catalog!, Date.now())
      : config.principals!.map(rowOf),
  );
  // an agent IS its row (§9): what runs is built from the table, so a host with nothing
  // but the store rebuilds the same agent. What a caller passes in code rides beside it —
  // a policy, a compiled gate, a retry pace: seams, and no row carries a function.
  const inCode = new Map((config.principals ?? []).map((p) => [p.agentId, p]));
  const roster: Principal[] = (await log.agents()).map((row) => {
    const p = inCode.get(row.agentId);
    return {
      ...configOf(row, dir),
      ...(p?.using ? { using: p.using } : {}),
      ...(p?.check ? { check: p.check } : {}),
      ...(p?.gate ? { gate: p.gate } : {}),
      ...(p?.retryDelaysMs ? { retryDelaysMs: p.retryDelaysMs } : {}),
    };
  });
  const principals = roster.filter((p) => p.runs !== false);
  // the provider can run the model at the effort declared (§9): refused here, not mid-turn
  for (const p of principals) checkProvider(p);
  // the mind is a ONE-MEMBER conversation (§6): seeding it as membership is what makes
  // "own mind readable, others' invisible" plain branch-3 policy, no special case. EVERY
  // roster entry has the room — a paused agent's is what its door still reads (§4)
  await log.upsertMemberships(roster.map((p) => (
    {
      service: "local",
      connection: "agent",
      conversation: sessionAddress(p.agentId, MIND),
      agentId: p.agentId,
      sessionId: MIND,
    }
  )));
  if (config.connections) await log.upsertConnections(config.connections);
  // the doors lay these when they declare; boot lays them for a roster entry typed by hand
  await seedOrg(dir);
  for (const agent of principals) if (agent.runs !== false) await seedAgent(dir, agent.agentId);
  // one transport per provider, shared by every agent declared on it; a test's scripted
  // edge stands in for all of them
  const transportOf = transports({ anthropic: config.apiKey });
  const transportFor = (p: Principal): ModelTransport =>
    overrides.transport ?? transportOf(providerOf(p.provider));
  // the egress proxy (§9): front every credential row that declares an env var — user space
  // gets the placeholder + proxy env, never a real credential (see installProxy).
  const proxy = await installProxy(dir);
  // ONE GROUND PER AGENT, ONE SHELL PER SESSION (§9): the ground is the agent's folder —
  // `agents/<id>`, where its docs and memories already are — with the org's binaries on
  // PATH; the shell on it is the session's, so where one session stands and what it left
  // running is never another's. Shells open on first contact and are reaped at teardown.
  // the address book (§9): one port per service that keeps one, wired where the connection
  // is declared — whatsapp's rides the bridge the dispatcher already talks to, on the same
  // token, and carries both legs: `contact` writes through it, `search` reads through it
  const bridge = config.catalog?.connections?.whatsapp;
  const contact: XiPorts["contact"] = bridge
    ? {
      whatsapp: whatsappContact(
        typeof bridge.bridgeUrl === "string" ? bridge.bridgeUrl : DEFAULT_BRIDGE_URL,
        Deno.env.get("WA_BRIDGE_TOKEN") ?? "",
      ),
    }
    : undefined;
  const grounds = new Map<string, ExecGround>();
  const shells = new Map<string, ExecPlane>();
  const shellOf = (agentId: string, sessionId: string): ExecPlane => {
    const key = sessionAddress(agentId, sessionId);
    let shell = shells.get(key);
    if (!shell) {
      shell = grounds.get(agentId)!.shell();
      shells.set(key, shell);
    }
    return shell;
  };
  // the org's locale reaches user space under the names every program reads (§9): the
  // shell speaks the org's language, and a script the agent runs by hand does too
  const locale = catalog?.organization.locale;
  const localeEnv: Record<string, string> = locale ? { LANG: locale } : {};
  for (const p of principals) {
    const userEnv = () => ({ ...proxy.env(p.agentId), ...localeEnv });
    grounds.set(
      p.agentId,
      await installExecGround(dir, p.agentId, userEnv, catalog?.system.bashTimeoutMs),
    );
  }
  // what an agent may ATTACH (§9 data classification): its own folder, the shared floor,
  // the system docs, and the media store — the same ground its uid can read. A `send`
  // naming a path elsewhere is refused broker-side, before any byte is read.
  const filesOf = (agentId: string) => {
    const home = `${dir}/agents/${agentId}`;
    return { home, roots: [home, `${dir}/organization`, `${dir}/system`, `${dir}/conversations`] };
  };

  let stopped = false;
  // the fan-outs' late half: ports close over `cast`/`castStatus` before the doors exist,
  // and the doors — which know who is tailing — take them over once they are up
  let cast: (agentId: string, sessionId: string, delta: Delta) => void = () => {};
  let castStatus: (
    agentId: string,
    sessionId: string,
    line: Status,
    about: About[],
  ) => void = () => {};
  // the status push is EDGE-triggered (§2): one line per change of what the daemon would
  // say — per SESSION, so siblings' edges never collide — and a quiet org tails quietly:
  // the ticker's steady `ignore`s all collapse here
  const reported = new Map<string, string>();
  const disclose = (
    agentId: string,
    sessionId: string,
    verdict: Decision,
    cursor: string | undefined,
    about: About[] = [],
  ) => {
    const line: Status = verdict === "ignore"
      ? { status: "idle", ...(cursor !== undefined ? { after: cursor } : {}) }
      : { status: "busy" };
    const who = sessionAddress(agentId, sessionId);
    const key = line.status + (line.after ?? "");
    if (reported.get(who) === key) return;
    reported.set(who, key);
    castStatus(agentId, sessionId, line, about);
  };
  // metered per agent: every model call this agent makes lands in the usage table
  // attributed to it (§2 telemetry) — also the seam where per-agent providers plug in.
  // The roster's transport is the STOCK one: what every session of the agent thinks
  // through unless an attachment asks for another (`tune`, below)
  const meter = (agentId: string, t: ModelTransport) =>
    metered(
      t,
      (row) => void log.meter(row).catch((err) => console.error("metering failed:", err)),
      agentId,
    );
  const stock = new Map(principals.map((p) => [p.agentId, meter(p.agentId, transportFor(p))]));
  // the runner (§4): what a session of an agent runs with. The identity is shared — one
  // ground, one metered transport, one home, one address book, one history — and the log
  // view, the lease, the stream and the shell (where it stands, what it left running) are
  // the session's. Built once per session and kept: an attachment's `tune` writes into it,
  // and the next invocation reads what it wrote.
  const portsFor = (p: Principal, sessionId: string) => {
    const { using, check, ...agent } = p;
    const { agentId } = agent;
    // the session's VIEW of the log (§6): reads, writes, and the tail all go through it.
    // A folder-declared org's policy is the connections map (live read-through lookups),
    // and a named session's always is; an explicit principal's mind carries its own (tests)
    const policy = derived || sessionId !== MIND
      ? policyFor({ agentId, id: sessionId })
      : { using, check };
    const slog = scoped(log, policy);
    const shell = shellOf(agentId, sessionId);
    return {
      config: { ...agent, sessionId },
      log: slog,
      ports: {
        log: slog,
        // the agent's history (§6): what `search` reads, from any of its sessions — the
        // same map, keyed on the agent. Explicit principals search their own view
        ...(derived ? { history: scoped(log, historyFor(agentId)) } : {}),
        docs,
        transport: stock.get(agentId)!,
        exec: shell.exec,
        ...(contact ? { contact } : {}),
        files: filesOf(agentId),
        media,
        onDelta: (d: Delta) => cast(agentId, sessionId, d),
        onDecision: (v: Decision, cursor: string | undefined, about: About[]) =>
          disclose(agentId, sessionId, v, cursor, about),
        ambient: shell.ambient,
      } satisfies XiPorts,
    };
  };
  const agents = principals.map((p) => portsFor(p, MIND));

  // The whole fan-out: each agent tails ITS OWN view of the log — the scoped subscription
  // only delivers what the agent may see (Realtime-on-RLS, §6), and xi's `relevant` keeps
  // the class gate. No poke payload (the invocation IS the poke), no queue (the turn lock
  // is the concurrency control). `outstanding` is lifecycle, not scheduling: teardown must
  // not close the log or reap the exec plane under a live turn.
  const outstanding = new Set<Promise<unknown>>();
  // A wake that finds the session's lease held exits on the word that the holder's end will
  // poke — a word only a publishing end keeps: an `ignore` verdict releases without
  // publishing, and the row that landed between the holder's read and its release would
  // wake nothing until the clock. So a held wake whose holder is one of OUR invocations is
  // owed one more, trigger-less, once that invocation settles: the window is read whole
  // then, so one re-poke answers for every wake held during the turn. A holder in another
  // process is not waited on (its end pokes, or the tick does).
  const inflight = new Map<string, Set<Promise<unknown>>>();
  const owed = new Set<string>();
  const invoke = (a: { config: AgentConfig; ports: XiPorts }) => {
    const key = sessionAddress(a.config.agentId, a.config.sessionId);
    const fire = (trigger?: Event) => {
      if (stopped) return; // teardown, not routing — main takes no other decision
      const mine = inflight.get(key) ?? new Set<Promise<unknown>>();
      inflight.set(key, mine);
      const run = xi(a.config, a.ports, trigger)
        .then((r) => {
          if (r === "held" && mine.size > 1) owed.add(key);
        })
        // a failed invocation never affects the next one — but it is SAID: a swallowed throw
        // reads as a healthy agent that chose silence
        .catch((err) => console.error(`${a.config.agentId} invocation failed:`, err))
        .finally(() => {
          outstanding.delete(run);
          mine.delete(run);
          if (mine.size > 0) return;
          inflight.delete(key);
          if (owed.delete(key)) fire();
        });
      outstanding.add(run);
      mine.add(run);
    };
    return fire;
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
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
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
  const named = new Map<string, ReturnType<typeof portsFor>>();
  const runnerOf = async (agentId: string, sessionId: string) => {
    const key = sessionAddress(agentId, sessionId);
    const hit = named.get(key);
    if (hit) return hit;
    const p = principals.find((x) => x.agentId === agentId);
    if (!p) return undefined; // an address wearing a name the roster doesn't
    await enroll(log, { agentId, sessionId });
    const r = portsFor(p, sessionId);
    named.set(key, r);
    return r;
  };

  // what a session thinks with, as an attachment asked (§9): the tail's `model` · `effort`
  // · `provider` hold while the connection lives, and the hang-up (`undefined`) puts the
  // roster's back — the same lifetime the tail's `cwd` has. Checked the way boot checks
  // the roster, so a provider that cannot run the model at that effort refuses the attach,
  // never a turn. The runner's config and transport are read at every invocation, so the
  // next turn thinks with the new ones; a turn already running finishes as it began.
  const tune = async (agentId: string, sessionId: string, t: Tune | undefined) => {
    const p = principals.find((x) => x.agentId === agentId);
    const r = sessionId === MIND
      ? agents.find((a) => a.config.agentId === agentId)
      : await runnerOf(agentId, sessionId);
    if (!p || !r) return;
    const provider = t?.provider ?? p.provider;
    const model = t?.model ?? p.model;
    const effort = t?.effort ?? p.effort;
    checkProvider({ agentId, provider, model, effort });
    r.config.model = model;
    r.config.effort = effort;
    r.ports.transport = provider === p.provider
      ? stock.get(agentId)!
      : meter(agentId, overrides.transport ?? transportOf(providerOf(provider)));
  };

  // the door (§9): a script's syscalls, as gated tool_use events in the caller's name. The
  // one boundary piece that HOLDS something in main — the sockets ARE the boundary; each
  // serves its agent's scoped ports, so even the door writes under §6 visibility. A
  // request that names a session speaks through THAT session's port — asking for one is
  // what births it.
  const doors = await installDoors(
    dir,
    roster.map((p): DoorAgent => {
      const a = agents.find((x) => x.config.agentId === p.agentId);
      if (a) {
        return {
          agentId: a.config.agentId,
          sessionId: a.config.sessionId,
          port: async (sessionId: string) =>
            sessionId === a.config.sessionId
              ? a.log
              : (await runnerOf(a.config.agentId, sessionId))!.log,
          // where the principal stands is where the session's shell starts (§9)
          stand: (session, path) => shellOf(a.config.agentId, session).stand(path),
          tune: (session, settings) => tune(a.config.agentId, session, settings),
        };
      }
      // a PAUSED agent (`mind: false`, §4): the door still opens on its rooms — a tail reads
      // what landed, an order is refused — and no runner, no shell, stands behind it
      return {
        agentId: p.agentId,
        sessionId: p.sessionId,
        paused: true,
        port: (sessionId: string) =>
          Promise.resolve(scoped(
            log,
            derived
              ? policyFor({ agentId: p.agentId, id: sessionId })
              : { using: p.using, check: p.check },
          )),
      };
    }),
  );
  // presence (§9): the same two facts the doors serve, written as a `delta` event in the
  // mind's room — the mirror is what carries it to every surface, tagged. Inert until a
  // surface is bound.
  const presence = createPresence({
    aliases: () => log.aliases(),
    publish: (draft) => log.publish(draft),
    onError: (err) => console.error("presence FAILED:", err),
  });
  cast = (agentId, sessionId, delta) => {
    doors.emit(agentId, sessionId, delta);
    presence.delta(agentId, sessionId, delta);
  };
  castStatus = (agentId, sessionId, line, about) => {
    doors.status(agentId, sessionId, line);
    presence.status(agentId, sessionId, line.status, about);
  };

  const unsubs = agents.map((a) => a.log.subscribe(wake(a)));
  // the named sessions ride the RAW log (§4): reactive, no subscription of their own —
  // the trigger's address names the session to invoke, and main builds its runner on
  // first contact, so a quiet session costs nothing
  unsubs.push(log.subscribe((e) => {
    for (const p of route(e)) {
      runnerOf(p.agentId, p.sessionId)
        .then((r) => r && invoke(r)(e))
        .catch((err) => console.error(`[main] ${p.sessionId}@${p.agentId}:`, err));
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
    nameOf: async (id) => (await log.agents()).find((a) => a.agentId === id)?.name ?? id,
    locale: catalog?.organization.locale,
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
      locale: catalog.organization.locale,
      onError: (e, err) =>
        console.error(`transcriber FAILED on ${e.envelope.conversation.address}:`, err),
    }));
  }
  for (const a of agents) invoke(a)(); // boot: no trigger ⇒ look at whatever the log owes
  // …and every enrolled named session gets the same look (§4): the backlog rule applies
  // to it as to the mind, and its enrollments are the only record it leaves
  for (const p of await log.enrolled()) {
    if (p.sessionId === MIND) continue; // the roster's own runners just looked
    const r = await runnerOf(p.agentId, p.sessionId);
    if (r) invoke(r)();
  }

  // the clock poke (§2 attention): deferred ambient news needs someone to re-ask once the
  // digest comes due, and the log cannot wake on time passing — so the clock is a poke
  // source like the log, a trigger-less invoke on a metronome. Cheap: decide() re-reads
  // one window and mostly answers `ignore`. A constant, not a knob: it is the resolution
  // of the attention intervals, not one of them. The same metronome is the store's clock
  // (`tick`, §10): due wakes become alarms, unanswered asks lapse, failed sends are
  // re-offered — nothing here posts, and where the log is a database with its own clock,
  // that pass is the clock's statement. One beat at a time: a tick that lands while a
  // beat is still publishing joins it instead of opening a second.
  const settingsOf: ClockSettings = (agentId) =>
    agents.find((a) => a.config.agentId === agentId)?.config;
  let beating: Promise<unknown> | undefined;
  const ticker = setInterval(() => {
    beating ??= tick(log, settingsOf)
      .then(
        (beat) => {
          for (const f of beat.failed) console.error(`the tick's ${f.pass} pass failed:`, f.error);
        },
        (err) => console.error("the tick failed:", err),
      )
      .finally(() => beating = undefined);
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
      // each session's own jobs, reaped with its own shell (§9)
      for (const shell of shells.values()) await shell.reap();
      await proxy?.close(); // stop the egress proxy and close its vault handle
      await log.close();
    },
  };
}

/** What runs, as main builds it from the agent's row: the runtime config, the policy
 *  seam, and the row's own facts (`provider` for the transport seam, `runs` for whether a
 *  session runs at all, §4). */
type Principal = AgentConfig & Policy & { provider?: string; runs?: boolean };

/** An explicit principal (tests) as the row it compiles to. What no row carries stays in
 *  code: `home` is the data root's, `gate` and `retryDelaysMs` are a test's. */
function rowOf(p: Principal): AgentRow {
  return {
    agentId: p.agentId,
    mind: sessionAddress(p.agentId, MIND),
    provider: p.provider,
    model: p.model,
    effort: p.effort,
    name: p.name,
    email: p.email,
    phone: p.phone,
    ...(p.runs === false ? { runs: false } : {}),
    settings: {
      maxTokens: p.maxTokens,
      timezone: p.timezone,
      locale: p.locale,
      tools: p.tools,
      rules: p.rules,
      windowLimit: p.windowLimit,
      since: p.since,
      gateHours: p.gateHours,
      engagedMinutes: p.engagedMinutes,
      digestAfterMessages: p.digestAfterMessages,
      digestMinutes: p.digestMinutes,
      sleepHours: p.sleepHours,
      processors: p.processors,
      compactAt: p.compactAt,
      keepRecent: p.keepRecent,
      compactTurnAt: p.compactTurnAt,
    },
  };
}

/** The agent its row describes (§9): the config a session of it runs with, and the row's
 *  own facts. `home` is where this data root keeps the agent's folder. */
function configOf(row: AgentRow, dir: string): Principal {
  if (!row.settings || row.model === undefined) {
    throw new Error(`agent ${row.agentId}: its row carries no settings`);
  }
  return {
    agentId: row.agentId,
    sessionId: MIND,
    model: row.model,
    ...(row.effort ? { effort: row.effort as Effort } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.runs === false ? { runs: false } : {}),
    ...row.settings,
    home: `${dir}/agents/${row.agentId}`,
  };
}

/** The framework way (§9): the catalog's `agents` roster declares the org — each entry
 *  becomes a registry row and a home folder, config → tables → folders. agentId = the
 *  entry's name, sessionId = `mind` (the pair is the identity, §4), the session's
 *  conversation = `mind@<name>`: the mind session is the one world traffic routes to,
 *  where the agent is steered; the principal talks straight into it (the REPL needs no
 *  identity map — principal name = agent name), and platform DMs alias onto it at ingest
 *  ("principal handle → principal-DM alias", the special wiring).
 *
 *  Resolution, most specific wins: agents.<name> → MainConfig (the process: tests) →
 *  organization.agents — every key has a default, so nothing falls through. The clock and locale
 *  are the ORG's alone: one deployment, one wall time. */
async function compileRoster(
  dir: string,
  defaults: Pick<MainConfig, "model" | "effort" | "maxTokens" | "backlogHours">,
  catalog: OrgConfig,
  startedAt: number,
): Promise<AgentRow[]> {
  // the backlog is resolved ONCE, into an instant: every agent in this org comes up owing
  // the same stretch of history, and no later read re-decides where that stretch begins
  const hours = defaults.backlogHours ?? catalog.organization.backlogHours;
  const since = new Date(startedAt - hours * 3_600_000).toISOString();
  const org = catalog.organization.agents;
  // the media kinds a processor makes readable — org-wide, one fact for every agent (§5)
  const processors = Object.entries(catalog.processors).filter(([, cmd]) => !!cmd)
    .map(([kind]) => kind);
  const found: AgentRow[] = [];
  for (const [name, entry] of Object.entries(catalog.agents)) {
    const { identity = {}, principals, mind, ...cfg } = entry;
    // a session runs unless the entry — or `organization.agents.mind`, for all of them — says not
    // (§4). The workspace is derived, for an agent: a person alone gets none (the door's
    // socket is all its folder holds), a paused agent keeps the one it has and takes no turn
    const runs = mind ?? org.mind;
    if (runs) await Deno.mkdir(`${dir}/agents/${name}`, { recursive: true });
    found.push({
      agentId: name,
      mind: sessionAddress(name, MIND),
      principals,
      ...(runs ? {} : { runs: false }),
      model: cfg.model ?? defaults.model ?? org.model,
      effort: cfg.effort ?? defaults.effort ?? org.effort ?? undefined,
      provider: cfg.provider ?? org.provider ?? undefined,
      name: identity.name ?? undefined,
      email: identity.email ?? undefined,
      phone: identity.phone ?? undefined,
      settings: {
        maxTokens: cfg.maxTokens ?? defaults.maxTokens ?? org.maxTokens,
        // null survives the funnel: it means "every tool", not "unset"
        tools: (cfg.tools !== undefined ? cfg.tools : org.tools) ?? undefined,
        rules: cfg.rules ?? org.rules,
        since,
        timezone: catalog.organization.timezone || undefined,
        locale: catalog.organization.locale ?? undefined,
        // attention (§2): the wake policy is the agent's — hot, summoned, or on the digest
        engagedMinutes: cfg.engagedMinutes ?? org.engagedMinutes,
        digestAfterMessages: cfg.digestAfterMessages ?? org.digestAfterMessages,
        digestMinutes: cfg.digestMinutes ?? org.digestMinutes,
        // null survives the funnel: it means "never sleeps", not "unset" (Wake, §2)
        sleepHours: cfg.sleepHours !== undefined ? cfg.sleepHours : org.sleepHours,
        // null survives too: an ask that stands until answered
        gateHours: cfg.gateHours !== undefined ? cfg.gateHours : org.gateHours,
        processors,
        // the system half funnels too — org-wide, no per-agent seat (harness machinery)
        windowLimit: catalog.system.windowLimit,
        compactAt: catalog.system.compactAt,
        keepRecent: catalog.system.keepRecent,
        compactTurnAt: catalog.system.compactTurnAt,
      },
    });
  }
  return found;
}

/** Resolve when `p` settles or `ms` elapses, whichever comes first — and never leave the
 *  timer dangling (an uncleared setTimeout would keep the event loop alive on a clean stop). */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const settled = () => {
      clearTimeout(t);
      resolve();
    };
    p.then(settled, settled); // a rejected `finally` would be a second, unhandled rejection
  });
}

/** An interface-raised daemon reaps itself after this long with nothing attached — long
 *  enough that consecutive `liquen cli` runs reuse one org instead of re-paying seeding,
 *  the exec planes and the proxy each time. */
const LINGER_MS = 30_000;
const REAP_POLL_MS = 1_000;

// Headless entry: the deployment's main. `liquen start` spawns it bare; an attach client
// (the REPL) that found no daemon spawns it with `--ephemeral`, and that daemon's life
// is its ATTACHMENTS: the count is the door's live connections, so a killed interface
// and a clean quit are the same hang-up, and zero held for the linger means nobody is
// coming back — stop and exit. A bare daemon never reads the count.
if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    const root = findRoot(org);
    const dir = `${root}/data`;
    const catalog = await readConfig(root);
    // ONE MIND PER ORG (stop.ts): a second main over one log is two tails, two fan-outs and
    // two mirrors of every line the agent speaks — the duplicate a REPL's ephemeral daemon
    // and a `liquen start` used to make between them
    const lock = claim(dir, MAIN);
    if ("taken" in lock) {
      const who = lock.taken === null ? "" : ` (pid ${lock.taken})`;
      throw new Error(`a main already runs ${root}${who} — \`liquen stop\` first`);
    }
    const main = await start({ dir, catalog });
    console.error(`agents: ${Object.keys(catalog.agents).join(", ")} · log: ${dir}/log`);
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      Deno.addSignalListener(sig, () => {
        void main.stop().finally(() => Deno.exit(0));
      });
    }
    if (org.args.includes("--ephemeral")) {
      let occupied = Date.now(); // boot counts as occupied: the raiser gets the linger to arrive
      const reaper = setInterval(() => {
        if (main.attachments() > 0) occupied = Date.now();
        else if (Date.now() - occupied >= LINGER_MS) {
          clearInterval(reaper);
          void main.stop().finally(() => Deno.exit(0));
        }
      }, REAP_POLL_MS);
    }
  });
}
