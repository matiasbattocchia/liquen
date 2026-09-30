import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { createOutlookPoller, FOLDERS, outlookSend, parseMessage } from "./mail.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender } from "../../store/log.ts";
import type { Draft, Event, FilePart, MessageEvent } from "../../types.ts";
import type { SaveFile } from "../mail.ts";

const KEY = "microsoft:ana@contoso.com";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const NOW = "2026-09-23T12:00:00.000Z";

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

async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
  scope = "User.Read Calendars.ReadWrite Mail.Read Mail.Send",
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({
      key: "microsoft:app:cid",
      value: { client_id: "cid", client_secret: "sec" },
      extra: { tenant: "t-1" },
    });
    await creds.put({
      key: KEY,
      value: { access_token: "eyJ.fresh", refresh_token: "0.r" },
      agentId: "ana",
      extra: { client_id: "cid", scope, expiry: new Date(Date.now() + 3600_000).toISOString() },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Call = { url: URL; init?: RequestInit; headers: Headers };

/** A Graph that answers by path (after `/v1.0/me`), the full URL handed to a function. */
function graph(
  routes: Record<string, unknown | ((url: URL) => unknown | Response)>,
  calls: Call[] = [],
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init, headers: new Headers(init?.headers) });
    const path = decodeURIComponent(url.pathname.slice("/v1.0/me".length));
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
  return createOutlookPoller({
    publish,
    creds,
    broker: createGrantBroker({ creds }),
    save,
    fetchApi,
    now: () => NOW,
  });
}

async function syncOf(
  creds: Awaited<ReturnType<typeof openCredentials>>,
): Promise<Record<string, string> | undefined> {
  return (await creds.get(KEY))?.extra?.mail_sync as Record<string, string> | undefined;
}

const MSG = {
  id: "AAMk1",
  internetMessageId: "<m1@x.com>",
  conversationId: "AAQk42",
  subject: "RV: Invoice 42",
  body: { contentType: "text", content: "Paid today.\r\n\r\nOn Tue Me wrote:\r\n> pay\r\n" },
  from: { emailAddress: { name: "Bob Ross", address: "Bob@Y.com" } },
  toRecipients: [{ emailAddress: { name: "Ana", address: "ana@contoso.com" } }],
  ccRecipients: [{ emailAddress: { address: "carl@z.com" } }],
  replyTo: [{ emailAddress: { name: "Desk", address: "desk@y.com" } }],
  sentDateTime: "2026-09-23T10:00:00Z",
  receivedDateTime: "2026-09-23T10:00:05Z",
  hasAttachments: true,
  isDraft: false,
  internetMessageHeaders: [{ name: "In-Reply-To", value: "<m0@contoso.com>" }],
};

Deno.test("outlook mail: a first run asks each folder from now, ids only, and keeps its deltaLink", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const { publish, rows } = captor();
    const api = graph({
      "/mailFolders/inbox/messages/delta": (url: URL) => {
        assertEquals(url.searchParams.get("$select"), "id");
        assertEquals(url.searchParams.get("$filter"), `receivedDateTime ge ${NOW}`);
        return {
          value: [{ id: "old" }],
          "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in1`,
        };
      },
      // sentitems pages once: the nextLink is fetched as given
      "/mailFolders/sentitems/messages/delta": (url: URL) =>
        url.searchParams.has("$skiptoken")
          ? {
            value: [],
            "@odata.deltaLink": `${GRAPH}/mailFolders/sentitems/messages/delta?$deltatoken=se1`,
          }
          : {
            value: [],
            "@odata.nextLink": `${GRAPH}/mailFolders/sentitems/messages/delta?$skiptoken=s1`,
          },
    }, calls);
    await poller(creds, api, publish).tick();
    assertEquals(rows, []); // the bootstrap publishes nothing, whatever it lists
    assertEquals(calls.filter((c) => /^\/v1\.0\/me\/messages\//.test(c.url.pathname)).length, 0); // no detail reads
    assertEquals(calls[0].headers.get("authorization"), "Bearer eyJ.fresh");
    assertEquals(await syncOf(creds), {
      inbox: `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in1`,
      sentitems: `${GRAPH}/mailFolders/sentitems/messages/delta?$deltatoken=se1`,
    });
    assertEquals(FOLDERS, ["inbox", "sentitems"]);
  });
});

