/**
 * connect/microsoft/teams.ts — the Teams wire on a delegated grant: chats and channels
 * pushed into the log, and the member's own sends, edits, deletes and reactions out.
 *
 * Teams is PUSH-ONLY under its API terms (a resource may be polled once a day), so the
 * ingest is a Graph change notification: a webhook `(Request) => Response` that answers
 * the validation handshake, checks each notice's `clientState` against the subscription
 * that minted it, acks within the wire's three seconds and reads the message back behind
 * the ack — a notice carries the resource's path and nothing else. The subscriptions that
 * feed it live for three days and are KEPT by the shared sweep (`connect/poll.ts`): every
 * minute, every grant, one subscription over all the member's chats
 * (`/users/<oid>/chats/getAllMessages`) and one per channel of every team the member is
 * in — created when absent, renewed inside its last day, recorded on the grant
 * (`extra.teams_sub`, keyed by the resource path, with the id, the expiry and the secret
 * the notices must echo). A channel subscription is one per channel for the whole app:
 * the first grant to reach it holds it and the others meet a 409, which is not a failure.
 * The lifecycle notices ride the same endpoint: a reauthorization renews, a removal drops
 * the record so the next sweep recreates, a miss is said on stderr.
 *
 * Graph must reach the endpoint over public HTTPS, so `connections.microsoft.notificationUrl`
 * is where it dials — the org's tunnel or its edge — and the ingest binds `ingestPort`
 * behind it. No URL declared means no subscriptions: the dispatch still runs, so the log's
 * sends reach Teams, and nothing comes back until the address exists.
 *
 * Mapping (§3, §4): a chat is a conversation addressed by its id, `direct` when Teams
 * calls it oneOnOne or group (the member set is the identity), `group` when it is a
 * meeting's; a channel is addressed `<team id>/<channel id>`, `channel`. A channel reply is
 * a `reply` to its root; a chat is flat. `external_id = teams:<address>:<message id>`, so
 * the same message reaching two members' subscriptions merges, and the member's own send
 * merges with its echo. An edit is its own event (`action: edit`, keyed by the edit's
 * time), a delete marks the row and adds a delete event, a reaction is an `add` keyed by
 * who and what, so a notice repeated lands once. The sender is the Teams user id; a sender
 * whose id is a grant's `oid` is that member (`agent.id`). Rows anchor to the grant whose
 * subscription delivered them.
 *
 * The body is HTML: `<at>` mentions become `@Name` and `payload.mentions`, an `<emoji>`
 * its glyph, a hosted image (a pasted screenshot) its bytes on the media shelf, and the
 * rest reads as words. A file is a reference to a OneDrive or SharePoint item: its bytes
 * come through `/shares/<encoded url>/driveItem/content` onto the shelf, and a file the
 * grant cannot read stays a link in the words. Outbound, a local file goes to the
 * channel's own folder, or to the account's OneDrive under `liquen/` with an
 * organization-wide view link, and rides the message as a `reference` attachment.
 */

import { encodeBase64Url } from "@std/encoding/base64url";
import { APP_PREFIX } from "./connect.ts";
import { htmlToText, mediaShelf, type SaveFile } from "../mail.ts";
import { createPoller, FETCH_TIMEOUT_MS, granted, type PollIngestDeps } from "../poll.ts";
import { createDispatcher } from "../dispatcher.ts";
import { DispatchError } from "../errors.ts";
import { claimMentions, type Directory, logDirectory, type NameEntry } from "../mentions.ts";
import { isExternal, pathOf } from "../../store/media.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../../store/log.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import type { GrantBroker } from "../../proxy/grants.ts";
import type {
  Draft,
  Event,
  EventId,
  FilePart,
  MessageEvent,
  Part,
  ReactionPart,
} from "../../types.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { entry } from "../../entry.ts";

const SERVICE = "microsoft" as const;
const GRANT_PREFIX = "microsoft:";
export const GRAPH = "https://graph.microsoft.com/v1.0";
/** The grant's record of its subscriptions: `extra.teams_sub[<resource path>]`. */
export const TEAMS_SUB = "teams_sub";

/** A grant the chat subscription applies to carries one of these; the channel
 *  subscriptions need the admin-granted read. Either Graph spelling. */
const both = (scopes: string[]) => scopes.flatMap((s) => [s, `https://graph.microsoft.com/${s}`]);
export const CHAT_SCOPES = both(["Chat.Read", "Chat.ReadWrite"]);
export const CHANNEL_SCOPES = both(["ChannelMessage.Read.All"]);

/** What the sweep keeps on every grant. */
export const RESOURCES = ["chats", "channels"];
/** A chatMessage subscription lives 4,320 minutes at most; ten minutes under it. */
export const LIFETIME_MS = 4310 * 60_000;
/** Renew inside the last day: a laptop closed for a night still holds its subscriptions. */
export const RENEW_AHEAD_MS = 24 * 3600_000;
/** How often a grant's teams and channels are listed again for new ones. */
export const CHANNELS_EVERY_MS = 3600_000;

/* ── the grammar: places, addresses, ids ──────────────────────────────────────────── */

export type Place = { kind: "chat"; chat: string } | {
  kind: "channel";
  team: string;
  channel: string;
};

/** The conversation address of a place: a chat's id, or `<team>/<channel>`. */
export function addressOf(p: Place): string {
  return p.kind === "chat" ? p.chat : `${p.team}/${p.channel}`;
}

/** A conversation address as a place; a team id is a GUID, so the slash decides. */
export function placeOf(address: string): Place {
  const slash = address.indexOf("/");
  if (slash < 0) return { kind: "chat", chat: address };
  return { kind: "channel", team: address.slice(0, slash), channel: address.slice(slash + 1) };
}

