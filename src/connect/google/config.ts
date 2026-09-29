/**
 * connect/google/config.ts — the google connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.google` and are validated at boot.
 */

import { checkAmong, checkStrings, connectorConfig, type ConnectorSpec } from "../../config.ts";

/** What the connection can read into the log, each by its own ingest in `run.ts`. */
export const SURFACES = ["calendar", "mail"] as const;
export type Surface = typeof SURFACES[number];
export const DEFAULT_LISTEN: Surface[] = [...SURFACES];
export const DEFAULT_CALENDARS = ["primary"];
/** Identity, the calendar, and the mailbox read and sent: the product. The mail poll runs
 *  only on a grant whose consent carries a mail read scope (`mail.ts`), so a grant made
 *  before mail joined keeps its calendar and takes mail on re-consent. */
export const DEFAULT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
/** The grant's proxy declaration (§9), written onto every vault row this connector mints:
 *  the env var main fronts the placeholder under, and the only hosts the token may be
 *  spent toward (the swap refuses any other dial). */
export const GRANT_ENV = "GOOGLE_WORKSPACE_CLI_TOKEN";
export const GRANT_HOSTS = ["*.googleapis.com"];

export interface GoogleConfig {
  listen: Surface[];
  calendars: string[];
  scopes: string[];
}

export const SPEC: ConnectorSpec = {
  name: "google",
  doc: "google — the oauth door, the calendar poll, and Gmail in and out",
  entries: [
    {
      key: "listen",
      value: DEFAULT_LISTEN,
      doc:
        'what the connection reads into the log: "calendar", "mail"; one left out is still reached through the grant (gws), and sends go out either way',
      check: checkAmong(SURFACES),
    },
    {
      key: "calendars",
      value: DEFAULT_CALENDARS,
      doc: 'calendars the poll watches on every grant; "primary" = the account\'s own',
      check: checkStrings,
    },
    {
      key: "scopes",
      value: DEFAULT_SCOPES,
      doc: "OAuth scopes a new grant asks for (a /start ?scopes= overrides per-link)",
      check: checkStrings,
    },
  ],
};

/** Read (and heal) `connections.google` from the org's config.jsonc. */
export function googleConfig(root: string): Promise<GoogleConfig> {
  return connectorConfig<GoogleConfig>(root, SPEC);
}
