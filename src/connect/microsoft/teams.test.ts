import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  bodyOf,
  createTeamsDispatch,
  createTeamsKeeper,
  createTeamsWebhook,
  GRAPH,
  idOf,
  isTeamsAddress,
  LIFETIME_MS,
  messagePath,
  parseResource,
  placeOf,
  RENEW_AHEAD_MS,
  shareId,
  subsOf,
  TEAMS_SUB,
  teamsWire,
  toTeamsHtml,
} from "./teams.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender, DeliveryPatch, ReadQuery, Subscriber } from "../../store/log.ts";
import type { Draft, Event, EventId, FilePart, MessageEvent } from "../../types.ts";
import type { SaveFile } from "../mail.ts";
import { newId } from "../../store/id.ts";

const KEY = "microsoft:ana@contoso.com";
const OID = "8ea0e38b-efb3-4757-924a-5f94061cf8c2";
const CHAT = "19:8ea0e38b_97f62344@unq.gbl.spaces";
const TEAM = "fbe2bf47-16c8-47cf-b4a5-4b9b187c508b";
const CHANNEL = "19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2";
const NOW = "2026-09-23T12:00:00.000Z";
const URL_ = "https://org.example/teams";
const SCOPES =
  "User.Read Chat.ReadWrite ChannelMessage.Read.All ChannelMessage.Send Files.ReadWrite";

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
  extra: Record<string, unknown> = {},
  scope = SCOPES,
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
      extra: {
        client_id: "cid",
        scope,
        oid: OID,
        expiry: new Date(Date.now() + 3600_000).toISOString(),
        ...extra,
      },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Call = { url: URL; path: string; init?: RequestInit; headers: Headers; body?: unknown };

/** A Graph that answers by `METHOD path` (after `/v1.0`), the call handed to a function. */
function graph(
  routes: Record<string, unknown | ((c: Call) => unknown | Response)>,
  calls: Call[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url,
      path: decodeURIComponent(url.pathname),
      init,
      headers: new Headers(init?.headers),
    };
    if (typeof init?.body === "string") {
      try {
        call.body = JSON.parse(init.body);
      } catch {
        call.body = init.body;
      }
    } else if (init?.body) call.body = init.body;
    calls.push(call);
    const method = init?.method ?? "GET";
    const path = call.path.slice("/v1.0".length);
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (route === undefined) return new Response("not found", { status: 404 });
    const ans = typeof route === "function" ? await (route as (c: Call) => unknown)(call) : route;
    return ans instanceof Response ? ans : Response.json(ans);
  }) as typeof fetch;
}

const saved: { conversation: string; bytes: Uint8Array; meta: unknown }[] = [];
const save: SaveFile = (conversation, bytes, meta) => {
  saved.push({ conversation, bytes, meta });
  return Promise.resolve({
    type: "file",
    kind: meta.mime_type?.startsWith("image/") ? "image" : "document",
    file: {
      mime_type: meta.mime_type ?? "application/octet-stream",
      uri: `file:///m/${meta.name ?? "x"}`,
      ...(meta.name ? { name: meta.name } : {}),
    },
  } as FilePart);
};

const sub = (resource: string, id: string, secret = "s-" + id) => ({
  [resource]: { id, expires: "2026-09-26T12:00:00.000Z", secret },
});
const CHAT_RES = `/users/${OID}/chats/getAllMessages`;
const CHAN_RES = `/teams/${TEAM}/channels/${CHANNEL}/messages`;

function notice(over: Record<string, unknown>): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: [over] }),
  });
}

/* ── the grammar ─────────────────────────────────────────────────────────────────── */

