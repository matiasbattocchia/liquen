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
 * (`internetMessageHeaders`) come only on a single message's read.
 *
 * Every id is asked immutable (`Prefer: IdType="ImmutableId"`), so a message keeps its id
 * from folder to folder and a read of it that answers 404 means it is gone for good. The
 * feed names a message again whenever it changes, and an `@removed` is one leaving the
 * folder: either way it is read, and how the mailbox shows it — the folder it sits in,
 * read, flagged, its categories — is compared with what its row kept of the last showing
 * (`extra.microsoft.shown`). What moved is the thread's view (connect/mail.ts): read,
 * `starred` for a flag, categories as labels, and a move — Archive, Deleted Items and Junk
 * are `archived`, `trashed` and `spam`, set by arriving and cleared by leaving, and any
 * other folder is its name. A row that kept no showing is one the wire has not shown yet
 * (a new message, or the Sent Items copy of our own send): it is published whole and
 * says nothing. A message gone for good is placed by the thread this process last read it
 * in; one it never read is not placed. Each thread's changes in one round are one line,
 * keyed by the deltaLink the round read from, and the showings are kept after the lines.
 *
 * The body is asked as text (`Prefer: outlook.body-content-type`), so the words are the
 * sender's, never markup. Attachments are the folder's `fileAttachment`s, their bytes in
 * the listing; an `isInline` one is not an attachment.
 *
 * A message's thread is its `conversationId`, the conversation the row is filed in.
 *
 * Sending is two calls: `POST /me/messages` with the MIME itself as the body, base64,
 * makes a draft — Exchange files it by the `References` header the MIME carries, and
 * answers with the draft's `conversationId`, the thread the message is in — then
 * `POST /me/messages/<id>/send` sends it. The draft needs `Mail.ReadWrite`. The copy in
 * Sent Items comes back through the poll under the Message-ID the MIME already wore.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { APP_PREFIX } from "./connect.ts";
import { isTeamsAddress } from "./teams.ts";
import {
  foldView,
  htmlToText,
  MAIL_SYNC,
  mailbox,
  mailConversation,
  type MailMessage,
  mailRef,
  mailRow,
  type MailSend,
  type MailWireDeps,
  mediaShelf,
  messageId,
  referencesOf,
  runMailDispatch,
  type SaveFile,
  type ViewFold,
  viewRows,
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
import type { Appender, Reader } from "../../store/log.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import { type GrantBroker, tokenOf } from "../../proxy/grants.ts";
import { entry } from "../../entry.ts";
import type { Conversation, Draft, MessageEvent, RoomView } from "../../types.ts";

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
  conversationId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  replyTo?: Recipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  internetMessageHeaders?: { name?: string; value?: string }[];
  isRead?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  parentFolderId?: string;
  [k: string]: unknown;
}

/** How the mailbox showed a message when last read, kept on its row. */
interface Shown {
  folder?: string;
  read: boolean;
  flagged: boolean;
  categories: string[];
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
  "conversationId",
  "subject",
  "body",
  "from",
  "toRecipients",
  "ccRecipients",
  "replyTo",
  "sentDateTime",
  "receivedDateTime",
  "hasAttachments",
  "isDraft",
  "internetMessageHeaders",
  "isRead",
  "flag",
  "categories",
  "parentFolderId",
].join(",");

/** Every read asks for ids that hold across moves. */
const IMMUTABLE = 'IdType="ImmutableId"';

