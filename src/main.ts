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
 * them. Lifecycle, not scheduling — teardown closes the sandbox and the log, and neither
 * may happen under a live turn.
 *
 * One subscription is not an agent's: the mind-alias mirror (§4), which rides the RAW log
 * because it joins across a boundary the scoped ports hide from each other. It lives here
 * for the same reason the agents do — it needs a log and nothing else, no socket and no
 * credential, so a process of its own would only be a lifetime nobody watches. The
 * connectors are the opposite case and stay outside: an ingest holds a port, a dispatcher
 * holds a token.
 */

import {
  type AgentConfig,
  answerCall,
  type Decision,
  OWN_TOOLS,
  relevant,
  xi,
  type XiPorts,
} from "./xi.ts";
import { ownComplex, ownVoice, silenced } from "./render.ts";
import { LOCAL_CONNECTION, MIND, sessionAddress } from "./session.ts";
import { historyFor, type Policy, policyFor, scoped } from "./policy.ts";
import {
  configOf,
  type Host,
  type Runner,
  runnerFor,
  type Seams,
  thinkingThrough,
} from "./runner.ts";
import type { Log, UsageRow } from "./store/log.ts";
import { databaseOf, storeAt } from "./store/mod.ts";
import { type Clock, tick } from "./tick.ts";
import { reportSends, resumeUnended, shellUpdate, updateDraft } from "./late.ts";
import { enroll, route } from "./route.ts";
import type { ConnectionRow } from "./store/connections.ts";
import type { AgentRow } from "./store/agents.ts";
import { bringSystemDocs, type Brought, seedAgent, seedOrg } from "./store/seed.ts";
import { packageManifest } from "./package.ts";
import {
  checkProvider,
  leaveOwed,
  metered,
  type ModelTransport,
  providerOf,
  takeOwed,
  transports,
  vaultKeys,
  type Warmth,
  warmth,
} from "./transport/mod.ts";
import { openCloudflareSandbox, openLocalSandbox, type SessionUpdate } from "./sandbox.ts";
import { whatsappContact } from "./connect/whatsapp/contact.ts";
import { whatsappRooms } from "./connect/whatsapp/rooms.ts";
import { DEFAULT_BRIDGE_URL } from "./connect/whatsapp/config.ts";
import { machine } from "./awake.ts";
import { slackRooms } from "./connect/slack/rooms.ts";
import { slackTokenFor } from "./connect/slack/dispatch.ts";
import { teamsRooms } from "./connect/microsoft/rooms.ts";
import { createGrantBroker } from "./proxy/grants.ts";
import { entry } from "./entry.ts";
import { claim, MAIN } from "./stop.ts";
import { openRunLog, sayConsole } from "./runlog.ts";
import { createMirror } from "./connect/mirror.ts";
import { createPresence } from "./connect/presence.ts";
import { createTranscriber } from "./processors.ts";
import { type DoorAgent, installDoors, type Status, type Tune } from "./door.ts";
import { readTurns, turnLine } from "./turns.ts";
import { loadMediaBlock, memoizedLoader } from "./store/media.ts";
import { collect } from "./store/storage.ts";
import type { Cause, Delta, Event, PresenceLevel } from "./types.ts";
import { checkToolDocs } from "./tooldoc.ts";
import { type BashInput, bashShape } from "./exec/bash.ts";
import { partialToolHomes } from "./exec/bubble.ts";
import { DOC_TOOLS } from "./exec/docs.ts";
import {
  DEFAULT_BACKLOG_HOURS,
  DEFAULT_BASH_WAIT_MS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_PRESENCE,
  findRoot,
  orgFlag,
  orgOf,
  parseDeclared,
  readFile,
  settingsOf,
  STOP_TIMEOUT_MS,
  TICK_MS,
} from "./config.ts";
import { applyFile } from "./org.ts";
import { IDLE_DAYS, idleAgents } from "./roster.ts";
import { serveSocket } from "./connect/serve.ts";
import { classifyFloors, ensureUser, requireTools, sealSystem } from "./users.ts";

/** How many rows of a session's room the turn's line reads back at a time: a turn is a
 *  few rows per step, and the walk pages further when one runs longer. */
const TURN_PAGE = 500;

/** How often the store is swept of what no event references (`collect`). */
const COLLECT_MS = 3_600_000;