Deno.test("teams: an address is a chat id or team/channel; a ref is teams:<address>:<id>; a resource parses to its place", () => {
  assertEquals(placeOf(CHAT), { kind: "chat", chat: CHAT });
  assertEquals(placeOf(`${TEAM}/${CHANNEL}`), { kind: "channel", team: TEAM, channel: CHANNEL });
  assertEquals(idOf(`teams:${TEAM}/${CHANNEL}:1614618259349`), {
    address: `${TEAM}/${CHANNEL}`,
    id: "1614618259349",
  });
  assertEquals(idOf("mail:abc@x.com"), undefined);
  assertEquals(parseResource(`chats('${CHAT}')/messages('17')`), {
    place: { kind: "chat", chat: CHAT },
    id: "17",
  });
  assertEquals(
    parseResource(`teams('${TEAM}')/channels('${CHANNEL}')/messages('1')/replies('2')`),
    {
      place: { kind: "channel", team: TEAM, channel: CHANNEL },
      id: "2",
      root: "1",
    },
  );
  assertEquals(
    messagePath({ kind: "channel", team: TEAM, channel: CHANNEL }, "2", "1"),
    `${GRAPH}/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages/1/replies/2`,
  );
  assert(isTeamsAddress(CHAT));
  assert(isTeamsAddress(`${TEAM}/${CHANNEL}`));
  assert(!isTeamsAddress("ana@x.com"));
  assert(!isTeamsAddress("calendar:me@org.com"));
  assertEquals(
    shareId("https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1"),
    "u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx",
  );
});

Deno.test("teams: the body — an <at> is @Name and a mention, an <emoji> its glyph, a hosted image a URL apart, markup goes", () => {
  const body = bodyOf({
    body: {
      contentType: "html",
      content:
        `<p>Hi&nbsp;<at id="0">Jane Smith</at>, see <b>this</b> <emoji id="1f440_eyes" alt="👀" title="Eyes"></emoji></p>` +
        `<attachment id="153fa47d"></attachment>` +
        `<div><img height="250" src="${GRAPH}/chats/${CHAT}/messages/1/hostedContents/aWQ9/$value" width="424"></div>`,
    },
    mentions: [{
      id: 0,
      mentionText: "Jane Smith",
      mentioned: { user: { id: "u-jane", displayName: "Jane Smith", userIdentityType: "aadUser" } },
    }],
  });
  assertEquals(body.text, "Hi @Jane Smith, see this 👀");
  assertEquals(body.mentions, [{ address: "u-jane", name: "Jane Smith" }]);
  assertEquals(body.hosted, [`${GRAPH}/chats/${CHAT}/messages/1/hostedContents/aWQ9/$value`]);
  assertEquals(bodyOf({ body: { contentType: "text", content: " plain " } }), {
    text: "plain",
    mentions: [],
    hosted: [],
  });
});

Deno.test("teams: toTeamsHtml — markdown to Teams' HTML, a claimed @Name to <at> with its mention entry", () => {
  const { html, mentions } = toTeamsHtml(
    "Hola @Ana, **ok** _sí_ `a<b` ~~no~~\n[doc](https://x.y/z) & fin\n```\nx < y\n```",
    [{ address: "u-ana", name: "Ana" }, { address: "C1", name: "general", type: "#" }],
  );
  assertEquals(
    html,
    'Hola <at id="0">Ana</at>, <b>ok</b> <i>sí</i> <code>a&lt;b</code> <s>no</s><br>' +
      '<a href="https://x.y/z">doc</a> &amp; fin<br><pre>x &lt; y</pre>',
  );
  assertEquals(mentions, [{
    id: 0,
    mentionText: "Ana",
    mentioned: { user: { id: "u-ana", displayName: "Ana", userIdentityType: "aadUser" } },
  }]);
  // nothing claimed: words stay words, and an address inside a word is not a summons
  assertEquals(toTeamsHtml("mail foo@here.com", []).html, "mail foo@here.com");
});

/* ── the webhook ─────────────────────────────────────────────────────────────────── */