export interface OutlookMailDeps {
  /** → the EventLog: a mail is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The log, read: a listed message's row, and how the mailbox showed it last. */
  read: Reader["read"];
  /** The vault: grants (the connections + the refresh_token) and the deltaLink cursors. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  /** A live access token for a grant key, reusing the proxy's refresh machinery. */
  broker: Pick<GrantBroker, "issue" | "accessTokenFor" | "refusal">;
  store?: Pick<Connections, "connections" | "upsertConnections">;
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
  const memory: Memory = { threads: new Map(), folders: folderNames() };
  return createPoller({
    service: SERVICE,
    name: "mail",
    grantPrefix: GRANT_PREFIX,
    appPrefix: APP_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: FOLDERS,
    watches: (grant) => granted(grant, READ_SCOPES),
    poll: (grant, folder) => pollFolder(deps, memory, grant.key, grant.agentId, folder),
    now: deps.now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
}

type Graph = (url: string, headers?: Record<string, string>) => Promise<Response>;

/** How many messages' threads a poller holds, the latest read: where a message deleted for
 *  good is placed. */
const THREADS_HELD = 10_000;

/** What a poller holds across polls: the thread each message was last read in, and each
 *  grant's folders. */
interface Memory {
  threads: Map<string, Conversation>;
  folders: FolderNames;
}

/** One grant, one folder: read the delta since the stored deltaLink (or bootstrap from
 *  now), publish a row per new message and a line per thread whose view moved, keep the
 *  showings, advance the cursor. Returns the number published. */
async function pollFolder(
  deps: OutlookMailDeps,
  memory: Memory,
  key: string,
  agentId: string | undefined,
  folder: string,
): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  const token = await tokenOf(deps.broker, key, agentId);
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
  const fold: ViewFold = new Map();
  const lately = new Map<string, Shown>(); // a message listed twice in a round: its last showing
  const keep = new Map<string, Draft<MessageEvent>>();
  let published = 0;
  let link: string | undefined;
  let gone = false;
  try {
    link = await round(graph, cursor, async (item) => {
      const removed = item["@removed"] !== undefined;
      const msg = await getMessage(graph, item.id!);
      if (!msg) {
        const thread = memory.threads.get(item.id!);
        if (removed && thread) foldView(fold, thread, { deleted: true });
        return;
      }
      if (msg.isDraft) return;
      const parsed = parseMessage(msg, now);
      const conversation = mailConversation(parsed.thread, parsed);
      memory.threads.delete(item.id!);
      memory.threads.set(item.id!, conversation);
      if (memory.threads.size > THREADS_HELD) {
        memory.threads.delete(memory.threads.keys().next().value!);
      }
      const ref = mailRef(upn, parsed.id);
      const shown = shownOf(msg);
      const was = lately.get(ref) ?? await keptOf(deps.read, upn, ref);
      if (!was) {
        if (removed) return; // leaving the folder before the log held it
        const extra = { [SERVICE]: { shown } };
        await deps.publish(mailRow(base, { ...await messageOf(graph, msg, deps, now), extra }));
        lately.set(ref, shown);
        published++;
        return;
      }
      lately.set(ref, shown);
      const change = await changeOf(was, shown, (id) => memory.folders.of(graph, key, id));
      if (Object.keys(change).length === 0) return;
      foldView(fold, conversation, change);
      keep.set(ref, keptRow(base, ref, conversation, shown, now()));
    });
  } catch (err) {
    if (!(err instanceof DeltaGone)) throw err;
    gone = true;
  }
  // the lines before the showings: a round read again finds the old showings, and says
  // the same lines under the same keys
  const lines = await viewRows(base, fold, cursor, now());
  if (lines.length) await deps.publish(lines);
  if (keep.size) await deps.publish([...keep.values()]);
  published += lines.length;
  if (gone) await storeCursor(deps.creds, key, MAIL_SYNC, folder, undefined);
  else if (link) await storeCursor(deps.creds, key, MAIL_SYNC, folder, link);
  return published;
}

/* ── the view: how the mailbox shows a message, and what moved ─────────────────────── */

function shownOf(msg: GraphMessage): Shown {
  return {
    ...(msg.parentFolderId ? { folder: msg.parentFolderId } : {}),
    read: msg.isRead ?? false,
    flagged: msg.flag?.flagStatus === "flagged",
    categories: msg.categories ?? [],
  };
}

/** The showing a message's row kept; nothing when the wire has not shown it yet. */
async function keptOf(read: Reader["read"], upn: string, ref: string): Promise<Shown | undefined> {
  const [row] = await read({ connection: upn, externalId: ref, types: ["message"] });
  return (row?.extra?.[SERVICE] as { shown?: Shown } | undefined)?.shown;
}

/** A showing kept on the row: no parts, so the row's words and files stand, and the
 *  showing merges into its `extra`. */
function keptRow(
  base: { service: typeof SERVICE; connection_address: string },
  ref: string,
  conversation: Conversation,
  shown: Shown,
  ts: string,
): Draft<MessageEvent> {
  return {
    ts,
    type: "message",
    envelope: { ...base, conversation, external_id: ref },
    extra: { [SERVICE]: { shown } },
  } as unknown as Draft<MessageEvent>; // partless by design — see above
}

/** What moved between two showings of a message, as its thread's view. */
async function changeOf(
  was: Shown,
  now: Shown,
  folderOf: (id: string) => Promise<Folder>,
): Promise<RoomView> {
  const added = now.categories.filter((c) => !was.categories.includes(c));
  const removed = was.categories.filter((c) => !now.categories.includes(c));
  const moved = was.folder && now.folder && was.folder !== now.folder
    ? moveOf(await folderOf(was.folder), await folderOf(now.folder))
    : {};
  return {
    ...moved,
    ...(now.read !== was.read ? { read: now.read } : {}),
    ...(now.flagged !== was.flagged ? { starred: now.flagged } : {}),
    ...(added.length || removed.length
      ? { labels: { ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) } }
      : {}),
  };
}

