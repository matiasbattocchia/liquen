/**
 * connect/google/config.ts — the google connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.google` and are validated at boot.
 */

import { checkPort, checkStrings, connectorConfig, type ConnectorSpec } from "../../config.ts";

export const DEFAULT_CALENDARS = ["primary"];
export const DEFAULT_OAUTH_PORT = 8791;
export const DEFAULT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
];
/** The grant's proxy declaration (§9), written onto every vault row this connector mints:
 *  the env var main fronts the placeholder under, and the only hosts the token may be
 *  spent toward (the swap refuses any other dial). */
export const GRANT_ENV = "GOOGLE_WORKSPACE_CLI_TOKEN";
export const GRANT_HOSTS = ["*.googleapis.com"];

export interface GoogleConfig {
  calendars: string[];
  oauthPort: number;
  scopes: string[];
}

export const SPEC: ConnectorSpec = {
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
      doc:
        "the port the account door binds when the app's callback is remote; a loopback one names its own",
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
export function googleConfig(root: string): Promise<GoogleConfig> {
  return connectorConfig<GoogleConfig>(root, SPEC);
}
