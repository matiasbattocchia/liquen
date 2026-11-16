/**
 * org.ts — the org's configuration as it stands, and the file applied to it (DESIGN §9).
 *
 * The store holds the configuration (`store/agents.ts`); `config.yaml` is input. Two
 * moves live here:
 *
 *   readConfig   the org as every process runs on it: `deployment` off the file, the
 *                rest off the store over the catalog's defaults.
 *   applyFile    what `liquen start`, `liquen reload` and whoever else raises main do with
 *                the file before main reads the store.
 *
 * The apply is three-way. The store keeps a base, what the file said at its last apply,
 * and each leaf the file states is weighed three ways:
 *
 *   the file as the base had it    the key is left alone, so a command's write survives
 *   the file moved, the store not  the file's value is taken
 *   both moved, apart              a conflict: the store's value stays, and is said
 *
 * A key taken out of the file stops being applied, and the store keeps its value. With
 * `overwrite`, the file's value is taken wherever it differs from the store's. The roster
 * entries weigh the same way, each one's leaves under `roster.<name>` in the base: the
 * entry itself, each identity key it states, its principals. So an agent the file
 * declares and a command removed stays removed while the file says of it what it said.
 * The org as it would stand is checked whole before a row is written, so a file the org
 * cannot run on changes nothing.
 */

import {
  CONFIG_FILE,
  type ConnectorSpec,
  DECLARED,
  type Declared,
  IDENTITY_KEYS,
  knobsOf,
  type OrgConfig,
  orgOf,
  readFile,
  type RoomKnobs,
  validateOrg,
} from "./config.ts";
import { type AgentRow, agentScope, type ConfigRow, type Registry } from "./store/agents.ts";
import { openStore } from "./store/mod.ts";
import { MIND, sessionAddress } from "./session.ts";
import type { Json } from "./types.ts";

/** Run `fn` on the org's registry: the handle given, or one opened for the call. */
async function reading<T>(
  root: string,
  log: Registry | undefined,
  fn: (log: Registry) => Promise<T>,
): Promise<T> {
  if (log) return await fn(log);
  const own = await (await openStore(root)).log();
  try {
    return await fn(own);
  } finally {
    await own.close();
  }
}

/** The org at `root` as it stands. `log` is the caller's open handle on the store, when
 *  it holds one. */
export async function readConfig(root: string, log?: Registry): Promise<OrgConfig> {
  const { deployment } = await readFile(root);
  return await reading(
    root,
    log,
    async (r) => orgOf(deployment, await r.config(), await r.agents()),
  );
}

/** A connector's reader: its knobs as the store holds them, over its spec's defaults —
 *  unknown keys error and each `check` runs. What a connect flow discovers belongs in the
 *  tables, and a missing knob means its default. */
export async function connectorConfig<T extends object>(
  root: string,
  spec: ConnectorSpec,
  log?: Registry,
): Promise<T & RoomKnobs> {
  return knobsOf<T>(await readConfig(root, log), spec, root);
}

/** The org as a running process reads it on each use: one call per unit of work, a turn,
 *  a delivery, a poll, and the snapshot it answers held until that work ends. A call asks
 *  the store's config version and reads the org again only when it moved. `deployment`
 *  is the file's, read once here: where the store is changes only with a start. */
export async function liveConfig(
  root: string,
  log: Registry,
): Promise<() => Promise<OrgConfig>> {
  const { deployment } = await readFile(root);
  let held: { version: number; org: OrgConfig } | undefined;
  return async () => {
    const version = await log.configVersion();
    if (held?.version !== version) {
      held = { version, org: orgOf(deployment, await log.config(), await log.agents()) };
    }
    return held.org;
  };
}

/** A connector's knobs, read on each use the way `liveConfig` reads the org. */
export async function liveKnobs<T extends object>(
  root: string,
  spec: ConnectorSpec,
  log: Registry,
): Promise<() => Promise<T & RoomKnobs>> {
  const org = await liveConfig(root, log);
  let held: { org: OrgConfig; knobs: T & RoomKnobs } | undefined;
  return async () => {
    const now = await org();
    if (held?.org !== now) held = { org: now, knobs: knobsOf<T>(now, spec, root) };
    return held.knobs;
  };
}

