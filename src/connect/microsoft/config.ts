/**
 * connect/microsoft/config.ts — the microsoft connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.microsoft` and are validated at boot.
 *
 * The tenant is not a knob: an Entra app registration lives in one tenant, so the tenant
 * is a fact about the app and rides on the app's vault row (`liquen connect microsoft app`).
 */

import { checkAmong, checkStrings, connectorConfig, type ConnectorSpec } from "../../config.ts";

/** What the connection can read into the log, each by its own ingest in `run.ts`. */
export const SURFACES = ["calendar", "mail", "teams"] as const;
export type Surface = typeof SURFACES[number];
export const DEFAULT_LISTEN: Surface[] = [...SURFACES];

/** `primary` is the account's own calendar (Graph's `/me/calendar`); any other entry is a
 *  calendar id from `/me/calendars`. */
export const DEFAULT_CALENDARS = ["primary"];
/** Identity, the `/me` profile, the calendar, the mailbox read and written (a send is a
 *  draft made from the MIME, then sent: the draft names its conversation), the member's
 *  chats read and written, the channels of their teams read and written, the files a
 *  Teams message carries (OneDrive items, shared by reference), and the rooms
 *  (`rooms.ts`): a chat made, its members added and removed, its topic; a channel made
 *  in a team, its members and its name. Entra records consent per permission, so a
 *  later ask adds to a grant: each poll or subscription runs only on a grant whose
 *  consent carries the scope it needs (`mail.ts`, `teams.ts`), a rooms leg refuses
 *  naming the one it lacks, and a grant made before a surface joined keeps what it has
 *  and takes the rest on re-consent. `ChannelMessage.Read.All`, `ChatMember.ReadWrite`
 *  and the three channel permissions (`Channel.Create`, `ChannelMember.ReadWrite.All`,
 *  `ChannelSettings.ReadWrite.All`) are granted by a tenant's admin on the registration,
 *  never by the member alone. The Graph permissions are spelled short; the wire accepts
 *  both spellings and the door compares them as one (`oauth.ts`). */
export const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "Mail.Send",
  "Chat.ReadWrite",
  "Chat.Create",
  "ChatMember.ReadWrite",
  "ChatMessage.Send",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "ChannelMessage.ReadWrite",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "Channel.Create",
  "ChannelMember.ReadWrite.All",
  "ChannelSettings.ReadWrite.All",
  "Files.ReadWrite",
];
/** The grant's proxy declaration (§9), written onto every vault row this connector mints:
 *  the env var main fronts the placeholder under, and the only host the token may be
 *  spent toward. A Graph token is good for Graph alone — the same sign-in would mint a
 *  different token for SharePoint or Exchange, and one row fronts one token. */
export const GRANT_ENV = "MICROSOFT_GRAPH_TOKEN";
export const GRANT_HOSTS = ["graph.microsoft.com"];

export interface MicrosoftConfig {
  listen: Surface[];
  calendars: string[];
  scopes: string[];
}

export const SPEC: ConnectorSpec = {
  name: "microsoft",
  doc:
    "microsoft — the Entra oauth door, the Outlook calendar poll, Outlook mail in and out, Teams pushed in and sent out",
  entries: [
    {
      key: "listen",
      value: DEFAULT_LISTEN,
      doc:
        'what the connection reads into the log: "calendar", "mail", "teams"; one left out is still reached through the grant, and sends go out either way',
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

/** Read (and heal) `connections.microsoft` from the org's config.jsonc. */
export function microsoftConfig(root: string): Promise<MicrosoftConfig> {
  return connectorConfig<MicrosoftConfig>(root, SPEC);
}
