import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import {
  buildMime,
  createMailDispatch,
  htmlToText,
  isMailAddress,
  mailbox,
  mailConversation,
  type MailOut,
  mailRef,
  mailRow,
  messageId,
  messageIdOf,
  mintMessageId,
  participants,
  referencesOf,
  referencesTo,
  replyAll,
  rfcDate,
  stripQuotes,
  threadOf,
} from "./mail.ts";
import type { DeliveryPatch, ReadQuery, Subscriber } from "../store/log.ts";
import type { Draft, Event, EventId, MessageEvent } from "../types.ts";
import { newId } from "../store/id.ts";

const ME = "me@org.com";
const ANA = mailbox("Ana@X.com", "Ana García");
const BOB = mailbox("bob@y.com");

Deno.test("mail: a Message-ID sheds its brackets; a thread sheds its Re:/Fwd: prefixes", () => {
  assertEquals(messageId("<abc@x.com>"), "abc@x.com");
  assertEquals(messageId(" <abc@x.com> "), "abc@x.com");
  assertEquals(messageId(""), undefined);
  assertEquals(messageId(undefined), undefined);
  assertEquals(threadOf("Re: Re: Invoice 42"), "Invoice 42");
  assertEquals(threadOf("Fwd: RE: hola"), "hola");
  assertEquals(threadOf("AW: Rechnung"), "Rechnung");
  // the localized forms: Spanish and Portuguese Outlook, French, German, Dutch, Italian
  assertEquals(threadOf("RV: Factura"), "Factura");
  assertEquals(threadOf("RE: RV: Factura"), "Factura");
  assertEquals(threadOf("RES: ENC: Proposta"), "Proposta");
  assertEquals(threadOf("TR: Devis"), "Devis");
  assertEquals(threadOf("WG: Angebot"), "Angebot");
  assertEquals(threadOf("Antw: Doorst: Offerte"), "Offerte");
  assertEquals(threadOf("R: I: Rif: Preventivo"), "Preventivo");
  assertEquals(threadOf("Re[2]: hola"), "hola");
  // a word that starts like a prefix, with no colon after it, is the subject
  assertEquals(threadOf("Rear window"), "Rear window");
  assertEquals(threadOf("Tres amigos"), "Tres amigos");
  assertEquals(threadOf("Informe: septiembre"), "Informe: septiembre");
  assertEquals(threadOf("  "), undefined);
  assertEquals(threadOf(undefined), undefined);
});

Deno.test("mail: the participants are the other parties, lower-cased and sorted; the account never", () => {
  const m = {
    from: ANA,
    to: [mailbox("ME@ORG.COM"), BOB],
    cc: [mailbox("me@org.com")],
  };
  assertEquals(participants(ME, m).map((p) => p.address), ["ana@x.com", "bob@y.com"]);
  // one entry per address, the name from whichever header carried one
  const twice = participants(ME, {
    from: mailbox("bob@y.com"),
    to: [mailbox("Bob@Y.com", "Bob")],
    cc: [],
  });
  assertEquals(twice, [{ address: "bob@y.com", name: "Bob" }]);
});

Deno.test("mail: a thread is a group conversation at the mailbox's thread id, named by its subject", () => {
  assertEquals(mailConversation("t1", { subject: "Re: Invoice 42" }), {
    address: "t1",
    kind: "group",
    name: "Invoice 42",
  });
  assertEquals(mailConversation("t1", {}), { address: "t1", kind: "group" });
  assertEquals(referencesOf("<m0@org.com>\r\n <m1@x.com>"), ["m0@org.com", "m1@x.com"]);
  assertEquals(referencesOf(undefined), []);
});

Deno.test("mail: a message is keyed per mailbox — the same Message-ID in two accounts is two keys", () => {
  assertEquals(mailRef("Me@Org.com", "m1@x.com"), "mail:me@org.com:m1@x.com");
  assert(mailRef(ME, "m1@x.com") !== mailRef("me@corp.com", "m1@x.com"));
  assertEquals(messageIdOf(ME, "mail:me@org.com:m1@x.com"), "m1@x.com");
  // another account's key, a key of another wire, nothing: no Message-ID of this account
  assertEquals(messageIdOf(ME, "mail:me@corp.com:m1@x.com"), undefined);
  assertEquals(messageIdOf(ME, "slack:T:C:1.2"), undefined);
  assertEquals(messageIdOf(ME, undefined), undefined);
});

