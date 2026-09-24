/**
 * connect/microsoft/config.ts — the microsoft connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.microsoft` and are validated at boot.
 *
 * The tenant is not a knob: an Entra app registration lives in one tenant, so the tenant
 * is a fact about the app and rides on the app's vault row (`liquen connect microsoft app`).
 */

import { checkPort, checkStrings, connectorConfig, type ConnectorSpec } from "../../config.ts";

/** `primary` is the account's own calendar (Graph's `/me/calendar`); any other entry is a
 *  calendar id from `/me/calendars`. */
export const DEFAULT_CALENDARS = ["primary"];
export const DEFAULT_OAUTH_PORT = 8792;
export const DEFAULT_INGEST_PORT = 8794;
/** Identity, the `/me` profile, the calendar, the mailbox read and sent, the member's
 *  chats read and written, the channels of their teams read and written, and the files
 *  a Teams message carries (OneDrive items, shared by reference): the product. Entra
 *  records consent per permission, so a later ask adds to a grant: each poll or
 *  subscription runs only on a grant whose consent carries the scope it needs
 *  (`mail.ts`, `teams.ts`), and a grant made before a surface joined keeps what it has
 *  and takes the rest on re-consent. `ChannelMessage.Read.All` is granted by a tenant's
 *  admin on the registration, never by the member alone. The Graph permissions are
 *  spelled short; the wire accepts both spellings and the door compares them as one
 *  (`oauth.ts`). */
export const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.Send",
  "Chat.ReadWrite",
  "ChatMessage.Send",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "ChannelMessage.ReadWrite",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "Files.ReadWrite",
];
/** The grant's proxy declaration (§9), written onto every vault row this connector mints:
 *  the env var main fronts the placeholder under, and the only host the token may be
 *  spent toward. A Graph token is good for Graph alone — the same sign-in would mint a
 *  different token for SharePoint or Exchange, and one row fronts one token. */
export const GRANT_ENV = "MICROSOFT_GRAPH_TOKEN";
export const GRANT_HOSTS = ["graph.microsoft.com"];

export interface MicrosoftConfig {
  calendars: string[];
  oauthPort: number;
  ingestPort: number;
  /** null ⇒ no Teams subscription is made: Graph pushes only to a public HTTPS address */
  notificationUrl: string | null;
  scopes: string[];
}

const aUrlOrNull = (v: unknown): string | null =>
  v === null || (typeof v === "string" && /^https:\/\/\S+$/.test(v))
    ? null
    : "must be an https:// URL, or null";

export const SPEC: ConnectorSpec = {
  name: "microsoft",
  doc:
    "microsoft — the Entra oauth door, the Outlook calendar poll, Outlook mail in and out, Teams pushed in and sent out",
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
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc:
        "where Graph's Teams notifications land, behind notificationUrl; 0 = any free port, announced",
      check: checkPort,
    },
    {
      key: "notificationUrl",
      value: null,
      doc:
        "the public https:// address Graph pushes Teams notifications to — the org's tunnel or edge in front of ingestPort; null ⇒ Teams is not subscribed (sends still go out)",
      check: aUrlOrNull,
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