export interface MainConfig {
  dir: string; // the org's data root (§9): log/ · system/ · shared/ · agents/
  /** The org's root. Its `config.yaml` is applied to the store at start, and the org is
   *  what the store then holds: the roster's rows, each agent's settings resolved over
   *  the org's — agentId = the row's name, the session's conversation = `mind@<name>`. */
  root?: string;
  /** One agent per principal, given in code and run as given (tests). The `Policy` half
   *  (using/check, §6) never reaches xi: main lifts it into the agent's scoped log —
   *  locally a wrapper, on Postgres a credential. */
  principals?: (AgentConfig & Policy)[];
  /** How far back the clock's passes look for what is owed, in hours (§5); the org's
   *  `backlogHours` when omitted. */
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
  /** Stop the org's main. `jobs: "end"` (the default) kills what the agents' commands left
   *  running: the org itself was stopped. `"leave"` leaves it running for the next main to
   *  adopt: main restarts (§9). */
  stop(opts?: { jobs?: "end" | "leave" }): Promise<void>;
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
  // the store is where the file's `deployment` says (§9); a process with no root (tests)
  // runs on the local engine under its data root
  const declared = config.root ? await readFile(config.root) : parseDeclared("", dir);
  const { deployment } = declared;
  const store = storeAt(
    databaseOf(dir, deployment.database, deployment.docs, deployment.storage),
  );
  // a harness running as root gives Linux to its agents (users.ts): the floors get their
  // owners before anything is laid on them
  await requireTools();
  await classifyFloors(dir);
  const log = await store.log();
  const docs = await store.docs(); // the doc cascade, files or the table (§8, §9)
  // the media port (§5): the object store's bytes, and a local file's, remembered across
  // every agent this process renders
  const storage = store.storage();
  const media = memoizedLoader((uri) => loadMediaBlock(uri, storage));
  // the store IS the org (§9): no explicit principals ⇒ the roster's rows are the agents
  const derived = config.principals === undefined; // …and gets the connections-map policy (§6)
  // boot is a reload at start: the file is applied to the store — a key it declares
  // overwrites, a key it leaves out keeps the store's value, an agent it does not name is
  // left alone — and from here the org is what the store holds. Explicit principals
  // (tests) are rows too: policy derives from rows (§6), the ingest classifier scans the
  // handles (email/phone → member), and render names members by them (§5).
  if (derived && config.root) await applyFile(config.root, log);
  else if (!derived) await log.putAgents(config.principals!.map(rowOf));
  const readOrg = async () => orgOf(deployment, await log.config(), await log.agents());
  // the org as it stands, read again whenever an agent is reconciled: an agent's settings
  // resolve its own scope over the org's when they are read
  let org = await readOrg();
  // what is read once, at start: where the org's parts live, its clock and locale, the
  // machinery's knobs. Explicit principals (tests) carry their own settings and need none.
  const catalog = derived ? org : null;
  // what a caller passes in code rides beside the row — a policy, a compiled gate, a
  // retry pace: seams, and no row carries a function.
  const inCode = new Map((config.principals ?? []).map((p) => [p.agentId, p]));
  // the config a session of the agent runs with, and the provider it thinks through: a
  // principal given in code runs as given, a row runs on what the store resolves
  const configFor = (row: AgentRow, sessionId: string): AgentConfig => {
    const given = inCode.get(row.agentId);
    if (!given) return configOf(row, org, sessionId);
    const { using: _using, check: _check, ...own } = given;
    return { ...own, sessionId, cache: providerOf(undefined).cache };
  };
  const providerFor = (agentId: string) =>
    inCode.has(agentId) ? undefined : settingsOf(org, agentId).provider;
  // every row main has met, running or paused, and each running agent's part, held by
  // agent so one comes up, goes down or changes while the others run on
  const rows = new Map<string, AgentRow>();
  const minds = new Map<string, Runner>();
  const subs = new Map<string, () => void>();
  const seamsOf = (agentId: string): Seams => {
    const p = inCode.get(agentId);
    return {
      ...(p?.gate ? { gate: p.gate } : {}),
      ...(p?.retryDelaysMs ? { retryDelaysMs: p.retryDelaysMs } : {}),
    };
  };
  // the session's VIEW of the log (§6): reads, writes, and the tail all go through it.
  // A folder-declared org's policy is the connections map (live read-through lookups),
  // and a named session's always is; an explicit principal's mind carries its own (tests)
  const policyOf = (agentId: string, sessionId: string): Policy => {
    if (derived || sessionId !== MIND) return policyFor({ agentId, id: sessionId });
    const p = inCode.get(agentId);
    return { using: p?.using, check: p?.check };
  };
  // the mind is a ONE-MEMBER conversation (§6): seeding it as membership is what makes
  // "own mind readable, others' invisible" plain branch-3 policy, no special case. EVERY
  // row has the room — a paused agent's is what its door still reads (§4)
  const enlist = (agentId: string) =>
    log.upsertMemberships([{
      service: "local",
      connection: LOCAL_CONNECTION,
      conversation: sessionAddress(agentId, MIND),
      agentId,
      sessionId: MIND,
    }]);
  for (const row of await log.agents()) {
    rows.set(row.agentId, row);
    await enlist(row.agentId);
  }
  const running = () => [...rows.values()].filter((row) => row.runs !== false);
  if (config.connections) await log.upsertConnections(config.connections);
  // the org's docs: its scaffolds laid where missing, the release's words brought (§9).
  // What only a person can settle is left as the org has it, and named at every boot
  await seedOrg(docs.bed);
  const brought = await bringSystemDocs(docs.bed, log);
  sayBrought(brought);
  const release = (await packageManifest()).version;
  if (release) await log.setManifest({ release });
  // every builtin tool's words are a doc the org may edit (tooldoc.ts): one that disagrees
  // with its schema stops the start here, named, before any turn reads it
  if (running().length > 0) {
    const ctx = { agent: running()[0].agentId };
    await checkToolDocs(
      [
        ...OWN_TOOLS,
        bashShape(catalog?.system.bashWaitMs ?? DEFAULT_BASH_WAIT_MS),
        ...Object.values(DOC_TOOLS),
      ],
      (name) => docs.read(ctx, { scope: "system", kind: "tool", name }),
    );
  }
  // the vault: the model keys below, and the rooms' grants further down
  const creds = await store.vault();
  // one client per provider and key, the key read off the vault at every call (an agent's
  // own before the org's, the environment's when it holds none); a test's scripted edge
  // stands in for all of them
  const transportOf = transports({ anthropic: config.apiKey, keyOf: vaultKeys(creds) });
  const transportFor = (agentId: string): ModelTransport =>
    overrides.transport ?? transportOf(providerOf(providerFor(agentId)), agentId);
  // the exec plane (§9): one provider owns the proxy, the grounds and the shells; main
  // holds only the provider, and every session's exec, ambient and files come from it —
  // this machine's, bare or in bubbles, or the sandbox gateway's the catalog names
  const bubble = catalog?.deployment.sandbox === "bwrap";
  const remote = bubble ? null : catalog?.deployment.sandbox ?? null;
  const updating = new Set<Promise<void>>();
  const planeOptions = {
    locale: catalog?.shared.locale,
    timezone: catalog?.shared.timezone,
    bashWaitMs: catalog?.system.bashWaitMs,
    tell: (u: SessionUpdate) => {
      // a shell's word on a call (late.ts): published as the update it is. Held until
      // stored, so the shutdown that kills every job tells each one before the log closes
      const told: Promise<void> = log
        .publish(updateDraft(shellUpdate(u), new Date().toISOString()))
        .then(() => {}, (err) => console.error("[main] update:", err))
        .then(() => void updating.delete(told));
      updating.add(told);
    },
  };
  const sandbox = remote
    ? openCloudflareSandbox({
      url: remote,
      token: sandboxToken(),
      storage,
      sleepMinutes: catalog?.deployment.sandboxSleepMinutes,
      ...planeOptions,
    })
    : await openLocalSandbox(dir, {
      store,
      bubble,
      mounts: catalog?.deployment.mounts,
      // read at each call, so a change of `export` reaches the next command
      exports: (agentId) => inCode.has(agentId) ? [] : settingsOf(org, agentId).export,
      ...planeOptions,
    });
  // an agent's ground: the writes that converge, each safe to make again. The provider
  // can run the model at the effort it is set (§9), refused here, not mid-turn; its docs
  // are laid where missing; root gives it its Linux user and its folder; the sandbox
  // prepares where its shells run
  const ground = async (row: AgentRow) => {
    const { agentId } = row;
    checkProvider({ ...configFor(row, MIND), provider: providerFor(agentId) });
    await enlist(agentId);
    await seedAgent(docs.bed, agentId);
    await ensureUser(dir, agentId);
    await sandbox.add(agentId);
  };
  for (const row of running()) await ground(row);
  // everything boot lays in `system/` is laid: the harness's docs are read-only to all
  await sealSystem(dir);
  if (!remote && !bubble && Deno.build.os === "linux" && running().length) {
    console.error(
      '[exec] the agents\' shells run bare, as you: deployment.sandbox "bwrap" gives each a ' +
        "bubble of its own that sees its folder, the shared floor and the system",
    );
  }
  for (const home of bubble ? partialToolHomes(catalog?.deployment.mounts ?? []) : []) {
    console.error(
      `[exec] a bubble shows ${home} only by its PATH folders: deployment.mounts ` +
        `["${home}"] shows it whole, so the tools there run`,
    );
  }
  // a command the last run answered async and never told the end of is followed on where
  // its shell runs (late.ts), before any turn of this run looks at the log
  const unended = await resumeUnended(log, (use) => {
    const agentId = use.agent!.id;
    if (rows.get(agentId)?.runs === false || !rows.has(agentId)) return Promise.resolve(false);
    return sandbox.forAgent(agentId).session(use.agent!.session_id ?? MIND).resume(
      { id: use.id, turn_id: use.payload.turn_id },
      use.parts[0].data.input as unknown as BashInput,
    );
  });
  if (unended.followed || unended.lost) {
    console.log(
      `[main] commands the last run left: ${unended.followed} followed on, ${unended.lost} lost`,
    );
  }
  // the ports stand whether or not a service is connected yet: a leg is only ever reached
  // through one of the agent's accounts, and a service connected while main runs has its
  // ports already there
  //
  // the address book (§9): one port per service that keeps one — whatsapp's rides the
  // bridge the dispatcher already talks to, on the same token, and carries both legs:
  // `contact` writes through it, `search` reads through it
  const bridge = catalog?.connections?.whatsapp?.bridgeUrl;
  const bridgeUrl = typeof bridge === "string" ? bridge : DEFAULT_BRIDGE_URL;
  const bridgeToken = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";
  const contact: XiPorts["contact"] = { whatsapp: whatsappContact(bridgeUrl, bridgeToken) };
  // the rooms (§9): one port per service whose API opens and changes conversations, over
  // the vault the dispatcher posts with — so a room is opened by the grant that speaks in
  // it; whatsapp's rides the bridge, whose session is the grant
  const rooms: XiPorts["rooms"] = {
    slack: slackRooms({ tokenFor: slackTokenFor(creds) }),
    microsoft: teamsRooms({ broker: createGrantBroker({ creds }), creds }),
    whatsapp: whatsappRooms(bridgeUrl, bridgeToken),
  };

