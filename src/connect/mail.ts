/**
 * connect/mail.ts — what every mail connector shares: the row a message becomes, the
 * conversation it lands in, the MIME a send is, and the dispatch loop. The poll that
 * finds the messages is `poll.ts`; a mail service's connector (`google/mail.ts`,
 * `microsoft/mail.ts`) owns its WIRE — how the mailbox is asked for what changed, how a
 * message and its attachments are read, how a MIME is handed over for sending — and hands
 * the result here as a `MailMessage`. From that point on one code path publishes and one
 * sends, so a mail reads the same in the window whichever service carried it.
 *
 * Email is conversation-shaped and lands in the log as one (DESIGN §4): the rows ride the
 * GRANT's service (`google`, `microsoft`) on the grant's connection, the way calendar rows
 * do, so one connection row and one process carry an account whole.
 *
 * A THREAD is a conversation (DESIGN §4), addressed by the id the MAILBOX files it under —
 * Gmail's `threadId`, Graph's `conversationId` — so a thread in the log is the thread the
 * account's own inbox shows. It is `kind: direct`, the shape of a group DM: its members
 * are whoever the latest message went to, and someone added later sees only what a message
 * carries to them. Its name is the subject with the reply and forward prefixes off. The
 * recipients of every message ride the row (`extra.mail`: To, Cc, Reply-To, and the
 * `References` it carried), so a reply reaches the thread's members without the wire being
 * asked: a reply-all to the latest message whose recipients the log knows.
 *
 * `external_id` is `mail:<Message-ID>` — the RFC 5322 id. Our own sends mint theirs, and
 * the copy the mailbox keeps in Sent comes back through the poll as the echo that MERGES
 * into the row it left from (§4). The wire answers a send with the thread it filed the
 * message in, and the row moves there when that is not where it stood: a first send, whose
 * address was the recipients, comma-joined, lands in the thread it opened. An inbound
 * `In-Reply-To` is the row's `reply` reference: the window shows which line it answers.
 *
 * A message's words are the part's `text`: the plain body, its quoted history cut off
 * (`stripQuotes` — a reply carries the whole thread below it, and the log already holds
 * that thread). Attachments are file parts on the media shelf; inline images (signature
 * logos, pasted screenshots the body already reads around) are not attachments.
 *
 * The cursor's namespace on the grant is `extra.mail_sync`, keyed by the folder or
 * mailbox the wire polls (`poll.ts`).
 */

