/**
 * store/suite — the store's contract as tests, run over an adapter (DESIGN §9).
 *
 * Each module here is one port area's suite: a function that registers its tests over a
 * `Substrate`, the one thing an adapter has to provide. The SQLite adapter runs every suite
 * (`src/store/*.test.ts`); an adapter is done when it runs them too, and its DDL is written
 * against them.
 */

import { type Log, openLog } from "../log.ts";
import { type Credentials, openCredentials } from "../credentials.ts";

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
    return {
      open: (opts) => openLog(`${dir}/log`, opts),
      vault: (opts) => openCredentials(dir, opts),
      drop: () => Deno.remove(dir, { recursive: true }),
    };
  },
};
