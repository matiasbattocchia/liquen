/**
 * store/mod.ts — the org's store, opened where the catalog says it is (DESIGN §9).
 *
 * Every process of an org — main, the scheduler, each connector, the setup doors — reaches
 * the log and the vault through `openStore(root)`: the catalog's `system.database` names
 * the engine, and the rest of the process never learns which one it got. Null is SQLite in
 * `data/log`, the embedded engine every deployment starts on; a Postgres URL is a schema
 * of that database, the same ports over a server (`src/store/pg/`).
 *
 * The URL carries no password: the driver reads `PGPASSWORD`, libpq's own name, and the
 * catalog stays a declaration git can hold. A `schema` query parameter names the schema,
 * `public` otherwise, so one database serves several orgs.
 */

import { type Log, openLog } from "./log.ts";
import { type Credentials, openCredentials } from "./credentials.ts";
import { openPgLog } from "./pg/log.ts";
import { openPgCredentials } from "./pg/credentials.ts";
import { readConfig } from "../config.ts";

/** An org's store: the log and the vault, each a handle of its own on the same rows. `now`
 *  is the clock a lease and an OAuth state age against (§9). */
export interface Store {
  log(opts?: { now?: () => number }): Promise<Log>;
  vault(opts?: { now?: () => number }): Promise<Credentials>;
}

/** The catalog's `system.database` as an address: an engine and where its rows live. */
export type Database =
  | { engine: "sqlite"; dir: string } // the org's data root: `log/` under it holds the file
  | { engine: "postgres"; url: string; schema: string };

/** The address `database` names, with the SQLite files under `dir`. */
export function databaseOf(dir: string, database: string | null): Database {
  if (database === null) return { engine: "sqlite", dir };
  const url = new URL(database);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  return { engine: "postgres", url: url.toString(), schema };
}

/** The store at an address. */
export function storeAt(at: Database): Store {
  if (at.engine === "sqlite") {
    return {
      log: (opts) => openLog(`${at.dir}/log`, opts),
      vault: (opts) => openCredentials(at.dir, opts),
    };
  }
  return {
    log: (opts) => openPgLog(at.url, { schema: at.schema, ...opts }),
    vault: (opts) => openPgCredentials(at.url, { schema: at.schema, ...opts }),
  };
}

/** The store of the org at `root`: its catalog read, the address resolved. */
export async function openStore(root: string): Promise<Store> {
  const catalog = await readConfig(root);
  return storeAt(databaseOf(`${root}/data`, catalog.system.database));
}