import { encodeBase64 } from "@std/encoding/base64";
import { createDispatcher } from "./dispatcher.ts";
import { DispatchError } from "./errors.ts";
import type { DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import type { GrantBroker } from "../proxy/grants.ts";
import { isExternal, kindOf, pathOf, saveMedia } from "../store/media.ts";
import type { Conversation, Draft, EventId, FilePart, MessageEvent, Service } from "../types.ts";
import { findRoot, orgFlag } from "../config.ts";
import { timedFetch } from "./http.ts";

/** Where a grant keeps its mail cursors (`cursorFor`/`storeCursor`, poll.ts). */
export const MAIL_SYNC = "mail_sync";

/** An address on the wire, with the display name the header gave it. */
export interface Mailbox {
  address: string;
  name?: string;
}

/** One message, the way a service hands it over once its wire is read. */
export interface MailMessage {
  /** The RFC 5322 Message-ID, angle brackets off. */
  id: string;
  /** The mailbox's id for the thread the message is filed in. */
  thread: string;
  /** When it was sent (the wire's stamp). */
  ts: string;
  from?: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  /** Where the sender asks replies to go, in place of From. */
  replyTo?: Mailbox[];
  subject?: string;
  /** The Message-ID this one answers, angle brackets off. */
  inReplyTo?: string;
  /** The thread's ids from its root down, angle brackets off (the `References` header). */
  references?: string[];
  /** The body as plain words, quoted history and all — `mailRow` cuts the quotes. */
  text?: string;
  /** The attachments, already on the media shelf. */
  files: FilePart[];
  /** Per-service provenance, under the service's name (types.ts `Extra`). */
  extra?: Record<string, unknown>;
}

/** A Message-ID header value → the bare id (`<a@b>` → `a@b`); nothing for an empty one. */
export function messageId(header?: string): string | undefined {
  const bare = header?.trim().replace(/^<|>$/g, "").trim();
  return bare || undefined;
}

/** The log's key for a message in `account`'s mailbox. A Message-ID names the message on
 *  every wire, and each mailbox holding it keeps a copy of its own — filed in its own
 *  thread, answered from that account — so the key is the pair. */
export function mailRef(account: string, id: string): string {
  return `mail:${account.toLowerCase()}:${id}`;
}

/** The Message-ID a key of `account`'s names; `undefined` for any other key. */
export function messageIdOf(account: string, ref: string | undefined): string | undefined {
  const prefix = `mail:${account.toLowerCase()}:`;
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

/** A mailbox, its address lower-cased: the wire is case-insensitive about addresses in
 *  practice, and the conversation is keyed on them. */
export function mailbox(address: string, name?: string): Mailbox {
  const clean = name?.trim();
  return { address: address.trim().toLowerCase(), ...(clean ? { name: clean } : {}) };
}

/** The reply and forward prefixes mail clients write, across the languages they localize
 *  them into: English `Re`/`Fw`/`Fwd`, German `AW`/`WG`, Nordic `SV`/`VS`, Spanish `RV`,
 *  Portuguese `RES`/`ENC`, French `TR`, Dutch `Antw`/`Doorst`, Italian `R`/`I`/`Rif`. */
const PREFIXES =
  /^(\s*(re|fwd?|aw|wg|sv|vs|rv|res|enc|tr|antw|doorst|rif|r|i)\s*(\[\d+\])?\s*:\s*)+/i;

/** The reply and forward prefixes off a subject, so every message of a thread names it the
 *  same way. */
export function threadOf(subject?: string): string | undefined {
  const t = (subject ?? "").replace(PREFIXES, "").trim();
  return t || undefined;
}

/** The other parties of a message on `account`: From, To and Cc without the account's own
 *  address, one entry per address, sorted. Empty when the account wrote to itself. */
export function participants(
  account: string,
  m: Pick<MailMessage, "from" | "to" | "cc">,
): Mailbox[] {
  const own = account.toLowerCase();
  const seen = new Map<string, Mailbox>();
  for (const p of [...(m.from ? [m.from] : []), ...m.to, ...m.cc]) {
    const a = p.address.toLowerCase();
    if (a === own || !a) continue;
    const prior = seen.get(a);
    if (!prior) seen.set(a, { ...p, address: a });
    else if (!prior.name && p.name) prior.name = p.name;
  }
  return [...seen.values()].sort((x, y) =>
    x.address < y.address ? -1 : x.address > y.address ? 1 : 0
  );
}

/** The `References` header → the bare ids, root first. */
export function referencesOf(header?: string): string[] {
  return (header ?? "").split(/\s+/).map((h) => messageId(h)).filter((id): id is string => !!id);
}

/** How many of a thread's latest messages a reply looks through for one whose recipients
 *  the log knows. */
const THREAD_REACH = 50;

/** The conversation a message belongs to: the mailbox's thread, named by its subject. */
export function mailConversation(thread: string, m: Pick<MailMessage, "subject">): Conversation {
  const name = threadOf(m.subject);
  return { address: thread, kind: "direct", ...(name ? { name } : {}) };
}

/** Whether an address is a recipient list: one or more addresses, comma-joined. */
export function isMailAddress(address: string): boolean {
  const parts = address.split(",");
  return parts.length > 0 && parts.every((p) => /^[^\s@,<>:]+@[^\s@,<>:]+$/.test(p));
}

/** The addressing a row keeps (`extra.mail`): who the message went to besides its sender,
 *  where its sender asked replies to go, and the `References` it carried, root first. */
export interface MailExtra {
  to: Mailbox[];
  cc: Mailbox[];
  replyTo?: Mailbox[];
  references?: string[];
}

/** One message → its row in its thread: sender the From, the words and the files its
 *  parts, a reply pointing at the message it answers, the addressing kept. Harness-derived
 *  like every wire row: no `agent`. */
export function mailRow(
  base: { service: Service; connection_address: string },
  m: MailMessage,
): Draft<MessageEvent> {
  const text = stripQuotes(m.text ?? "");
  const parts: MessageEvent["parts"] = [
    ...(text ? [{ type: "text", kind: "text", text } as const] : []),
    ...m.files,
  ];
  const mail: MailExtra = {
    to: m.to,
    cc: m.cc,
    ...(m.replyTo?.length ? { replyTo: m.replyTo } : {}),
    ...(m.references?.length ? { references: m.references } : {}),
  };
  return {
    ts: m.ts,
    type: "message",
    ...(m.inReplyTo
      ? {
        payload: {
          action: "reply",
          ref_external_id: mailRef(base.connection_address, m.inReplyTo),
        },
      }
      : {}),
    envelope: {
      ...base,
      conversation: mailConversation(m.thread, m),
      ...(m.from ? { sender: m.from } : {}),
      external_id: mailRef(base.connection_address, m.id),
    },
    parts,
    extra: { ...m.extra, mail },
  };
}

/** The addressing a row kept, when it kept any: a row the wire has not echoed back yet
 *  (our own send, just dispatched) knows no recipients. */
function mailOf(e: MessageEvent): MailExtra | undefined {
  const mail = e.extra?.mail as MailExtra | undefined;
  return mail && Array.isArray(mail.to) ? mail : undefined;
}

/** A reply-all to one message, as `account`: its Reply-To in place of its sender when it
 *  names one, its To and Cc, the account never. One entry per address, sorted. */
export function replyAll(account: string, e: MessageEvent): Mailbox[] {
  const mail = mailOf(e);
  const sender = e.envelope.sender?.address
    ? [mailbox(e.envelope.sender.address, e.envelope.sender.name)]
    : [];
  const answer = mail?.replyTo?.length ? mail.replyTo : sender;
  return participants(account, { to: [...answer, ...(mail?.to ?? [])], cc: mail?.cc ?? [] });
}

/** The `References` a reply to `parent` (Message-ID `id`, in `account`'s mailbox) carries:
 *  the parent's own, else the message it answered, then the parent. */
export function referencesTo(account: string, parent: MessageEvent, id: string): string[] {
  const answered = messageIdOf(account, parent.payload?.ref_external_id);
  const own = mailOf(parent)?.references ?? (answered ? [answered] : []);
  return [...new Set([...own, id])];
}

/* ── the words: quotes off, markup off ─────────────────────────────────────────────── */

/** A line that opens the quoted history under a reply: a mail client's attribution
 *  (`On …, Ana wrote:`, its Spanish and German forms), Outlook's separator, or a forwarded
 *  header block. The attribution may wrap onto a second line. */
const QUOTE_OPENERS = [
  /^On .+wrote:\s*$/,
  /^El .+escribi[oó]:\s*$/,
  /^Am .+schrieb .*:\s*$/,
  /^Le .+a écrit\s*:\s*$/,
  /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Mensaje (original|reenviado)\s*-{2,}\s*$/i,
  /^_{3,}\s*$/,
];

/** The words the sender typed: the body cut at the first line that opens quoted history,
 *  or at a trailing block of `>`-quoted lines. A body that is nothing but a quote (a bare
 *  forward) keeps its words, since cutting it would leave nothing. */
export function stripQuotes(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (QUOTE_OPENERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
    // an attribution wrapped onto two lines: `On Tue, …, Ana <ana@x.com>` / `wrote:`
    if (
      /^(On|El) .+[>,]\s*$/.test(line) &&
      /^(wrote|escribi[oó]):\s*$/.test(lines[i + 1]?.trim() ?? "")
    ) {
      cut = i;
      break;
    }
    // a forwarded header block: `From: …` followed by `Sent:`/`Date:`/`To:` within 3 lines
    if (
      /^(From|De):\s/.test(line) &&
      lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date|To|Enviado|Para):\s/.test(l.trim()))
    ) {
      cut = i;
      break;
    }
  }
  // the trailing `>` block: everything from the first quoted line on, when nothing but
  // quotes and blanks follow it
  let first = cut;
  for (let i = cut - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith(">")) first = i;
    else break;
  }
  const kept = lines.slice(0, first).join("\n").trim();
  return kept || text.trim();
}