Deno.test("teams webhook: the handshake echoes the token plain; a notice is acked and the message read back into a row", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    const calls: Call[] = [];
    const memberships: unknown[] = [];
    const msg = {
      id: "1612289992105",
      messageType: "message",
      createdDateTime: "2021-02-02T18:19:52.105Z",
      chatId: CHAT,
      from: { user: { id: "u-robin", displayName: "Robin Kline" } },
      body: {
        contentType: "html",
        content:
          `<p><at id="0">Ana</at> the budget <img src="${GRAPH}/chats/${CHAT}/messages/1612289992105/hostedContents/aWQ9/$value"></p><attachment id="a1"></attachment>`,
      },
      mentions: [{
        id: 0,
        mentionText: "Ana",
        mentioned: { user: { id: OID, displayName: "Ana" } },
      }],
      attachments: [{
        id: "a1",
        contentType: "reference",
        contentUrl: "https://contoso.sharepoint.com/sites/t/Shared%20Documents/Budget.docx",
        name: "Budget.docx",
      }],
    };
    const fetchApi = graph({
      [`/chats/${CHAT}/messages/1612289992105`]: msg,
      [`/chats/${CHAT}`]: {
        chatType: "oneOnOne",
        topic: null,
        members: [{ userId: OID, displayName: "Ana" }, {
          userId: "u-robin",
          displayName: "Robin Kline",
        }],
      },
      [`/chats/${CHAT}/messages/1612289992105/hostedContents/aWQ9/$value`]: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      [
        `/shares/${
          shareId("https://contoso.sharepoint.com/sites/t/Shared%20Documents/Budget.docx")
        }/driveItem/content`
      ]: () =>
        new Response(new Uint8Array([4, 5]), {
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        }),
    }, calls);
    const handler = createTeamsWebhook({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      store: {
        upsertMemberships: (r) => {
          memberships.push(...r);
          return Promise.resolve();
        },
      },
      save,
      fetchApi,
      now: () => NOW,
    });
    // the record the keeper wrote: the notice must echo its secret
    await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAT_RES, "sub-1") } });

    const shake = await handler(
      new Request(`${URL_}?validationToken=tok%20en`, { method: "POST" }),
    );
    assertEquals(shake.status, 200);
    assertEquals(shake.headers.get("content-type"), "text/plain");
    assertEquals(await shake.text(), "tok en");

    saved.length = 0;
    const res = await handler(notice({
      subscriptionId: "sub-1",
      clientState: "s-sub-1",
      changeType: "created",
      resource: `chats('${CHAT}')/messages('1612289992105')`,
    }));
    assertEquals(res.status, 202);
    assertEquals(rows.length, 1);
    const row = rows[0];
    assertEquals(row.envelope, {
      service: "microsoft",
      connection_address: "ana@contoso.com",
      conversation: { address: CHAT, kind: "direct", name: "Robin Kline" },
      external_id: `teams:${CHAT}:1612289992105`,
      sender: { address: "u-robin", name: "Robin Kline" },
    });
    assertEquals(row.ts, "2021-02-02T18:19:52.105Z");
    assertEquals(row.agent, undefined); // Robin is nobody's grant
    assertEquals(row.payload, { mentions: [{ address: OID, name: "Ana" }] });
    assertEquals(row.parts.map((p) => p.type), ["text", "file", "file"]);
    assertEquals((row.parts[0] as { text: string }).text, "@Ana the budget");
    assertEquals(saved.map((s) => [s.conversation, [...s.bytes]]), [[CHAT, [1, 2, 3]], [CHAT, [
      4,
      5,
    ]]]);
    assertEquals((saved[1].meta as { name?: string }).name, "Budget.docx");
    // the token rode every read
    assert(calls.every((c) => c.headers.get("authorization") === "Bearer eyJ.fresh"));
    // the member whose subscription delivered a chat is in it
    assertEquals(memberships, [{
      service: "microsoft",
      connection: "ana@contoso.com",
      conversation: CHAT,
      agentId: "ana",
    }]);
  });
});

Deno.test("teams webhook: a channel reply is a reply to its root, addressed team/channel and named Team / Channel; a member's own message wears their stamp", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    const fetchApi = graph({
      [`/teams/${TEAM}/channels/${CHANNEL}/messages/1/replies/2`]: {
        id: "2",
        replyToId: "1",
        messageType: "message",
        createdDateTime: "2021-02-18T18:02:28.387Z",
        channelIdentity: { teamId: TEAM, channelId: CHANNEL },
        from: { user: { id: OID, displayName: "Ana" } },
        body: { contentType: "html", content: "<div><div>Test</div></div>" },
      },
      [`/teams/${TEAM}`]: { displayName: "Sales" },
      [`/teams/${TEAM}/channels/${CHANNEL}`]: { displayName: "General" },
    });
    const handler = createTeamsWebhook({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      save,
      fetchApi,
      now: () => NOW,
    });
    await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAN_RES, "sub-c") } });
    await handler(notice({
      subscriptionId: "sub-c",
      clientState: "s-sub-c",
      changeType: "created",
      resource: `teams('${TEAM}')/channels('${CHANNEL}')/messages('1')/replies('2')`,
    }));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].agent, { id: "ana" });
    assertEquals(rows[0].payload, {
      action: "reply",
      ref_external_id: `teams:${TEAM}/${CHANNEL}:1`,
    });
    assertEquals(rows[0].envelope.conversation, {
      address: `${TEAM}/${CHANNEL}`,
      kind: "channel",
      name: "Sales / General",
    });
    assertEquals(rows[0].envelope.external_id, `teams:${TEAM}/${CHANNEL}:2`);
    assertEquals(rows[0].parts, [{ type: "text", kind: "text", text: "Test" }]);
  });
});

