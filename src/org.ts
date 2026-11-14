/**
 * org.ts — the org's configuration as it stands, and the file applied to it (DESIGN §9).
 *
 * The store holds the configuration (`store/agents.ts`); `config.yaml` is input. Two
 * moves live here:
 *
 *   readConfig   the org as every process runs on it: `deployment` off the file, the
 *                rest off the store over the catalog's defaults.
 *   applyFile    what boot and `liquen reload` do with the file. A key it declares
 *                overwrites the store's; a key it leaves out keeps the store's value; an
 *                agent it does not name is left alone. Taking a key out of the file stops
 *                pinning it, and resets nothing. The org as it would stand is checked
 *                whole before a row is written, so a file boot cannot run changes nothing.
 */

import {
  CONFIG_FILE,
  type ConnectorSpec,
  IDENTITY_KEYS,
  knobsOf,
  type OrgConfig,
  orgOf,
  readFile,
  type RoomKnobs,
  validateOrg,
} from "./config.ts";
import type { AgentRow, ConfigRow, Registry } from "./store/agents.ts";
import { openStore } from "./store/mod.ts";
import { MIND, sessionAddress } from "./session.ts";

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

/** The roster with the file's entries laid over it: a handle the file states replaces the
 *  row's (`null` clears it), principals it states replace the row's, and an entry with no
 *  row is a new one. The rows the file touched are returned beside the whole roster. */
function rosterWith(
  roster: AgentRow[],
  declared: Awaited<ReturnType<typeof readFile>>["agents"],
): { all: AgentRow[]; touched: AgentRow[] } {
  const byId = new Map(roster.map(({ runs: _runs, ...row }) => [row.agentId, row]));
  const touched: AgentRow[] = [];
  for (const [name, entry] of Object.entries(declared)) {
    const row: AgentRow = {
      ...(byId.get(name) ?? { agentId: name, mind: sessionAddress(name, MIND) }),
    };
    for (const key of IDENTITY_KEYS) {
      if (!(key in entry.identity)) continue;
      const handle = entry.identity[key];
      if (handle === null || handle === undefined) delete row[key];
      else row[key] = handle;
    }
    if (entry.principals !== undefined) row.principals = entry.principals;
    byId.set(name, row);
    touched.push(row);
  }
  return { all: [...byId.values()], touched };
}

/** Apply `<root>/config.yaml` to the store, and answer the org as it now stands. A row
 *  with no backlog floor, new here or met for the first time, gets it: `now` less the
 *  org's `backlogHours`. */
export async function applyFile(
  root: string,
  log: Registry,
  now: number = Date.now(),
): Promise<OrgConfig> {
  const declared = await readFile(root);
  const leaf = (r: ConfigRow) => `${r.scope}\0${r.key}`;
  const rows = new Map((await log.config()).map((r) => [leaf(r), r]));
  for (const r of declared.leaves) rows.set(leaf(r), r);
  const { all, touched } = rosterWith(await log.agents(), declared.agents);
  const next = orgOf(declared.deployment, [...rows.values()], all);
  validateOrg(next, `${root}/${CONFIG_FILE}`);
  const since = new Date(now - next.shared.backlogHours * 3_600_000).toISOString();
  const puts = new Map(touched.map((row) => [row.agentId, row]));
  for (const row of all) if (row.since === undefined) puts.set(row.agentId, row);
  await log.putAgents([...puts.values()].map((row) => ({ ...row, since: row.since ?? since })));
  await log.setConfig(declared.leaves);
  return next;
}