/** A body that came only as HTML, as words: blocks become line breaks, links keep their
 *  target (`[text](url)`), entities decode, and nothing else of the markup survives. */
export function htmlToText(html: string): string {
  const out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = String(href).trim();
      return !label || label === url ? url : `[${label}](${url})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ── the media shelf: attachments land beside the conversation ─────────────────────── */

/** Store one attachment's bytes for a conversation → the file part. */
export type SaveFile = (
  conversation: string,
  bytes: Uint8Array,
  meta: { mime_type?: string; name?: string },
) => Promise<FilePart>;

/** The org's media shelf under `dir` (the data root). */
export function mediaShelf(dir: string): SaveFile {
  return async (conversation, bytes, meta) => {
    const file = await saveMedia(dir, conversation, bytes, meta);
    return { type: "file", kind: kindOf(file.mime_type), file };
  };
}

/* ── the send: one MIME, handed to the wire ────────────────────────────────────────── */

/** What a mail send is, before the wire: the headers a message needs and its parts. */
export interface Outgoing {
  from: Mailbox;
  to: Mailbox[];
  subject?: string;
  /** RFC 5322 date. */
  date: string;
  /** The bare id this message wears; the wire and the log both key on it. */
  messageId: string;
  /** The bare id of the message it answers. */
  inReplyTo?: string;
  /** The thread's ids, root first; `inReplyTo` alone when absent. */
  references?: string[];
  text: string;
  files: { name: string; mime: string; bytes: Uint8Array }[];
}

/** A fresh Message-ID for a message sent from `account`: unique, and in the account's
 *  domain the way a mail client would mint it. */
export function mintMessageId(account: string): string {
  const domain = account.slice(account.indexOf("@") + 1) || "liquen";
  return `${crypto.randomUUID()}@${domain}`;
}

/** The message as RFC 5322 text: CRLF lines, UTF-8 throughout (headers encoded where they
 *  need it, bodies base64), one text part, `multipart/mixed` when files ride along. */
export function buildMime(m: Outgoing): string {
  const CRLF = "\r\n";
  const refs = m.references ?? (m.inReplyTo ? [m.inReplyTo] : []);
  const headers = [
    `From: ${mailboxHeader(m.from)}`,
    `To: ${m.to.map(mailboxHeader).join(", ")}`,
    ...(m.subject ? [`Subject: ${encodeWord(m.subject)}`] : []),
    `Date: ${m.date}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...(refs.length ? [`References: ${refs.map((r) => `<${r}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(encodeBase64(new TextEncoder().encode(m.text))),
  ].join(CRLF);
  if (m.files.length === 0) return [...headers, textPart].join(CRLF) + CRLF;
  const boundary = `=_liquen_${crypto.randomUUID().replaceAll("-", "")}`;
  const attachments = m.files.map((f) =>
    [
      `Content-Type: ${f.mime}; name="${quoted(f.name)}"`,
      `Content-Disposition: attachment; filename="${quoted(f.name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(encodeBase64(f.bytes)),
    ].join(CRLF)
  );
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...[textPart, ...attachments].map((p) => `--${boundary}${CRLF}${p}`),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

/** `Name <address>`, the name encoded and quoted as the header needs. */
function mailboxHeader(m: Mailbox): string {
  if (!m.name) return `<${m.address}>`;
  const name = /[^\x20-\x7e]/.test(m.name) ? encodeWord(m.name) : `"${quoted(m.name)}"`;
  return `${name} <${m.address}>`;
}

/** RFC 2047 encoded-word for a header value with characters outside printable ASCII;
 *  a plain one stands as it is. */
function encodeWord(s: string): string {
  return /[^\x20-\x7e]/.test(s) ? `=?utf-8?B?${encodeBase64(new TextEncoder().encode(s))}?=` : s;
}

function quoted(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ");
}

function wrap76(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/* ── the dispatch loop: the log's outbound mail onto the wire ──────────────────────── */

/** One message for the wire: the MIME, the Message-ID it wears, and — for a reply — the
 *  mailbox's id for the thread it goes into. */
export interface MailOut {
  mime: string;
  messageId: string;
  thread?: string;
}

/** Put one message on the wire as `grant` (the account, and whose hand), answering with
 *  the thread the mailbox filed it in when the wire can say. Throws to fail the send —
 *  `DispatchError` carries the class. */
export type MailSend = (
  grant: { connection: string; agentId?: string },
  out: MailOut,
) => Promise<{ thread?: string }>;

export interface MailDispatchDeps {
  service: Service;
  subscribe: Subscriber["subscribe"];
  read: Reader["read"];
  send: MailSend;
  /** An address another wire of the same service carries (Teams, beside Outlook mail):
   *  its rows are that wire's dispatch's, and this one leaves them queued for it. */
  elsewhere?: (address: string) => boolean;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  /** The clock the Date header and the mint read. */
  now?: () => string;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, id: string | undefined) => void;
}

interface Work {
  connection: string;
  address: string;
  text: string;
  files: FilePart[];
  ref?: string;
}

/** Wire dispatch to the log — the shared loop (`dispatcher.ts`) with one leg: a message is
 *  a MIME the wire sends. A send into a thread the account's log holds goes to the
 *  thread's members — a reply-all to its latest message whose recipients the log knows —
 *  under `Re:` its name. `re` quotes: it names the line answered (`In-Reply-To`), and
 *  without it the answer is to the thread's latest; either way the members are the
 *  same. A send to addresses opens a thread. The row moves to the thread the wire filed it
 *  in, when that is not where it stood. Mail has no edit, delete or reaction, so those
 *  sends fail with the sentence rather than vanish. Returns stop. */
export function createMailDispatch(deps: MailDispatchDeps): () => Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  return createDispatcher<Work>({
    subscribe: deps.subscribe,
    read: deps.read,
    service: deps.service,
    setDelivery: deps.setDelivery,
    onError: deps.onError,
    onSent: deps.onSent,
    select: (event) => {
      const connection = event.envelope.connection_address;
      const address = event.envelope.conversation.address;
      if (!connection || !address || deps.elsewhere?.(address)) return null;
      const parts = event.parts ?? [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const files = parts.filter((p): p is FilePart => p.type === "file");
      const ref = event.payload?.ref_external_id;
      return { connection, address, text, files, ...(ref ? { ref } : {}) };
    },
    post: async (work, event) => {
      const action = event.payload?.action;
      if (action && action !== "reply") {
        throw new DispatchError(`mail cannot ${action} a message once sent`, 400);
      }
      // the thread this send lands in: the mail rows the account's log files at its
      // address, newest first — none, and the address is who it opens one with
      const thread = (await deps.read({
        connection: work.connection,
        conversation: work.address,
        types: ["message"],
        limit: THREAD_REACH,
      }) as MessageEvent[])
        .filter((e) =>
          e.id !== event.id && messageIdOf(work.connection, e.envelope.external_id) !== undefined
        )
        .reverse();
      if (thread.length === 0 && !isMailAddress(work.address)) {
        throw new DispatchError(`${work.address} is not a mail address`, 400);
      }
      // the referent: the message this one answers — the line named, else the thread's last
      let re: MessageEvent | undefined;
      if (work.ref) {
        if (messageIdOf(work.connection, work.ref) === undefined) {
          throw new DispatchError("the message replied to is not a mail of this account", 400);
        }
        [re] = (await deps.read({
          connection: work.connection,
          externalId: work.ref,
          types: ["message"],
        })) as MessageEvent[];
      } else re = thread[0];
      const name = event.envelope.conversation.name;
      const subject = thread.length ? (name ? `Re: ${name}` : undefined) : name;
      // the members: whoever the latest message the log knows the recipients of went to
      const latest = thread.find((e) => mailOf(e) !== undefined);
      const to = thread.length
        ? (latest ? replyAll(work.connection, latest) : [])
        : work.address.split(",").map((a) => mailbox(a));
      if (to.length === 0) throw new DispatchError("the thread has nobody to answer", 400);
      // the headers a reply is threaded by: the parent, and the chain the parent carried
      const parent = messageIdOf(work.connection, re?.envelope.external_id);
      const references = re && parent ? referencesTo(work.connection, re, parent) : [];
      // local files ride as attachments; an external link joins the words as a line
      const files: Outgoing["files"] = [];
      const links: string[] = [];
      for (const f of work.files) {
        if (isExternal(f.file.uri)) {
          links.push(f.file.uri);
          continue;
        }
        const name = f.file.name ?? f.file.uri.slice(f.file.uri.lastIndexOf("/") + 1);
        files.push({
          name,
          mime: f.file.mime_type,
          bytes: await Deno.readFile(pathOf(f.file.uri)),
        });
      }
      const text = [work.text, ...links].filter((s) => s.length > 0).join("\n");
      if (!text && files.length === 0) throw new DispatchError("nothing to send", 400);
      const id = mintMessageId(work.connection);
      const mime = buildMime({
        from: mailbox(work.connection),
        to,
        ...(subject ? { subject } : {}),
        date: rfcDate(now()),
        messageId: id,
        ...(parent ? { inReplyTo: parent } : {}),
        references,
        text,
        files,
      });
      const filed = await deps.send({ connection: work.connection, agentId: event.agent?.id }, {
        mime,
        messageId: id,
        ...(thread.length ? { thread: work.address } : {}),
      });
      // the id is ours, so the row carries it before the Sent copy comes back to merge. The
      // row stands where the mailbox filed it: a thread opened here is the one the wire
      // answered, and a wire that cannot say leaves it at the minted id
      const at = filed.thread ?? (thread.length ? work.address : id);
      return {
        id,
        external_id: mailRef(work.connection, id),
        sender: { address: work.connection },
        ...(at !== work.address
          ? { conversation: mailConversation(at, { subject: name ?? subject }) }
          : {}),
      };
    },
  });
}

/** An ISO instant as the Date header spells it. */
export function rfcDate(iso: string): string {
  return new Date(iso).toUTCString().replace(/GMT$/, "+0000");
}

/* ── local entry: the dispatch half over the org's log and vault ───────────────────── */

/** What a wire's `send` is built with: the vault and broker for the token, a bounded fetch. */
export interface MailWireDeps {
  creds: Pick<Credentials, "get">;
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  fetchApi: typeof fetch;
}

/** Wire the outbound half over the org's log — resident once it returns (subscribed).
 *  Returns stop: unsubscribe, settle the posts in flight, release the handles. */
export async function runMailDispatch(
  service: Service,
  wire: (deps: MailWireDeps) => MailSend,
  elsewhere?: (address: string) => boolean,
): Promise<() => Promise<void>> {
  const { openStore } = await import("../store/mod.ts");
  const { createGrantBroker } = await import("../proxy/grants.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  const broker = createGrantBroker({ creds });
  const stop = createMailDispatch({
    service,
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    send: wire({ creds, broker, fetchApi: timedFetch }),
    ...(elsewhere ? { elsewhere } : {}),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[dispatch] ${service} mail: watching ${dir}/log for outbound sends`);
  return async () => {
    await stop();
    await creds.close();
    await log.close();
  };
}
