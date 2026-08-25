/**
 * connect/slack/config.ts — the slack connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.slack` and are validated at boot.
 */

import {
  checkPort,
  checkStrings,
  type ConnectorSpec,
  ensureConnectorConfig,
} from "../../config.ts";

export const DEFAULT_INGEST_PORT = 8789;
export const DEFAULT_OAUTH_PORT = 8790;
export const DEFAULT_BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "users:read",
  "chat:write",
];

export interface SlackConfig {
  ingestPort: number;
  oauthPort: number;
  botScopes: string[];
}

const SPEC: ConnectorSpec = {
  name: "slack",
  doc: "slack — ingest (HTTP mode), the hosted oauth door, dispatch",
  entries: [
    {
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc: "the HTTP-mode ingest port (Socket Mode needs none)",
      check: checkPort,
    },
    {
      key: "oauthPort",
      value: DEFAULT_OAUTH_PORT,
      doc: "the hosted oauth door's port",
      check: checkPort,
    },
    {
      key: "botScopes",
      value: DEFAULT_BOT_SCOPES,
      doc: "bot scopes a new install asks for",
      check: checkStrings,
    },
  ],
};

/** Read (and heal) `connections.slack` from the org's config.jsonc. */
export function slackConfig(dir = "./data"): Promise<SlackConfig> {
  return ensureConnectorConfig<SlackConfig>(dir, SPEC);
}
