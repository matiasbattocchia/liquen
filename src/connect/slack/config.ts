/**
 * connect/slack/config.ts — the slack connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * under `connections.slack` (`config.yaml`, or the store) and are validated at boot.
 *
 * The two scope lists are the ONE source: the app manifest `liquen connect slack app` prints
 * is filled from both (`withScopes`), and the user door asks Slack for exactly the user
 * list (`user_scope`) — so the app you create and the consent you request cannot drift.
 */

import { checkStrings, type ConnectorSpec, type RoomKnobs } from "../../config.ts";
import { connectorConfig } from "../../org.ts";

/** What either leg reads. A token sees a room only once in it, so reading the roster,
 *  the history and the names of what it is in is the whole job — the four `:read`s are
 *  what `conversations.info` and `conversations.members` need for a room of each kind —
 *  and the attachments included: `files:read` is what lets a token fetch a shared file's
 *  `url_private` (the media seam's download); without it Slack answers a sign-in page.
 *  A pin is said only as an event, and `pins:read` is what delivers it. */
const READ_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  // the profile email — the handle the classifier scans the roster with (§4)
  "users:read.email",
  "files:read",
  "pins:read",
];
/** The BOT is one identity for the whole org. Its writes are what the rooms port asks
 *  of it (`rooms.ts`): a public channel is `channels:manage` (create, rename, kick, leave)
 *  and `channels:join`, a private one `groups:write`, a direct room `im:write` /
 *  `mpim:write`; an invite is the `:write.invites` of the room's kind. */
export const DEFAULT_BOT_SCOPES = [
  ...READ_SCOPES,
  "chat:write",
  "channels:manage",
  "channels:join",
  "channels:write.invites",
  "groups:write",
  "groups:write.invites",
  "im:write",
  "mpim:write",
];
/** A USER token acts AS that human and therefore sees what they see — and search has no
 *  bot equivalent at all. The rooms port's writes are the same acts under a user's own
 *  names: `channels:write` is the user side of `channels:manage` and `channels:join`.
 *  `im:write` is also what the user door calls `conversations.open` with to resolve the
 *  self-DM: notes-to-self IS the mind on this surface (§4), and without it the binding
 *  cannot be made. */
export const DEFAULT_USER_SCOPES = [
  ...READ_SCOPES,
  "chat:write",
  "search:read",
  "channels:write",
  "channels:write.invites",
  "groups:write",
  "groups:write.invites",
  "im:write",
  "mpim:write",
];

export interface SlackConfig {
  botScopes: string[];
  userScopes: string[];
}

export const SPEC: ConnectorSpec = {
  name: "slack",
  doc: "slack — ingest (HTTP mode) and dispatch",
  entries: [
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

/** Read `connections.slack` as the org's store holds it, the room knobs beside. */
export function slackConfig(root: string): Promise<SlackConfig & RoomKnobs> {
  return connectorConfig<SlackConfig>(root, SPEC);
}
