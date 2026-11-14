/**
 * connect/telegram/config.ts — the telegram connector's catalog (the config rules, §4):
 * its defaults live here and nowhere else; the values heal under `connections.telegram`
 * (`config.yaml`, or the store) and are validated at boot.
 *
 * Secrets live in the vault, written by `liquen connect telegram`: `telegram:app` (the
 * api id and hash Telegram issues an application) and `telegram:<user id>` (an account's
 * session). What is not secret and not a knob is where a session's cache lies, which is
 * the org's own folder: `data/telegram/<user id>.session`.
 */

import type { ConnectorSpec, RoomKnobs } from "../../config.ts";
import { connectorConfig } from "../../org.ts";

export const DEFAULT_BIOS = true;
export const DEFAULT_HISTORY_DAYS = 60;

export interface TelegramConfig {
  bios: boolean;
  historyDays: number;
}

/** Who signs the grant note a sign-in publishes: the line the running process takes an
 *  account up by. */
export const GRANT_SENDER = "telegram-connect";

/** The vault key of the application's credentials. */
export const APP_KEY = "telegram:app";

/** The vault key of an account's session. */
export const sessionKey = (account: string): string => `telegram:${account}`;

/** The cache of an account's session: the peers it has met and its update cursors. */
export const cachePath = (root: string, account: string): string =>
  `${root}/data/telegram/${account}.session`;

/** The sign-in whose history the process imported for an account, by its grant note's
 *  time: a newer note is a sign-in still owed its import. */
export const historyPath = (root: string, account: string): string =>
  `${root}/data/telegram/${account}.history`;

export const SPEC: ConnectorSpec = {
  name: "telegram",
  doc: "telegram — an account's MTProto session: ingest, dispatch, the book and the rooms",
  entries: [
    {
      key: "bios",
      value: DEFAULT_BIOS,
      doc:
        "read what a stranger wrote about themselves (their profile's about text) onto the first line they write in a direct chat or a private group",
      check: (v) => typeof v === "boolean" ? null : "must be true or false",
    },
    {
      key: "historyDays",
      value: DEFAULT_HISTORY_DAYS,
      doc:
        "how many days of every chat a sign-in imports, as history: kept and searchable, never news; a file is named and left on Telegram. 0 imports nothing",
      check: (v) =>
        Number.isInteger(v) && (v as number) >= 0 ? null : "must be a whole number, 0 or more",
    },
  ],
};

/** Read `connections.telegram` as the org's store holds it. */
export function telegramConfig(root: string): Promise<TelegramConfig & RoomKnobs> {
  return connectorConfig<TelegramConfig>(root, SPEC);
}