Deno.test("mail: a reply-all is the message's Reply-To in place of its sender, its To and Cc — the account never", () => {
  const row = (sender: string | undefined, mail: unknown) =>
    ({
      envelope: sender
        ? { sender: mailbox(sender, sender === "ana@x.com" ? "Ana García" : undefined) }
        : {},
      extra: { mail },
    }) as unknown as MessageEvent;
  // theirs: the sender, To and Cc
  assertEquals(
    replyAll(ME, row("ana@x.com", { to: [mailbox(ME), BOB], cc: [mailbox("carl@z.com")] })),
    [ANA, BOB, mailbox("carl@z.com")],
  );
  // a Reply-To answers for the sender: a list, a no-reply sender, a form
  assertEquals(
    replyAll(
      ME,
      row("noreply@x.com", { to: [mailbox(ME)], cc: [], replyTo: [mailbox("desk@x.com")] }),
    ),
    [mailbox("desk@x.com")],
  );
  // ours: whoever it went to
  assertEquals(replyAll(ME, row(ME, { to: [ANA], cc: [BOB] })), [ANA, BOB]);
  // a row that kept neither a sender nor recipients names nobody
  assertEquals(replyAll(ME, { envelope: {} } as unknown as MessageEvent), []);
});

Deno.test("mail: a reply's References are the parent's own, then the parent", () => {
  const parent = (mail: unknown, ref?: string) =>
    ({
      envelope: {},
      ...(ref ? { payload: { action: "reply", ref_external_id: ref } } : {}),
      extra: { mail },
    }) as unknown as MessageEvent;
  assertEquals(
    referencesTo(ME, parent({ to: [], cc: [], references: ["m0@org.com"] }), "m1@x.com"),
    ["m0@org.com", "m1@x.com"],
  );
  // a parent that kept no References: the message it answered stands in for them
  assertEquals(
    referencesTo(ME, parent({ to: [], cc: [] }, "mail:me@org.com:m0@org.com"), "m1@x.com"),
    ["m0@org.com", "m1@x.com"],
  );
  assertEquals(referencesTo(ME, parent({ to: [], cc: [] }), "m1@x.com"), ["m1@x.com"]);
});

Deno.test("mail: a mail address is one or more addresses comma-joined, nothing else", () => {
  assert(isMailAddress("ana@x.com"));
  assert(isMailAddress("ana@x.com,bob@y.com"));
  assert(!isMailAddress("19:abc@thread.v2"));
  assert(!isMailAddress("5491100000000"));
  assert(!isMailAddress("ana@x.com,"));
  assert(!isMailAddress(""));
});

Deno.test("mail: the row — sender the From, quotes cut, files as parts, a reply pointing at its referent, the addressing kept", () => {
  const row = mailRow({ service: "google", connection_address: ME }, {
    id: "m1@x.com",
    thread: "t1",
    ts: "2026-09-23T10:00:00.000Z",
    from: ANA,
    to: [mailbox(ME)],
    cc: [BOB],
    replyTo: [mailbox("desk@x.com")],
    subject: "Re: Invoice 42",
    inReplyTo: "m0@org.com",
    references: ["m0@org.com"],
    text: "Paid today.\n\nOn Tue, Sep 22, 2026 at 9:00 AM Me <me@org.com> wrote:\n> Please pay",
    files: [{
      type: "file",
      kind: "document",
      file: { mime_type: "application/pdf", uri: "file:///r.pdf" },
    }],
  });
  assertEquals(row, {
    ts: "2026-09-23T10:00:00.000Z",
    type: "message",
    payload: { action: "reply", ref_external_id: "mail:me@org.com:m0@org.com" },
    envelope: {
      service: "google",
      connection_address: ME,
      conversation: { address: "t1", kind: "group", name: "Invoice 42" },
      sender: ANA,
      external_id: "mail:me@org.com:m1@x.com",
    },
    parts: [
      { type: "text", kind: "text", text: "Paid today." },
      {
        type: "file",
        kind: "document",
        file: { mime_type: "application/pdf", uri: "file:///r.pdf" },
      },
    ],
    extra: {
      mail: {
        to: [mailbox(ME)],
        cc: [BOB],
        replyTo: [mailbox("desk@x.com")],
        references: ["m0@org.com"],
      },
    },
  });
  // no words, no payload: a bare attachment
  const bare = mailRow({ service: "microsoft", connection_address: ME }, {
    id: "m2@x.com",
    thread: "c2",
    ts: "2026-09-23T10:00:00.000Z",
    to: [mailbox(ME)],
    cc: [],
    files: [],
  });
  assertEquals(bare.parts, []);
  assertEquals("payload" in bare, false);
  assertEquals("sender" in bare.envelope, false);
  assertEquals(bare.extra, { mail: { to: [mailbox(ME)], cc: [] } });
});

