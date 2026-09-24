import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { createGmailPoller, gmailSend, MAILBOX, parseAddresses, parseMessage } from "./mail.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender } from "../../store/log.ts";
import type { Draft, Event, FilePart, MessageEvent } from "../../types.ts";
import type { SaveFile } from "../mail.ts";

const KEY = "google:me@org.com";
const NOW = "2026-09-23T12:00:00.000Z";
const READ =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

function captor(): { publish: Appender["publish"]; rows: Draft<MessageEvent>[] } {
  const rows: Draft<MessageEvent>[] = [];
  const publish = ((e: Draft<Event> | Draft<Event>[]) => {
    const one = (d: Draft<Event>) => {
      rows.push(d as Draft<MessageEvent>);
      return { ...d, id: `id${rows.length}` } as Event;
    };
    return Promise.resolve(Array.isArray(e) ? e.map(one) : one(e));
  }) as Appender["publish"];
  return { publish, rows };
}

/** A vault with one fresh google grant (no refresh needed) + its app row. */
async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
  scope = READ,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({ key: "google:app:cid", value: { client_id: "cid", client_secret: "sec" } });
    await creds.put({
      key: KEY,
      value: { access_token: "ya29.fresh", refresh_token: "1//r" },
      agentId: "me",
      extra: { client_id: "cid", scope, expiry: new Date(Date.now() + 3600_000).toISOString() },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Call = { url: URL; init?: RequestInit };

/** A Gmail that answers by path: `routes` keyed on the path after `/users/me`. */
function gmail(
  routes: Record<string, unknown | ((url: URL) => unknown | Response)>,
  calls: Call[] = [],
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const path = url.pathname.slice("/gmail/v1/users/me".length);
    const route = routes[path];
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    const ans = typeof route === "function" ? (route as (u: URL) => unknown)(url) : route;
    return Promise.resolve(ans instanceof Response ? ans : Response.json(ans));
  }) as typeof fetch;
}

const saved: { conversation: string; bytes: Uint8Array; meta: unknown }[] = [];
const save: SaveFile = (conversation, bytes, meta) => {
  saved.push({ conversation, bytes, meta });
  return Promise.resolve({
    type: "file",
    kind: "document",
    file: {
      mime_type: meta.mime_type ?? "application/octet-stream",
      uri: `file:///m/${meta.name}`,
    },
  } as FilePart);
};

function poller(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  fetchApi: typeof fetch,
  publish: Appender["publish"] = captor().publish,
): { tick(): Promise<void> } {
  return createGmailPoller({
    publish,
    creds,
    broker: createGrantBroker({ creds }),
    save,
    fetchApi,
    now: () => NOW,
  });
}

async function cursorOf(
  creds: Awaited<ReturnType<typeof openCredentials>>,
): Promise<string | undefined> {
  const sync = (await creds.get(KEY))?.extra?.mail_sync as Record<string, string> | undefined;
  return sync?.[MAILBOX];
}

const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s));

const FULL = {
  id: "g1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: "1790000000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Ana García <Ana@x.com>" },
      { name: "To", value: "Me <me@org.com>, bob@y.com" },
      { name: "Cc", value: "" },
      { name: "Subject", value: "Re: Invoice 42" },
      { name: "Message-ID", value: "<m1@x.com>" },
      { name: "In-Reply-To", value: "<m0@org.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Paid today.\n\nOn Tue Me wrote:\n> pay") } },
          { mimeType: "text/html", body: { data: b64("<p>Paid today.</p>") } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "receipt.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="receipt.pdf"' }],
        body: { attachmentId: "att1", size: 8 },
      },
      {
        mimeType: "image/png",
        filename: "logo.png",
        headers: [{ name: "Content-Disposition", value: 'inline; filename="logo.png"' }],
        body: { attachmentId: "att2", size: 8 },
      },
    ],
  },
};

