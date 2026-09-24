import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import {
  buildMime,
  createMailDispatch,
  htmlToText,
  isMailAddress,
  mailbox,
  mailConversation,
  mailRow,
  messageId,
  mintMessageId,
  participants,
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
  assertEquals(threadOf("Rear window"), "Rear window"); // a word that starts with re is not a prefix
  assertEquals(threadOf("  "), undefined);
  assertEquals(threadOf(undefined), undefined);
});

Deno.test("mail: the conversation is the other parties, lower-cased and sorted; the account never", () => {
  const m = {
    from: ANA,
    to: [mailbox("ME@ORG.COM"), BOB],
    cc: [mailbox("me@org.com")],
    subject: "Re: Invoice 42",
  };
  assertEquals(participants(ME, m).map((p) => p.address), ["ana@x.com", "bob@y.com"]);
  assertEquals(mailConversation(ME, m), {
    address: "ana@x.com,bob@y.com",
    kind: "direct",
    name: "Ana García",
    thread: "Invoice 42",
  });
  // a note to self is a conversation with the account itself
  assertEquals(mailConversation(ME, { from: mailbox(ME), to: [mailbox(ME)], cc: [] }), {
    address: ME,
    kind: "direct",
  });
  // one entry per address, the name from whichever header carried one
  const twice = participants(ME, {
    from: mailbox("bob@y.com"),
    to: [mailbox("Bob@Y.com", "Bob")],
    cc: [],
  });
  assertEquals(twice, [{ address: "bob@y.com", name: "Bob" }]);
});

Deno.test("mail: a mail address is one or more addresses comma-joined, nothing else", () => {
  assert(isMailAddress("ana@x.com"));
  assert(isMailAddress("ana@x.com,bob@y.com"));
  assert(!isMailAddress("calendar:me@org.com"));
  assert(!isMailAddress("5491100000000"));
  assert(!isMailAddress("ana@x.com,"));
  assert(!isMailAddress(""));
});