Deno.test("teams webhook: an edit is its own event, a delete a marked row and a delete event, a reaction an add per reactor; a bad secret is dropped", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    let served: Record<string, unknown> = {};
    const fetchApi = graph({
      [`/chats/${CHAT}/messages/7`]: () => served,
      [`/chats/${CHAT}`]: { chatType: "group", topic: "Ops", members: [] },
    });
    const handler = createTeamsWebhook({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      save,
      fetchApi,
      now: () => NOW,
    });
    await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAT_RES, "sub-1") } });
    const send = (changeType: string) =>
      handler(
        notice({
          subscriptionId: "sub-1",
          clientState: "s-sub-1",
          changeType,
          resource: `chats('${CHAT}')/messages('7')`,
        }),
      );
    const base = {
      id: "7",
      messageType: "message",
      createdDateTime: "2026-09-23T11:00:00Z",
      from: { user: { id: "u-x", displayName: "X" } },
    };

    served = {
      ...base,
      lastEditedDateTime: "2026-09-23T11:05:00Z",
      body: { contentType: "text", content: "fixed" },
    };
    await send("updated");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].payload, { action: "edit", ref_external_id: `teams:${CHAT}:7` });
    assertEquals(
      rows[0].envelope.external_id,
      `teams:${CHAT}:7:edit:${Date.parse("2026-09-23T11:05:00Z")}`,
    );
    assertEquals(rows[0].envelope.conversation, { address: CHAT, kind: "direct", name: "Ops" });

    served = {
      ...base,
      body: { contentType: "text", content: "hi" },
      reactions: [{ reactionType: "👍", user: { user: { id: OID, displayName: "Ana" } } }, {
        reactionType: "❤️",
        user: { user: { id: "u-x" } },
      }],
    };
    await send("updated");
    assertEquals(rows.length, 3);
    assertEquals(rows[1].payload, { action: "add", ref_external_id: `teams:${CHAT}:7` });
    assertEquals(rows[1].agent, { id: "ana" });
    assertEquals(rows[1].parts, [{
      type: "data",
      kind: "reaction",
      data: { name: "👍", unicode: "👍" },
    }]);
    assertEquals(rows[1].envelope.external_id, `teams:${CHAT}:7:react:${OID}:👍`);
    assertEquals(rows[2].envelope.sender, { address: "u-x" });

    served = {
      ...base,
      deletedDateTime: "2026-09-23T11:09:00Z",
      body: { contentType: "text", content: "" },
    };
    await send("deleted");
    assertEquals(rows.length, 5);
    assertEquals(rows[3].payload, { action: "delete", ref_external_id: `teams:${CHAT}:7` });
    assertEquals(rows[3].envelope.external_id, `teams:${CHAT}:7:del`);
    assertEquals(rows[4].envelope.external_id, `teams:${CHAT}:7`);
    assertEquals((rows[4] as { status?: unknown }).status, {
      state: "deleted",
      deleted_at: "2026-09-23T11:09:00Z",
    });

    // a notice whose secret is not the record's is nobody's
    const bad = await handler(
      notice({
        subscriptionId: "sub-1",
        clientState: "forged",
        changeType: "created",
        resource: `chats('${CHAT}')/messages('7')`,
      }),
    );
    assertEquals(bad.status, 202);
    assertEquals(rows.length, 5);
    // a system event (someone joined) is not a message
    served = {
      ...base,
      messageType: "systemEventMessage",
      body: { contentType: "html", content: "<systemEventMessage/>" },
    };
    await send("created");
    assertEquals(rows.length, 5);
  });
});

