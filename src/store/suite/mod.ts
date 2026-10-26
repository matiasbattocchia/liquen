/**
 * store/suite — the store's contract as tests, run over an adapter (DESIGN §9).
 *
 * Each module here is one port area's suite: a function that registers its tests over a
 * `Substrate`, the one thing an adapter has to provide. The SQLite adapter runs every suite
 * (`src/store/*.test.ts`); an adapter is done when it runs them too, and its DDL is written
 * against them.
 */

import { DatabaseSync } from "node:sqlite";
import type { Log } from "../log.ts";
import type { Credentials } from "../credentials.ts";
import type { DocScope, DocTable } from "../docs.ts";
import { openSqliteDocs } from "../doctable.ts";
import { type DocStore, storeAt } from "../mod.ts";
import { connect } from "../pg/sql.ts";
import { ident } from "../pg/schema.ts";
import { openPgDocs } from "../pg/docs.ts";

/** What a suite gets a store from: a store nothing has written to, per test. */
export interface Substrate {
  fresh(): Promise<Store>;
}

/** One store, from empty to dropped. Every `open` is a process's own handle on it — the
 *  cross-process cases are two handles — and the vault is the same store's, on a handle of
 *  its own. `drop` ends it; the caller has closed its handles by then. */
export interface Store {
  open(opts?: { now?: () => number }): Promise<Log>;
  vault(opts?: { now?: () => number }): Promise<Credentials>;
  drop(): Promise<void>;
}

/** A store, opened once, for the length of `fn`. */
export async function withStore(
  s: Substrate,
  fn: (log: Log, store: Store) => Promise<void>,
): Promise<void> {
  const store = await s.fresh();
  const log = await store.open();
  try {
    await fn(log, store);
  } finally {
    await log.close();
    await store.drop();
  }
}

/** The local adapter: one `log.db` in a folder of its own, the vault beside the log in
 *  it, as an org's data root lays them out. */
export const sqlite: Substrate = {
  async fresh(): Promise<Store> {
    const dir = await Deno.makeTempDir();
    const store = storeAt({ engine: "sqlite", dir, docs: "files" });
    return {
      open: store.log,
      vault: store.vault,
      drop: () => Deno.remove(dir, { recursive: true }),
    };
  },
};

/** The Postgres adapter: a schema of its own per store, in the database at `url`, dropped
 *  whole at the end. */
export function postgres(url: string): { fresh(): Promise<Store & { schema: string }> } {
  return {
    fresh() {
      const schema = `liquen_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      // the docs are the schema's own table: no data root is needed, none is given
      const store = storeAt({ engine: "postgres", url, schema, dir: "", docs: "table" });
      return Promise.resolve({
        schema,
        open: store.log,
        vault: store.vault,
        drop: async () => {
          const sql = connect(url);
          try {
            await sql.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
          } finally {
            await sql.end();
          }
        },
      });
    },
  };
}

/** A docs table, opened, and the org's own hand on its rows: what the docs suite
 *  (`suite/docs.ts`) gets from an engine. */
export interface DocsBench {
  docs: DocTable;
  /** Write a row past every agent's rule, as the org does: laid, replaced, or gone (null). */
  set(scope: DocScope, owner: string, name: string, text: string | null): Promise<void>;
  /** Every row, `scope/owner/name` and its text, in key order. */
  rows(): Promise<{ key: string; text: string }[]>;
  /** The same table's docs as the store opens them where the catalog puts them there. */
  store(): Promise<DocStore>;
  close(): Promise<void>;
}

export interface DocsSubstrate {
  fresh(): Promise<DocsBench>;
}

/** SQLite's docs table: the one in `log.db` under a data root of its own. */
export const sqliteDocs: DocsSubstrate = {
  async fresh(): Promise<DocsBench> {
    const dir = await Deno.makeTempDir();
    const docs = await openSqliteDocs(dir);
    const db = new DatabaseSync(`${dir}/log/log.db`);
    return {
      docs,
      set(scope, owner, name, text) {
        if (text === null) {
          db.prepare("DELETE FROM docs WHERE scope = ? AND owner = ? AND name = ?")
            .run(scope, owner, name);
        } else {
          db.prepare(
            `INSERT INTO docs (scope, owner, name, text, updated_at) VALUES (?, ?, ?, ?, 't')
             ON CONFLICT (scope, owner, name) DO UPDATE SET text = excluded.text`,
          ).run(scope, owner, name, text);
        }
        return Promise.resolve();
      },
      rows: () =>
        Promise.resolve(
          db.prepare(
            `SELECT scope || '/' || owner || '/' || name AS key, text FROM docs
             ORDER BY scope, owner, name`,
          ).all() as { key: string; text: string }[],
        ),
      store: () => storeAt({ engine: "sqlite", dir, docs: "table" }).docs(),
      async close() {
        db.close();
        await docs.close();
        await Deno.remove(dir, { recursive: true });
      },
    };
  },
};

/** Postgres's docs table: the one in a schema of its own, dropped at the end. */
export function postgresDocs(url: string): DocsSubstrate {
  return {
    async fresh(): Promise<DocsBench> {
      const store = await postgres(url).fresh();
      const docs = await openPgDocs(url, { schema: store.schema });
      const sql = connect(url, store.schema);
      return {
        docs,
        async set(scope, owner, name, text) {
          if (text === null) {
            await sql.unsafe(
              "DELETE FROM docs WHERE scope = $1::text AND owner = $2::text AND name = $3::text",
              [scope, owner, name],
            );
          } else {
            await sql.unsafe(
              `INSERT INTO docs (scope, owner, name, text, updated_at)
               VALUES ($1::text, $2::text, $3::text, $4::text, 't')
               ON CONFLICT (scope, owner, name) DO UPDATE SET text = excluded.text`,
              [scope, owner, name, text],
            );
          }
        },
        rows: async () =>
          (await sql.unsafe(
            `SELECT scope || '/' || owner || '/' || name AS key, text FROM docs
             ORDER BY scope, owner, name`,
          )) as unknown as { key: string; text: string }[],
        store: () =>
          storeAt({ engine: "postgres", url, schema: store.schema, dir: "", docs: "table" })
            .docs(),
        async close() {
          await sql.end();
          await docs.close();
          await store.drop();
        },
      };
    },
  };
}