Deno.test("outlook mail: a grant without a mail scope is not polled", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    await poller(creds, graph({}, calls)).tick();
    assertEquals(calls, []);
    assertEquals(await syncOf(creds), undefined);
  }, "User.Read Calendars.ReadWrite");
});

Deno.test("outlook mail: a listed id is read back as text with its headers → the row; attachments fetched, inline ones not; @removed publishes nothing", async () => {
  await withVault(async (creds) => {
    const IN = `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in1`;
    const SENT = `${GRAPH}/mailFolders/sentitems/messages/delta?$deltatoken=se1`;
    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { inbox: IN, sentitems: SENT } } });
    const calls: Call[] = [];
    const { publish, rows } = captor();
    saved.length = 0;
    const api = graph({
      "/mailFolders/inbox/messages/delta": (url: URL) => {
        assertEquals(url.href, IN);
        return {
          value: [{ id: "AAMk1" }, { id: "AAMk0", "@removed": { reason: "changed" } }],
          "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
        };
      },
      "/mailFolders/sentitems/messages/delta": { value: [], "@odata.deltaLink": SENT },
      "/messages/AAMk1": (url: URL) => {
        for (const field of ["internetMessageHeaders", "body", "conversationId", "replyTo"]) {
          assertStringIncludes(url.searchParams.get("$select") ?? "", field);
        }
        return MSG;
      },
      "/messages/AAMk1/attachments": {
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "receipt.pdf",
            contentType: "application/pdf",
            contentBytes: encodeBase64(new TextEncoder().encode("%PDF-1.4")),
            isInline: false,
          },
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "logo.png",
            contentType: "image/png",
            contentBytes: encodeBase64(new TextEncoder().encode("png")),
            isInline: true,
          },
          { "@odata.type": "#microsoft.graph.itemAttachment", name: "an old mail" },
        ],
      },
    }, calls);
    await poller(creds, api, publish).tick();
    const read = calls.find((c) => c.url.pathname.endsWith("/messages/AAMk1"));
    assertEquals(read?.headers.get("prefer"), 'outlook.body-content-type="text"');
    assertEquals(rows.length, 1);
    assertEquals(rows[0], {
      ts: "2026-09-23T10:00:00Z",
      type: "message",
      payload: { action: "reply", ref_external_id: "mail:ana@contoso.com:m0@contoso.com" },
      envelope: {
        service: "microsoft",
        connection_address: "ana@contoso.com",
        // the thread: the conversation Exchange files the message in
        conversation: { address: "AAQk42", kind: "direct", name: "Invoice 42" },
        sender: { address: "bob@y.com", name: "Bob Ross" },
        external_id: "mail:ana@contoso.com:m1@x.com",
      },
      parts: [
        { type: "text", kind: "text", text: "Paid today." },
        {
          type: "file",
          kind: "document",
          file: { mime_type: "application/pdf", uri: "file:///m/receipt.pdf" },
        },
      ],
      extra: {
        mail: {
          to: [{ address: "ana@contoso.com", name: "Ana" }],
          cc: [{ address: "carl@z.com" }],
          replyTo: [{ address: "desk@y.com", name: "Desk" }],
        },
      },
    });
    assertEquals(saved.length, 1);
    assertEquals(saved[0].conversation, "AAQk42");
    assertEquals(new TextDecoder().decode(saved[0].bytes), "%PDF-1.4");
    assertEquals(
      (await syncOf(creds))?.inbox,
      `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
    );
  });
});

Deno.test("outlook mail: a draft and a message gone between list and read publish nothing; a 410 drops the folder's cursor", async () => {
  await withVault(async (creds) => {
    const IN = `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in1`;
    const SENT = `${GRAPH}/mailFolders/sentitems/messages/delta?$deltatoken=se1`;
    await creds.put({ key: KEY, value: {}, extra: { mail_sync: { inbox: IN, sentitems: SENT } } });
    const { publish, rows } = captor();
    await poller(
      creds,
      graph({
        "/mailFolders/inbox/messages/delta": {
          value: [{ id: "draft" }, { id: "gone" }],
          "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
        },
        "/messages/draft": { ...MSG, id: "draft", isDraft: true, hasAttachments: false },
        "/mailFolders/sentitems/messages/delta": new Response("gone", { status: 410 }),
      }),
      publish,
    ).tick();
    assertEquals(rows, []);
    assertEquals(await syncOf(creds), {
      inbox: `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
    });
  });
});

