/**
 * connect/slack/config.ts — the slack connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.slack` and are validated at boot.
 *
 * The two scope lists are the ONE source: the oauth door asks Slack for exactly these
 * (`scope` / `user_scope`) and the app manifest `mu connect slack` prints is filled from
 * them (`withScopes`) — so the app you create and the consent you request cannot drift.
 */

import { checkPort, checkStrings, connectorConfig, type ConnectorSpec } from "../../config.ts";

export const DEFAULT_INGEST_PORT = 8789;
export const DEFAULT_OAUTH_PORT = 8790;
/** The BOT is one identity for the whole org: it sees a channel only once invited, so
 *  reading the roster and the history of what it was invited to is the whole job. */
export const DEFAULT_BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "users:read",
  "chat:write",
];
/** A USER token acts AS that human and therefore sees what they see — which is why the
 *  list is longer: enumerating their private channels, DMs and group DMs needs the three
 *  `:read`s a bot has no use for, and search/files have no bot equivalent at all. */
export const DEFAULT_USER_SCOPES = [
  ...DEFAULT_BOT_SCOPES,
  "groups:read",
  "im:read",
  "mpim:read",
  "search:read",
  "files:read",
];

export interface SlackConfig {
  ingestPort: number;
  oauthPort: number;
  botScopes: string[];
  userScopes: string[];
}

export const SPEC: ConnectorSpec = {
  name: "slack",
  doc: "slack — ingest (HTTP mode), the hosted oauth door, dispatch",
  entries: [
    {
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc: "the HTTP-mode ingest port (Socket Mode needs none); 0 = any free port, announced",
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
      doc: "the org leg: scopes the bot token is granted (the app manifest asks for these)",
      check: checkStrings,
    },
    {
      key: "userScopes",
      value: DEFAULT_USER_SCOPES,
      doc: "the per-principal leg: scopes a member's own token is granted",
      check: checkStrings,
    },
  ],
};

/** Read (and heal) `connections.slack` from the org's config.jsonc. */
export function slackConfig(root: string): Promise<SlackConfig> {
  return connectorConfig<SlackConfig>(root, SPEC);
}
