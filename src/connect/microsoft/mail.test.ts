import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { createOutlookPoller, FOLDERS, moveOf, outlookSend, parseMessage } from "./mail.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender, Reader } from "../../store/log.ts";
import type { Draft, Event, FilePart, MessageEvent, RoomPart } from "../../types.ts";
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

const saved: { bytes: Uint8Array; meta: unknown }[] = [];
const save: SaveFile = (bytes, meta) => {
  saved.push({ bytes, meta });
  return Promise.resolve({
    type: "file",
    kind: "document",
    file: {
      mime_type: meta.mime_type ?? "application/octet-stream",
      uri: `file:///m/${meta.name}`,
    },
  } as FilePart);
};

/** A log that merges a draft into the row its `external_id` names, the way the store's
 *  upsert does: objects merge, anything else (an array, a scalar) replaces, and a key the
 *  draft lacks stands. `published` is every draft in the order it came. */
function memLog(seed: Draft<MessageEvent>[] = []): {
  publish: Appender["publish"];
  read: Reader["read"];
  published: Draft<MessageEvent>[];
  row(id: string): Draft<MessageEvent> | undefined;
} {
  const rows = new Map<string, Draft<MessageEvent>>();
  const published: Draft<MessageEvent>[] = [];
  const isBag = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const merge = (a: unknown, b: unknown): unknown =>
    isBag(a) && isBag(b)
      ? Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [
          k,
          k in b ? merge(a[k], b[k]) : a[k],
        ]),
      )
      : b;
  const put = (d: Draft<MessageEvent>) => {
    const id = d.envelope.external_id!;
    const prior = rows.get(id);
    rows.set(id, prior ? merge(prior, d) as Draft<MessageEvent> : d);
  };
  for (const d of seed) put(d);
  const publish = ((e: Draft<Event> | Draft<Event>[]) => {
    const one = (d: Draft<Event>) => {
      published.push(d as Draft<MessageEvent>);
      put(d as Draft<MessageEvent>);
      return { ...d, id: `id${published.length}` } as Event;
    };
    return Promise.resolve(Array.isArray(e) ? e.map(one) : one(e));
  }) as Appender["publish"];
  const read: Reader["read"] = (q = {}) => {
    const hit = q.externalId ? rows.get(q.externalId) : undefined;
    return Promise.resolve(hit ? [{ ...hit, id: "row" } as Event] : []);
  };
  return { publish, read, published, row: (id) => rows.get(id) };
}