Deno.test("mail: stripQuotes cuts at the attribution, the separator, the header block or the > tail", () => {
  assertEquals(
    stripQuotes(
      "Sí, dale.\n\nEl mar, 22 sept 2026 a las 9:00, Ana <ana@x.com> escribió:\n> ¿vamos?",
    ),
    "Sí, dale.",
  );
  // an attribution wrapped onto two lines
  assertEquals(
    stripQuotes("ok\n\nOn Tue, Sep 22, 2026 at 9:00 AM Ana García <ana@x.com>\nwrote:\n\n> hi"),
    "ok",
  );
  assertEquals(
    stripQuotes("Sure.\r\n\r\n-----Original Message-----\r\nFrom: Ana\r\nSent: x"),
    "Sure.",
  );
  assertEquals(
    stripQuotes("See below.\n\nFrom: Ana <ana@x.com>\nSent: Tuesday\nTo: me\nSubject: x\n\nbody"),
    "See below.",
  );
  assertEquals(
    stripQuotes("Outlook style\n\n________________________________\nFrom: Ana"),
    "Outlook style",
  );
  assertEquals(stripQuotes("Top post.\n\n> quoted line\n> another\n\n> more"), "Top post.");
  // a body that is nothing but the quote keeps its words
  assertEquals(stripQuotes("> only quoted\n> lines"), "> only quoted\n> lines");
  assertEquals(stripQuotes("On the other hand, no.\nFine."), "On the other hand, no.\nFine.");
  assertEquals(stripQuotes(""), "");
});

Deno.test("mail: htmlToText — blocks break lines, links keep their target, entities decode, markup goes", () => {
  const html = `<html><head><style>p{color:red}</style></head><body>
    <p>Hola <b>Ana</b>,<br>todo bien &amp; listo.</p>
    <div>Ver <a href="https://x.com/p?a=1&amp;b=2">la propuesta</a> o <a href="https://x.com">https://x.com</a></div>
    <ul><li>uno</li><li>dos</li></ul>
    <p>&#161;Chau! &nbsp;</p></body></html>`;
  assertEquals(
    htmlToText(html),
    "Hola Ana,\ntodo bien & listo.\n\nVer [la propuesta](https://x.com/p?a=1&b=2) o https://x.com\n\n- uno\n- dos\n\n¡Chau!",
  );
});

Deno.test("mail: buildMime — RFC 5322 headers, base64 UTF-8 body, multipart with attachments", () => {
  const plain = buildMime({
    from: mailbox(ME),
    to: [ANA, BOB],
    subject: "Factura 42 — año",
    date: rfcDate("2026-09-23T12:00:00.000Z"),
    messageId: "u1@org.com",
    inReplyTo: "m1@x.com",
    references: ["m0@org.com", "m1@x.com"],
    text: "Hola Ana,\n\nadjunto.\n",
    files: [],
  });
  const lines = plain.split("\r\n");
  assertEquals(lines[0], `From: <${ME}>`);
  assertEquals(lines[1], "To: =?utf-8?B?QW5hIEdhcmPDrWE=?= <ana@x.com>, <bob@y.com>");
  assertEquals(lines[2], "Subject: =?utf-8?B?RmFjdHVyYSA0MiDigJQgYcOxbw==?=");
  assertEquals(lines[3], "Date: Wed, 23 Sep 2026 12:00:00 +0000");
  assertEquals(lines[4], "Message-ID: <u1@org.com>");
  assertEquals(lines[5], "In-Reply-To: <m1@x.com>");
  assertEquals(lines[6], "References: <m0@org.com> <m1@x.com>");
  assertEquals(lines[7], "MIME-Version: 1.0");
  assertEquals(lines[8], "Content-Type: text/plain; charset=utf-8");
  assertEquals(lines[9], "Content-Transfer-Encoding: base64");
  assertEquals(lines[10], "");
  assertEquals(new TextDecoder().decode(decodeBase64(lines[11])), "Hola Ana,\n\nadjunto.\n");
  assert(plain.endsWith("\r\n"));
  assert(!plain.includes("\n\n")); // CRLF throughout

  const mixed = buildMime({
    from: mailbox(ME),
    to: [ANA],
    subject: "plain ascii",
    date: rfcDate("2026-09-23T12:00:00.000Z"),
    messageId: "u2@org.com",
    text: "see attached",
    files: [{
      name: 'q "final".pdf',
      mime: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4"),
    }],
  });
  assertStringIncludes(mixed, "Subject: plain ascii\r\n");
  const boundary = /boundary="([^"]+)"/.exec(mixed)![1];
  assertStringIncludes(
    mixed,
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8`,
  );
  assertStringIncludes(
    mixed,
    `--${boundary}\r\nContent-Type: application/pdf; name="q \\"final\\".pdf"\r\nContent-Disposition: attachment; filename="q \\"final\\".pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--${boundary}--\r\n`,
  );
  assert(!mixed.includes("In-Reply-To"));
});