  let stopped = false;
  // the fan-outs' late half: ports close over `cast`/`castStatus` before the doors exist,
  // and the doors — which know who is tailing — take them over once they are up
  let cast: (agentId: string, sessionId: string, delta: Delta) => void = () => {};
  let castStatus: (
    agentId: string,
    sessionId: string,
    line: Status,
  ) => void = () => {};
  // every decision with its cause, not only the edges: presence keeps who asked for a stretch
  let castDecision: (
    agentId: string,
    sessionId: string,
    verdict: Decision,
    cause?: Cause,
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
  ) => {
    const line: Status = verdict === "ignore"
      ? { status: "idle", ...(cursor !== undefined ? { after: cursor } : {}) }
      : { status: "busy" };
    const who = sessionAddress(agentId, sessionId);
    const key = line.status + (line.after ?? "");
    const was = reported.get(who);
    if (was === key) return;
    reported.set(who, key);
    castStatus(agentId, sessionId, line);
    if (line.status === "idle" && was === "busy") sayTurn(agentId, sessionId);
  };
  // the turn's line: when a session falls from busy to idle, the turn that just ended is
  // read back off its log — what opened it, its steps, what they cost, how it ended,
  // whether a checkpoint followed — and said once, the reading `liquen log turns` prints
  const told = new Map<string, string>();
  const sayTurn = (agentId: string, sessionId: string) => {
    const who = sessionAddress(agentId, sessionId);
    const port = sessionId === MIND ? minds.get(agentId)?.log : named.get(who)?.log;
    if (!port) return;
    readTurns(port, { agentId, id: sessionId }, 1, TURN_PAGE, {
      prices: catalog?.system.prices ?? [],
    })
      .then(([t]) => {
        if (!t || t.end === "open" || told.get(who) === t.id) return;
        told.set(who, t.id);
        console.error(`turn ${turnLine(t)}`);
      })
      .catch((err) => console.error(`turn ${who}: its line could not be read:`, err));
  };
  // metered per agent: every model call this agent makes lands in the usage table
  // attributed to it (§2 telemetry) — also the seam where per-agent providers plug in.
  // The roster's transport is the STOCK one: what every session of the agent thinks
  // through unless an attachment asks for another (`tune`, below)
  // …and each row crosses the agent's observing tails (§9), under the step it paid for
  let castUsage: (agentId: string, row: UsageRow) => void = () => {};
  const meter = (agentId: string, t: ModelTransport) =>
    metered(
      t,
      (row) => {
        void log.meter(row).catch((err) => console.error("metering failed:", err));
        castUsage(agentId, row);
      },
      agentId,
    );
  const stock = new Map<string, ModelTransport>();
  // each mind's keeper (§5), every one of them stopped with the org. The ping a keeper
  // still owes waits in a file of its agent's for the next boot's keeper to take up
  const keepers = new Map<string, Warmth>();
  const owedAt = (agentId: string) => `${dir}/run/${agentId}.keep.json`;
  // the runner (§4): one builder for the mind and every named session, over the store,
  // the row and these ports — the process's own part is the fan-outs and the transports
  const host: Host = {
    log,
    docs,
    // where the docs are the table's, the session's read · write · edit tools (§9)
    ...(docs.as ? { reach: docs.as } : {}),
    media,
    policy: policyOf,
    // the agent's history (§6): what `search` reads, from any of its sessions — the
    // same map, keyed on the agent. Explicit principals search their own view
    ...(derived ? { history: historyFor } : {}),
    transport: (agentId) => stock.get(agentId)!,
    warmth: (agentId) => {
      const w = warmth({ owed: takeOwed(owedAt(agentId)) });
      keepers.set(agentId, w);
      return w;
    },
    sandbox,
    ...(contact ? { contact } : {}),
    ...(rooms ? { rooms } : {}),
    onDelta: (agentId, sessionId, d) => cast(agentId, sessionId, d),
    onDecision: (agentId, sessionId, v, cursor, cause) => {
      disclose(agentId, sessionId, v, cursor);
      castDecision(agentId, sessionId, v, cause);
    },
  };
  const build = (row: AgentRow, sessionId: string): Runner =>
    runnerFor(host, configFor(row, sessionId), providerFor(row.agentId), seamsOf(row.agentId));

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
      // teardown, the org's or the agent's own, not routing — main takes no other decision
      if (stopped || !minds.has(a.config.agentId)) return;
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
  const wake = (a: Runner) => {
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
  // trigger's own address names the session to invoke (its room, a direct room it is in,
  // a group it is enrolled in), so main builds a runner on first contact and a quiet
  // session costs nothing.
  // Bursts bounce off the session's own turn lease; the mind's ladder never applies.
  const named = new Map<string, Runner>();
  const runnerOf = async (agentId: string, sessionId: string) => {
    const key = sessionAddress(agentId, sessionId);
    const hit = named.get(key);
    if (hit) return hit;
    const p = rows.get(agentId);
    // an address wearing a name the roster doesn't, or an agent that is not up
    if (!p || !minds.has(agentId)) return undefined;
    await enroll(log, { agentId, sessionId });
    const r = build(p, sessionId);
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
    const p = rows.get(agentId);
    const r = sessionId === MIND ? minds.get(agentId) : await runnerOf(agentId, sessionId);
    if (!p || !r) return;
    const stated = configFor(p, MIND); // the roster's word, what the hang-up puts back
    const own = providerFor(agentId);
    const provider = t?.provider ?? own;
    const model = t?.model ?? stated.model;
    const effort = t?.effort ?? stated.effort;
    checkProvider({ agentId, provider, model, effort });
    r.config.model = model;
    r.config.effort = effort;
    r.ports.transport = thinkingThrough(
      r,
      provider,
      provider === own
        ? stock.get(agentId)!
        : meter(agentId, overrides.transport ?? transportOf(providerOf(provider), agentId)),
    );
  };

  // the door (§9): a script's syscalls, as gated tool_use events in the caller's name. The
  // one boundary piece that HOLDS something in main — the sockets ARE the boundary; each
  // serves its agent's scoped ports, so even the door writes under §6 visibility. A
  // request that names a session speaks through THAT session's port, and a call is answered
  // with that session's runner — asking for one is what births it.
  const doors = await installDoors(dir);
  const doorOf = (agentId: string): DoorAgent => {
    const a = minds.get(agentId);
    if (a) {
      return {
        agentId,
        sessionId: a.config.sessionId,
        port: async (sessionId: string) =>
          sessionId === a.config.sessionId ? a.log : (await runnerOf(agentId, sessionId))!.log,
        answer: async (sessionId, use, signal) => {
          const r = sessionId === a.config.sessionId ? a : (await runnerOf(agentId, sessionId))!;
          return answerCall(use, r.config, r.ports, signal);
        },
        // where the principal stands is where the session's shell starts (§9)
        stand: (session, path) => sandbox.forAgent(agentId).session(session).stand(path),
        tune: (session, settings) => tune(agentId, session, settings),
        spend: (turns) => log.spend({ agentId, turns }),
        storage,
      };
    }
    // a PAUSED agent (`mind: false`, §4): the door still opens on its rooms — a tail reads
    // what landed, an order is refused — and no runner, no shell, stands behind it
    return {
      agentId,
      sessionId: MIND,
      paused: true,
      port: (sessionId: string) => Promise.resolve(scoped(log, policyOf(agentId, sessionId))),
      spend: (turns) => log.spend({ agentId, turns }),
      storage,
    };
  };
  // presence (§9): the same two facts the doors serve, written as a `delta` event in the
  // mind's room — the mirror is what carries it to every surface, tagged. Inert until a
  // surface is bound. Each agent's level is its entry's, else the org's
  const presenceOf = (agentId: string): PresenceLevel =>
    derived ? settingsOf(org, agentId).presence : DEFAULT_PRESENCE;
  const presence = createPresence({
    aliases: () => log.aliases(),
    publish: (draft) => log.publish(draft),
    level: presenceOf,
    onError: (err) => console.error("presence FAILED:", err),
  });
  cast = (agentId, sessionId, delta) => {
    doors.emit(agentId, sessionId, delta);
    presence.delta(agentId, sessionId, delta);
  };
  castUsage = (agentId, row) => doors.usage(agentId, row);
  castStatus = (agentId, sessionId, line) => doors.status(agentId, sessionId, line);
  castDecision = (agentId, sessionId, v, cause) =>
    presence.status(agentId, sessionId, v === "ignore" ? "idle" : "busy", cause);

  // UP (§9): an agent's entries and its subscription, over the ground laid for it. Its
  // metered transport, its mind's runner, its door; then its own view of the log tailed,
  // and the trigger-less look at whatever the log owes it
  const run = async (row: AgentRow, look = true) => {
    const { agentId } = row;
    stock.set(agentId, meter(agentId, transportFor(agentId)));
    const a = build(row, MIND);
    minds.set(agentId, a);
    await doors.open(doorOf(agentId));
    subs.set(agentId, a.log.subscribe(wake(a)));
    if (look) invoke(a)();
  };
  // DOWN: the same, undone. The agent leaves the maps first, so nothing new starts for it;
  // its subscription and its burst's timer go, its turns in flight are waited out, its
  // keeper stops, and the sandbox ends its shells and no one else's
  const down = async (agentId: string) => {
    if (!minds.delete(agentId)) return;
    subs.get(agentId)?.();
    subs.delete(agentId);
    clearTimeout(settling.get(agentId));
    settling.delete(agentId);
    const mine = (key: string) => key.endsWith(`@${agentId}`);
    await withTimeout(
      Promise.all([...inflight].filter(([key]) => mine(key)).flatMap(([, runs]) => [...runs])),
      config.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    );
    const keeper = keepers.get(agentId);
    if (keeper) leaveOwed(owedAt(agentId), keeper.stop());
    keepers.delete(agentId);
    stock.delete(agentId);
    for (const key of [...named.keys()].filter(mine)) named.delete(key);
    for (const key of [...reported.keys(), ...told.keys()].filter(mine)) {
      reported.delete(key);
      told.delete(key);
    }
    await sandbox.remove(agentId);
  };
  // a change of settings is neither: the runner's config and transport are read at every
  // invocation, so each of the agent's runners takes the new ones and its next turn runs
  // on them, while one already running finishes as it began
  const retune = (row: AgentRow) => {
    const { agentId } = row;
    checkProvider({ ...configFor(row, MIND), provider: providerFor(agentId) });
    stock.set(agentId, meter(agentId, transportFor(agentId)));
    const mine = [
      minds.get(agentId)!,
      ...[...named].filter(([key]) => key.endsWith(`@${agentId}`)).map(([, r]) => r),
    ];
    for (const r of mine) {
      const { home, gate, retryDelaysMs } = r.config;
      r.config = {
        ...configFor(row, r.config.sessionId),
        ...(home !== undefined ? { home } : {}),
        ...(gate ? { gate } : {}),
        ...(retryDelaysMs ? { retryDelaysMs } : {}),
      };
      r.ports.transport = thinkingThrough(r, providerFor(agentId), stock.get(agentId)!);
    }
  };
  // one agent brought in line with its row, the others running on: up when it should run
  // and does not, down when it runs and should not (paused, or its row gone), retuned
  // when it runs and stays. One at a time: a second change waits for the first
  let reconciling: Promise<unknown> = Promise.resolve();
  const reconcile = (agentId: string, force?: "down"): Promise<string> => {
    const turn = reconciling.then(async () => {
      org = await readOrg();
      const row = (await log.agents()).find((a) => a.agentId === agentId);
      const was = minds.has(agentId);
      if (!row || force === "down") {
        await down(agentId);
        await doors.shut(agentId);
        rows.delete(agentId);
        return was ? `${agentId} down` : `${agentId} is not running`;
      }
      rows.set(agentId, row);
      await enlist(agentId);
      if (row.runs === false) {
        await down(agentId);
        await doors.open(doorOf(agentId));
        return was ? `${agentId} paused` : `${agentId} stays paused`;
      }
      if (!was) {
        await ground(row);
        await run(row);
        return `${agentId} up`;
      }
      retune(row);
      return `${agentId} changed`;
    });
    reconciling = turn.catch(() => {});
    return turn;
  };
  // main's socket (roster.ts): a caller that wrote the roster pokes here, and is answered
  // with what main did. The harness's own user's alone: an agent's user cannot connect
  const asked = await serveSocket(`${dir}/run/main.sock`, async (req) => {
    try {
      const body = req.method === "POST" ? await req.json() : {};
      const names = typeof body.agent === "string"
        ? [body.agent]
        : [...new Set([...rows.keys(), ...(await log.agents()).map((a) => a.agentId)])];
      const said: string[] = [];
      for (const name of names) said.push(await reconcile(name, body.down ? "down" : undefined));
      return new Response(said.join(" · ") || "no agents");
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
    }
  });
  await Deno.chmod(`${dir}/run/main.sock`, 0o600);

  // boot is up for each row, its first look held until every tail below is listening; a
  // paused agent's door opens on its rooms alone
  for (const row of rows.values()) {
    if (row.runs === false) await doors.open(doorOf(row.agentId));
    else await run(row, false);
  }
  const unsubs: (() => void)[] = [];
  // the principal's word in the mind's room, the moment it lands: a stretch they did not
  // ask for becomes theirs, and presence says what is running (§9)
  unsubs.push(log.subscribe((e) => {
    if (e.type !== "message" || silenced(e)) return;
    for (const a of minds.values()) {
      const home = sessionAddress(a.config.agentId, MIND);
      const session = { agentId: a.config.agentId, id: MIND, conversation: home };
      if (e.envelope.conversation.address === home && !ownVoice(e, session)) {
        presence.heard(a.config.agentId);
      }
    }
  }));
  // the named sessions ride the RAW log (§4): reactive, no subscription of their own —
  // the trigger's address names the session to invoke, and main builds its runner on
  // first contact, so a quiet session costs nothing
  unsubs.push(log.subscribe((e) => {
    route(e, log).then((named) => {
      for (const p of named) {
        runnerOf(p.agentId, p.sessionId)
          .then((r) => r && invoke(r)(e))
          .catch((err) => console.error(`[main] ${p.sessionId}@${p.agentId}:`, err));
      }
    }).catch((err) => console.error("[main] route:", err));
  }));
  // a send that fails for good, is withdrawn, or goes out after it was told stalled, is told
  // to its call at once (late.ts): the update stream says a row of the model's own moved, and the
  // clock's report pass runs now instead of at the next beat, which stays the guarantee for
  // a move stamped while nobody listened. A move landing mid-pass runs the pass once more.
  let telling: Promise<void> | undefined;
  let again = false;
  const tell = () => {
    if (telling) {
      again = true;
      return;
    }
    telling = reportSends(log)
      .then(() => undefined, (err) => console.error("[main] report:", err))
      .finally(() => {
        telling = undefined;
        if (again) {
          again = false;
          tell();
        }
      });
  };
  unsubs.push(log.subscribe(tell, {
    updates: true,
    filter: (e) =>
      e.type === "message" && e.agent !== undefined && e.payload?.turn_id !== undefined &&
      e.status !== undefined && (
        (e.status.state === "failed" || e.status.withdrawn_at !== undefined) &&
          e.status.reported_at === undefined ||
        (e.status.stalled_at ?? e.status.reported_at ?? e.status.withdrawn_at) !== undefined &&
          e.status.corrected_at === undefined &&
          ["dispatched", "delivered", "read"].includes(e.status.state ?? "")
      ),
  }));
  // the mirror rides the RAW log (§4): it copies between a mind and its alias surfaces, and
  // an agent's own alias conversation is invisible to that agent's scoped port (§6) — the
  // join has to happen where visibility isn't filtered. Inert until a surface is bound, so
  // it costs nothing in an org that has none.
  unsubs.push(createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    gates: (scope) => log.gates(scope),
    aliases: () => log.aliases(),
    nameOf: async (id) => (await log.agents()).find((a) => a.agentId === id)?.name ?? id,
    // `"*"` is the row's own word: the view derives no principal from it
    principalsOf: async (id) =>
      (await log.agents()).find((a) => a.agentId === id)?.principals === "*"
        ? "*"
        : await log.principalsOf(id),
    locale: catalog?.shared.locale,
    presence: presenceOf,
    asked: (id) => presence.asked(id),
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
      read: (q) => log.read(q),
      storage,
      command: catalog.processors.audio,
      locale: catalog.shared.locale,
      onError: (e, err) =>
        console.error(`transcriber FAILED on ${e.envelope.conversation.address}:`, err),
    }));
  }
  for (const a of minds.values()) invoke(a)(); // boot: no trigger ⇒ look at whatever the log owes
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
  // (`tick`, §10): due reminders become alarms, unanswered asks lapse, failed sends are
  // re-offered — nothing here posts, and where the log is a database with its own clock,
  // that pass is the clock's statement. One beat at a time: a tick that lands while a
  // beat is still publishing joins it instead of opening a second.
  const clock: Clock = {
    agents: () =>
      [...minds.values()].map((a) => ({ agentId: a.config.agentId, timezone: a.config.timezone })),
    docs,
    backlogHours: config.backlogHours ?? catalog?.shared.backlogHours ??
      DEFAULT_BACKLOG_HOURS,
  };
  let beating: Promise<unknown> | undefined;
  const ticker = setInterval(() => {
    machine.look(); // a wake is stamped within a tick even when no turn reads it (awake.ts)
    beating ??= tick(log, clock)
      .then(
        (beat) => {
          for (const f of beat.failed) console.error(`the tick's ${f.pass} pass failed:`, f.error);
        },
        (err) => console.error("the tick failed:", err),
      )
      .finally(() => beating = undefined);
    for (const a of minds.values()) invoke(a)();
  }, TICK_MS);
  // references keep an object (§8): the store is swept of what no event references, at a
  // pace of its own, since a sweep lists the whole store
  let collecting: Promise<unknown> | undefined;
  const collector = setInterval(() => {
    collecting ??= collect(storage, async (uri) => (await log.read({ uri, limit: 1 })).length > 0)
      .then(
        (n) => n && console.error(`[storage] ${n} object(s) no event references, let go`),
        (err) => console.error("[storage] the sweep failed:", err),
      )
      .finally(() => collecting = undefined);
  }, COLLECT_MS);

  return {
    log,
    attachments: () => doors.attachments(),
    async stop({ jobs = "end" } = {}) {
      stopped = true;
      clearInterval(ticker);
      clearInterval(collector);
      for (const t of settling.values()) clearTimeout(t); // a burst still settling: drop it
      settling.clear();
      for (const [agentId, w] of keepers) leaveOwed(owedAt(agentId), w.stop());
      for (const unsub of [...unsubs, ...subs.values()]) unsub();
      await asked.shutdown(); // no change to the roster is taken from here on
      await Deno.remove(`${dir}/run/main.sock`).catch(() => {});
      await doors.close(); // stop taking syscalls before the log goes away
      // Bound the settle. A turn wedged on a hung model connection (e.g. a network
      // outage during shutdown) must not block teardown forever — the sandbox's close
      // and log.close have to run so no background job or file handle is left behind.
      // The orphaned in-flight turn is swallowed by drive's catch (and, in task
      // mode, killed outright by the process exit that follows).
      await withTimeout(
        Promise.all([...outstanding]),
        config.stopTimeoutMs ?? STOP_TIMEOUT_MS,
      );
      await sandbox.close({ jobs }); // every shell's jobs ended or left, the proxy stopped
      await Promise.all([...updating]); // …and each one ended told so, before the log goes
      await docs.close();
      await creds.close();
      await log.close();
    },
  };
}

