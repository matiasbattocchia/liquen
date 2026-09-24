/**
 * connect/google/mail.ts — the Gmail wire: the poll that reads a mailbox's changes into
 * the log (connect/poll.ts: the cursor, the sweep, the resident loop) and the send that
 * puts a MIME on it, both in the shared mail grammar (connect/mail.ts).
 *
 * What it watches: each google GRANT the org holds (`google:<email>`, minus the
 * `google:app:` client rows) whose consent carries a mail read scope. Gmail's history is
 * MAILBOX-wide — folders are labels — so a grant has one cursor, the `historyId`: a first
 * run takes the mailbox's current one from the profile and publishes nothing; each poll
 * lists `history` from it (`messageAdded` records), reads every listed message in full, and
 * advances to the page's `historyId`. A `404` on the start id means Gmail no longer holds
 * history that far back, and the cursor is dropped to re-bootstrap.
 *
 * A message counts when it is in INBOX or SENT and not a draft: the two sides of every
 * conversation the account is in, and nothing from spam, trash or chat. The account's own
 * sends — the agent's through the API, the principal's from a client — arrive by SENT as
 * the wire's copy, keyed by the same Message-ID (the API's send is a MIME we author).
 *
 * The body is the first `text/plain` part; a message that came only as HTML is read as
 * words (`htmlToText`). Attachments are the parts with a filename, fetched by
 * `attachmentId`; a part disposed `inline` is not one.
 *
 * Sending is `messages.send` with the MIME as `raw` and, for a reply, the referent's
 * `threadId` (kept as the row's `extra.google.thread`): Gmail files a message into a thread
 * by that id together with the `References` header the MIME already carries.
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import {
  htmlToText,
  MAIL_SYNC,
  type Mailbox,
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

const SERVICE = "google" as const;
const GRANT_PREFIX = "google:";
const APP_PREFIX = "google:app:";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A grant the mail poll applies to carries one of these. */
export const READ_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

/** The one resource a Gmail grant is polled on: history is mailbox-wide. */
export const MAILBOX = "mailbox";

/* ── the wire's shapes ─────────────────────────────────────────────────────────────── */

interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

/** A `messages.get?format=full` answer. */
export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  /** Epoch milliseconds, as a string. */
  internalDate?: string;
  payload?: GmailPart;
}

