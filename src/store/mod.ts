/**
 * store/mod.ts — the org's store, opened where the catalog says it is (DESIGN §9).
 *
 * Every process of an org — main, the scheduler, each connector, the setup doors — reaches
 * the log, the vault and the docs through `openStore(root)`: the catalog's `system.database`
 * names the engine, `system.docs` where the docs live, and the rest of the process never
 * learns which it got. Null is SQLite in `data/log`, the embedded engine every deployment
 * starts on; a Postgres URL is a schema of that database, the same ports over a server
 * (`src/store/pg/`). The docs are files under the data root unless the catalog puts them
 * in that database's docs table — a switch of its own, so an org whose log moved keeps its
 * docs where they are.
 *
 * The URL carries no password: the driver reads `PGPASSWORD`, libpq's own name, and the
 * catalog stays a declaration git can hold. A `schema` query parameter names the schema,
 * `public` otherwise, so one database serves several orgs.
 */

import { type Log, openLog } from "./log.ts";
import { type Credentials, openCredentials } from "./credentials.ts";
import { type DocContext, type Docs, openFileDocs } from "./docs.ts";
import { openPgLog } from "./pg/log.ts";
import { openPgCredentials } from "./pg/credentials.ts";
import { type DocCalls, openPgDocs } from "./pg/docs.ts";
import { onFiles, type Seedbed } from "./seed.ts";
import { readConfig } from "../config.ts";

/** The docs as a process opens them: the read port, the bed the seeds go in, and — where
 *  the docs live in the table — the agent's own reach, the substrate tool (§9). */
export interface DocStore extends Docs {
  bed: Seedbed;
  as?: (ctx: DocContext) => DocCalls;
  close(): Promise<void>;
}

/** An org's store: the log, the vault and the docs, each a handle of its own on the same
 *  rows. `now` is the clock a lease and an OAuth state age against (§9). */
export interface Store {
  log(opts?: { now?: () => number }): Promise<Log>;
  vault(opts?: { now?: () => number }): Promise<Credentials>;
  docs(): Promise<DocStore>;
}

/** The catalog's `system.database` and `system.docs` as an address: an engine, where its
 *  rows live, and where the docs are. `dir` is the org's data root: the SQLite files are
 *  under it, and so are the docs when they are files. */
export type Database =
  | { engine: "sqlite"; dir: string }
  | { engine: "postgres"; url: string; schema: string; dir: string; docs: "files" | "table" };

/** The address `database` names, with the files under `dir`. */
export function databaseOf(
  dir: string,
  database: string | null,
  docs: "files" | "table" = "files",
): Database {
  if (database === null) return { engine: "sqlite", dir };
  const url = new URL(database);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  return { engine: "postgres", url: url.toString(), schema, dir, docs };
}

/** The store at an address. */
export function storeAt(at: Database): Store {
  const files = (): DocStore => ({
    ...openFileDocs(at.dir),
    bed: onFiles(at.dir),
    close: () => Promise.resolve(),
  });
  if (at.engine === "sqlite") {
    return {
      log: (opts) => openLog(`${at.dir}/log`, opts),
      vault: (opts) => openCredentials(at.dir, opts),
      docs: () => Promise.resolve(files()),
    };
  }
  return {
    log: (opts) => openPgLog(at.url, { schema: at.schema, ...opts }),
    vault: (opts) => openPgCredentials(at.url, { schema: at.schema, ...opts }),
    docs: async () => {
      if (at.docs === "files") return files();
      const docs = await openPgDocs(at.url, { schema: at.schema });
      return { ...docs, bed: { laid: docs.laid, lay: docs.lay } };
    },
  };
}

/** The store of the org at `root`: its catalog read, the address resolved. */
export async function openStore(root: string): Promise<Store> {
  const catalog = await readConfig(root);
  return storeAt(databaseOf(`${root}/data`, catalog.system.database, catalog.system.docs));
}