Deno.test("mail: a minted Message-ID is unique and in the account's domain", () => {
  const a = mintMessageId(ME);
  const b = mintMessageId(ME);
  assert(a !== b);
  assert(a.endsWith("@org.com"));
  assert(!a.includes("<"));
});

/* ── the dispatch ─────────────────────────────────────────────────────────────────── */

/** A hand-cranked log: the opening read answers `queued`, a read by externalId or by
 *  conversation answers from `rows`, and events are pushed by hand. */
function fakeLog(queued: Event[] = [], rows: Event[] = []) {
  let deliver: ((e: Event) => void) | undefined;
  const subscribe: Subscriber["subscribe"] = (listener, opts) => {
    deliver = (e) => {
      if (!opts?.filter || opts.filter(e)) listener(e);
    };
    return () => {};
  };
  const patches: { id: EventId; patch: DeliveryPatch }[] = [];
  return {
    subscribe,
    read: (q?: ReadQuery) =>
      Promise.resolve(
        q?.externalId || q?.conversation
          ? rows.filter((r) =>
            (!q.externalId || r.envelope.external_id === q.externalId) &&
            (!q.conversation || r.envelope.conversation.address === q.conversation) &&
            (!q.connection || r.envelope.connection_address === q.connection)
          )
          : queued,
      ),
    push: (e: Draft) => deliver?.({ ...e, id: e.id ?? newId() } as Event),
    patches,
    setDelivery: (id: EventId, patch: DeliveryPatch) => {
      patches.push({ id, patch });
      return Promise.resolve();
    },
  };
}

const outbound = (over: Partial<MessageEvent> = {}): Draft<MessageEvent> => ({
  ts: "2026-09-23T12:00:00Z",
  type: "message",
  agent: { id: "a1", session_id: "s1" },
  envelope: {
    service: "google",
    connection_address: ME,
    conversation: { address: "ana@x.com", name: "Invoice 42" },
    status: "queued",
  },
  status: { state: "queued", queued_at: "2026-09-23T12:00:00Z" },
  parts: [{ type: "text", kind: "text", text: "Hola Ana" }],
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A wire's send that records what it was handed and answers with `filed`. */
function wire(filed: { thread?: string } = {}) {
  const sent: { grant: { connection: string; agentId?: string }; out: MailOut }[] = [];
  return {
    sent,
    send: (grant: { connection: string; agentId?: string }, out: MailOut) => {
      sent.push({ grant, out });
      return Promise.resolve(filed);
    },
  };
}

Deno.test("mail dispatch: a send to addresses opens a thread — a MIME to them under the subject, the row moved to the thread the wire filed it in", async () => {
  const log = fakeLog();
  const w = wire({ thread: "t7" });
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    now: () => "2026-09-23T12:00:00.000Z",
    send: w.send,
  });
  log.push(outbound({
    id: "e1",
    envelope: {
      ...outbound().envelope,
      conversation: { address: "ana@x.com,bob@y.com", name: "Invoice 42" },
    },
  }));
  await settle();
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].grant, { connection: ME, agentId: "a1" });
  const { mime, messageId, thread } = w.sent[0].out;
  assertEquals(thread, undefined);
  assertStringIncludes(
    mime,
    `From: <${ME}>\r\nTo: <ana@x.com>, <bob@y.com>\r\nSubject: Invoice 42\r\n`,
  );
  assert(!mime.includes("References:"));
  assertStringIncludes(mime, `Message-ID: <${messageId}>`);
  assert(messageId.endsWith("@org.com"));
  assertEquals(log.patches[0].patch.external_id, `mail:${ME}:${messageId}`);
  assertEquals(log.patches[0].patch.sender, { address: ME });
  assertEquals(log.patches[0].patch.status?.state, "dispatched");
  assertEquals(log.patches[0].patch.conversation, {
    address: "t7",
    kind: "group",
    name: "Invoice 42",
  });
});

