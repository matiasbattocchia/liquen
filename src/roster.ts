/**
 * roster.ts — the one path an agent is made, changed and removed by (DESIGN §9).
 *
 * `liquen agent`, a connector routing a room to an agent it makes on the room's first
 * line, and a tool an agent calls all take the same two steps:
 *
 *   1. The store function checks and writes. `upsertAgent`: the name a folder and a Unix
 *      user can be, no key the file declares, every principal a member, the org as it
 *      would stand one boot can run, the provider able to run the model at its effort.
 *      Then the row and the agent's `config` scope in one transaction, the backlog floor
 *      when the row is new, and its docs seeded beside it, laid where missing, so its
 *      instructions can be written before it runs.
 *   2. The poke: `POST {agent}` on `data/run/main.sock`. main reconciles that one agent
 *      from its row — up, down or a change of settings — and answers with which, or
 *      with the sentence it refused on. The socket is the harness's own user's, 0600:
 *      root's in a container, where an agent's user cannot connect to it. With no main
 *      running the rows stand, and the next boot reconciles every row.
 *
 * `removeAgent` asks main over the same socket to bring the agent down, then deletes it
 * whole (`dropAgent`), and its folder and Unix user once that has committed.
 */

import {
  AGENT_KEYS,
  AGENT_NAME,
  type AgentDefaults,
  CONFIG_FILE,
  connectionScope,
  DECLARED,
  declaredPaths,
  type Identity,
  IDENTITY_KEYS,
  isPrincipals,
  nameRule,
  orgOf,
  pinned,
  readFile,
  settingsOf,
  validateOrg,
} from "./config.ts";
import {
  type AgentRow,
  agentScope,
  type Registry,
  steeredBy,
  steeringRefusal,
} from "./store/agents.ts";
import type { Connections } from "./store/connections.ts";
import { seedAgent, type Seedbed } from "./store/seed.ts";
import { MIND, sessionAddress } from "./session.ts";
import { socketUp } from "./connect/serve.ts";
import { dropUser } from "./users.ts";
import type { Json } from "./types.ts";

/** What a caller says of an agent: only what it names changes. */
export interface AgentChange {
  /** A handle given replaces the agent's; `null` clears it. */
  identity?: Identity;
  /** Who steers: a list of members, `"*"`, or `null` ⇒ derived from ownership again. */
  principals?: string[] | "*" | null;
  /** Settings of its own, over the org's. */
  set?: Partial<AgentDefaults>;
  /** Settings to inherit from the org again. */
  unset?: string[];
}

/** Make an agent, or change it. Answers whether it was made. `docs`, when given, is where
 *  a new agent's instructions and memories are laid. */