/** What bringing the release's docs did, said once at boot. */
function sayBrought(b: Brought): void {
  const said = [
    ...(b.laid.length ? [`laid ${b.laid.join(" · ")}`] : []),
    ...(b.replaced.length ? [`brought to this release ${b.replaced.join(" · ")}`] : []),
    ...(b.deleted.length ? [`removed with this release ${b.deleted.join(" · ")}`] : []),
  ];
  if (said.length > 0) console.error(`[docs] system: ${said.join("; ")}`);
  if (b.pending.length > 0) {
    console.error(
      `[docs] this release words ${b.pending.map((p) => `${p.doc} (${p.state})`).join(" · ")} ` +
        "otherwise than the org has it — `liquen update` settles each",
    );
  }
}

/** A principal given in code (tests) as its row: who it is, and its backlog floor. What
 *  it runs with stays in code, as it was given. */
function rowOf(p: AgentConfig & Policy): AgentRow {
  return {
    agentId: p.agentId,
    mind: sessionAddress(p.agentId, MIND),
    ...(p.name ? { name: p.name } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.since ? { since: p.since } : {}),
  };
}

/** Resolve when `p` settles or `ms` elapses, whichever comes first — and never leave the
 *  timer dangling (an uncleared setTimeout would keep the event loop alive on a clean stop). */
