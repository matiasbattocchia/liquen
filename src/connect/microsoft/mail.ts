/**
 * connect/microsoft/mail.ts — the Outlook mail wire: the poll that reads a mailbox's
 * changes into the log (connect/poll.ts: the cursor, the sweep, the resident loop) and
 * the send that puts a MIME on it, both in the shared mail grammar (connect/mail.ts).
 *
 * What it watches: each microsoft GRANT the org holds (`microsoft:<upn>`, minus the
 * `microsoft:app:` client rows) whose consent carries a mail read scope, on two folders —
 * Inbox and Sent Items, the two sides of every conversation the account is in. Graph's
 * delta is per folder (`/me/mailFolders/<folder>/messages/delta`), so a grant has one
 * cursor per folder, the `@odata.deltaLink`: a first run asks the folder from now
 * (`$filter=receivedDateTime ge now`) and pages to the deltaLink publishing nothing; a
 * `410 Gone` (the token aged out) drops it. The feed is asked for ids alone and each one is
 * read back in full — the calendar's shape — because the headers a reply is threaded by
 * (`internetMessageHeaders`) come only on a single message's read. A message the feed lists
 * again (a flag flipped) reads and publishes again, and the log merges it on its id; an
 * `@removed` is a message leaving the folder, not a message unsaid, and publishes nothing.
 *
 * The body is asked as text (`Prefer: outlook.body-content-type`), so the words are the
 * sender's, never markup. Attachments are the folder's `fileAttachment`s, their bytes in
 * the listing; an `isInline` one is not an attachment.
 *
 * Sending is `POST /me/sendMail` with the MIME itself as the body, base64: Exchange files
 * the message by the `References` header the MIME carries and keeps its copy in Sent
 * Items, where the poll finds it under the Message-ID the MIME already wore.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { APP_PREFIX } from "./connect.ts";
import {
  htmlToText,
  MAIL_SYNC,
  mailbox,
  mailConversation,
  type MailMessage,
  mailRow,
  type MailSend,
  type MailWireDeps,
  mediaShelf,
  messageId,
  runMailDispatch,
  type SaveFile,
} from "../mail.ts";
import {
  createPoller,
  cursorFor,
  FETCH_TIMEOUT_MS,
  granted,
  type PollIngestDeps,
  runPollIngest,
  storeCursor,
} from "../poll.ts";
import { DispatchError } from "../errors.ts";
import type { Appender } from "../../store/log.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import type { GrantBroker } from "../../proxy/grants.ts";
import { entry } from "../../entry.ts";

const SERVICE = "microsoft" as const;
const GRANT_PREFIX = "microsoft:";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

/** A grant the mail poll applies to carries one of these — Entra answers a Graph permission
 *  in either spelling. */
export const READ_SCOPES = ["Mail.Read", "Mail.ReadWrite"].flatMap((
  s,
) => [s, `https://graph.microsoft.com/${s}`]);

/** The folders polled on every grant, by their well-known names. */
export const FOLDERS = ["inbox", "sentitems"];

/* ── the wire's shapes ─────────────────────────────────────────────────────────────── */

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}

/** The slice of a Graph `message` the detail read asks for. */
export interface GraphMessage {
  id?: string;
  internetMessageId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  internetMessageHeaders?: { name?: string; value?: string }[];
  [k: string]: unknown;
}

interface GraphAttachment {
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  contentBytes?: string;
  isInline?: boolean;
}

interface DeltaItem {
  id?: string;
  "@removed"?: { reason?: string };
}