Deno.test("outlook mail: parseMessage — an HTML body the wire insisted on becomes words; the Graph id stands in for a missing Message-ID and conversation", () => {
  const m = parseMessage({
    id: "AAMk9",
    body: { contentType: "html", content: "<p>Hola<br>Ana</p>" },
    from: { emailAddress: { address: "bob@y.com" } },
    receivedDateTime: "2026-09-23T10:00:05Z",
  }, () => NOW);
  assertEquals(m, {
    id: "AAMk9",
    thread: "AAMk9",
    ts: "2026-09-23T10:00:05Z",
    from: { address: "bob@y.com" },
    to: [],
    cc: [],
    text: "Hola\nAna",
  });
});

Deno.test("outlook send: the MIME, base64, is made a draft that names its conversation, then the draft is sent", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const send = outlookSend({
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: graph({
        "/messages": Response.json({ id: "AAMk7", conversationId: "AAQk42" }, { status: 201 }),
        "/messages/AAMk7/send": new Response(null, { status: 202 }),
      }, calls),
    });
    const mime = "From: <ana@contoso.com>\r\n\r\nhi\r\n";
    const filed = await send({ connection: "ana@contoso.com", agentId: "ana" }, {
      mime,
      messageId: "u1@contoso.com",
      thread: "AAQk42",
    });
    assertEquals(filed, { thread: "AAQk42" });
    assertEquals(calls.map((c) => [c.init?.method, c.url.pathname]), [
      ["POST", "/v1.0/me/messages"],
      ["POST", "/v1.0/me/messages/AAMk7/send"],
    ]);
    assertEquals(calls[0].headers.get("content-type"), "text/plain");
    assertEquals(new TextDecoder().decode(decodeBase64(String(calls[0].init?.body))), mime);
    for (const c of calls) assertEquals(c.headers.get("authorization"), "Bearer eyJ.fresh");
  });
});

Deno.test("outlook send: a draft refused names the scope; a draft the send refuses is deleted", async () => {
  await withVault(async (creds) => {
    const mime = "From: <ana@contoso.com>\r\n\r\nhi\r\n";
    const out = { mime, messageId: "u1@contoso.com" };
    // a grant without Mail.ReadWrite makes no draft
    const bare = outlookSend({
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: graph({
        "/messages": new Response('{"error":"ErrorAccessDenied"}', { status: 403 }),
      }),
    });
    const denied = await bare({ connection: "ana@contoso.com" }, out).catch((e) => e);
    assert(denied instanceof Error);
    assertStringIncludes(denied.message, "HTTP 403");
    assertStringIncludes(denied.message, "Mail.ReadWrite");
    assertEquals((denied as { code?: number }).code, 403);

    const calls: Call[] = [];
    const refused = outlookSend({
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: graph({
        "/messages": Response.json({ id: "AAMk8", conversationId: "AAQk9" }, { status: 201 }),
        "/messages/AAMk8/send": new Response("quota", { status: 429 }),
        "/messages/AAMk8": new Response(null, { status: 204 }),
      }, calls),
    });
    const err = await refused({ connection: "ana@contoso.com" }, out).catch((e) => e);
    assert(err instanceof Error);
    assertStringIncludes(err.message, "HTTP 429");
    assertEquals((err as { code?: number }).code, 429);
    assertEquals(calls.at(-1)?.init?.method, "DELETE");
    assertEquals(calls.at(-1)?.url.pathname, "/v1.0/me/messages/AAMk8");
  });
});