Deno.test("mail dispatch: a wire that cannot name the thread it opened leaves the row at the minted id", async () => {
  const log = fakeLog();
  const w = wire();
  createMailDispatch({
    service: "microsoft",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: w.send,
  });
  log.push(outbound({
    id: "e1",
    envelope: {
      ...outbound().envelope,
      service: "microsoft",
      conversation: { address: "ana@x.com" },
    },
  }));
  await settle();
  assertEquals(log.patches[0].patch.conversation, {
    address: w.sent[0].out.messageId,
    kind: "group",
  });
});

/** A message in `account`'s thread `t9`, as the ingest files it. */
const inThread = (
  id: string,
  ts: string,
  m: { from?: typeof ANA; to?: (typeof ANA)[]; cc?: (typeof ANA)[]; replyTo?: (typeof ANA)[] },
  account = ME,
) =>
  ({
    ...mailRow({ service: "google", connection_address: account }, {
      id,
      thread: "t9",
      ts,
      from: m.from ?? ANA,
      to: m.to ?? [mailbox(account)],
      cc: m.cc ?? [],
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      subject: "Fwd: Invoice 42",
      inReplyTo: "m0@org.com",
      references: ["m0@org.com"],
      text: "please pay",
      files: [],
    }),
    id: `e-${account}-${id}`,
  }) as Event;

const intoThread = (id: string, ref?: string) =>
  outbound({
    id,
    ...(ref ? { payload: { action: "reply", ref_external_id: ref } } : {}),
    envelope: {
      ...outbound().envelope,
      conversation: { address: "t9", kind: "group", name: "Invoice 42" },
    },
  });

Deno.test("mail dispatch: a send into a thread is a reply-all to its latest message, under Re: its name — `re` quotes, the members stay", async () => {
  const log = fakeLog([], [
    // Ana wrote to the account, Bob and Carl in Cc
    inThread("m1@x.com", "2026-09-23T11:00:00Z", { cc: [BOB, mailbox("carl@z.com", "Carl")] }),
    // Bob answered only Ana and the account: Carl is no longer in the thread
    inThread("m2@y.com", "2026-09-23T11:30:00Z", { from: BOB, to: [mailbox(ME), ANA] }),
  ]);
  const w = wire({ thread: "t9" });
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: w.send,
  });
  // `re` quotes Ana's first message
  log.push(intoThread("e1", `mail:${ME}:m1@x.com`));
  // no `re`: the answer is to the latest
  log.push(intoThread("e2"));
  await settle();
  assertEquals(w.sent.length, 2);
  for (const { out } of w.sent) {
    // the members: the latest message's — Carl, dropped from it, is not written to
    assertStringIncludes(
      out.mime,
      "To: =?utf-8?B?QW5hIEdhcmPDrWE=?= <ana@x.com>, <bob@y.com>\r\nSubject: Re: Invoice 42\r\n",
    );
    assert(!out.mime.includes("carl@z.com"));
    assertEquals(out.thread, "t9");
  }
  assertStringIncludes(
    w.sent[0].out.mime,
    "In-Reply-To: <m1@x.com>\r\nReferences: <m0@org.com> <m1@x.com>\r\n",
  );
  assertStringIncludes(
    w.sent[1].out.mime,
    "In-Reply-To: <m2@y.com>\r\nReferences: <m0@org.com> <m2@y.com>\r\n",
  );
  // the wire filed them where they stand: the rows are not moved
  assertEquals(log.patches.map((p) => p.patch.conversation), [undefined, undefined]);
});

Deno.test("mail dispatch: a Reply-To answers for its sender; our own message not yet echoed is passed over for the one before it", async () => {
  const ours = {
    ...intoThread("e0"),
    envelope: {
      ...intoThread("e0").envelope,
      external_id: `mail:${ME}:u1@org.com`,
      sender: { address: ME },
      status: "dispatched",
    },
    ts: "2026-09-23T11:40:00Z",
  } as Event;
  const log = fakeLog([], [
    inThread("m1@x.com", "2026-09-23T11:00:00Z", {
      from: mailbox("noreply@x.com"),
      replyTo: [mailbox("desk@x.com", "Desk")],
      cc: [BOB],
    }),
    ours,
  ]);
  const w = wire();
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: w.send,
  });
  log.push(intoThread("e1"));
  await settle();
  const { mime } = w.sent[0].out;
  assertStringIncludes(mime, 'To: <bob@y.com>, "Desk" <desk@x.com>\r\n');
  assert(!mime.includes("noreply@x.com"));
  // the answer is still to the latest line, ours
  assertStringIncludes(mime, "In-Reply-To: <u1@org.com>\r\n");
});