Deno.test("teams webhook: lifecycle — a removal drops the record, a reauthorization renews it", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    const calls: Call[] = [];
    const fetchApi = graph({
      "PATCH /subscriptions/sub-1": { id: "sub-1", expirationDateTime: "2026-09-26T11:50:00.000Z" },
    }, calls);
    const handler = createTeamsWebhook({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      save,
      fetchApi,
      now: () => NOW,
    });
    await creds.put({
      key: KEY,
      value: {},
      extra: { [TEAMS_SUB]: { ...sub(CHAT_RES, "sub-1"), ...sub(CHAN_RES, "sub-c") } },
    });

    await handler(
      notice({
        subscriptionId: "sub-1",
        clientState: "s-sub-1",
        lifecycleEvent: "reauthorizationRequired",
      }),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].body, {
      expirationDateTime: new Date(Date.parse(NOW) + LIFETIME_MS).toISOString(),
    });
    let subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES].expires, "2026-09-26T11:50:00.000Z");
    assertEquals(subs[CHAT_RES].secret, "s-sub-1"); // the secret stays: the notices keep echoing it

    await handler(
      notice({
        subscriptionId: "sub-c",
        clientState: "s-sub-c",
        lifecycleEvent: "subscriptionRemoved",
      }),
    );
    subs = subsOf(await creds.get(KEY));
    assertEquals(Object.keys(subs), [CHAT_RES]);
    assertEquals(rows.length, 0);
  });
});

/* ── the keeper ──────────────────────────────────────────────────────────────────── */

Deno.test("teams keeper: a first sweep subscribes the member's chats and every channel of their teams, recording id, expiry and secret on the grant", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    let n = 0;
    const fetchApi = graph({
      "/me/joinedTeams": { value: [{ id: TEAM }] },
      [`/teams/${TEAM}/channels`]: { value: [{ id: CHANNEL }, { id: "19:other@thread.tacv2" }] },
      "POST /subscriptions": (c: Call) => {
        const body = c.body as { resource: string };
        // another grant already holds the second channel
        if (body.resource.includes("other")) return new Response("exists", { status: 409 });
        return Response.json({ id: `sub-${++n}`, expirationDateTime: "2026-09-26T11:50:00Z" });
      },
    }, calls);
    const keeper = createTeamsKeeper({
      creds,
      broker: createGrantBroker({ creds }),
      notificationUrl: URL_,
      fetchApi,
      now: () => NOW,
      onError: (_k, err) => {
        throw err;
      },
    });
    await keeper.tick();
    const posts = calls.filter((c) => c.init?.method === "POST").map((c) =>
      c.body as Record<string, unknown>
    );
    assertEquals(posts.length, 3);
    assertEquals(posts[0].resource, CHAT_RES);
    assertEquals(posts[0].changeType, "created,updated,deleted");
    assertEquals(posts[0].notificationUrl, URL_);
    assertEquals(posts[0].lifecycleNotificationUrl, URL_);
    assertEquals(
      posts[0].expirationDateTime,
      new Date(Date.parse(NOW) + LIFETIME_MS).toISOString(),
    );
    assertEquals(typeof posts[0].clientState, "string");
    assertEquals(posts[1].resource, CHAN_RES);
    const subs = subsOf(await creds.get(KEY));
    assertEquals(Object.keys(subs).sort(), [CHAN_RES, CHAT_RES].sort());
    assertEquals(subs[CHAT_RES], {
      id: "sub-1",
      expires: "2026-09-26T11:50:00Z",
      secret: posts[0].clientState as string,
    });
    assertEquals(subs[CHAN_RES].id, "sub-2");

    // a second sweep: everything is fresh, the channel listing is remembered, nothing is asked
    calls.length = 0;
    await keeper.tick();
    assertEquals(calls.length, 0);
  });
});