interface HistoryPage {
  history?: {
    id?: string;
    messagesAdded?: { message?: { id?: string; threadId?: string; labelIds?: string[] } }[];
  }[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailDeps {
  /** → the EventLog: a mail is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The vault: grants (the connections + the refresh_token) and the historyId cursor. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  /** A live access token for a grant key, reusing the proxy's refresh machinery. */
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  store?: Pick<Connections, "upsertConnections">;
  /** Where attachments land. */
  save: SaveFile;
  /** Injectable for tests; defaults to global `fetch` against the Gmail API. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, resource: string, published: number) => void;
}

/** The Gmail poller: the shared sweep over `google:` grants with a mail scope. */
export function createGmailPoller(deps: GmailDeps): { tick(): Promise<void> } {
  return createPoller({
    service: SERVICE,
    grantPrefix: GRANT_PREFIX,
    appPrefix: APP_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: [MAILBOX],
    watches: (grant) => granted(grant, READ_SCOPES),
    poll: (grant) => pollMailbox(deps, grant.key, grant.agentId),
    now: deps.now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
}

type Api = (path: string) => Promise<Response>;

/** One grant: read the history since the stored id (or bootstrap from the profile's),
 *  publish a row per message, advance the cursor. Returns the number published. */
async function pollMailbox(deps: GmailDeps, key: string, agentId?: string): Promise<number> {
  const fetchApi = deps.fetchApi ?? fetch;
  const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
  if (!token) throw new Error(`no access token for ${key}`);
  const api: Api = (path) =>
    fetchApi(`${GMAIL}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  const cursor = await cursorFor(deps.creds, key, MAIL_SYNC, MAILBOX);
  if (!cursor) {
    const res = await api("/profile");
    if (!res.ok) {
      throw new Error(`gmail profile ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const { historyId } = await res.json() as { historyId?: string };
    await storeCursor(deps.creds, key, MAIL_SYNC, MAILBOX, historyId);
    return 0;
  }

  const email = key.slice(GRANT_PREFIX.length);
  const base = { service: SERVICE, connection_address: email };
  const seen = new Set<string>(); // a message can appear under several history records
  let latest = cursor;
  let pageToken: string | undefined;
  let published = 0;
  do {
    const q = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await api(`/history?${q}`);
    if (res.status === 404) {
      // the start id is older than the history Gmail keeps: start over from now
      await res.body?.cancel();
      await storeCursor(deps.creds, key, MAIL_SYNC, MAILBOX, undefined);
      return published;
    }
    if (!res.ok) {
      throw new Error(`gmail history ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const page = await res.json() as HistoryPage;
    for (const h of page.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const stub = added.message;
        if (!stub?.id || seen.has(stub.id)) continue;
        seen.add(stub.id);
        if (!inConversation(stub.labelIds)) continue;
        const full = await getMessage(api, stub.id);
        if (!full) continue;
        const m = await messageOf(api, full, email, deps.save);
        await deps.publish(mailRow(base, m));
        published++;
      }
    }
    latest = page.historyId ?? latest;
    pageToken = page.nextPageToken;
  } while (pageToken);

  await storeCursor(deps.creds, key, MAIL_SYNC, MAILBOX, latest);
  return published;
}

/** In INBOX or SENT, and not a draft. */
function inConversation(labels: string[] = []): boolean {
  return (labels.includes("INBOX") || labels.includes("SENT")) && !labels.includes("DRAFT");
}

/** A full message → the shared shape, its attachments fetched onto the shelf. */
async function messageOf(
  api: Api,
  full: GmailMessage,
  account: string,
  save: SaveFile,
): Promise<MailMessage> {
  const parsed = parseMessage(full);
  const conversation = mailConversation(account, parsed).address;
  const files: MailMessage["files"] = [];
  for (const a of parsed.attachments) {
    const res = await api(
      `/messages/${encodeURIComponent(full.id!)}/attachments/${encodeURIComponent(a.id)}`,
    );
    if (!res.ok) {
      await res.body?.cancel();
      continue; // the message still lands; the attachment is the wire's to hold
    }
    const { data } = await res.json() as { data?: string };
    if (!data) continue;
    files.push(
      await save(conversation, decodeBase64Url(data), { mime_type: a.mime, name: a.name }),
    );
  }
  return { ...parsed, files };
}

/** The headers, words and attachment handles of a full message. */
export function parseMessage(
  full: GmailMessage,
): Omit<MailMessage, "files"> & { attachments: { id: string; name: string; mime: string }[] } {
  const headers = full.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value;
  const [from] = parseAddresses(h("From"));
  let plain: string | undefined;
  let html: string | undefined;
  const attachments: { id: string; name: string; mime: string }[] = [];
  const walk = (p: GmailPart) => {
    const disposition = p.headers?.find((x) => x.name?.toLowerCase() === "content-disposition")
      ?.value ?? "";
    if (p.filename && p.body?.attachmentId) {
      if (!/^\s*inline/i.test(disposition)) {
        attachments.push({
          id: p.body.attachmentId,
          name: p.filename,
          mime: p.mimeType ?? "application/octet-stream",
        });
      }
    } else if (p.mimeType === "text/plain" && p.body?.data && plain === undefined) {
      plain = decodeText(p.body.data);
    } else if (p.mimeType === "text/html" && p.body?.data && html === undefined) {
      html = decodeText(p.body.data);
    }
    for (const child of p.parts ?? []) walk(child);
  };
  if (full.payload) walk(full.payload);
  const text = plain ?? (html !== undefined ? htmlToText(html) : undefined);
  const ms = Number(full.internalDate);
  const ts = Number.isFinite(ms) && full.internalDate
    ? new Date(ms).toISOString()
    : new Date(h("Date") ?? Date.now()).toISOString();
  return {
    id: messageId(h("Message-ID")) ?? full.id!,
    ts,
    ...(from ? { from } : {}),
    to: parseAddresses(h("To")),
    cc: parseAddresses(h("Cc")),
    ...(h("Subject") ? { subject: h("Subject") } : {}),
    ...(messageId(h("In-Reply-To")) ? { inReplyTo: messageId(h("In-Reply-To")) } : {}),
    ...(text ? { text } : {}),
    attachments,
    ...(full.threadId ? { extra: { google: { thread: full.threadId } } } : {}),
  };
}

function decodeText(b64url: string): string {
  return new TextDecoder().decode(decodeBase64Url(b64url));
}

/** An address-list header (`"Ana García" <ana@x.com>, bob@y.com`) → mailboxes. The API
 *  hands headers decoded, so a name arrives as its words. */
export function parseAddresses(header?: string): Mailbox[] {
  if (!header) return [];
  const out: Mailbox[] = [];
  // split on commas outside quotes and angle brackets
  const items: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(item);
    if (m) {
      const name = m[1].trim().replace(/^"(.*)"$/, "$1").replaceAll('\\"', '"').trim();
      out.push(mailbox(m[2], name || undefined));
    } else if (item.includes("@")) {
      out.push(mailbox(item.replace(/^<|>$/g, "")));
    }
  }
  return out;
}

/** The message behind a listed id, in full; `undefined` when it is gone. */
async function getMessage(api: Api, id: string): Promise<GmailMessage | undefined> {
  const res = await api(`/messages/${encodeURIComponent(id)}?format=full`);
  if (res.status === 404) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.ok) throw new Error(`gmail message ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as GmailMessage;
}

/* ── the send: messages.send with the MIME as raw ─────────────────────────────────── */

/** The wire's send for a grant: the MIME as `raw`, threaded by the referent's thread. */
export function gmailSend(deps: MailWireDeps): MailSend {
  return async ({ connection, agentId }, mime, re) => {
    const key = `${GRANT_PREFIX}${connection}`;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
    if (!token) throw new DispatchError(`no access token for ${key}`, 401);
    const thread = (re?.extra?.google as { thread?: string } | undefined)?.thread;
    const res = await deps.fetchApi(`${GMAIL}/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        raw: encodeBase64Url(new TextEncoder().encode(mime)),
        ...(thread ? { threadId: thread } : {}),
      }),
    });
    if (!res.ok) {
      throw new DispatchError(
        `gmail send: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
        res.status,
      );
    }
    await res.body?.cancel();
  };
}

/* ── local entry: `deno task run:google` — every google grant with mail, on a metronome ── */

export function runIngest(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "mail",
    () => Promise.resolve([MAILBOX]),
    (deps: PollIngestDeps) => createGmailPoller({ ...deps, save: mediaShelf(deps.dir) }),
  );
}

export function runDispatch(): Promise<() => Promise<void>> {
  return runMailDispatch(SERVICE, gmailSend);
}

if (import.meta.main) await entry(async () => [await runIngest(), await runDispatch()]);