Deno.test("mail: the row — sender the From, quotes cut, files as parts, a reply pointing at its referent", () => {
  const row = mailRow({ service: "google", connection_address: ME }, {
    id: "m1@x.com",
    ts: "2026-09-23T10:00:00.000Z",
    from: ANA,
    to: [mailbox(ME)],
    cc: [],
    subject: "Re: Invoice 42",
    inReplyTo: "m0@org.com",
    text: "Paid today.\n\nOn Tue, Sep 22, 2026 at 9:00 AM Me <me@org.com> wrote:\n> Please pay",
    files: [{
      type: "file",
      kind: "document",
      file: { mime_type: "application/pdf", uri: "file:///r.pdf" },
    }],
    extra: { google: { thread: "t1" } },
  });
  assertEquals(row, {
    ts: "2026-09-23T10:00:00.000Z",
    type: "message",
    payload: { action: "reply", ref_external_id: "mail:m0@org.com" },
    envelope: {
      service: "google",
      connection_address: ME,
      conversation: {
        address: "ana@x.com",
        kind: "direct",
        name: "Ana García",
        thread: "Invoice 42",
      },
      sender: ANA,
      external_id: "mail:m1@x.com",
    },
    parts: [
      { type: "text", kind: "text", text: "Paid today." },
      {
        type: "file",
        kind: "document",
        file: { mime_type: "application/pdf", uri: "file:///r.pdf" },
      },
    ],
    extra: { google: { thread: "t1" } },
  });
  // no words, no payload: a bare attachment
  const bare = mailRow({ service: "microsoft", connection_address: ME }, {
    id: "m2@x.com",
    ts: "2026-09-23T10:00:00.000Z",
    to: [mailbox(ME)],
    cc: [],
    files: [],
  });
  assertEquals(bare.parts, []);
  assertEquals("payload" in bare, false);
  assertEquals("sender" in bare.envelope, false);
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
  assertEquals(lines[6], "References: <m1@x.com>");
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

/** A hand-cranked log: the opening read answers `queued`, a read by externalId answers
 *  from `rows`, and events are pushed by hand. */
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
        q?.externalId ? rows.filter((r) => r.envelope.external_id === q.externalId) : queued,
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
    conversation: { address: "ana@x.com", kind: "direct", thread: "Invoice 42" },
    status: "queued",
  },
  status: { state: "queued", queued_at: "2026-09-23T12:00:00Z" },
  parts: [{ type: "text", kind: "text", text: "Hola Ana" }],
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("mail dispatch: a fresh send is a MIME to the conversation's addresses under its thread; the row takes the minted id", async () => {
  const log = fakeLog();
  const sent: {
    grant: { connection: string; agentId?: string };
    mime: string;
    re?: MessageEvent;
  }[] = [];
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    now: () => "2026-09-23T12:00:00.000Z",
    send: (grant, mime, re) => {
      sent.push({ grant, mime, re });
      return Promise.resolve();
    },
  });
  log.push(outbound({
    id: "e1",
    envelope: {
      ...outbound().envelope,
      conversation: { address: "ana@x.com,bob@y.com", thread: "Invoice 42" },
    },
  }));
  await settle();
  assertEquals(sent.length, 1);
  assertEquals(sent[0].grant, { connection: ME, agentId: "a1" });
  assertEquals(sent[0].re, undefined);
  assertStringIncludes(
    sent[0].mime,
    `From: <${ME}>\r\nTo: <ana@x.com>, <bob@y.com>\r\nSubject: Invoice 42\r\n`,
  );
  const id = /Message-ID: <([^>]+)>/.exec(sent[0].mime)![1];
  assert(id.endsWith("@org.com"));
  assertEquals(log.patches[0].patch.external_id, `mail:${id}`);
  assertEquals(log.patches[0].patch.sender, { address: ME });
  assertEquals(log.patches[0].patch.status?.state, "dispatched");
});

Deno.test("mail dispatch: a reply threads by the referent — its id in In-Reply-To, its thread as Re:, the row handed to the wire", async () => {
  const theirs = {
    ...mailRow({ service: "google", connection_address: ME }, {
      id: "m1@x.com",
      ts: "2026-09-23T11:00:00Z",
      from: ANA,
      to: [mailbox(ME)],
      cc: [],
      subject: "Fwd: Invoice 42",
      text: "please pay",
      files: [],
      extra: { google: { thread: "t9" } },
    }),
    id: "e0",
  } as Event;
  const log = fakeLog([], [theirs]);
  const sent: { mime: string; re?: MessageEvent }[] = [];
  createMailDispatch({
    service: "google",
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    send: (_g, mime, re) => {
      sent.push({ mime, re });
      return Promise.resolve();
    },
  });
  log.push(outbound({
    id: "e1",
    payload: { action: "reply", ref_external_id: "mail:m1@x.com" },
    // the send tool inherited the thread; the wire's Re: is spelled here
    envelope: {
      ...outbound().envelope,
      conversation: { address: "ana@x.com", thread: "Invoice 42" },
    },
  }));
  await settle();
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0].mime, "Subject: Re: Invoice 42\r\n");
  assertStringIncludes(sent[0].mime, "In-Reply-To: <m1@x.com>\r\nReferences: <m1@x.com>\r\n");
  assertEquals(sent[0].re?.id, "e0");
  assertEquals(sent[0].re?.extra, { google: { thread: "t9" } });
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
      return Promise.resolve();
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
    envelope: { ...outbound().envelope, conversation: { address: "calendar:me@org.com" } },
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
  assertStringIncludes(String(log.patches[2].patch.status?.error), "is not a mail address");
  assertStringIncludes(String(log.patches[3].patch.status?.error), "nothing to send");
  assertStringIncludes(String(log.patches[4].patch.status?.error), "not a mail");
});