/** The well-known folders that are view fields, by what arriving in one says. */
const VIEW_FOLDERS: Record<string, (on: boolean) => RoomView> = {
  archive: (on) => ({ archived: on }),
  deleteditems: (on) => ({ trashed: on }),
  junkemail: (on) => ({ spam: on }),
};

/** A move as the thread's view: leaving one of the view folders clears its field, arriving
 *  in one sets it, and any other folder is named — but a return to the Inbox from one of
 *  them is the clearing alone. */
export function moveOf(from: Folder, to: Folder): RoomView {
  const left = (from.well ? VIEW_FOLDERS[from.well]?.(false) : undefined) ?? {};
  const came = to.well ? VIEW_FOLDERS[to.well]?.(true) : undefined;
  if (came) return { ...left, ...came };
  if (to.well === "inbox" && Object.keys(left).length) return left;
  return { ...left, folder: to.name };
}

/* ── the folders: a grant's, asked once ────────────────────────────────────────────── */

/** A folder as a move names it: its display name, and its well-known name when it has one. */
export interface Folder {
  name: string;
  well?: string;
}

interface FolderNames {
  of(graph: Graph, key: string, id: string): Promise<Folder>;
}

/** Each grant's folders by id, asked of Graph once per grant per process: the Inbox and the
 *  view folders by their well-known names, any other folder by its id when a move first
 *  names it. A folder that did not answer is asked again. */
function folderNames(): FolderNames {
  const cache = new Map<string, Map<string, Folder>>();
  const ask = async (graph: Graph, path: string) => {
    const res = await graph(`${GRAPH}/mailFolders/${path}?$select=id,displayName`);
    if (res.ok) return await res.json() as { id?: string; displayName?: string };
    await res.body?.cancel();
    return res.status === 404 ? null : undefined; // none in this mailbox · ask again
  };
  return {
    async of(graph, key, id) {
      let folders = cache.get(key);
      if (!folders) {
        folders = new Map();
        let whole = true;
        for (const well of ["inbox", ...Object.keys(VIEW_FOLDERS)]) {
          const f = await ask(graph, well);
          if (f === undefined) whole = false;
          if (f?.id) folders.set(f.id, { name: f.displayName ?? well, well });
        }
        if (whole) cache.set(key, folders);
      }
      const hit = folders.get(id);
      if (hit) return hit;
      const f = await ask(graph, encodeURIComponent(id));
      const found = { name: f?.displayName ?? id };
      if (f) folders.set(id, found);
      return found;
    },
  };
}