function poller(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  fetchApi: typeof fetch,
  publish: Appender["publish"] = captor().publish,
  read: Reader["read"] = () => Promise.resolve([]),
): { tick(): Promise<void> } {
  return createOutlookPoller({
    publish,
    read,
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
    assertEquals(
      read?.headers.get("prefer"),
      'outlook.body-content-type="text", IdType="ImmutableId"',
    );
    // every delta page asks for ids that hold across moves
    const delta = calls.find((c) => c.url.pathname.endsWith("/delta"));
    assertEquals(delta?.headers.get("prefer"), 'IdType="ImmutableId"');
    assertEquals(rows.length, 1);
    assertEquals(rows[0], {
      ts: "2026-09-23T10:00:00Z",
      type: "message",
      payload: { action: "reply", ref_external_id: "mail:ana@contoso.com:m0@contoso.com" },
      envelope: {
        service: "microsoft",
        connection_address: "ana@contoso.com",
        // the thread: the conversation Exchange files the message in
        conversation: { address: "AAQk42", kind: "group", name: "Invoice 42" },
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
        // how the mailbox showed it, kept for the next listing to compare with
        microsoft: { shown: { read: false, flagged: false, categories: [] } },
      },
    });
    assertEquals(saved.length, 1);
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

const IN1 = `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in1`;
const SENT1 = `${GRAPH}/mailFolders/sentitems/messages/delta?$deltatoken=se1`;

/** A message the log already holds, and how the mailbox showed it last. */
const held = (n: string, conversation: string, shown: Record<string, unknown> = {}) =>
  ({
    ts: NOW,
    type: "message",
    envelope: {
      service: "microsoft",
      connection_address: "ana@contoso.com",
      conversation: { address: conversation, kind: "group" },
      external_id: `mail:ana@contoso.com:${n}@x.com`,
    },
    parts: [{ type: "text", kind: "text", text: "hi" }],
    extra: {
      microsoft: {
        shown: { folder: "F-in", read: false, flagged: false, categories: [], ...shown },
      },
    },
  }) as Draft<MessageEvent>;

/** The message as a read shows it now. */
const reads = (
  id: string,
  n: string,
  conversationId: string,
  over: Record<string, unknown> = {},
) => ({
  ...MSG,
  id,
  internetMessageId: `<${n}@x.com>`,
  conversationId,
  hasAttachments: false,
  parentFolderId: "F-in",
  isRead: false,
  flag: { flagStatus: "notFlagged" },
  categories: [],
  ...over,
});

/** The mailbox's folders, the well-known ones by their names. */
const FOLDER_ROUTES = {
  "/mailFolders/inbox": { id: "F-in", displayName: "Inbox" },
  "/mailFolders/archive": { id: "F-arc", displayName: "Archive" },
  "/mailFolders/deleteditems": { id: "F-del", displayName: "Deleted Items" },
  "/mailFolders/junkemail": { id: "F-junk", displayName: "Junk Email" },
  "/mailFolders/F-cli": { id: "F-cli", displayName: "Clientes" },
};

/** The view a line says, and the conversation it says it of. */
const viewsOf = (drafts: Draft<MessageEvent>[]) =>
  drafts.filter((d) => d.parts?.[0]?.type === "data").map((d) => [
    d.envelope.conversation.address,
    (d.parts[0] as RoomPart).data.view,
  ]);

Deno.test("outlook mail: a message listed again says what moved — read, flag, categories — one line per conversation, then keeps the showing", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: KEY,
      value: {},
      extra: { mail_sync: { inbox: IN1, sentitems: SENT1 } },
    });
    const log = memLog([
      held("a1", "C1"),
      held("a2", "C1", { read: true, categories: ["Blue category"] }),
      held("b1", "C2"),
    ]);
    const calls: Call[] = [];
    const api = graph({
      "/mailFolders/inbox/messages/delta": {
        value: [{ id: "A1" }, { id: "A2" }, { id: "B1" }],
        "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
      },
      "/mailFolders/sentitems/messages/delta": { value: [], "@odata.deltaLink": SENT1 },
      "/messages/A1": reads("A1", "a1", "C1", {
        isRead: true,
        flag: { flagStatus: "flagged" },
        categories: ["Red category"],
      }),
      "/messages/A2": reads("A2", "a2", "C1", { isRead: true }),
      "/messages/B1": reads("B1", "b1", "C2"), // listed, nothing we keep moved
    }, calls);
    await poller(creds, api, log.publish, log.read).tick();
    const [line, ...kept] = log.published;
    assertEquals(viewsOf([line]), [["C1", {
      read: true,
      starred: true,
      labels: { added: ["Red category"], removed: ["Blue category"] },
    }]]);
    // the account's own line, in the conversation, named by its subject
    assertEquals(line.ts, NOW);
    assertEquals(line.envelope.sender, { address: "ana@contoso.com" });
    assertEquals(line.envelope.conversation, { address: "C1", kind: "group", name: "Invoice 42" });
    assert(line.envelope.external_id?.startsWith("mailview:ana@contoso.com:C1:"));
    // then the showings, on the rows, which keep their words
    assertEquals(kept.map((d) => [d.envelope.external_id, "parts" in d]), [
      ["mail:ana@contoso.com:a1@x.com", false],
      ["mail:ana@contoso.com:a2@x.com", false],
    ]);
    assertEquals(log.row("mail:ana@contoso.com:a1@x.com")?.extra?.microsoft, {
      shown: { folder: "F-in", read: true, flagged: true, categories: ["Red category"] },
    });
    assertEquals(log.row("mail:ana@contoso.com:a2@x.com")?.extra?.microsoft, {
      shown: { folder: "F-in", read: true, flagged: false, categories: [] },
    });
    assertEquals(log.row("mail:ana@contoso.com:a1@x.com")?.parts, [
      { type: "text", kind: "text", text: "hi" },
    ]);
    // a message the log holds is not read again whole, and nothing moved folders
    assertEquals(calls.filter((c) => /attachments|mailFolders\/[^/]+$/.test(c.url.pathname)), []);
    assertEquals(
      (await syncOf(creds))?.inbox,
      `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
    );
  });
});

Deno.test("outlook mail: a move — Archive, Deleted Items, Junk, any folder, and back to the Inbox — is the conversation's view", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: KEY,
      value: {},
      extra: { mail_sync: { inbox: IN1, sentitems: SENT1 } },
    });
    const log = memLog([
      held("m1", "K1"),
      held("m2", "K2"),
      held("m3", "K3"),
      held("m4", "K4"),
      held("m5", "K5", { folder: "F-arc" }),
      held("m6", "K6", { folder: "F-cli" }),
    ]);
    const calls: Call[] = [];
    const gone = { "@removed": { reason: "deleted" } };
    const api = graph({
      ...FOLDER_ROUTES,
      "/mailFolders/inbox/messages/delta": {
        value: [
          { id: "M1", ...gone },
          { id: "M2", ...gone },
          { id: "M3", ...gone },
          { id: "M4", ...gone },
          { id: "M5" },
          { id: "M6" },
          { id: "M7", ...gone },
        ],
        "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
      },
      "/mailFolders/sentitems/messages/delta": { value: [], "@odata.deltaLink": SENT1 },
      "/messages/M1": reads("M1", "m1", "K1", { parentFolderId: "F-arc" }),
      "/messages/M2": reads("M2", "m2", "K2", { parentFolderId: "F-del" }),
      "/messages/M3": reads("M3", "m3", "K3", { parentFolderId: "F-junk" }),
      "/messages/M4": reads("M4", "m4", "K4", { parentFolderId: "F-cli" }),
      "/messages/M5": reads("M5", "m5", "K5"),
      "/messages/M6": reads("M6", "m6", "K6"),
      // a message leaving the folder before the log held it says nothing
      "/messages/M7": reads("M7", "m7", "K7", { parentFolderId: "F-arc" }),
    }, calls);
    await poller(creds, api, log.publish, log.read).tick();
    assertEquals(viewsOf(log.published), [
      ["K1", { archived: true }],
      ["K2", { trashed: true }],
      ["K3", { spam: true }],
      ["K4", { folder: "Clientes" }],
      ["K5", { archived: false }],
      ["K6", { folder: "Inbox" }],
    ]);
    // the well-known folders once, and the other folder once
    assertEquals(
      calls.filter((c) =>
        c.url.pathname.includes("/mailFolders/") && !c.url.pathname.endsWith("/delta")
      )
        .map((c) => c.url.pathname.slice("/v1.0/me/mailFolders/".length)),
      ["inbox", "archive", "deleteditems", "junkemail", "F-cli"],
    );
    assertEquals(log.row("mail:ana@contoso.com:m1@x.com")?.extra?.microsoft, {
      shown: { folder: "F-arc", read: false, flagged: false, categories: [] },
    });
  });
});

Deno.test("outlook mail: a new message is published whole and says nothing; one gone for good is deleted in the conversation it was read in", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: KEY,
      value: {},
      extra: { mail_sync: { inbox: IN1, sentitems: SENT1 } },
    });
    const log = memLog();
    const next = (token: string) =>
      `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=${token}`;
    let deleted = false;
    const api = graph({
      "/mailFolders/inbox/messages/delta": (url: URL) =>
        url.searchParams.get("$deltatoken") === "in1"
          ? { value: [{ id: "N1" }], "@odata.deltaLink": next("in2") }
          : {
            value: [
              { id: "N1", "@removed": { reason: "deleted" } },
              { id: "X9", "@removed": { reason: "deleted" } }, // never read here: not placed
            ],
            "@odata.deltaLink": next("in3"),
          },
      "/mailFolders/sentitems/messages/delta": { value: [], "@odata.deltaLink": SENT1 },
      "/messages/N1": () =>
        deleted ? new Response("gone", { status: 404 }) : reads("N1", "n1", "AAQk-N"),
    });
    const p = poller(creds, api, log.publish, log.read);
    await p.tick();
    assertEquals(log.published.length, 1);
    assertEquals(log.published[0].envelope.external_id, "mail:ana@contoso.com:n1@x.com");
    assertEquals(log.published[0].extra?.microsoft, {
      shown: { folder: "F-in", read: false, flagged: false, categories: [] },
    });
    deleted = true;
    await p.tick();
    assertEquals(viewsOf(log.published.slice(1)), [["AAQk-N", { deleted: true }]]);
    assertEquals(log.published.slice(1)[0].envelope.conversation.name, "Invoice 42");
    assertEquals((await syncOf(creds))?.inbox, next("in3"));
  });
});

Deno.test("outlook mail: a round whose showings did not land is read again, and says its lines again under the same keys", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: KEY,
      value: {},
      extra: { mail_sync: { inbox: IN1, sentitems: SENT1 } },
    });
    const log = memLog([held("a1", "C1")]);
    let refuse = true;
    const publish = ((e: Draft<Event> | Draft<Event>[]) => {
      const drafts = Array.isArray(e) ? e : [e];
      if (refuse && drafts.some((d) => !("parts" in d))) {
        return Promise.reject(new Error("the log is away"));
      }
      return log.publish(e as Draft<Event>[]);
    }) as Appender["publish"];
    const api = graph({
      "/mailFolders/inbox/messages/delta": {
        value: [{ id: "A1" }],
        "@odata.deltaLink": `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
      },
      "/mailFolders/sentitems/messages/delta": { value: [], "@odata.deltaLink": SENT1 },
      "/messages/A1": reads("A1", "a1", "C1", { isRead: true }),
    });
    await poller(creds, api, publish, log.read).tick();
    assertEquals((await syncOf(creds))?.inbox, IN1); // the cursor stood
    refuse = false;
    await poller(creds, api, publish, log.read).tick();
    const lines = log.published.filter((d) => "parts" in d);
    assertEquals(viewsOf(lines), [["C1", { read: true }], ["C1", { read: true }]]);
    assertEquals(lines[0].envelope.external_id, lines[1].envelope.external_id);
    assertEquals(
      (await syncOf(creds))?.inbox,
      `${GRAPH}/mailFolders/inbox/messages/delta?$deltatoken=in2`,
    );
  });
});

Deno.test("outlook mail: moveOf — the view folders set and clear their field, any other folder is named", () => {
  const inbox = { name: "Inbox", well: "inbox" };
  const archive = { name: "Archive", well: "archive" };
  const bin = { name: "Deleted Items", well: "deleteditems" };
  const junk = { name: "Junk Email", well: "junkemail" };
  const clientes = { name: "Clientes" };
  assertEquals(moveOf(inbox, archive), { archived: true });
  assertEquals(moveOf(inbox, bin), { trashed: true });
  assertEquals(moveOf(inbox, junk), { spam: true });
  assertEquals(moveOf(inbox, clientes), { folder: "Clientes" });
  assertEquals(moveOf(archive, inbox), { archived: false });
  assertEquals(moveOf(clientes, inbox), { folder: "Inbox" });
  assertEquals(moveOf(archive, clientes), { archived: false, folder: "Clientes" });
  assertEquals(moveOf(junk, archive), { spam: false, archived: true });
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