Deno.test("teams keeper: a subscription inside its last day is renewed, an expired one made anew; a grant without the chat consent is left alone", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const fetchApi = graph({
      "/me/joinedTeams": { value: [] },
      "PATCH /subscriptions/sub-old": { id: "sub-old", expirationDateTime: "2026-09-26T11:50:00Z" },
      "POST /subscriptions": { id: "sub-new", expirationDateTime: "2026-09-26T11:50:00Z" },
    }, calls);
    const keeper = createTeamsKeeper({
      creds,
      broker: createGrantBroker({ creds }),
      notificationUrl: URL_,
      fetchApi,
      now: () => NOW,
    });
    const soon = new Date(Date.parse(NOW) + RENEW_AHEAD_MS / 2).toISOString();
    await creds.put({
      key: KEY,
      value: {},
      extra: { [TEAMS_SUB]: { [CHAT_RES]: { id: "sub-old", expires: soon, secret: "keep" } } },
    });
    await keeper.tick();
    assertEquals(calls.filter((c) => c.init?.method === "PATCH").length, 1);
    let subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES], {
      id: "sub-old",
      expires: "2026-09-26T11:50:00Z",
      secret: "keep",
    });

    await creds.put({
      key: KEY,
      value: {},
      extra: {
        [TEAMS_SUB]: {
          [CHAT_RES]: { id: "sub-old", expires: "2026-09-20T00:00:00Z", secret: "gone" },
        },
      },
    });
    await keeper.tick();
    subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES].id, "sub-new");
    assert(subs[CHAT_RES].secret !== "gone");
  });
  // no Chat scope on the consent: the sweep skips the grant without a verdict
  await withVault(
    async (creds) => {
      const calls: Call[] = [];
      const keeper = createTeamsKeeper({
        creds,
        broker: createGrantBroker({ creds }),
        notificationUrl: URL_,
        fetchApi: graph({}, calls),
        now: () => NOW,
      });
      await keeper.tick();
      assertEquals(calls.length, 0);
    },
    {},
    "User.Read Mail.Read",
  );
});

/* ── the dispatch ────────────────────────────────────────────────────────────────── */

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
  ts: NOW,
  type: "message",
  agent: { id: "ana", session_id: "s1" },
  envelope: {
    service: "microsoft",
    connection_address: "ana@contoso.com",
    conversation: { address: CHAT, kind: "direct" },
    status: "queued",
  },
  status: { state: "queued", queued_at: NOW },
  parts: [{ type: "text", kind: "text", text: "Hola **Robin**" }],
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("teams dispatch: a chat message posts as HTML with its mentions; the row takes the id and the wire's sender; a channel reply lands under the root", async () => {
  const root: Event = {
    id: "r0",
    ts: NOW,
    type: "message",
    envelope: {
      service: "microsoft",
      connection_address: "ana@contoso.com",
      conversation: { address: `${TEAM}/${CHANNEL}`, kind: "channel" },
      external_id: `teams:${TEAM}/${CHANNEL}:1`,
    },
    parts: [{ type: "text", kind: "text", text: "root" }],
  } as Event;
  const reply: Event = {
    ...root,
    id: "r1",
    payload: { action: "reply", ref_external_id: `teams:${TEAM}/${CHANNEL}:1` },
    envelope: { ...root.envelope, external_id: `teams:${TEAM}/${CHANNEL}:2` },
  } as Event;
  const log = fakeLog([], [root, reply]);
  const posts: unknown[] = [];
  createTeamsDispatch({
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    directory: () => Promise.resolve([{ address: "u-robin", name: "Robin" }]),
    wire: {
      post: (grant, place, message, root) => {
        posts.push({ grant, place, message, root });
        return Promise.resolve({ id: "9", user: OID });
      },
      amend: () => Promise.resolve(),
      react: () => Promise.resolve(),
    },
  });
  log.push(
    outbound({ id: "e1", parts: [{ type: "text", kind: "text", text: "Hola @Robin, **ok**" }] }),
  );
  await settle();
  assertEquals(posts.length, 1);
  assertEquals(posts[0], {
    grant: { connection: "ana@contoso.com", agentId: "ana" },
    place: { kind: "chat", chat: CHAT },
    message: {
      html: 'Hola <at id="0">Robin</at>, <b>ok</b>',
      mentions: [{
        id: 0,
        mentionText: "Robin",
        mentioned: { user: { id: "u-robin", displayName: "Robin", userIdentityType: "aadUser" } },
      }],
      files: [],
    },
    root: undefined,
  });
  assertEquals(log.patches[0].patch, {
    external_id: `teams:${CHAT}:9`,
    sender: { address: OID },
    status: { state: "dispatched", dispatched_at: log.patches[0].patch.status!.dispatched_at },
  });

  // a reply to a reply in a channel threads under the referent's root
  log.push(outbound({
    id: "e2",
    envelope: {
      service: "microsoft",
      connection_address: "ana@contoso.com",
      conversation: { address: `${TEAM}/${CHANNEL}`, kind: "channel" },
      status: "queued",
    },
    payload: { action: "reply", ref_external_id: `teams:${TEAM}/${CHANNEL}:2` },
    parts: [{ type: "text", kind: "text", text: "sí" }],
  }));
  await settle();
  assertEquals((posts[1] as { root?: string }).root, "1");
  assertEquals((posts[1] as { place: unknown }).place, {
    kind: "channel",
    team: TEAM,
    channel: CHANNEL,
  });
  // a reply in a chat is a plain message: chats have no threads
  log.push(
    outbound({ id: "e3", payload: { action: "reply", ref_external_id: `teams:${CHAT}:5` } }),
  );
  await settle();
  assertEquals((posts[2] as { root?: string }).root, undefined);
});