/** The log's key for a message: `teams:<address>:<id>`. */
export function teamsRef(address: string, id: string): string {
  return `teams:${address}:${id}`;
}

/** `teams:<address>:<id>` → the id; a reference minted elsewhere names nothing here. */
export function idOf(ref: string | undefined): { address: string; id: string } | undefined {
  if (!ref?.startsWith("teams:")) return undefined;
  const at = ref.lastIndexOf(":");
  const address = ref.slice("teams:".length, at);
  const id = ref.slice(at + 1);
  return address && id ? { address, id } : undefined;
}

/** The Graph path of a message, or of a place's messages when `id` is absent; a channel
 *  reply sits under its root. */
export function messagePath(p: Place, id?: string, root?: string): string {
  const base = p.kind === "chat"
    ? `${GRAPH}/chats/${enc(p.chat)}/messages`
    : `${GRAPH}/teams/${enc(p.team)}/channels/${enc(p.channel)}/messages`;
  if (id === undefined) return root ? `${base}/${enc(root)}/replies` : base;
  return root ? `${base}/${enc(root)}/replies/${enc(id)}` : `${base}/${enc(id)}`;
}

const enc = encodeURIComponent;

/** A notice's `resource` — `chats('…')/messages('…')` or
 *  `teams('…')/channels('…')/messages('…')[/replies('…')]` — as the place and ids it names. */
export function parseResource(
  resource: string,
): { place: Place; id: string; root?: string } | undefined {
  const seg = [...resource.matchAll(/([a-zA-Z]+)\('([^']+)'\)/g)].map((m) => [m[1], m[2]]);
  const get = (name: string) => seg.find(([k]) => k === name)?.[1];
  const message = get("messages");
  if (!message) return undefined;
  const reply = get("replies");
  const chat = get("chats");
  if (chat) return { place: { kind: "chat", chat }, id: reply ?? message };
  const team = get("teams"), channel = get("channels");
  if (!team || !channel) return undefined;
  return reply
    ? { place: { kind: "channel", team, channel }, id: reply, root: message }
    : { place: { kind: "channel", team, channel }, id: message };
}

/* ── the wire's shapes ─────────────────────────────────────────────────────────────── */

interface TeamsUser {
  id?: string;
  displayName?: string | null;
  userIdentityType?: string;
}

/** The slice of a Graph `chatMessage` the ingest reads. */
export interface ChatMessage {
  id?: string;
  replyToId?: string | null;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  chatId?: string | null;
  channelIdentity?: { teamId?: string; channelId?: string } | null;
  from?: { user?: TeamsUser | null } | null;
  body?: { contentType?: string; content?: string };
  attachments?: {
    id?: string;
    contentType?: string;
    contentUrl?: string | null;
    name?: string | null;
    content?: string | null;
  }[];
  mentions?: { id?: number; mentionText?: string; mentioned?: { user?: TeamsUser | null } }[];
  reactions?: { reactionType?: string; user?: { user?: TeamsUser | null } }[];
  [k: string]: unknown;
}

interface Notice {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  lifecycleEvent?: string;
}

/** What a grant records of one subscription. */
export interface SubRecord {
  id: string;
  expires: string;
  secret: string;
}

type Graph = (url: string, init?: RequestInit) => Promise<Response>;

/** A Graph caller bound to one grant's token, bounded per call. */
function graphFor(fetchApi: typeof fetch, token: string): Graph {
  return (url, init = {}) =>
    fetchApi(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
}

/** The grant's subscriptions, as recorded. */
export function subsOf(row: CredentialRow | null | undefined): Record<string, SubRecord> {
  const map = row?.extra?.[TEAMS_SUB];
  return map && typeof map === "object" ? { ...(map as Record<string, SubRecord>) } : {};
}

async function writeSubs(
  creds: Pick<Credentials, "put">,
  key: string,
  subs: Record<string, SubRecord>,
): Promise<void> {
  await creds.put({ key, value: {}, extra: { [TEAMS_SUB]: subs } });
}

/* ── the body: HTML → words, mentions, hosted images ───────────────────────────────── */

export interface Body {
  text: string;
  mentions: { address: string; name?: string }[];
  /** Hosted content the body shows inline — the URL its bytes are read from. */
  hosted: string[];
}

/** The words of a message body. HTML is Teams' form whenever the message carries a mention
 *  or an image: `<at>` reads as `@Name` (the mention's user id lifted beside it), an
 *  `<emoji>` as its glyph, an `<attachment>` tag as nothing (the attachment rides apart),
 *  a hosted `<img>` as nothing in the words and a URL in `hosted`. */
export function bodyOf(msg: ChatMessage): Body {
  const content = msg.body?.content ?? "";
  if (msg.body?.contentType?.toLowerCase() !== "html") {
    return { text: content.trim(), mentions: [], hosted: [] };
  }
  const mentions: Body["mentions"] = [];
  const hosted: string[] = [];
  const html = content
    .replace(/<at\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/at>/gi, (_, id, inner) => {
      const label = String(inner).replace(/<[^>]+>/g, "").trim();
      const m = msg.mentions?.find((x) => String(x.id) === id);
      const user = m?.mentioned?.user;
      const name = label || m?.mentionText || undefined;
      if (user?.id && !mentions.some((e) => e.address === user.id)) {
        mentions.push({ address: user.id, ...(name ? { name } : {}) });
      }
      return `@${name ?? id}`;
    })
    .replace(/<emoji\b[^>]*\balt="([^"]*)"[^>]*>(?:<\/emoji>)?/gi, "$1")
    .replace(/<customemoji\b[^>]*\balt="([^"]*)"[^>]*>(?:<\/customemoji>)?/gi, ":$1:")
    .replace(/<attachment\b[^>]*>(?:<\/attachment>)?/gi, "")
    .replace(/<img\b[^>]*\bsrc="([^"]*hostedContents[^"]*)"[^>]*>/gi, (_, src) => {
      hosted.push(String(src).replace(/&amp;/g, "&"));
      return "";
    });
  return { text: htmlToText(html), mentions, hosted };
}

