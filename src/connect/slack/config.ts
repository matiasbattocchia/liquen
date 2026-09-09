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
 *  reading the roster and the history of what it was invited to is the whole job — the
 *  attachments included: `files:read` is what lets the bot token fetch a shared file's
 *  `url_private` (the media seam's download); without it Slack answers a sign-in page. */
export const DEFAULT_BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "users:read",
  // the profile email — the handle the classifier scans the roster with (§4)
  "users:read.email",
  "files:read",
  "chat:write",
];
/** A USER token acts AS that human and therefore sees what they see — which is why the
 *  list is longer: enumerating their private channels, DMs and group DMs needs the three
 *  `:read`s a bot has no use for, and search has no bot equivalent at all. */
export const DEFAULT_USER_SCOPES = [
  ...DEFAULT_BOT_SCOPES,
  "groups:read",
  "im:read",
  "mpim:read",
  "search:read",
  // conversations.open, which the user door calls to resolve the self-DM: notes-to-self
  // IS the mind on this surface (§4), and without this the binding cannot be made
  "im:write",
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

/** What the ask did not get. Slack states what a token MAY do in two places — the
 *  `x-oauth-scopes` header on every Web API response, `scope` on an oauth exchange —
 *  and a token short of the ask fails at the CALL, with `missing_scope`, long after the
 *  door that stored it said it was connected. Comma- or space-separated, both arrive. */
export function missingScopes(asked: string[], granted?: string[] | string): string[] {
  const list = Array.isArray(granted) ? granted : (granted ?? "").split(/[,\s]+/);
  const has = new Set(list.filter(Boolean));
  return asked.filter((s) => !has.has(s));
}

/** Read (and heal) `connections.slack` from the org's config.jsonc. */
export function slackConfig(root: string): Promise<SlackConfig> {
  return connectorConfig<SlackConfig>(root, SPEC);
}