Deno.test("teams dispatch: an edit, a delete and a reaction act on the referent; a row that is not Teams' is not this dispatch's", async () => {
  const log = fakeLog();
  const amends: unknown[] = [];
  const reacts: unknown[] = [];
  createTeamsDispatch({
    subscribe: log.subscribe,
    read: log.read,
    setDelivery: log.setDelivery,
    wire: {
      post: () => Promise.reject(new Error("no post expected")),
      amend: (_g, place, a) => {
        amends.push({ place, a });
        return Promise.resolve();
      },
      react: (_g, place, r) => {
        reacts.push({ place, r });
        return Promise.resolve();
      },
    },
  });
  log.push(
    outbound({
      id: "e1",
      payload: { action: "edit", ref_external_id: `teams:${CHAT}:7` },
      parts: [{ type: "text", kind: "text", text: "fixed" }],
    }),
  );
  log.push(
    outbound({
      id: "e2",
      payload: { action: "delete", ref_external_id: `teams:${CHAT}:7` },
      parts: [],
    }),
  );
  log.push(outbound({
    id: "e3",
    payload: { action: "add", ref_external_id: `teams:${CHAT}:7` },
    parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
  }));
  log.push(
    outbound({
      id: "e4",
      envelope: {
        service: "microsoft",
        connection_address: "ana@contoso.com",
        conversation: { address: "bob@y.com" },
        status: "queued",
      },
    }),
  );
  log.push(
    outbound({
      id: "e5",
      payload: { action: "edit" },
      parts: [{ type: "text", kind: "text", text: "x" }],
    }),
  );
  await settle();
  assertEquals(amends, [
    {
      place: { kind: "chat", chat: CHAT },
      a: { id: "7", root: undefined, action: "edit", html: "fixed" },
    },
    {
      place: { kind: "chat", chat: CHAT },
      a: { id: "7", root: undefined, action: "delete", html: "" },
    },
  ]);
  assertEquals(reacts, [{
    place: { kind: "chat", chat: CHAT },
    r: { id: "7", root: undefined, glyph: "👍", remove: false },
  }]);
  const states = Object.fromEntries(log.patches.map((p) => [p.id, p.patch.status?.state]));
  assertEquals(states, { e1: "dispatched", e2: "dispatched", e3: "dispatched", e5: "failed" });
  assertStringIncludes(
    String(log.patches.find((p) => p.id === "e5")!.patch.status!.error),
    "needs the message",
  );
});