export async function upsertAgent(
  root: string,
  log: Registry,
  name: string,
  change: AgentChange = {},
  opts: { docs?: Seedbed; now?: number } = {},
): Promise<{ made: boolean }> {
  if (!AGENT_NAME.test(name)) throw new Error(nameRule(name));
  const scope = agentScope(name);
  for (const key of [...Object.keys(change.set ?? {}), ...(change.unset ?? [])]) {
    if (!AGENT_KEYS.includes(key)) throw new Error(`unknown setting "${key}"`);
  }
  if (change.principals != null && !isPrincipals(change.principals)) {
    throw new Error(`principals must be a list of roster names, or "*"`);
  }
  // every key has one owner: what the file declares is the file's to change
  const declared = await readFile(root);
  const owned = declaredPaths(declared);
  const touched = [
    ...Object.keys(change.set ?? {}).map((k) => `${scope}.${k}`),
    ...(change.unset ?? []).map((k) => `${scope}.${k}`),
    ...Object.keys(change.identity ?? {}).map((k) => `${scope}.identity.${k}`),
    ...(change.principals !== undefined ? [`${scope}.principals`] : []),
  ];
  for (const path of touched) if (owned.has(path)) throw pinned(path);

  const roster = (await log.agents()).map(({ runs: _runs, ...row }) => row);
  const had = roster.find((a) => a.agentId === name);
  const row: AgentRow = { ...(had ?? { agentId: name, mind: sessionAddress(name, MIND) }) };
  for (const key of IDENTITY_KEYS) {
    if (!change.identity || !(key in change.identity)) continue;
    const handle = change.identity[key];
    if (handle === null || handle === undefined) delete row[key];
    else row[key] = handle;
  }
  if (change.principals === null) delete row.principals;
  else if (change.principals !== undefined) row.principals = change.principals;

  // the org as it would stand: checked whole, so a refusal writes nothing
  const unset = new Set(change.unset ?? []);
  const rows = (await log.config())
    .filter((r) => !(r.scope === scope && (unset.has(r.key) || r.key in (change.set ?? {}))))
    .concat(
      Object.entries(change.set ?? {}).map(([key, value]) => ({
        scope,
        key,
        value: value as Json,
      })),
    );
  const next = orgOf(
    declared.deployment,
    rows,
    [...roster.filter((a) => a.agentId !== name), row],
  );
  validateOrg(next, `agent ${name}`);
  const settings = settingsOf(next, name);
  if (settings.mind) {
    // loaded when an agent is written, not with every process that may write one
    const { checkProvider } = await import("./transport/mod.ts");
    checkProvider({ agentId: name, ...settings });
  }
  const since = had?.since ??
    new Date((opts.now ?? Date.now()) - next.shared.backlogHours * 3_600_000).toISOString();
  await log.putAgents([{
    ...row,
    since,
    settings: (change.set ?? {}) as Record<string, Json>,
    unset: change.unset ?? [],
  }]);
  if (settings.mind && opts.docs) await seedAgent(opts.docs, name);
  return { made: had === undefined };
}

/** Remove an agent, whole: main brings it down, its rows go in one transaction, then its
 *  folder and its Unix user. An agent the file declares is the file's to remove first. */
export async function removeAgent(root: string, log: Registry, name: string): Promise<void> {
  if (declaredPaths(await readFile(root)).has(agentScope(name))) {
    throw pinned(agentScope(name), "remove it there first");
  }
  const roster = await log.agents();
  if (!roster.some((a) => a.agentId === name)) throw new Error(`no agent named ${name}`);
  const steered = steeredBy(roster, name);
  if (steered.length > 0) throw steeringRefusal(name, steered);
  await poke(root, { agent: name, down: true });
  await log.dropAgent(name);
  await Deno.remove(`${root}/data/agents/${name}`, { recursive: true }).catch((err) => {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  });
  await dropUser(name);
}

/** How long without a turn makes an agent the file does not declare worth naming. */
export const IDLE_DAYS = 30;

/** One line of the roster as `liquen agent` lists it. */
export interface Member {
  agentId: string;
  /** Whether `config.yaml` declares it. */
  declared: boolean;
  /** Whether a session runs for it. */
  runs: boolean;
  /** When it last paid for a model call; absent ⇒ never. */
  last?: string;
}

/** Every agent: declared or not, running or paused, its last turn. */
export async function members(root: string, log: Registry): Promise<Member[]> {
  const owned = declaredPaths(await readFile(root));
  const last = await log.lastTurns();
  return (await log.agents()).map((a) => ({
    agentId: a.agentId,
    declared: owned.has(agentScope(a.agentId)),
    runs: a.runs !== false,
    ...(last[a.agentId] ? { last: last[a.agentId] } : {}),
  }));
}

/** The agents nothing declares and no turn has run for in `IDLE_DAYS`, counted from its
 *  last turn, or from its backlog floor when it never took one. */
export async function idleAgents(
  root: string,
  log: Registry,
  now: number = Date.now(),
): Promise<string[]> {
  const floor = new Map((await log.agents()).map((a) => [a.agentId, a.since]));
  const cutoff = new Date(now - IDLE_DAYS * 86_400_000).toISOString();
  return (await members(root, log))
    .filter((m) => !m.declared && m.runs && (m.last ?? floor.get(m.agentId) ?? "") < cutoff)
    .map((m) => m.agentId);
}

