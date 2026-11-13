/**
 * connect/telegram/accounts.ts — which accounts' sessions the process holds open, kept
 * in line with the store while it runs.
 *
 * The accounts that should be open are the live `telegram` connection rows whose session
 * is in the vault. `reconcile` brings the open ones in line: an account signed in since
 * opens, one removed closes, and one signed in again, whose session string changed,
 * swaps. A swap closes the old session first and only then opens the new one, since two
 * clients on one account's cache would contend for it, and ends the old session on
 * Telegram so the account's list of devices does not keep it. A removed account's
 * session is left standing on Telegram, as every removal leaves the platform's side.
 *
 * Calls are serialized: a reconcile asked while one runs runs after it, once.
 */

import type { ConnectionRow } from "../../store/connections.ts";
import { SignedOut } from "../errors.ts";
import { sessionKey } from "./config.ts";
import { SERVICE, type TgWire } from "./wire.ts";

/** How often the process reconciles of its own accord: a removal says nothing it hears. */
export const RECONCILE_MS = 60_000;

/** An account's session, open. */
export interface Opened {
  wire: TgWire;
  stop: () => Promise<void>;
}

export interface AccountsDeps {
  /** The live connection rows. */
  rows: () => Promise<ConnectionRow[]>;
  /** The session string a vault key holds, if any. */
  session: (key: string) => Promise<string | undefined>;
  /** Open an account's session. Throws `SignedOut` when Telegram no longer takes it. */
  open: (row: ConnectionRow, session: string) => Promise<Opened>;
  /** End a replaced session on Telegram. */
  logOut: (session: string) => Promise<void>;
  /** Say an account down on its row. */
  signedOut: (row: ConnectionRow, error: string) => Promise<void>;
  onError?: (account: string, what: string, err: unknown) => void;
  onOpened?: (account: string, wire: TgWire) => void;
}

export interface Accounts {
  reconcile: () => Promise<void>;
  wireOf: (account: string) => TgWire | undefined;
  /** Close every session, its cursors kept. */
  stop: () => Promise<void>;
}

export function createAccounts(deps: AccountsDeps): Accounts {
  const open = new Map<string, Opened & { session: string }>();
  // the session strings a row failed to open with: tried again only once the vault holds
  // another, by a sign-in
  const refused = new Map<string, string>();
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const close = async (account: string) => {
    const held = open.get(account);
    if (!held) return;
    open.delete(account);
    try {
      await held.stop();
    } catch (err) {
      deps.onError?.(account, "closing", err);
    }
  };

  const pass = async () => {
    const rows = (await deps.rows()).filter((r) => r.service === SERVICE);
    const wanted = new Set<string>();
    for (const row of rows) {
      const account = row.address;
      const session = await deps.session(row.credentialKey ?? sessionKey(account));
      if (!session) {
        await close(account);
        if (row.extra?.state !== "signed_out") {
          await deps.signedOut(row, "no session in the vault: sign in again");
        }
        continue;
      }
      wanted.add(account);
      const held = open.get(account);
      if (held?.session === session || refused.get(account) === session) continue;
      if (held) {
        await close(account);
        await deps.logOut(held.session).catch((err) =>
          deps.onError?.(account, "ending the replaced session", err)
        );
      }
      try {
        const opened = await deps.open(row, session);
        if (stopped) {
          await opened.stop();
          return;
        }
        open.set(account, { ...opened, session });
        refused.delete(account);
        deps.onOpened?.(account, opened.wire);
      } catch (err) {
        if (!(err instanceof SignedOut)) {
          deps.onError?.(account, "opening", err);
          continue;
        }
        refused.set(account, session);
        await deps.signedOut(row, err.message);
      }
    }
    for (const account of [...open.keys()]) {
      if (!wanted.has(account)) await close(account);
    }
  };

  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again && !stopped);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    reconcile,
    wireOf: (account) => open.get(account)?.wire,
    stop: async () => {
      stopped = true;
      await running?.catch(() => {});
      for (const account of [...open.keys()]) await close(account);
    },
  };
}