/* ── the names: a chat's or a channel's, asked once ────────────────────────────────── */

interface ChatInfo {
  chatType?: string;
  topic?: string | null;
  members?: { userId?: string; displayName?: string | null }[];
}

/** A place's kind and name (§3: the service's display facts), asked of Graph once per
 *  place per process and remembered. A oneOnOne chat is named for the other member, a
 *  group chat by its topic or its other members, a channel `Team / Channel`. */
export function teamsNames(): {
  of(graph: Graph, place: Place, self?: string): Promise<{
    kind: NonNullable<MessageEvent["envelope"]["conversation"]["kind"]>;
    name?: string;
  }>;
} {
  const cache = new Map<string, { kind: "direct" | "group" | "channel"; name?: string }>();
  return {
    async of(graph, place, self) {
      const key = addressOf(place);
      const hit = cache.get(key);
      if (hit) return hit;
      let found: { kind: "direct" | "group" | "channel"; name?: string };
      if (place.kind === "chat") {
        const res = await graph(`${GRAPH}/chats/${enc(place.chat)}?$expand=members`);
        const info = res.ok ? await res.json() as ChatInfo : (await res.body?.cancel(), {});
        const others = (info.members ?? [])
          .filter((m) => m.userId !== self && m.displayName)
          .map((m) => m.displayName as string);
        const kind = info.chatType === "meeting" ? "group" : "direct";
        const name = info.topic || (others.length ? others.join(", ") : undefined);
        found = { kind, ...(name ? { name } : {}) };
        if (!res.ok) return found; // unnamed for now; a later message asks again
      } else {
        const [team, channel] = await Promise.all([
          graph(`${GRAPH}/teams/${enc(place.team)}?$select=displayName`),
          graph(`${GRAPH}/teams/${enc(place.team)}/channels/${enc(place.channel)}`),
        ]);
        const t = team.ok ? await team.json() as { displayName?: string } : {};
        const c = channel.ok ? await channel.json() as { displayName?: string } : {};
        if (!team.ok) await team.body?.cancel();
        if (!channel.ok) await channel.body?.cancel();
        const name = [t.displayName, c.displayName].filter(Boolean).join(" / ");
        found = { kind: "channel", ...(name ? { name } : {}) };
        if (!team.ok || !channel.ok) return found;
      }
      cache.set(key, found);
      return found;
    },
  };
}

/* ── the webhook: the handshake, the notices, the read-back ────────────────────────── */

export interface TeamsWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The vault: the grants and their subscription records — what a notice is checked
   *  against, and whose token reads the message back. */
  creds: Pick<Credentials, "list" | "get" | "put">;
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  /** The memberships mirror (§4): a member whose subscription delivers a chat is in it.
   *  Absent ⇒ pure mapping. */
  store?: Pick<Connections, "upsertMemberships">;
  /** Where attachments and pasted images land. */
  save: SaveFile;
  fetchApi?: typeof fetch;
  /** The response's timing (Slack's shape): present, the 202 goes out first and the work
   *  is handed here; absent, the answer waits for the work. */
  track?: (work: Promise<void>) => void;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** Build the ingest handler. Pure over its deps — call once, serve anywhere. */