/** A key the file and the store both moved, apart: the path as the file spells it, and
 *  each one's value (`undefined` where the store holds none). */
export interface Conflict {
  path: string;
  file: Json;
  store: Json | undefined;
}

/** What an apply did: the org as it now stands, and the conflicts it left to the store. */
export interface Applied {
  org: OrgConfig;
  conflicts: Conflict[];
}

/** The scope a roster entry's leaves are weighed under. */
const ROSTER = "roster.";
const rosterScope = (name: string): string => `${ROSTER}${name}`;
const PRINCIPALS = "principals";

/** The roster entries the file declares, as leaves: the entry, each identity key it
 *  states, and its principals when it states them. */
function declaredRoster(agents: Declared["agents"]): ConfigRow[] {
  return Object.entries(agents).flatMap(([name, entry]) => {
    const scope = rosterScope(name);
    return [
      { scope, key: DECLARED, value: true },
      ...Object.entries(entry.identity).map(([key, value]) => ({
        scope,
        key,
        value: value ?? null,
      })),
      ...(entry.principals !== undefined
        ? [{ scope, key: PRINCIPALS, value: entry.principals as Json }]
        : []),
    ];
  });
}

/** The roster's rows as the same leaves: a handle or principals a row lacks is null. */
function storedRoster(rows: AgentRow[]): ConfigRow[] {
  return rows.flatMap((row) => {
    const scope = rosterScope(row.agentId);
    return [
      { scope, key: DECLARED, value: true },
      ...IDENTITY_KEYS.map((key) => ({ scope, key, value: row[key] ?? null })),
      { scope, key: PRINCIPALS, value: (row.principals ?? null) as Json },
    ];
  });
}

const at = (r: { scope: string; key: string }) => `${r.scope}\0${r.key}`;
const byPath = (rows: ConfigRow[]) => new Map(rows.map((r) => [at(r), r]));

/** A JSON value spelled one way whatever order its object keys came in. */
function canonical(v: Json | undefined): string | undefined {
  if (v === undefined) return undefined;
  return JSON.stringify(
    v,
    (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1))
        : value,
  );
}
const same = (a?: ConfigRow, b?: ConfigRow) => canonical(a?.value) === canonical(b?.value);

/** A leaf's path as the file spells it. */
export function pathOf({ scope, key }: { scope: string; key: string }): string {
  if (scope.startsWith(ROSTER)) {
    const agent = agentScope(scope.slice(ROSTER.length));
    if (key === DECLARED) return agent;
    return key === PRINCIPALS ? `${agent}.${PRINCIPALS}` : `${agent}.identity.${key}`;
  }
  return key === DECLARED ? scope : `${scope}.${key}`;
}

/** Apply `<root>/config.yaml` to the store, three-way, and answer the org as it now stands
 *  with the conflicts the apply left. A row with no backlog floor, new here or met for the
 *  first time, gets it: `now` less the org's `backlogHours`. */