Deno.test("mail dispatch: a thread is the account's — another mailbox's copy of it is neither read nor answered", async () => {
  const log = fakeLog([], [
    inThread("m1@x.com", "2026-09-23T11:00:00Z", { cc: [BOB] }),
    // the same thread id on another account: its members are not this thread's
    inThread("m2@y.com", "2026-09-23T11:30:00Z", {
      from: mailbox("zed@q.com"),
      to: [mailbox("me@corp.com")],
    }, "me@corp.com"),
  ]);
  const w = wire();
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: w.send,
  });
  log.push(intoThread("e1"));
  // `re` naming the other mailbox's copy is refused
  log.push(intoThread("e2", "mail:me@corp.com:m2@y.com"));
  await settle();
  assertEquals(w.sent.length, 1);
  assertStringIncludes(
    w.sent[0].out.mime,
    "To: =?utf-8?B?QW5hIEdhcmPDrWE=?= <ana@x.com>, <bob@y.com>\r\n",
  );
  assertStringIncludes(w.sent[0].out.mime, "In-Reply-To: <m1@x.com>\r\n");
  assert(!w.sent[0].out.mime.includes("zed@q.com"));
  const refused = log.patches.find((p) => p.id === "e2")!;
  assertEquals(refused.patch.status?.state, "failed");
  assertStringIncludes(String(refused.patch.status?.error), "not a mail of this account");
});

Deno.test("mail dispatch: a reply the wire files in another thread moves there", async () => {
  const log = fakeLog([], [inThread("m1@x.com", "2026-09-23T11:00:00Z", {})]);
  const w = wire({ thread: "t10" });
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: w.send,
  });
  log.push(intoThread("e1"));
  await settle();
  assertEquals(log.patches[0].patch.conversation, {
    address: "t10",
    kind: "group",
    name: "Invoice 42",
  });
});

Deno.test("mail dispatch: what mail cannot do fails with its class — an edit, a reaction, a non-mail address, an empty send", async () => {
  const log = fakeLog();
  let posts = 0;
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: () => {
      posts++;
      return Promise.resolve({});
    },
  });
  log.push(outbound({ id: "e1", payload: { action: "edit", ref_external_id: "mail:m1@x.com" } }));
  log.push(outbound({
    id: "e2",
    payload: { action: "add", ref_external_id: "mail:m1@x.com" },
    parts: [{ type: "data", kind: "reaction", data: { name: "👍" } }],
  }));
  log.push(outbound({
    id: "e3",
    envelope: { ...outbound().envelope, conversation: { address: "19:abc@thread.v2" } },
  }));
  log.push(outbound({ id: "e4", parts: [] }));
  log.push(outbound({ id: "e5", payload: { action: "reply", ref_external_id: "slack:T:C:1.2" } }));
  await settle();
  assertEquals(posts, 0);
  assertEquals(log.patches.map((p) => p.id), ["e1", "e2", "e3", "e4", "e5"]);
  for (const p of log.patches) {
    assertEquals(p.patch.status?.state, "failed");
    assertEquals(p.patch.status?.error_code, 400);
  }
  assertStringIncludes(String(log.patches[0].patch.status?.error), "mail cannot edit");
  assertStringIncludes(String(log.patches[1].patch.status?.error), "mail cannot add");
  assertStringIncludes(String(log.patches[2].patch.status?.error), "is not a mail address"); // no thread there either
  assertStringIncludes(String(log.patches[3].patch.status?.error), "nothing to send");
  assertStringIncludes(String(log.patches[4].patch.status?.error), "not a mail");
});

Deno.test("mail dispatch: an address another wire of the service carries is left queued for it", async () => {
  const log = fakeLog();
  let posts = 0;
  createMailDispatch({
    service: "microsoft",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    elsewhere: (address) => address.startsWith("19:"),
    send: () => {
      posts++;
      return Promise.resolve({});
    },
  });
  const place = (address: string) => ({
    ...outbound().envelope,
    service: "microsoft" as const,
    conversation: { address },
  });
  log.push(outbound({ id: "e1", envelope: place("19:abc@thread.v2") }));
  log.push(outbound({ id: "e2", envelope: place("ana@x.com") }));
  await settle();
  assertEquals(posts, 1);
  assertEquals(log.patches.map((p) => p.id), ["e2"]);
});