Deno.test("gmail: a first run takes the profile's historyId and publishes nothing", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const { publish, rows } = captor();
    await poller(
      creds,
      gmail({ "/profile": { emailAddress: "me@org.com", historyId: "5000" } }, calls),
      publish,
    ).tick();
    assertEquals(calls.map((c) => c.url.pathname), ["/gmail/v1/users/me/profile"]);
    assertEquals(calls[0].init?.headers, { authorization: "Bearer ya29.fresh" });
    assertEquals(rows, []);
    assertEquals(await cursorOf(creds), "5000");
  });
});

Deno.test("gmail: a grant without a mail scope is not polled", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    await poller(creds, gmail({ "/profile": { historyId: "5000" } }, calls)).tick();
    assertEquals(calls, []);
    assertEquals(await cursorOf(creds), undefined);
  }, "openid https://www.googleapis.com/auth/calendar");
});

Deno.test("gmail: history → the message in full → the row; attachments fetched, inline ones not; cursor advances", async () => {
  await withVault(async (creds) => {
    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { [MAILBOX]: "5000" } } });
    const calls: Call[] = [];
    const { publish, rows } = captor();
    saved.length = 0;
    const api = gmail({
      "/history": (url: URL) => {
        assertEquals(url.searchParams.get("startHistoryId"), "5000");
        assertEquals(url.searchParams.get("historyTypes"), "messageAdded");
        return {
          history: [
            {
              id: "5001",
              messagesAdded: [{
                message: { id: "g1", threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
              }],
            },
            // the same message under a second record, and a draft, and spam
            { id: "5002", messagesAdded: [{ message: { id: "g1", labelIds: ["INBOX"] } }] },
            { id: "5003", messagesAdded: [{ message: { id: "g2", labelIds: ["DRAFT"] } }] },
            { id: "5004", messagesAdded: [{ message: { id: "g3", labelIds: ["SPAM"] } }] },
          ],
          historyId: "5010",
        };
      },
      "/messages/g1": (url: URL) => {
        assertEquals(url.searchParams.get("format"), "full");
        return FULL;
      },
      "/messages/g1/attachments/att1": { data: b64("%PDF-1.4"), size: 8 },
    }, calls);
    await poller(creds, api, publish).tick();
    assertEquals(
      calls.map((c) => c.url.pathname.slice("/gmail/v1/users/me".length)),
      ["/history", "/messages/g1", "/messages/g1/attachments/att1"],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0], {
      ts: "2026-09-21T14:13:20.000Z",
      type: "message",
      payload: { action: "reply", ref_external_id: "mail:m0@org.com" },
      envelope: {
        service: "google",
        connection_address: "me@org.com",
        conversation: {
          address: "ana@x.com,bob@y.com",
          kind: "direct",
          name: "Ana García",
          thread: "Invoice 42",
        },
        sender: { address: "ana@x.com", name: "Ana García" },
        external_id: "mail:m1@x.com",
      },
      parts: [
        { type: "text", kind: "text", text: "Paid today." },
        {
          type: "file",
          kind: "document",
          file: { mime_type: "application/pdf", uri: "file:///m/receipt.pdf" },
        },
      ],
      extra: { google: { thread: "t1" } },
    });
    assertEquals(saved.length, 1);
    assertEquals(saved[0].conversation, "ana@x.com,bob@y.com");
    assertEquals(new TextDecoder().decode(saved[0].bytes), "%PDF-1.4");
    assertEquals(saved[0].meta, { mime_type: "application/pdf", name: "receipt.pdf" });
    assertEquals(await cursorOf(creds), "5010");
  });
});

Deno.test("gmail: a SENT message is the account's own hand — the conversation is still the other side", async () => {
  await withVault(async (creds) => {
    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { [MAILBOX]: "5000" } } });
    const { publish, rows } = captor();
    const api = gmail({
      "/history": {
        history: [{ id: "5001", messagesAdded: [{ message: { id: "g9", labelIds: ["SENT"] } }] }],
        historyId: "5001",
      },
      "/messages/g9": {
        id: "g9",
        threadId: "t9",
        labelIds: ["SENT"],
        internalDate: "1790000000000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "me@org.com" },
            { name: "To", value: "Ana García <ana@x.com>" },
            { name: "Subject", value: "Invoice 42" },
            { name: "Message-ID", value: "<u1@org.com>" },
          ],
          body: { data: b64("Hola Ana") },
        },
      },
    });
    await poller(creds, api, publish).tick();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].envelope.sender, { address: "me@org.com" });
    assertEquals(rows[0].envelope.conversation, {
      address: "ana@x.com",
      kind: "direct",
      name: "Ana García",
      thread: "Invoice 42",
    });
    assertEquals(rows[0].envelope.external_id, "mail:u1@org.com");
    assertEquals(rows[0].parts, [{ type: "text", kind: "text", text: "Hola Ana" }]);
  });
});