export async function applyFile(
  root: string,
  log: Registry,
  opts: { overwrite?: boolean; now?: number } = {},
): Promise<Applied> {
  const declared = await readFile(root);
  const file = byPath([...declared.leaves, ...declaredRoster(declared.agents)]);
  const base = byPath(await log.base());
  const roster = await log.agents();
  const config = await log.config();
  const store = byPath([...config, ...storedRoster(roster)]);

  const taken = new Map<string, ConfigRow>();
  const kept = new Map<string, ConfigRow>(); // conflicts: the base each one keeps
  const conflicts = new Map<string, Conflict>();
  const conflict = (path: string, f: ConfigRow, b?: ConfigRow) => {
    conflicts.set(path, { path: pathOf(f), file: f.value, store: store.get(path)?.value });
    if (b) kept.set(path, b);
  };
  for (const [path, f] of file) {
    const b = base.get(path);
    const s = store.get(path);
    if (same(f, s)) continue;
    if (opts.overwrite || same(s, b)) taken.set(path, f);
    else if (!same(f, b)) conflict(path, f, b);
  }
  // an entry the store does not hold and the apply does not make takes none of its leaves:
  // each one the file moved is a conflict with the agent's absence
  const absent = new Set(
    Object.keys(declared.agents).filter((name) =>
      !store.has(at({ scope: rosterScope(name), key: DECLARED })) &&
      !taken.has(at({ scope: rosterScope(name), key: DECLARED }))
    ),
  );
  const ownerOf = (scope: string) =>
    scope.startsWith(ROSTER)
      ? scope.slice(ROSTER.length)
      : scope.startsWith("agents.")
      ? scope.slice("agents.".length)
      : null;
  for (const [path, f] of taken) {
    const owner = ownerOf(f.scope);
    if (owner === null || !absent.has(owner)) continue;
    taken.delete(path);
    conflict(path, f, base.get(path));
  }

  // the org as it would stand: the store's rows with the taken leaves laid over them
  const rows = byPath(config);
  const byId = new Map(roster.map(({ runs: _runs, ...row }) => [row.agentId, row]));
  const touched = new Set<string>();
  const takenRows = [...taken.values()];
  for (const f of takenRows.filter((f) => f.scope.startsWith(ROSTER) && f.key === DECLARED)) {
    const name = f.scope.slice(ROSTER.length);
    if (!byId.has(name)) byId.set(name, { agentId: name, mind: sessionAddress(name, MIND) });
    touched.add(name);
  }
  for (const f of takenRows) {
    if (!f.scope.startsWith(ROSTER)) {
      rows.set(at(f), f);
      continue;
    }
    if (f.key === DECLARED) continue;
    const name = f.scope.slice(ROSTER.length);
    const row = byId.get(name)!;
    if (f.key === PRINCIPALS) row.principals = f.value as string[] | "*";
    else {
      const key = f.key as (typeof IDENTITY_KEYS)[number];
      if (f.value === null) delete row[key];
      else row[key] = f.value as string;
    }
    touched.add(name);
  }
  const all = [...byId.values()];
  const next = orgOf(declared.deployment, [...rows.values()], all);
  validateOrg(next, `${root}/${CONFIG_FILE}`);

  const since = new Date((opts.now ?? Date.now()) - next.shared.backlogHours * 3_600_000)
    .toISOString();
  const puts = all.filter((row) => touched.has(row.agentId) || row.since === undefined);
  await log.putAgents(puts.map((row) => ({ ...row, since: row.since ?? since })));
  await log.setConfig(takenRows.filter((f) => !f.scope.startsWith(ROSTER)));
  // the base is the file as it reads now, but where a conflict stands: that key keeps the
  // base it had, so the next apply weighs it again
  const nextBase = new Map(file);
  for (const path of conflicts.keys()) {
    const b = kept.get(path);
    if (b) nextBase.set(path, b);
    else nextBase.delete(path);
  }
  await log.setBase([...nextBase.values()]);
  return { org: next, conflicts: [...conflicts.values()] };
}

/** What an apply that left conflicts says: each key with both values, and the ways out. */
export function conflictLines(conflicts: Conflict[]): string[] {
  if (conflicts.length === 0) return [];
  const value = (v: Json | undefined) => v === undefined ? "nothing" : JSON.stringify(v);
  return [
    `${CONFIG_FILE} and the store both changed ${
      conflicts.length === 1 ? "this key" : `these ${conflicts.length} keys`
    }, so the store's value stays:`,
    ...conflicts.map((c) =>
      `  ${c.path}: the file says ${value(c.file)}, the store ${value(c.store)}`
    ),
    "`liquen reload --overwrite` takes the file's; `liquen config` prints the store, for " +
    `${CONFIG_FILE} to match it`,
  ];
}