interface DeltaPage {
  value?: DeltaItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const SELECT = [
  "internetMessageId",
  "subject",
  "body",
  "from",
  "toRecipients",
  "ccRecipients",
  "sentDateTime",
  "receivedDateTime",
  "hasAttachments",
  "isDraft",
  "internetMessageHeaders",
].join(",");

export interface OutlookMailDeps {
  /** → the EventLog: a mail is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The vault: grants (the connections + the refresh_token) and the deltaLink cursors. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  /** A live access token for a grant key, reusing the proxy's refresh machinery. */
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  store?: Pick<Connections, "upsertConnections">;
  /** Where attachments land. */
  save: SaveFile;
  /** Injectable for tests; defaults to global `fetch` against Graph. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, resource: string, published: number) => void;
}

/** The Outlook poller: the shared sweep over `microsoft:` grants with a mail scope,
 *  `pollFolder` per folder. */
export function createOutlookPoller(deps: OutlookMailDeps): { tick(): Promise<void> } {
  return createPoller({
    service: SERVICE,
    grantPrefix: GRANT_PREFIX,
    appPrefix: APP_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: FOLDERS,
    watches: (grant) => granted(grant, READ_SCOPES),
    poll: (grant, folder) => pollFolder(deps, grant.key, grant.agentId, folder),
    now: deps.now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
}

type Graph = (url: string, headers?: Record<string, string>) => Promise<Response>;

/** One grant, one folder: read the delta since the stored deltaLink (or bootstrap from
 *  now), publish a row per message, advance the cursor. Returns the number published. */
async function pollFolder(
  deps: OutlookMailDeps,
  key: string,
  agentId: string | undefined,
  folder: string,
): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
  if (!token) throw new Error(`no access token for ${key}`);
  const graph: Graph = (url, headers = {}) =>
    fetchApi(url, {
      headers: { authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  const cursor = await cursorFor(deps.creds, key, MAIL_SYNC, folder);
  if (!cursor) {
    const link = await round(graph, deltaStart(folder, now()));
    await storeCursor(deps.creds, key, MAIL_SYNC, folder, link);
    return 0;
  }

  const upn = key.slice(GRANT_PREFIX.length);
  const base = { service: SERVICE, connection_address: upn };
  let published = 0;
  let link: string | undefined;
  try {
    link = await round(graph, cursor, async (item) => {
      if (item["@removed"]) return;
      const msg = await getMessage(graph, item.id!);
      if (!msg || msg.isDraft) return;
      const m = await messageOf(graph, msg, upn, deps.save, now);
      await deps.publish(mailRow(base, m));
      published++;
    });
  } catch (err) {
    if (err instanceof DeltaGone) {
      await storeCursor(deps.creds, key, MAIL_SYNC, folder, undefined);
      return published;
    }
    throw err;
  }
  if (link) await storeCursor(deps.creds, key, MAIL_SYNC, folder, link);
  return published;
}

/** A read message → the shared shape, its attachments fetched onto the shelf. */
async function messageOf(
  graph: Graph,
  msg: GraphMessage,
  account: string,
  save: SaveFile,
  now: () => string,
): Promise<MailMessage> {
  const parsed = parseMessage(msg, now);
  const files: MailMessage["files"] = [];
  if (msg.hasAttachments && msg.id) {
    const conversation = mailConversation(account, parsed).address;
    const res = await graph(`${GRAPH}/messages/${encodeURIComponent(msg.id)}/attachments`);
    if (res.ok) {
      const { value } = await res.json() as { value?: GraphAttachment[] };
      for (const a of value ?? []) {
        if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline) continue;
        if (!a.contentBytes) continue;
        files.push(
          await save(conversation, decodeBase64(a.contentBytes), {
            mime_type: a.contentType,
            name: a.name,
          }),
        );
      }
    } else await res.body?.cancel(); // the message still lands; the files are the wire's to hold
  }
  return { ...parsed, files };
}

/** The headers and words of a read message. */
export function parseMessage(msg: GraphMessage, now: () => string): Omit<MailMessage, "files"> {
  const box = (r?: Recipient) =>
    r?.emailAddress?.address ? mailbox(r.emailAddress.address, r.emailAddress.name) : undefined;
  const boxes = (rs?: Recipient[]) =>
    (rs ?? []).map(box).filter((b): b is NonNullable<typeof b> => !!b);
  const header = (name: string) =>
    msg.internetMessageHeaders?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
  const from = box(msg.from);
  const content = msg.body?.content?.trim();
  const text = content
    ? msg.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content
    : undefined;
  const inReplyTo = messageId(header("In-Reply-To"));
  return {
    id: messageId(msg.internetMessageId) ?? msg.id!,
    ts: msg.sentDateTime ?? msg.receivedDateTime ?? now(),
    ...(from ? { from } : {}),
    to: boxes(msg.toRecipients),
    cc: boxes(msg.ccRecipients),
    ...(msg.subject ? { subject: msg.subject } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(text ? { text } : {}),
  };
}

/* ── the Graph wire (direct fetch; the broker already holds the secret) ────────────── */

/** Thrown on a 410 — the delta token is too old; the caller re-bootstraps. */
class DeltaGone extends Error {}

/** The first request of a first round: the folder's messages from `since` forward, ids
 *  only — the deltaLink keeps both the selection and the bound. */
function deltaStart(folder: string, since: string): string {
  const q = new URLSearchParams({ $select: "id", $filter: `receivedDateTime ge ${since}` });
  return `${GRAPH}/mailFolders/${encodeURIComponent(folder)}/messages/delta?${q}`;
}

/** One round of the delta: from `url` through every `@odata.nextLink` to the
 *  `@odata.deltaLink` that ends it, `onItem` on each listed message. Returns the deltaLink. */
async function round(
  graph: Graph,
  url: string,
  onItem?: (item: DeltaItem) => Promise<void>,
): Promise<string | undefined> {
  let next: string | undefined = url;
  for (let i = 0; i < 100 && next; i++) { // a bound; a round is one page unless a lot changed
    const res = await graph(next);
    if (res.status === 410) {
      await res.body?.cancel();
      throw new DeltaGone();
    }
    if (!res.ok) throw new Error(`mail delta ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json() as DeltaPage;
    for (const item of page.value ?? []) {
      if (item.id && onItem) await onItem(item);
    }
    if (page["@odata.deltaLink"]) return page["@odata.deltaLink"];
    next = page["@odata.nextLink"];
  }
  return undefined;
}

/** The message behind a listed id, its body as text; `undefined` when it is gone. */
async function getMessage(graph: Graph, id: string): Promise<GraphMessage | undefined> {
  const res = await graph(`${GRAPH}/messages/${encodeURIComponent(id)}?$select=${SELECT}`, {
    prefer: 'outlook.body-content-type="text"',
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.ok) throw new Error(`mail message ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as GraphMessage;
}

/* ── the send: sendMail with the MIME as the body ─────────────────────────────────── */

/** The wire's send for a grant: the MIME itself, base64, to `sendMail`. */
export function outlookSend(deps: MailWireDeps): MailSend {
  return async ({ connection, agentId }, mime) => {
    const key = `${GRANT_PREFIX}${connection}`;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
    if (!token) throw new DispatchError(`no access token for ${key}`, 401);
    const res = await deps.fetchApi(`${GRAPH}/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: encodeBase64(new TextEncoder().encode(mime)),
    });
    if (!res.ok) {
      throw new DispatchError(
        `graph sendMail: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
        res.status,
      );
    }
    await res.body?.cancel();
  };
}

/* ── local entry: `deno task run:microsoft` — every microsoft grant with mail, on a metronome ── */

export function runIngest(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "mail",
    () => Promise.resolve(FOLDERS),
    (deps: PollIngestDeps) => createOutlookPoller({ ...deps, save: mediaShelf(deps.dir) }),
  );
}

export function runDispatch(): Promise<() => Promise<void>> {
  return runMailDispatch(SERVICE, outlookSend);
}

if (import.meta.main) await entry(async () => [await runIngest(), await runDispatch()]);