Deno.test("teams wire: a post with a local file uploads it (a channel's folder, a chat's OneDrive with an org link) and attaches by reference; edit, delete and reactions hit their paths", async () => {
  await withVault(async (creds) => {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/budget.pdf`;
    await Deno.writeFile(path, new Uint8Array([9, 9]));
    const calls: Call[] = [];
    const fetchApi = graph({
      [`PUT /me/drive/root:/liquen/budget.pdf:/content`]: {
        id: "item-1",
        eTag: '"{153FA47D-18C9-4179-BE08-9879815A9F90},1"',
        webUrl: "https://contoso-my.sharepoint.com/personal/ana/Documents/liquen/budget.pdf",
      },
      "POST /me/drive/items/item-1/createLink": { link: { webUrl: "https://x" } },
      [`POST /chats/${CHAT}/messages`]: { id: "77", from: { user: { id: OID } } },
      [`/teams/${TEAM}/channels/${CHANNEL}/filesFolder`]: {
        id: "folder-1",
        parentReference: { driveId: "drive-1" },
      },
      [`PUT /drives/drive-1/items/folder-1:/budget.pdf:/content`]: {
        id: "item-2",
        eTag: '"{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee},2"',
        webDavUrl:
          "https://contoso.sharepoint.com/sites/Sales/Shared%20Documents/General/budget.pdf",
      },
      [`POST /teams/${TEAM}/channels/${CHANNEL}/messages/1/replies`]: {
        id: "78",
        from: { user: { id: OID } },
      },
      [`PATCH /chats/${CHAT}/messages/7`]: () => new Response(null, { status: 204 }),
      [`POST /chats/${CHAT}/messages/7/softDelete`]: () => new Response(null, { status: 204 }),
      [`POST /teams/${TEAM}/channels/${CHANNEL}/messages/1/replies/2/setReaction`]: () =>
        new Response(null, { status: 204 }),
      [`POST /chats/${CHAT}/messages/7/unsetReaction`]: () => new Response(null, { status: 204 }),
    }, calls);
    const wire = teamsWire({ broker: createGrantBroker({ creds }), fetchApi });
    const grant = { connection: "ana@contoso.com", agentId: "ana" };
    const file: FilePart = {
      type: "file",
      kind: "document",
      file: { mime_type: "application/pdf", uri: `file://${path}`, name: "budget.pdf" },
    };

    const chat = await wire.post(grant, { kind: "chat", chat: CHAT }, {
      html: "the budget",
      mentions: [],
      files: [file, {
        type: "file",
        kind: "document",
        file: { mime_type: "text/html", uri: "https://ext.example/x" },
      }],
    });
    assertEquals(chat, { id: "77", user: OID });
    const put = calls.find((c) => c.init?.method === "PUT")!;
    assertEquals(put.headers.get("content-type"), "application/pdf");
    assertEquals([...(put.body as Uint8Array)], [9, 9]);
    assertEquals(calls.find((c) => c.path.endsWith("/createLink"))!.body, {
      type: "view",
      scope: "organization",
    });
    const posted = calls.find((c) => c.path.endsWith(`/chats/${CHAT}/messages`))!
      .body as Record<string, unknown>;
    assertEquals(posted.body, {
      contentType: "html",
      content: 'the budget<br><a href="https://ext.example/x">https://ext.example/x</a>' +
        '<attachment id="153FA47D-18C9-4179-BE08-9879815A9F90"></attachment>',
    });
    assertEquals(posted.attachments, [{
      id: "153FA47D-18C9-4179-BE08-9879815A9F90",
      contentType: "reference",
      contentUrl: "https://contoso-my.sharepoint.com/personal/ana/Documents/liquen/budget.pdf",
      name: "budget.pdf",
    }]);
    assertEquals(posted.mentions, undefined);

    calls.length = 0;
    const reply = await wire.post(grant, { kind: "channel", team: TEAM, channel: CHANNEL }, {
      html: "here",
      mentions: [],
      files: [file],
    }, "1");
    assertEquals(reply.id, "78");
    assert(calls.some((c) => c.path.endsWith("/filesFolder")));
    assert(!calls.some((c) => c.path.endsWith("/createLink"))); // the channel's folder is already the members'
    const attached =
      (calls.at(-1)!.body as { attachments: { id: string; contentUrl: string }[] }).attachments[0];
    assertEquals(attached.id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assertEquals(
      attached.contentUrl,
      "https://contoso.sharepoint.com/sites/Sales/Shared%20Documents/General/budget.pdf",
    );

    calls.length = 0;
    await wire.amend(grant, { kind: "chat", chat: CHAT }, {
      id: "7",
      action: "edit",
      html: "<b>fixed</b>",
    });
    assertEquals(calls[0].init?.method, "PATCH");
    assertEquals(calls[0].body, { body: { contentType: "html", content: "<b>fixed</b>" } });
    await wire.amend(grant, { kind: "chat", chat: CHAT }, { id: "7", action: "delete", html: "" });
    assert(calls[1].url.pathname.endsWith("/messages/7/softDelete"));
    await wire.react(grant, { kind: "channel", team: TEAM, channel: CHANNEL }, {
      id: "2",
      root: "1",
      glyph: "💘",
      remove: false,
    });
    assertEquals(calls[2].body, { reactionType: "💘" });
    await wire.react(grant, { kind: "chat", chat: CHAT }, { id: "7", glyph: "💘", remove: true });
    assert(calls[3].url.pathname.endsWith("/unsetReaction"));

    // a refusal keeps its class
    const err = await wire.amend(grant, { kind: "chat", chat: CHAT }, {
      id: "nope",
      action: "edit",
      html: "x",
    }).catch((e) => e);
    assertEquals((err as { code?: number }).code, 404);
    await Deno.remove(dir, { recursive: true });
  });
});