/** The sandbox gateway's bearer token: a secret, so the environment's, and a boot refusal
 *  when the catalog names a gateway and the environment holds none. */
function sandboxToken(): string {
  const token = Deno.env.get("SANDBOX_API_KEY");
  if (!token) {
    throw new Error("deployment.sandbox names a gateway: SANDBOX_API_KEY in .env holds its token");
  }
  return token;
}

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
 *  the sandbox each time. */
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
    // raised alone, main has no supervisor pumping its lines: it writes the run log itself
    const alone = org.args.includes("--ephemeral");
    if (alone) sayConsole(openRunLog(dir, false), MAIN);
    // ONE MIND PER ORG (stop.ts): a second main over one log is two tails, two fan-outs and
    // two mirrors of every line the agent speaks
    const lock = claim(dir, MAIN);
    if ("taken" in lock) {
      const who = lock.taken === null ? "" : ` (pid ${lock.taken})`;
      throw new Error(`a main already runs ${root}${who} — \`liquen stop\` first`);
    }
    const main = await start({ dir, root });
    const roster = await main.log.agents();
    console.error(`agents: ${roster.map((a) => a.agentId).join(", ")} · log: ${dir}/log`);
    // an agent the file does not declare and no turn has run for in a while is named: it
    // stays until `liquen agent --remove` takes it out
    const idle = await idleAgents(root, main.log);
    if (idle.length > 0) {
      console.error(
        `idle for ${IDLE_DAYS} days and declared nowhere: ${idle.join(", ")} — ` +
          "`liquen agent --remove <name>` removes one",
      );
    }
    // the signal says whether the org stops or main restarts (§9): SIGINT is a stop — a
    // ctrl-c, `liquen stop`, the supervisor's own stop — and kills what the agents' commands
    // left running; SIGTERM is a restart — a reload, a deploy — and leaves it for the next
    // main to adopt
    const stops = { SIGINT: "end", SIGTERM: "leave" } as const;
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      Deno.addSignalListener(sig, () => {
        void main.stop({ jobs: stops[sig] }).finally(() => Deno.exit(0));
      });
    }
    if (alone) {
      let occupied = Date.now(); // boot counts as occupied: the raiser gets the linger to arrive
      const reaper = setInterval(() => {
        if (main.attachments() > 0) occupied = Date.now();
        else if (Date.now() - occupied >= LINGER_MS) {
          clearInterval(reaper);
          // nobody is attached, which is not a stop: the next main adopts what runs
          void main.stop({ jobs: "leave" }).finally(() => Deno.exit(0));
        }
      }, REAP_POLL_MS);
    }
  });
}