/** A read message → the shared shape, its attachments fetched onto its thread's shelf. */
async function messageOf(
  graph: Graph,
  msg: GraphMessage,
  deps: Pick<OutlookMailDeps, "save">,
  now: () => string,
): Promise<MailMessage> {
  const parsed = parseMessage(msg, now);
  const files: MailMessage["files"] = [];
  if (msg.hasAttachments && msg.id) {
    const res = await graph(`${GRAPH}/messages/${encodeURIComponent(msg.id)}/attachments`);
    if (res.ok) {
      const { value } = await res.json() as { value?: GraphAttachment[] };
      for (const a of value ?? []) {
        if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline) continue;
        if (!a.contentBytes) continue;
        files.push(
          await deps.save(decodeBase64(a.contentBytes), {
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
  const references = referencesOf(header("References"));
  const replyTo = boxes(msg.replyTo);
  return {
    id: messageId(msg.internetMessageId) ?? msg.id!,
    thread: msg.conversationId ?? msg.id!,
    ts: msg.sentDateTime ?? msg.receivedDateTime ?? now(),
    ...(from ? { from } : {}),
    to: boxes(msg.toRecipients),
    cc: boxes(msg.ccRecipients),
    ...(replyTo.length ? { replyTo } : {}),
    ...(msg.subject ? { subject: msg.subject } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
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
    const res = await graph(next, { prefer: IMMUTABLE });
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
    prefer: `outlook.body-content-type="text", ${IMMUTABLE}`,
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.ok) throw new Error(`mail message ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as GraphMessage;
}

/* ── the send: sendMail with the MIME as the body ─────────────────────────────────── */

/** The wire's send for a grant: the MIME itself, base64, made a draft — which names the
 *  conversation Exchange filed it in — and the draft sent. A draft the send refuses is
 *  deleted, so a retry leaves none behind. */
export function outlookSend(deps: MailWireDeps): MailSend {
  return async ({ connection, agentId }, { mime }) => {
    const key = `${GRANT_PREFIX}${connection}`;
    const token = await tokenOf(deps.broker, key, agentId);
    const authorization = `Bearer ${token}`;
    const made = await deps.fetchApi(`${GRAPH}/messages`, {
      method: "POST",
      headers: { authorization, "content-type": "text/plain" },
      body: encodeBase64(new TextEncoder().encode(mime)),
    });
    if (!made.ok) {
      throw new DispatchError(
        `graph draft: HTTP ${made.status} ${(await made.text()).slice(0, 300)}` +
          (made.status === 403 ? " — sending needs Mail.ReadWrite on the grant" : ""),
        made.status,
      );
    }
    const draft = await made.json() as { id?: string; conversationId?: string };
    if (!draft.id) throw new DispatchError("graph draft: no id in the answer", 502);
    const draftUrl = `${GRAPH}/messages/${encodeURIComponent(draft.id)}`;
    const sent = await deps.fetchApi(`${draftUrl}/send`, {
      method: "POST",
      headers: { authorization },
    });
    if (!sent.ok) {
      const why = `graph send: HTTP ${sent.status} ${(await sent.text()).slice(0, 300)}`;
      await deps.fetchApi(draftUrl, { method: "DELETE", headers: { authorization } })
        .then((r) => r.body?.cancel())
        .catch(() => {});
      throw new DispatchError(why, sent.status);
    }
    await sent.body?.cancel();
    return draft.conversationId ? { thread: draft.conversationId } : {};
  };
}

/* ── local entry: `deno task run:microsoft` — every microsoft grant with mail, on a metronome ── */

export function runIngest(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "mail",
    () => Promise.resolve(FOLDERS),
    (deps: PollIngestDeps) => createOutlookPoller({ ...deps, save: mediaShelf(deps.storage) }),
  );
}

/** Outlook mail out; a Teams place on the same service is the Teams dispatch's. */
export function runDispatch(): Promise<() => Promise<void>> {
  return runMailDispatch(SERVICE, outlookSend, isTeamsAddress);
}

if (import.meta.main) await entry(async () => [await runIngest(), await runDispatch()]);