export function createTeamsWebhook(deps: TeamsWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  const names = teamsNames();

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    // the handshake: Graph asks the endpoint to say the token back, plain, and creates
    // the subscription only on that answer
    const token = new URL(req.url).searchParams.get("validationToken");
    if (token !== null) return text(200, token);

    let notices: Notice[];
    try {
      notices = ((await req.json()) as { value?: Notice[] }).value ?? [];
    } catch {
      return text(400, "invalid json");
    }
    const grants = (await deps.creds.list(GRANT_PREFIX)).filter((r) =>
      !r.key.startsWith(APP_PREFIX)
    );
    const work = notices.map((n) => handle(n, grants));
    if (deps.track) {
      for (const w of work) {
        deps.track(w.catch((err) => {
          console.error("[ingest] teams notice failed:", err instanceof Error ? err.message : err);
        }));
      }
      return text(202, "accepted");
    }
    try {
      await Promise.all(work);
      return text(202, "accepted");
    } catch (err) {
      return text(500, err instanceof Error ? err.message : String(err));
    }
  };

  /** The grant holding a notice's subscription — its record must carry the secret the
   *  notice echoes, or the notice is nobody's. */
  function holderOf(
    n: Notice,
    grants: CredentialRow[],
  ): { grant: CredentialRow; resource: string } | undefined {
    for (const grant of grants) {
      for (const [resource, sub] of Object.entries(subsOf(grant))) {
        if (sub.id === n.subscriptionId && sub.secret === n.clientState) return { grant, resource };
      }
    }
    return undefined;
  }

  async function handle(n: Notice, grants: CredentialRow[]): Promise<void> {
    const held = holderOf(n, grants);
    if (!held) {
      console.error(`[ingest] teams notice for unknown subscription ${n.subscriptionId} dropped`);
      return;
    }
    const { grant, resource } = held;
    if (n.lifecycleEvent) {
      await lifecycle(n.lifecycleEvent, grant, resource);
      return;
    }
    if (!n.resource) return;
    const at = parseResource(n.resource);
    if (!at) return;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(grant.key, grant.agentId));
    if (!token) throw new Error(`no access token for ${grant.key}`);
    const graph = graphFor(fetchApi, token);
    const res = await graph(messagePath(at.place, at.id, at.root));
    if (res.status === 404) {
      await res.body?.cancel();
      return;
    }
    if (!res.ok) {
      throw new Error(`teams message ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const msg = await res.json() as ChatMessage;
    const rows = await mapMessage(msg, at, grant, grants, graph, n.changeType);
    if (rows.length) await deps.publish(rows);
  }

  /** A lifecycle notice: a reauthorization is a renewal, a removal drops the record so
   *  the sweep recreates, a miss can only be said. */
  async function lifecycle(event: string, grant: CredentialRow, resource: string): Promise<void> {
    const subs = subsOf(grant);
    const sub = subs[resource];
    if (event === "subscriptionRemoved") {
      delete subs[resource];
      await writeSubs(deps.creds, grant.key, subs);
      return;
    }
    if (event === "reauthorizationRequired" && sub) {
      const token = await deps.broker.accessTokenFor(deps.broker.issue(grant.key, grant.agentId));
      if (!token) throw new Error(`no access token for ${grant.key}`);
      const renewed = await renew(graphFor(fetchApi, token), sub, now);
      subs[resource] = renewed;
      await writeSubs(deps.creds, grant.key, subs);
      return;
    }
    if (event === "missed") {
      console.error(`[ingest] teams notices missed on ${grant.key} ${resource}`);
    }
  }

  /** The message as rows: the words and files as one row, or the delete pair, or the
   *  edit event, or one `add` per reaction when the change was a reaction. */
  async function mapMessage(
    msg: ChatMessage,
    at: { place: Place; id: string; root?: string },
    grant: CredentialRow,
    grants: CredentialRow[],
    graph: Graph,
    changeType: string | undefined,
  ): Promise<Draft<MessageEvent>[]> {
    if (!msg.id || (msg.messageType && msg.messageType !== "message")) return [];
    const upn = grant.key.slice(GRANT_PREFIX.length);
    const address = addressOf(at.place);
    const ref = teamsRef(address, msg.id);
    const envelope = (
      external_id: string,
      kind?: MessageEvent["envelope"]["conversation"]["kind"],
      name?: string,
    ) => ({
      service: SERVICE,
      connection_address: upn,
      conversation: { address, ...(kind ? { kind } : {}), ...(name ? { name } : {}) },
      external_id,
    });
    const ts = now();

    // a delete marks, never removes: the delete EVENT and the stamp on the original
    if (changeType === "deleted" || msg.deletedDateTime) {
      const when = msg.deletedDateTime ?? ts;
      return [{
        ts,
        type: "message",
        payload: { action: "delete", ref_external_id: ref },
        envelope: envelope(`${ref}:del`),
        parts: [],
      }, {
        ts,
        type: "message",
        envelope: envelope(ref),
        status: { state: "deleted", deleted_at: when },
      } as unknown as Draft<MessageEvent>];
    }

    const from = msg.from?.user ?? undefined;
    const who = from?.id ? whoIs(from.id, grants) : undefined;
    const sender = from?.id
      ? { address: from.id, ...(from.displayName ? { name: from.displayName } : {}) }
      : undefined;
    const stamp = who ? { agent: { id: who } } : {};

    // an update that edited nothing is a reaction: one `add` per reaction, keyed by who
    // and what, so the same state told twice lands once
    if (changeType === "updated" && !msg.lastEditedDateTime) {
      return (msg.reactions ?? []).flatMap((r) => {
        const u = r.user?.user;
        if (!r.reactionType || !u?.id) return [];
        const reactor = whoIs(u.id, grants);
        const part: ReactionPart = {
          type: "data",
          kind: "reaction",
          data: { name: r.reactionType, unicode: r.reactionType },
        };
        return [{
          ts,
          type: "message",
          ...(reactor ? { agent: { id: reactor } } : {}),
          payload: { action: "add", ref_external_id: ref },
          envelope: {
            ...envelope(`${ref}:react:${u.id}:${r.reactionType}`),
            sender: { address: u.id, ...(u.displayName ? { name: u.displayName } : {}) },
          },
          parts: [part],
        }];
      });
    }

    const body = bodyOf(msg);
    const { kind, name } = await names.of(graph, at.place, grant.extra?.oid as string | undefined);
    const parts: Part[] = [];
    if (body.text) parts.push({ type: "text", kind: "text", text: body.text });
    for (const url of body.hosted) {
      const file = await fetchOnto(graph, url, address, undefined, deps.save);
      if (file) parts.push(file);
    }
    let reply: string | undefined = at.root ? teamsRef(address, at.root) : undefined;
    const links: string[] = [];
    for (const a of msg.attachments ?? []) {
      if (a.contentType === "messageReference" && a.content) {
        // a quoted reply in a chat names the message it answers
        try {
          const q = JSON.parse(a.content) as { messageId?: string };
          if (q.messageId) reply = teamsRef(address, q.messageId);
        } catch { /* a quote the wire could not spell is no reference */ }
        continue;
      }
      if (a.contentType !== "reference" || !a.contentUrl) continue;
      const file = await fetchOnto(
        graph,
        `${GRAPH}/shares/${shareId(a.contentUrl)}/driveItem/content`,
        address,
        a.name ?? undefined,
        deps.save,
      );
      if (file) parts.push(file);
      else links.push(a.name ? `[${a.name}](${a.contentUrl})` : a.contentUrl);
    }
    if (links.length) {
      const text = parts.find((p): p is Extract<Part, { type: "text" }> => p.type === "text");
      if (text) text.text = [text.text, ...links].join("\n");
      else parts.push({ type: "text", kind: "text", text: links.join("\n") });
    }
    if (parts.length === 0) return [];

    // the membership mirror (§4): the member whose subscription delivered a chat is in it
    if (deps.store && grant.agentId && at.place.kind === "chat") {
      await deps.store.upsertMemberships([
        { service: SERVICE, connection: upn, conversation: address, agentId: grant.agentId },
      ]);
    }

    const edit = changeType === "updated" && msg.lastEditedDateTime;
    const payload = {
      ...(edit
        ? { action: "edit" as const, ref_external_id: ref }
        : reply
        ? { action: "reply" as const, ref_external_id: reply }
        : {}),
      ...(body.mentions.length ? { mentions: body.mentions } : {}),
    };
    return [{
      ts: edit ? ts : msg.createdDateTime ?? ts,
      type: "message",
      ...stamp,
      ...(Object.keys(payload).length ? { payload } : {}),
      envelope: {
        ...envelope(edit ? `${ref}:edit:${Date.parse(msg.lastEditedDateTime!)}` : ref, kind, name),
        ...(sender ? { sender } : {}),
      },
      parts,
    }];
  }
}

/** The member a Teams user id names: the grant whose account (`extra.oid`) it is. */
function whoIs(userId: string, grants: CredentialRow[]): string | undefined {
  return grants.find((g) => g.extra?.oid === userId)?.agentId;
}

/** Read bytes at `url` with the grant's token onto the shelf; null when the wire refuses. */
async function fetchOnto(
  graph: Graph,
  url: string,
  conversation: string,
  name: string | undefined,
  save: SaveFile,
): Promise<FilePart | null> {
  const res = await graph(url);
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0].trim() || undefined;
  return await save(conversation, bytes, { ...(mime ? { mime_type: mime } : {}), name });
}

/** A sharing URL as the `/shares` API takes it: `u!` + unpadded base64url of the URL. */
export function shareId(url: string): string {
  return `u!${encodeBase64Url(new TextEncoder().encode(url))}`;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── the keeper: subscriptions alive on every grant, over the shared sweep ─────────── */

export interface TeamsKeeperDeps {
  creds: Pick<Credentials, "list" | "get" | "put">;
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  store?: Pick<Connections, "upsertConnections">;
  /** Where Graph dials the ingest — the `notificationUrl` and `lifecycleNotificationUrl`. */
  notificationUrl: string;
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, resource: string, published: number) => void;
}

/** The sweep over `microsoft:` grants: `chats` keeps the one subscription over the
 *  member's chats, `channels` one per channel of every team they are in. Returns how many
 *  subscriptions it created or renewed. */
export function createTeamsKeeper(deps: TeamsKeeperDeps): { tick(): Promise<void> } {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  // when each grant's teams and channels were last listed, and which of them another
  // grant holds (a 409 on create) — asked again only with the next listing
  const listed = new Map<string, { at: number; paths: string[]; foreign: Set<string> }>();

  const keep = async (grant: CredentialRow, resource: string): Promise<number> => {
    const oid = grant.extra?.oid;
    if (typeof oid !== "string" || !oid) return 0;
    if (resource === "chats" && !granted(grant, CHAT_SCOPES)) return 0;
    if (resource === "channels" && !granted(grant, CHANNEL_SCOPES)) return 0;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(grant.key, grant.agentId));
    if (!token) throw new Error(`no access token for ${grant.key}`);
    const graph = graphFor(fetchApi, token);
    const all = resource === "chats"
      ? [`/users/${oid}/chats/getAllMessages`]
      : await channelPaths(graph, grant.key);
    const foreign = listed.get(grant.key)?.foreign ?? new Set<string>();
    const paths = all.filter((p) => !foreign.has(p));
    // the record as it stands now: another process (the webhook) writes it too
    const subs = subsOf(await deps.creds.get(grant.key));
    let touched = 0;
    let changed = false;
    for (const path of paths) {
      const sub = subs[path];
      const t = Date.parse(now());
      if (sub && Date.parse(sub.expires) - t > RENEW_AHEAD_MS) continue;
      if (sub && Date.parse(sub.expires) > t) {
        subs[path] = await renew(graph, sub, now);
        touched++;
        changed = true;
        continue;
      }
      const made = await create(graph, path, deps.notificationUrl, now);
      if (made) {
        subs[path] = made;
        touched++;
        changed = true;
      } else {
        // held by another grant: nothing of ours to record, and not asked again this hour
        foreign.add(path);
        if (sub) {
          delete subs[path];
          changed = true;
        }
      }
    }
    if (changed) await writeSubs(deps.creds, grant.key, subs);
    return touched;
  };

  /** The channels' resource paths for a grant — listed once an hour. */
  const channelPaths = async (graph: Graph, key: string): Promise<string[]> => {
    const hit = listed.get(key);
    const t = Date.parse(now());
    if (hit && t - hit.at < CHANNELS_EVERY_MS) return hit.paths;
    const teams = await page<{ id?: string }>(graph, `${GRAPH}/me/joinedTeams?$select=id`);
    const paths: string[] = [];
    for (const team of teams) {
      if (!team.id) continue;
      const channels = await page<{ id?: string }>(
        graph,
        `${GRAPH}/teams/${enc(team.id)}/channels?$select=id`,
      );
      for (const c of channels) if (c.id) paths.push(`/teams/${team.id}/channels/${c.id}/messages`);
    }
    listed.set(key, { at: t, paths, foreign: new Set() });
    return paths;
  };

  return createPoller({
    service: SERVICE,
    grantPrefix: GRANT_PREFIX,
    appPrefix: APP_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: RESOURCES,
    watches: (grant) => granted(grant, [...CHAT_SCOPES, ...CHANNEL_SCOPES]),
    poll: keep,
    now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
}

/** Every item of a paged listing. */
async function page<T>(graph: Graph, url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; i < 50 && next; i++) {
    const res = await graph(next);
    if (!res.ok) throw new Error(`teams list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json() as { value?: T[]; "@odata.nextLink"?: string };
    out.push(...(body.value ?? []));
    next = body["@odata.nextLink"];
  }
  return out;
}