/** main's socket: a POST of `{ agent?, down? }` — reconcile that agent from its row, or
 *  every agent when none is named; `down` brings it down whatever its row says, ahead of
 *  a removal. Answered with what main did, in words, or with the sentence it refused on. */
export function mainSocket(root: string): string {
  return `${root}/data/run/main.sock`;
}

/** Tell the running main about a change to the roster. What it did, in its words; null
 *  when no main runs this org: the rows stand, and the next boot reconciles every one.
 *  A refusal (a `useradd` that failed) is thrown as its sentence. */
export async function poke(
  root: string,
  body: { agent?: string; down?: boolean } = {},
): Promise<string | null> {
  const sock = mainSocket(root);
  if (!(await socketUp(sock))) return null;
  const client = Deno.createHttpClient({ proxy: { transport: "unix", path: sock } });
  try {
    const res = await fetch("http://localhost/", {
      method: "POST",
      body: JSON.stringify(body),
      client,
    });
    const said = await res.text();
    if (!res.ok) throw new Error(said);
    return said;
  } finally {
    client.close();
  }
}

/** What a caller says after the poke: who took the change up. */
export function taken(said: string | null): string {
  return said === null
    ? "no org is running: `liquen start` takes it up"
    : `the running org: ${said}`;
}

/** Declare a connection in the store: its scope stands, with the knobs given, and
 *  `liquen start` runs its process. One already declared is left as found. Answers
 *  whether it was new. */
export async function declareConnection(
  log: Registry,
  service: string,
  knobs: Record<string, Json> = {},
): Promise<boolean> {
  const scope = connectionScope(service);
  if ((await log.config(scope)).some((r) => r.key === DECLARED)) return false;
  await log.setConfig([
    { scope, key: DECLARED, value: true },
    ...Object.entries(knobs).map(([key, value]) => ({ scope, key, value })),
  ]);
  return true;
}

/** Take a connection out of the store, its knobs with it, so `liquen start` runs nothing
 *  for it. Answers whether there was one. One the file declares is the file's to remove. */
export async function undeclareConnection(
  root: string,
  log: Registry,
  service: string,
): Promise<boolean> {
  const scope = connectionScope(service);
  if (declaredPaths(await readFile(root)).has(scope)) {
    throw pinned(scope, `remove it from ${CONFIG_FILE} first`);
  }
  const had = (await log.config(scope)).length > 0;
  await log.unsetConfig(scope);
  return had;
}

/** Route a room to an agent, making the agent when it is missing (§4, §9): the steps in
 *  the order a room's first line needs. The agent is made from `entry` — its identity and
 *  settings, nobody steering it unless `entry` names someone; the route is one merge of
 *  `extra.mirrors.rooms` on the shared account's connection row, every other agent's room
 *  left as it was; a new agent is poked up. The caller then publishes the line: the route
 *  holds once the row does, and the mirror's copy into the agent's mind is owed to it from
 *  its backlog floor, whether main has brought it up yet or not. Answers whether the
 *  agent was made. */
export async function ensureRoute(
  root: string,
  log: Registry & Connections,
  route: { service: string; connection: string; room: string; agent: string },
  entry: AgentChange = {},
  opts: { docs?: Seedbed } = {},
): Promise<{ made: boolean }> {
  const exists = (await log.agents()).some((a) => a.agentId === route.agent);
  if (!exists) {
    await upsertAgent(root, log, route.agent, { principals: [], ...entry }, opts);
  }
  await log.upsertConnections([{
    service: route.service,
    address: route.connection,
    extra: { mirrors: { rooms: { [route.agent]: route.room } } },
  }]);
  if (!exists) await poke(root, { agent: route.agent });
  return { made: !exists };
}