Deno.test("gmail: a 404 on the start id drops the cursor; a message gone between list and read is skipped", async () => {
  await withVault(async (creds) => {
    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { [MAILBOX]: "10" } } });
    await poller(creds, gmail({ "/history": new Response("gone", { status: 404 }) })).tick();
    assertEquals(await cursorOf(creds), undefined);

    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { [MAILBOX]: "5000" } } });
    const { publish, rows } = captor();
    await poller(
      creds,
      gmail({
        "/history": {
          history: [{
            id: "5001",
            messagesAdded: [{ message: { id: "gone", labelIds: ["INBOX"] } }],
          }],
          historyId: "5002",
        },
      }),
      publish,
    ).tick();
    assertEquals(rows, []);
    assertEquals(await cursorOf(creds), "5002");
  });
});

Deno.test("gmail: parseMessage — an HTML-only body becomes words; a bare Gmail id stands in for a missing Message-ID", () => {
  const m = parseMessage({
    id: "g7",
    internalDate: "1790000000000",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "From", value: "ana@x.com" }, {
        name: "Date",
        value: "Tue, 22 Sep 2026 09:00:00 +0000",
      }],
      body: { data: b64("<p>Hola<br>Ana</p>") },
    },
  });
  assertEquals(m.id, "g7");
  assertEquals(m.text, "Hola\nAna");
  assertEquals(m.from, { address: "ana@x.com" });
  assertEquals(m.to, []);
  assertEquals(m.attachments, []);
  assertEquals("extra" in m, false);
});

Deno.test("gmail: parseAddresses — quoted names, bare addresses, commas inside quotes", () => {
  assertEquals(
    parseAddresses('"García, Ana" <Ana@X.com>, bob@y.com, <carl@z.com>, Dan Ho <dan@z.com>'),
    [
      { address: "ana@x.com", name: "García, Ana" },
      { address: "bob@y.com" },
      { address: "carl@z.com" },
      { address: "dan@z.com", name: "Dan Ho" },
    ],
  );
  assertEquals(parseAddresses(""), []);
  assertEquals(parseAddresses(undefined), []);
  assertEquals(parseAddresses("undisclosed-recipients:;"), []);
});

Deno.test("gmail send: the MIME rides as raw, threaded by the referent's thread", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const send = gmailSend({
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: gmail({ "/messages/send": { id: "g10", threadId: "t9" } }, calls),
    });
    const re = { extra: { google: { thread: "t9" } } } as unknown as MessageEvent;
    await send({ connection: "me@org.com", agentId: "me" }, "From: <me@org.com>\r\n\r\nhi\r\n", re);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].init?.method, "POST");
    const body = JSON.parse(String(calls[0].init?.body));
    assertEquals(body, {
      raw: encodeBase64Url(new TextEncoder().encode("From: <me@org.com>\r\n\r\nhi\r\n")),
      threadId: "t9",
    });
    // a fresh send names no thread
    await send({ connection: "me@org.com" }, "x");
    assertEquals(JSON.parse(String(calls[1].init?.body)), {
      raw: encodeBase64Url(new TextEncoder().encode("x")),
    });
    // a refusal carries its class
    const refused = gmailSend({
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: gmail({ "/messages/send": new Response("forbidden", { status: 403 }) }),
    });
    const err = await refused({ connection: "me@org.com" }, "x").catch((e) => e);
    assert(err instanceof Error);
    assertStringIncludes(err.message, "HTTP 403");
    assertEquals((err as { code?: number }).code, 403);
  });
});