/** Create a subscription on `resource`; null when another grant already holds one for it
 *  (a 409 — one per channel for the whole app). */
async function create(
  graph: Graph,
  resource: string,
  notificationUrl: string,
  now: () => string,
): Promise<SubRecord | null> {
  const secret = crypto.randomUUID();
  const expires = new Date(Date.parse(now()) + LIFETIME_MS).toISOString();
  const res = await graph(`${GRAPH}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      changeType: "created,updated,deleted",
      notificationUrl,
      lifecycleNotificationUrl: notificationUrl,
      resource,
      expirationDateTime: expires,
      clientState: secret,
    }),
  });
  if (res.status === 409) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) {
    throw new Error(
      `teams subscribe ${resource}: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
  const made = await res.json() as { id?: string; expirationDateTime?: string };
  if (!made.id) throw new Error(`teams subscribe ${resource}: no id in the answer`);
  return { id: made.id, expires: made.expirationDateTime ?? expires, secret };
}

/** Renew a subscription for another lifetime — which also reauthorizes it. */
async function renew(graph: Graph, sub: SubRecord, now: () => string): Promise<SubRecord> {
  const expires = new Date(Date.parse(now()) + LIFETIME_MS).toISOString();
  const res = await graph(`${GRAPH}/subscriptions/${enc(sub.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expirationDateTime: expires }),
  });
  if (!res.ok) {
    throw new Error(`teams renew ${sub.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const got = await res.json() as { expirationDateTime?: string };
  return { ...sub, expires: got.expirationDateTime ?? expires };
}

/* ── the dispatch: the member's sends, edits, deletes and reactions ────────────────── */

/** The wire's legs for a grant (`connection` = the account's UPN, `agentId` whose hand). */
export interface TeamsWire {
  post(
    grant: { connection: string; agentId?: string },
    place: Place,
    message: { html: string; mentions: Mention[]; files: FilePart[] },
    root?: string,
  ): Promise<{ id?: string; user?: string }>;
  amend(
    grant: { connection: string; agentId?: string },
    place: Place,
    amend: { id: string; root?: string; action: "edit" | "delete"; html: string },
  ): Promise<void>;
  react(
    grant: { connection: string; agentId?: string },
    place: Place,
    react: { id: string; root?: string; glyph: string; remove: boolean },
  ): Promise<void>;
}

/** A mention as Graph takes it beside the `<at id>` tag in the body. */
export interface Mention {
  id: number;
  mentionText: string;
  mentioned: { user: { id: string; displayName: string; userIdentityType: "aadUser" } };
}

export interface TeamsDispatchDeps {
  subscribe: Subscriber["subscribe"];
  read: Reader["read"];
  wire: TeamsWire;
  /** The conversation's name directory (§3 mentions): the agent's `@Name` tokens claim
   *  user ids. Absent ⇒ names stay words. */
  directory?: Directory;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, id: string | undefined) => void;
}

interface Work {
  connection: string;
  address: string;
  text: string;
  files: FilePart[];
  /** The referent's id and address, when the row names one. */
  re?: { address: string; id: string };
  glyph?: string;
}

/** Wire dispatch to the log — the shared loop over Teams' legs. A channel reply lands
 *  under the referent's ROOT (a reply to a reply is in the same thread); a chat has no
 *  threads, so a reply there is a plain message. Returns stop. */
export function createTeamsDispatch(deps: TeamsDispatchDeps): () => Promise<void> {
  return createDispatcher<Work>({
    subscribe: deps.subscribe,
    read: deps.read,
    service: SERVICE,
    setDelivery: deps.setDelivery,
    onError: deps.onError,
    onSent: deps.onSent,
    select: (event) => {
      const connection = event.envelope.connection_address;
      const address = event.envelope.conversation.address;
      if (!connection || !address || !isTeamsAddress(address)) return null;
      const parts = event.parts ?? [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const files = parts.filter((p): p is FilePart => p.type === "file");
      const re = idOf(event.payload?.ref_external_id);
      const reaction = parts.find((p) => p.type === "data" && p.kind === "reaction") as
        | ReactionPart
        | undefined;
      if (reaction) {
        const glyph = reaction.data.unicode ?? reaction.data.name;
        return { connection, address, text: "", files: [], re, glyph };
      }
      if (event.payload?.action === "delete") {
        return { connection, address, text: "", files: [], re };
      }
      if (!text && files.length === 0) return null;
      return { connection, address, text, files, re };
    },
    post: async (work, event) => {
      const grant = { connection: work.connection, agentId: event.agent?.id };
      const place = placeOf(work.address);
      const action = event.payload?.action;
      // where the referent sits: a channel reply is addressed under its root
      const root = work.re && place.kind === "channel"
        ? await rootOf(deps.read, work.re)
        : undefined;
      if (action === "edit" || action === "delete") {
        if (!work.re) throw new DispatchError(`a ${action} needs the message it acts on`, 400);
        const { html } = toTeamsHtml(work.text, []);
        await deps.wire.amend(grant, place, { id: work.re.id, root, action, html });
        return {};
      }
      if (work.glyph !== undefined) {
        if (!work.re) throw new DispatchError("a reaction needs the message it lands on", 400);
        await deps.wire.react(grant, place, {
          id: work.re.id,
          root,
          glyph: work.glyph,
          remove: action === "remove",
        });
        return {};
      }
      const dir = /@/.test(work.text) ? await deps.directory?.(SERVICE, work.address) : null;
      const message = { ...toTeamsHtml(work.text, dir ?? []), files: work.files };
      // a channel reply threads under the referent's root — its own id when it is one
      const thread = place.kind === "channel" && work.re ? root ?? work.re.id : undefined;
      const { id, user } = await deps.wire.post(grant, place, message, thread);
      return {
        id,
        ...(id !== undefined ? { external_id: teamsRef(work.address, id) } : {}),
        ...(user ? { sender: { address: user } } : {}),
      };
    },
  });
}

/** Whether an address names a Teams place: a chat id (`19:…@thread.v2`,
 *  `19:…@unq.gbl.spaces`) or `<team guid>/<channel id>`. Mail and calendar rows ride the
 *  same service, so the dispatch takes only what is Teams'. */
const THREAD_ID = /^19:[^\s/]+@[a-z0-9.]+$/i;
export function isTeamsAddress(address: string): boolean {
  const p = placeOf(address);
  return THREAD_ID.test(p.kind === "chat" ? p.chat : p.channel);
}

/** The thread root of a referent: the message its own row replies to when it is itself a
 *  reply, else undefined (it is a root). */
async function rootOf(
  read: Reader["read"],
  re: { address: string; id: string },
): Promise<string | undefined> {
  const [row] = await read({ externalId: teamsRef(re.address, re.id), types: ["message"] });
  const parent = idOf((row as MessageEvent | undefined)?.payload?.ref_external_id);
  return (row as MessageEvent | undefined)?.payload?.action === "reply" ? parent?.id : undefined;
}

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** Common markdown → the HTML Teams shows: the three wire characters escaped, `**b**`,
 *  `*i*`/`_i_`, `~~s~~`, code spans and fences, `[t](u)`, line breaks; a claimed `@Name`
 *  becomes `<at id>` with its mention entry. Unclaimed names stay words. */
export function toTeamsHtml(text: string, dir: NameEntry[]): { html: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  // claim first, on the plain text, so the tags never sit inside a claimed span
  const claims = claimMentions(text, dir.filter((e) => e.type !== "#"));
  let marked = "";
  let at = 0;
  for (const c of claims) {
    const name = c.name ?? c.address;
    const n = mentions.length;
    mentions.push({
      id: n,
      mentionText: name,
      mentioned: { user: { id: c.address, displayName: name, userIdentityType: "aadUser" } },
    });
    marked += text.slice(at, c.index) + `\uE000at${n}\uE000`;
    at = c.index + c.length;
  }
  marked += text.slice(at);
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = marked.split(CODE).map((chunk, i) => {
    if (i % 2 === 1) {
      const fence = /^```[^\n]*\n?([\s\S]*?)```$/.exec(chunk);
      return fence
        ? `<pre>${esc(fence[1].replace(/\n$/, ""))}</pre>`
        : `<code>${esc(chunk.slice(1, -1))}</code>`;
    }
    return esc(chunk)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>")
      .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
      .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
      .replace(/\n/g, "<br>");
  }).join("");
  return {
    html: html.replace(
      /\uE000at(\d+)\uE000/g,
      (_, n) => `<at id="${n}">${esc(mentions[Number(n)].mentionText)}</at>`,
    ),
    mentions,
  };
}

/* ── the wire: messages, replies, amendments, reactions, files ─────────────────────── */

export interface TeamsWireDeps {
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  fetchApi: typeof fetch;
}

/** The legs over one token source. A non-2xx keeps its status as the failure's class. */
export function teamsWire(deps: TeamsWireDeps): TeamsWire {
  const tokenFor = async (grant: { connection: string; agentId?: string }): Promise<Graph> => {
    const key = `${GRANT_PREFIX}${grant.connection}`;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(key, grant.agentId));
    if (!token) throw new DispatchError(`no access token for ${key}`, 401);
    return graphFor(deps.fetchApi, token);
  };
  const call = async (graph: Graph, what: string, url: string, init: RequestInit) => {
    const res = await graph(url, init);
    if (!res.ok) {
      throw new DispatchError(
        `${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
        res.status,
      );
    }
    return res;
  };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    async post(grant, place, message, root) {
      const graph = await tokenFor(grant);
      // a local file is uploaded and rides as a reference; an external link joins the words
      const local = message.files.filter((f) => !isExternal(f.file.uri));
      const links = message.files.filter((f) => isExternal(f.file.uri)).map((f) => f.file.uri);
      const attachments: {
        id: string;
        contentType: "reference";
        contentUrl: string;
        name: string;
      }[] = [];
      for (const f of local) {
        const name = f.file.name ?? f.file.uri.slice(f.file.uri.lastIndexOf("/") + 1);
        const item = await upload(
          graph,
          place,
          name,
          f.file.mime_type,
          await Deno.readFile(pathOf(f.file.uri)),
        );
        attachments.push({ id: item.id, contentType: "reference", contentUrl: item.url, name });
      }
      const html = [message.html, ...links.map((l) => `<a href="${l}">${l}</a>`)]
        .filter((s) => s.length > 0).join("<br>") +
        attachments.map((a) => `<attachment id="${a.id}"></attachment>`).join("");
      if (!html) throw new DispatchError("nothing to send", 400);
      const res = await call(
        graph,
        "teams post",
        messagePath(place, undefined, root),
        json({
          body: { contentType: "html", content: html },
          ...(message.mentions.length ? { mentions: message.mentions } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
      );
      const made = await res.json() as ChatMessage;
      return { id: made.id, user: made.from?.user?.id ?? undefined };
    },
    async amend(grant, place, { id, root, action, html }) {
      const graph = await tokenFor(grant);
      const path = messagePath(place, id, root);
      const res = action === "delete"
        ? await call(graph, "teams delete", `${path}/softDelete`, { method: "POST" })
        : await call(graph, "teams edit", path, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: { contentType: "html", content: html } }),
        });
      await res.body?.cancel();
    },
    async react(grant, place, { id, root, glyph, remove }) {
      const graph = await tokenFor(grant);
      const verb = remove ? "unsetReaction" : "setReaction";
      const res = await call(
        graph,
        `teams ${verb}`,
        `${messagePath(place, id, root)}/${verb}`,
        json({
          reactionType: glyph,
        }),
      );
      await res.body?.cancel();
    },
  };

  /** Put a file where the place's members can open it: a channel's own folder, or the
   *  account's OneDrive under `liquen/` with a view link for the organization. Returns
   *  the attachment id (the item's eTag GUID) and the URL the reference names. */
  async function upload(
    graph: Graph,
    place: Place,
    name: string,
    mime: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ id: string; url: string }> {
    let target: string;
    if (place.kind === "channel") {
      const folder = await call(
        graph,
        "teams filesFolder",
        `${GRAPH}/teams/${enc(place.team)}/channels/${enc(place.channel)}/filesFolder`,
        {},
      );
      const f = await folder.json() as { id?: string; parentReference?: { driveId?: string } };
      if (!f.id || !f.parentReference?.driveId) {
        throw new DispatchError("teams filesFolder: no drive in the answer", 502);
      }
      target = `${GRAPH}/drives/${enc(f.parentReference.driveId)}/items/${enc(f.id)}:/${
        enc(name)
      }:/content`;
    } else {
      target = `${GRAPH}/me/drive/root:/liquen/${enc(name)}:/content`;
    }
    const put = await call(graph, `upload ${name}`, target, {
      method: "PUT",
      headers: { "content-type": mime },
      body: bytes,
    });
    const item = await put.json() as {
      id?: string;
      eTag?: string;
      webUrl?: string;
      webDavUrl?: string;
    };
    const guid = /\{?([0-9a-f-]{36})\}?/i.exec(item.eTag ?? "")?.[1];
    const url = item.webDavUrl ?? item.webUrl;
    if (!item.id || !guid || !url) {
      throw new DispatchError(`upload ${name}: no item in the answer`, 502);
    }
    if (place.kind === "chat") {
      const link = await call(
        graph,
        `share ${name}`,
        `${GRAPH}/me/drive/items/${enc(item.id)}/createLink`,
        json({
          type: "view",
          scope: "organization",
        }),
      );
      await link.body?.cancel();
    }
    return { id: guid, url };
  }
}

/* ── local entries: the ingest (the webhook and the keeper) and the dispatch ────────── */

/** Wire the inbound half over the org's log: serve the webhook on `ingestPort`, keep the
 *  subscriptions alive on the shared cadence. No `notificationUrl` declared ⇒ nothing is
 *  subscribed and the half says so once. Returns stop. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { createGrantBroker } = await import("../../proxy/grants.ts");
  const { serveIngest } = await import("../serve.ts");
  const { microsoftConfig } = await import("./config.ts");
  const { runPollIngest } = await import("../poll.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const { ingestPort, notificationUrl } = await microsoftConfig(root);
  if (!notificationUrl) {
    console.error(
      "[ingest] microsoft teams: no connections.microsoft.notificationUrl — Graph has nowhere " +
        "to push, so no Teams subscription is made; sends still go out",
    );
    return () => Promise.resolve();
  }
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const inflight = new Set<Promise<void>>();
  const handler = createTeamsWebhook({
    publish: log.publish,
    creds,
    broker,
    store: log,
    save: mediaShelf(dir),
    fetchApi: timedFetch,
    track: (w) => {
      inflight.add(w);
      w.finally(() => inflight.delete(w));
    },
  });
  const server = serveIngest(
    "connections.microsoft.ingestPort",
    ingestPort,
    handler,
    (bound) => console.error(`[ingest] microsoft teams serving :${bound} ← ${notificationUrl}`),
  );
  const stopKeeper = await runPollIngest(
    SERVICE,
    "teams subscriptions",
    () => Promise.resolve(RESOURCES),
    (deps: PollIngestDeps) => createTeamsKeeper({ ...deps, notificationUrl }),
  );
  return async () => {
    await server.shutdown();
    await Promise.allSettled(inflight);
    await stopKeeper();
    await creds.close();
    await log.close();
  };
}

/** Wire the outbound half over the org's log — resident once it returns. Returns stop. */
export async function runDispatch(): Promise<() => Promise<void>> {
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { createGrantBroker } = await import("../../proxy/grants.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const stop = createTeamsDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    wire: teamsWire({ broker, fetchApi: timedFetch }),
    directory: logDirectory((q) => log.read(q) as Promise<Event[]>),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[dispatch] microsoft teams: watching ${dir}/log for outbound sends`);
  return async () => {
    await stop();
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await entry(async () => [await runIngest(), await runDispatch()]);
