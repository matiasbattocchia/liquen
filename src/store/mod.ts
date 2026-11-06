/**
 * store/mod.ts — the org's store, opened where the catalog says it is (DESIGN §9).
 *
 * Every process of an org — main, the scheduler, each connector, the setup doors — reaches
 * the log, the vault and the docs through `openStore(root)`: the catalog's `deployment.database`
 * names the engine, `deployment.docs` where the docs live, and the rest of the process never
 * learns which it got. `sqlite` is SQLite in `data/log`, the embedded engine every
 * deployment starts on; a Postgres URL is a schema of that database, the same ports over a
 * server (`src/store/pg/`). The docs are files under the data root unless the catalog puts
 * them in the database's docs table, on either engine — a switch of its own, so an org whose log
 * moved keeps its docs where they are. The files the org keeps are under `data/storage`
 * unless `deployment.storage` names a bucket, reached over the S3 API (`s3.ts`).
 *
 * The URL carries no password: the driver reads `PGPASSWORD`, libpq's own name, and the
 * catalog stays a declaration git can hold. A `schema` query parameter names the schema,
 * `public` otherwise, so one database serves several orgs.
 */

import { type Log, openLog } from "./log.ts";
import { type Credentials, openCredentials } from "./credentials.ts";
import { type DocCalls, type DocContext, type Docs, type DocTable, openFileDocs } from "./docs.ts";
import { openSqliteDocs } from "./doctable.ts";
import { openPgLog } from "./pg/log.ts";
import { openPgCredentials } from "./pg/credentials.ts";
import { openPgDocs } from "./pg/docs.ts";
import { onFiles, type Relaybed } from "./seed.ts";
import { fileStorage, type Storage } from "./storage.ts";
import { s3AddressOf, s3Storage } from "./s3.ts";
import { readConfig } from "../config.ts";

/** The docs as a process opens them: the read port, the bed the seeds go in, and — where
 *  the docs live in the table — the agent's own reach, the substrate tool (§9). */
export interface DocStore extends Docs {
  bed: Relaybed;
  as?: (ctx: DocContext) => DocCalls;
  close(): Promise<void>;
}

/** An org's store: the log, the vault and the docs, each a handle of its own on the same
 *  rows. `now` is the clock a lease and an OAuth state age against (§9). */
export interface Store {
  log(opts?: { now?: () => number }): Promise<Log>;
  vault(opts?: { now?: () => number }): Promise<Credentials>;
  docs(): Promise<DocStore>;
  /** The object store: the media the org keeps (`storage.ts`). */
  storage(): Storage;
}

/** The catalog's `deployment.database` and `deployment.docs` as an address: an engine, where its
 *  rows live, and where the docs are. `dir` is the org's data root: the SQLite files are
 *  under it, and so are the docs when they are files. */
export type Database =
  & ({ engine: "sqlite" } | { engine: "postgres"; url: string; schema: string })
  & {
    dir: string;
    docs: "filesystem" | "database";
    /** `deployment.storage`: `filesystem`, or a bucket's URL over the S3 API. */
    storage?: string;
  };

/** The address `database` names, with the files under `dir`. */
export function databaseOf(
  dir: string,
  database: string,
  docs: "filesystem" | "database" = "filesystem",
  storage = "filesystem",
): Database {
  if (database === "sqlite") return { engine: "sqlite", dir, docs, storage };
  const url = new URL(database);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  return { engine: "postgres", url: url.toString(), schema, dir, docs, storage };
}

/** The store at an address. */
export function storeAt(at: Database): Store {
  const files = (): DocStore => ({
    ...openFileDocs(at.dir),
    bed: onFiles(at.dir),
    close: () => Promise.resolve(),
  });
  const table = (docs: DocTable): DocStore => ({
    ...docs,
    bed: { laid: docs.laid, lay: docs.lay, text: docs.text, swap: docs.swap },
  });
  // the object store, opened once and on first need: a bucket's keys are read then, so a
  // process that keeps no file never asks for them
  let kept: Storage | undefined;
  const storage = () =>
    kept ??= at.storage === undefined || at.storage === "filesystem"
      ? fileStorage(at.dir)
      : s3Storage(s3AddressOf(at.storage));
  if (at.engine === "sqlite") {
    return {
      log: (opts) => openLog(`${at.dir}/log`, opts),
      vault: (opts) => openCredentials(at.dir, opts),
      docs: async () => at.docs === "filesystem" ? files() : table(await openSqliteDocs(at.dir)),
      storage,
    };
  }
  return {
    log: (opts) => openPgLog(at.url, { schema: at.schema, ...opts }),
    vault: (opts) => openPgCredentials(at.url, { schema: at.schema, ...opts }),
    docs: async () =>
      at.docs === "filesystem" ? files() : table(await openPgDocs(at.url, { schema: at.schema })),
    storage,
  };
}

/** The store of the org at `root`: its catalog read, the address resolved. */
export async function openStore(root: string): Promise<Store> {
  const catalog = await readConfig(root);
  return storeAt(
    databaseOf(
      `${root}/data`,
      catalog.deployment.database,
      catalog.deployment.docs,
      catalog.deployment.storage,
    ),
  );
}
