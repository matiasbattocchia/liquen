/**
 * connect/google/config.ts — the google connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.google` and are validated at boot.
 */

import {
  checkPort,
  checkStrings,
  type ConnectorSpec,
  ensureConnectorConfig,
} from "../../config.ts";

export const DEFAULT_CALENDARS = ["primary"];
export const DEFAULT_OAUTH_PORT = 8791;
export const DEFAULT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
];

export interface GoogleConfig {
  calendars: string[];
  oauthPort: number;
  scopes: string[];
}

const SPEC: ConnectorSpec = {
  name: "google",
  doc: "google — the oauth door and the calendar poll",
  entries: [
    {
      key: "calendars",
      value: DEFAULT_CALENDARS,
      doc: 'calendars the poll watches on every grant; "primary" = the account\'s own',
      check: checkStrings,
    },
    {
      key: "oauthPort",
      value: DEFAULT_OAUTH_PORT,
      doc: "the oauth door's localhost port (hosted callback or the account door)",
      check: checkPort,
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
export function googleConfig(dir = "./data"): Promise<GoogleConfig> {
  return ensureConnectorConfig<GoogleConfig>(dir, SPEC);
}
