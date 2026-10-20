import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  bodyOf,
  createTeamsCatchUp,
  createTeamsDispatch,
  createTeamsKeeper,
  createTeamsWebhook,
  GRAPH,
  idOf,
  isTeamsAddress,
  kindOf,
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
import {
  type Appender,
  type DeliveryPatch,
  type Log,
  openLog,
  type ReadQuery,
  type Subscriber,
} from "../../store/log.ts";
import type { ConnectionRow, Connections, MembershipRow } from "../../store/connections.ts";
import type { Registry } from "../../store/agents.ts";
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
  [resource]: { id, expires: "2026-09-26T12:00:00.000Z", secret, url: URL_ },
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
  assert(!isTeamsAddress("me@org.com"));
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

Deno.test("teams webhook: a member added, a member gone and a rename are the room's own lines; another system event is none", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    const system = (id: string, eventDetail: Record<string, unknown>) => ({
      id,
      messageType: "systemEventMessage",
      createdDateTime: `2021-02-02T18:0${id}:00.000Z`,
      chatId: CHAT,
      from: null,
      body: { contentType: "html", content: "<systemEventMessage/>" },
      eventDetail,
    });
    const robin = { id: "u-robin", displayName: "Robin Kline" };
    let topic = "ops";
    const fetchApi = graph({
      [`/chats/${CHAT}/messages/1`]: system("1", {
        "@odata.type": "#microsoft.graph.membersAddedEventMessageDetail",
        members: [{ id: "u-bo", displayName: "Bo" }],
        initiator: { user: robin },
      }),
      [`/chats/${CHAT}/messages/2`]: system("2", {
        "@odata.type": "#microsoft.graph.membersLeftEventMessageDetail",
        members: [{ id: "u-bo", displayName: "Bo" }],
        initiator: null,
      }),
      [`/chats/${CHAT}/messages/3`]: system("3", {
        "@odata.type": "#microsoft.graph.chatRenamedEventMessageDetail",
        chatDisplayName: "ops-q4",
        initiator: { user: { id: OID, displayName: "Ana" } },
      }),
      [`/chats/${CHAT}/messages/4`]: system("4", {
        "@odata.type": "#microsoft.graph.callEndedEventMessageDetail",
        initiator: { user: robin },
      }),
      [`/chats/${CHAT}`]: () => Response.json({ chatType: "group", topic, members: [] }),
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
    for (const id of ["1", "2", "3", "4"]) {
      if (id === "3") topic = "ops-q4";
      await handler(notice({
        subscriptionId: "sub-1",
        clientState: "s-sub-1",
        changeType: "created",
        resource: `chats('${CHAT}')/messages('${id}')`,
      }));
    }
    assertEquals(rows.length, 3);
    const [added, gone, renamed] = rows;
    assertEquals(added.envelope, {
      service: "microsoft",
      connection_address: "ana@contoso.com",
      conversation: { address: CHAT, kind: "group", name: "ops" },
      external_id: `teams:${CHAT}:1`,
      sender: { address: "u-robin", name: "Robin Kline" },
    });
    assertEquals(added.ts, "2021-02-02T18:01:00.000Z");
    assertEquals(added.parts, [{
      type: "data",
      kind: "room",
      data: { joined: [{ address: "u-bo", name: "Bo" }] },
    }]);
    assertEquals(gone.envelope.sender, { address: "u-bo", name: "Bo" }); // nobody did it to them
    assertEquals(gone.parts[0], {
      type: "data",
      kind: "room",
      data: { left: [{ address: "u-bo", name: "Bo" }] },
    });
    assertEquals(renamed.agent, { id: "ana" }); // the member renamed it
    assertEquals(renamed.envelope.conversation.name, "ops-q4");
    assertEquals(renamed.parts[0], { type: "data", kind: "room", data: { name: "ops-q4" } });
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
    // a group chat is a `group`: a roster under a topic, not a member-defined pair
    assertEquals(rows[0].envelope.conversation, { address: CHAT, kind: "group", name: "Ops" });

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

/* ── the mind surfaces ───────────────────────────────────────────────────────────── */

const ORG_KEY = "microsoft:org@contoso.com";
const ORG_OID = "4f0c2b1e-0000-4000-8000-00000000a0a0";
const BO_KEY = "microsoft:bo@contoso.com";
const BO_OID = "u-bo";
const DM_SOL = "19:8ea0e38b_50150150@unq.gbl.spaces";
const DM_BO = "19:8ea0e38b_b0b0b0b0@unq.gbl.spaces";
const DM_ORG = "19:4f0c2b1e_50150150@unq.gbl.spaces";
const SELF = "19:8ea0e38b_8ea0e38b@unq.gbl.spaces";
const GROUP = "19:0a1b2c3d4e5f@thread.v2";

/** A second grant beside ana's: `agentId` absent ⇒ an org account. */
async function grantFor(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  key: string,
  oid: string,
  agentId?: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await creds.put({
    key,
    value: { access_token: "eyJ.fresh", refresh_token: "0.r" },
    ...(agentId ? { agentId } : {}),
    extra: {
      client_id: "cid",
      scope: SCOPES,
      oid,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      ...extra,
    },
  });
}

/** The org on a real log: ana's account (hers, declaring sol and bo her principals), bo's
 *  own, and the org's; sol a person alone, ventas an agent with no account. `writes` is
 *  every mind-surface record written on an account row. */
async function withOrg(
  fn: (o: {
    log: Log;
    store:
      & Pick<Connections, "upsertMemberships" | "connection" | "connections" | "upsertConnections">
      & Pick<Registry, "agents">;
    writes: ConnectionRow[];
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await log.syncAgents([
      {
        agentId: "ana",
        mind: "mind@ana",
        email: "ana@contoso.com",
        principals: ["ana", "sol", "bo"],
      },
      { agentId: "bo", mind: "mind@bo", email: "bo@contoso.com" },
      { agentId: "sol", mind: "mind@sol", email: "sol@contoso.com", runs: false },
      { agentId: "ventas", mind: "mind@ventas" },
    ]);
    await log.upsertConnections([
      { service: "microsoft", address: "ana@contoso.com", agentId: "ana", credentialKey: KEY },
      { service: "microsoft", address: "bo@contoso.com", agentId: "bo", credentialKey: BO_KEY },
      { service: "microsoft", address: "org@contoso.com", credentialKey: ORG_KEY },
    ]);
    const writes: ConnectionRow[] = [];
    const store = {
      upsertMemberships: (rows: MembershipRow[]) => log.upsertMemberships(rows),
      connection: (service: string, address: string) => log.connection(service, address),
      connections: () => log.connections(),
      agents: () => log.agents(),
      upsertConnections: (rows: ConnectionRow[]) => {
        writes.push(...rows.filter((r) => r.extra?.mirrors !== undefined));
        return log.upsertConnections(rows);
      },
    };
    await fn({ log, store, writes });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

/** A chat line from `from`, as Graph reads it back. */
const line = (chat: string, id: string, from: string, text = "hola") => ({
  id,
  messageType: "message",
  createdDateTime: `2026-09-23T11:0${id}:00.000Z`,
  chatId: chat,
  from: { user: { id: from } },
  body: { contentType: "text", content: text },
});

/** A notice of `chat`'s message `id`, held by subscription `subId`. */
const told = (subId: string, chat: string, id: string) =>
  notice({
    subscriptionId: subId,
    clientState: `s-${subId}`,
    changeType: "created",
    resource: `chats('${chat}')/messages('${id}')`,
  });

Deno.test("teams surfaces: a principal's DM with an owned account is recorded on its row once, the member found by email or by grant; the owner's own lines, a group chat and an org account record nothing", async () => {
  await withVault(async (creds) => {
    await withOrg(async ({ log, store, writes }) => {
      await grantFor(creds, BO_KEY, BO_OID, "bo", { [TEAMS_SUB]: sub(CHAT_RES, "sub-b") });
      await grantFor(creds, ORG_KEY, ORG_OID, undefined, { [TEAMS_SUB]: sub(CHAT_RES, "sub-o") });
      await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAT_RES, "sub-a") } });
      const ana = { userId: OID, email: "ana@contoso.com" };
      const { publish, rows } = captor();
      const handler = createTeamsWebhook({
        publish,
        creds,
        broker: createGrantBroker({ creds }),
        store,
        save,
        fetchApi: graph({
          // sol has no grant: the chat lists her email, in the case she typed it
          [`/chats/${DM_SOL}`]: {
            chatType: "oneOnOne",
            members: [ana, { userId: "u-sol", email: "Sol@Contoso.com" }],
          },
          [`/chats/${DM_SOL}/messages/1`]: line(DM_SOL, "1", "u-sol"),
          [`/chats/${DM_SOL}/messages/2`]: line(DM_SOL, "2", "u-sol"),
          // bo holds a grant: his account names him, no email needed
          [`/chats/${DM_BO}`]: { chatType: "oneOnOne", members: [ana, { userId: BO_OID }] },
          [`/chats/${DM_BO}/messages/3`]: line(DM_BO, "3", OID),
          [`/chats/${DM_BO}/messages/4`]: line(DM_BO, "4", BO_OID),
          [`/chats/${GROUP}`]: {
            chatType: "group",
            topic: "ops",
            members: [ana, { userId: "u-sol", email: "sol@contoso.com" }],
          },
          [`/chats/${GROUP}/messages/5`]: line(GROUP, "5", "u-sol"),
          [`/chats/${DM_ORG}`]: {
            chatType: "oneOnOne",
            members: [{ userId: ORG_OID }, { userId: "u-sol", email: "sol@contoso.com" }],
          },
          [`/chats/${DM_ORG}/messages/6`]: line(DM_ORG, "6", "u-sol"),
        }),
        now: () => NOW,
      });

      // sol writes to ana's account: found by the email the chat lists, recorded under her
      // name, and her line wears her stamp
      await handler(told("sub-a", DM_SOL, "1"));
      assertEquals(writes, [{
        service: "microsoft",
        address: "ana@contoso.com",
        extra: { mirrors: { dms: { sol: DM_SOL } } },
      }]);
      assertEquals(rows.at(-1)?.agent, { id: "sol" });
      // a second line finds the record holding the chat, and writes nothing
      await handler(told("sub-a", DM_SOL, "2"));
      assertEquals(writes.length, 1);

      // ana's own line in her DM with bo is nothing on her row; on bo's own account it is a
      // member writing to him, recorded there for the view to judge
      await handler(told("sub-a", DM_BO, "3"));
      assertEquals(writes.slice(1), [{
        service: "microsoft",
        address: "bo@contoso.com",
        extra: { mirrors: { dms: { ana: DM_BO } } },
      }]);
      // bo answers, and his own subscription delivers it: the record lands on ana's row
      // all the same, read off the chat's members
      await handler(told("sub-b", DM_BO, "4"));
      assertEquals(writes[2], {
        service: "microsoft",
        address: "ana@contoso.com",
        extra: { mirrors: { dms: { bo: DM_BO } } },
      });

      // a group chat is a room, never a DM; an org account's DMs are the world's
      await handler(told("sub-a", GROUP, "5"));
      await handler(told("sub-o", DM_ORG, "6"));
      assertEquals(writes.length, 3);

      // the view reads sol's and bo's as surfaces of ana's mind; ana is no principal of
      // bo's, so his record of her names nothing
      const aliases = (await log.aliases()).filter((a) => a.service === "microsoft");
      assertEquals(
        aliases.map((a) => [a.conversation, a.agentId, a.principal]).sort(),
        [[DM_BO, "ana", "bo"], [DM_SOL, "ana", "sol"]].sort(),
      );
    });
  });
});

Deno.test("teams surfaces: an owned account's chat with itself is its self-chat, recorded at its first line by the id the notices carry; a send there takes the id its echo comes back with", async () => {
  await withVault(async (creds) => {
    await withOrg(async ({ log, store, writes }) => {
      await grantFor(creds, ORG_KEY, ORG_OID, undefined, { [TEAMS_SUB]: sub(CHAT_RES, "sub-o") });
      await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAT_RES, "sub-a") } });
      const ORG_SELF = "19:4f0c2b1e_4f0c2b1e@unq.gbl.spaces";
      const { publish, rows } = captor();
      const handler = createTeamsWebhook({
        publish,
        creds,
        broker: createGrantBroker({ creds }),
        store,
        save,
        fetchApi: graph({
          [`/chats/${SELF}`]: { chatType: "oneOnOne", members: [{ userId: OID }] },
          [`/chats/${SELF}/messages/1`]: line(SELF, "1", OID, "recordame el informe"),
          [`/chats/${SELF}/messages/77`]: line(SELF, "77", OID, "`[agent]` listo"),
          [`/chats/${ORG_SELF}`]: { chatType: "oneOnOne", members: [{ userId: ORG_OID }] },
          [`/chats/${ORG_SELF}/messages/2`]: line(ORG_SELF, "2", ORG_OID),
        }),
        now: () => NOW,
      });

      await handler(told("sub-a", SELF, "1"));
      assertEquals(writes, [{
        service: "microsoft",
        address: "ana@contoso.com",
        extra: { mirrors: { self: SELF } },
      }]);
      const self = (await log.aliases()).find((a) => a.conversation === SELF);
      assertEquals(self?.agentId, "ana");
      assertEquals(self?.principal, "ana");
      // an org account has no self-chat: nobody's mind is behind it
      await handler(told("sub-o", ORG_SELF, "2"));
      assertEquals(writes.length, 1);

      // the mirror's CC into the self-chat goes out, and the row takes the id the wire
      // gave; the echo the subscription brings back is keyed the same, so the two are one
      const out = fakeLog();
      createTeamsDispatch({
        subscribe: out.subscribe,
        read: out.read,
        setDelivery: out.setDelivery,
        wire: {
          post: () => Promise.resolve({ id: "77", user: OID }),
          amend: () => Promise.resolve(),
          react: () => Promise.resolve(),
        },
      });
      out.push(outbound({
        id: "cc1",
        envelope: {
          service: "microsoft",
          connection_address: "ana@contoso.com",
          conversation: { address: SELF },
          status: "queued",
        },
        parts: [{ type: "text", kind: "text", text: "`[agent]` listo" }],
      }));
      await settle();
      await handler(told("sub-a", SELF, "77"));
      assertEquals(out.patches[0].patch.external_id, `teams:${SELF}:77`);
      assertEquals(rows.at(-1)?.envelope.external_id, `teams:${SELF}:77`);
      assertEquals(rows.at(-1)?.agent, { id: "ana" });
    });
  });
});

Deno.test("teams surfaces: a group chat named as an agent with no account is its steering room on an org account — recorded once by id, let go when the account is out, said in the mind", async () => {
  await withVault(async (creds) => {
    await withOrg(async ({ log, store, writes }) => {
      await grantFor(creds, ORG_KEY, ORG_OID, undefined, { [TEAMS_SUB]: sub(CHAT_RES, "sub-o") });
      await creds.put({ key: KEY, value: {}, extra: { [TEAMS_SUB]: sub(CHAT_RES, "sub-a") } });
      const GROUP2 = "19:9f8e7d6c5b4a@thread.v2";
      const GROUP_ANA = "19:a4a4a4a4a4a4@thread.v2";
      const OWNED = "19:0e0e0e0e0e0e@thread.v2";
      const org = { userId: ORG_OID };
      const sol = { userId: "u-sol", email: "sol@contoso.com" };
      let inGroup = [org, sol];
      const { publish, rows } = captor();
      const handler = createTeamsWebhook({
        publish,
        creds,
        broker: createGrantBroker({ creds }),
        store,
        save,
        fetchApi: graph({
          [`/chats/${GROUP}`]: () =>
            Response.json({ chatType: "group", topic: "ventas", members: inGroup }),
          [`/chats/${GROUP}/messages/1`]: line(GROUP, "1", "u-sol"),
          [`/chats/${GROUP}/messages/2`]: {
            id: "2",
            messageType: "systemEventMessage",
            createdDateTime: "2026-09-23T11:02:00.000Z",
            chatId: GROUP,
            body: { contentType: "html", content: "<systemEventMessage/>" },
            eventDetail: {
              "@odata.type": "#microsoft.graph.membersDeletedEventMessageDetail",
              members: [{ id: ORG_OID, displayName: "Org" }],
              initiator: { user: { id: "u-sol", displayName: "Sol" } },
            },
          },
          [`/chats/${GROUP2}`]: { chatType: "group", topic: "ventas", members: [org, sol] },
          [`/chats/${GROUP2}/messages/3`]: line(GROUP2, "3", "u-sol"),
          [`/chats/${GROUP2}/messages/4`]: line(GROUP2, "4", "u-sol"),
          // ana owns an account: a chat wearing her name is a room like any other
          [`/chats/${GROUP_ANA}`]: { chatType: "group", topic: "ana", members: [org, sol] },
          [`/chats/${GROUP_ANA}/messages/5`]: line(GROUP_ANA, "5", "u-sol"),
          // an owned account in a chat named as the agent hosts no room
          [`/chats/${OWNED}`]: {
            chatType: "group",
            topic: "ventas",
            members: [{ userId: OID }, sol],
          },
          [`/chats/${OWNED}/messages/6`]: line(OWNED, "6", "u-sol"),
        }),
        now: () => NOW,
      });

      // a line in the org account's chat named "ventas": the room is recorded, and the mind
      // is told before the line lands
      await handler(told("sub-o", GROUP, "1"));
      assertEquals(writes, [{
        service: "microsoft",
        address: "org@contoso.com",
        extra: { mirrors: { rooms: { ventas: GROUP } } },
      }]);
      assertEquals(rows.length, 2);
      assertEquals(rows[0].envelope.conversation.address, "mind@ventas");
      assertEquals(rows[0].parts, [
        { type: "data", kind: "room", data: { joined: [{ address: GROUP, name: "ventas" }] } },
      ]);
      const room = (await log.aliases()).find((a) => a.conversation === GROUP);
      assertEquals(room?.agentId, "ventas");
      assertEquals(room?.principal, undefined);

      // a second chat wearing the name, one named for an agent with an account, and an
      // owned account's chat are left alone
      await handler(told("sub-o", GROUP2, "3"));
      await handler(told("sub-o", GROUP_ANA, "5"));
      await handler(told("sub-a", OWNED, "6"));
      assertEquals(writes.length, 1);

      // the org account is taken out: the room is let go, and the mind is told
      inGroup = [sol];
      rows.length = 0;
      await handler(told("sub-o", GROUP, "2"));
      assertEquals(writes[1], {
        service: "microsoft",
        address: "org@contoso.com",
        extra: { mirrors: { rooms: { ventas: null } } },
      });
      assertEquals(rows[0].envelope.conversation.address, "mind@ventas");
      assertEquals(rows[0].parts, [
        { type: "data", kind: "room", data: { left: [{ address: GROUP, name: "ventas" }] } },
      ]);

      // with the record gone, the next chat wearing the name is adopted
      await handler(told("sub-o", GROUP2, "4"));
      assertEquals(writes[2].extra, { mirrors: { rooms: { ventas: GROUP2 } } });
    });
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
      url: URL_,
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
      extra: {
        [TEAMS_SUB]: { [CHAT_RES]: { id: "sub-old", expires: soon, secret: "keep", url: URL_ } },
      },
    });
    await keeper.tick();
    assertEquals(calls.filter((c) => c.init?.method === "PATCH").length, 1);
    let subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES], {
      id: "sub-old",
      expires: "2026-09-26T11:50:00Z",
      secret: "keep",
      url: URL_,
    });

    await creds.put({
      key: KEY,
      value: {},
      extra: {
        [TEAMS_SUB]: {
          [CHAT_RES]: { id: "sub-old", expires: "2026-09-20T00:00:00Z", secret: "gone", url: URL_ },
        },
      },
    });
    await keeper.tick();
    subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES].id, "sub-new");
    assert(subs[CHAT_RES].secret !== "gone");
  });
  // made for another address: Graph would go on delivering there, so it is deleted and
  // one for the org's address made in its place, however fresh the old one was
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const fetchApi = graph({
      "/me/joinedTeams": { value: [] },
      "DELETE /subscriptions/sub-elsewhere": new Response(null, { status: 204 }),
      "POST /subscriptions": { id: "sub-here", expirationDateTime: "2026-09-26T11:50:00Z" },
    }, calls);
    const keeper = createTeamsKeeper({
      creds,
      broker: createGrantBroker({ creds }),
      notificationUrl: URL_,
      fetchApi,
      now: () => NOW,
    });
    const fresh = new Date(Date.parse(NOW) + LIFETIME_MS).toISOString();
    await creds.put({
      key: KEY,
      value: {},
      extra: {
        [TEAMS_SUB]: {
          [CHAT_RES]: {
            id: "sub-elsewhere",
            expires: fresh,
            secret: "old",
            url: "https://old.example/microsoft/ingest",
          },
        },
      },
    });
    await keeper.tick();
    assertEquals(calls.filter((c) => c.init?.method === "DELETE").map((c) => c.path), [
      "/v1.0/subscriptions/sub-elsewhere",
    ]);
    const subs = subsOf(await creds.get(KEY));
    assertEquals(subs[CHAT_RES].id, "sub-here");
    assertEquals(subs[CHAT_RES].url, URL_);
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

Deno.test("teams keeper: a channel named as an agent with no account is its steering room on an org account, adopted from the account's own listing and let go when the listing no longer shows it", async () => {
  await withVault(async (creds) => {
    await withOrg(async ({ log, store, writes }) => {
      await grantFor(creds, ORG_KEY, ORG_OID);
      const VENTAS = "19:7e7e7e7e7e7e7e7e@thread.tacv2";
      let channels = [
        { id: CHANNEL, displayName: "General" },
        { id: VENTAS, displayName: "ventas" },
      ];
      let clock = Date.parse(NOW);
      let n = 0;
      const { publish, rows } = captor();
      const keeper = createTeamsKeeper({
        creds,
        broker: createGrantBroker({ creds }),
        store,
        publish,
        notificationUrl: URL_,
        fetchApi: graph({
          "/me/joinedTeams": { value: [{ id: TEAM, displayName: "Sales" }] },
          [`/teams/${TEAM}/channels`]: () => Response.json({ value: channels }),
          "POST /subscriptions": () =>
            Response.json({ id: `sub-${++n}`, expirationDateTime: "2026-09-26T11:50:00Z" }),
        }),
        now: () => new Date(clock).toISOString(),
        onError: (_k, err) => {
          throw err;
        },
      });

      await keeper.tick();
      // ana's account is hers and hosts no room: only the org's row is written
      assertEquals(writes, [{
        service: "microsoft",
        address: "org@contoso.com",
        extra: { mirrors: { rooms: { ventas: `${TEAM}/${VENTAS}` } } },
      }]);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].envelope.conversation.address, "mind@ventas");
      assertEquals(rows[0].parts, [{
        type: "data",
        kind: "room",
        data: { joined: [{ address: `${TEAM}/${VENTAS}`, name: "Sales / ventas" }] },
      }]);
      const room = (await log.aliases()).find((a) => a.agentId === "ventas");
      assertEquals(room?.conversation, `${TEAM}/${VENTAS}`);

      // within the hour nothing is listed again; past it, the channel is gone
      channels = [{ id: CHANNEL, displayName: "General" }];
      await keeper.tick();
      assertEquals(writes.length, 1);
      clock += 3600_000;
      await keeper.tick();
      assertEquals(writes[1], {
        service: "microsoft",
        address: "org@contoso.com",
        extra: { mirrors: { rooms: { ventas: null } } },
      });
      assertEquals(rows.at(-1)?.parts, [{
        type: "data",
        kind: "room",
        data: { left: [{ address: `${TEAM}/${VENTAS}` }] },
      }]);
      assertEquals((await log.aliases()).find((a) => a.agentId === "ventas"), undefined);
    });
  });
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

/* ── the catch-up ────────────────────────────────────────────────────────────────── */

Deno.test("kindOf: a oneOnOne chat is direct, a group or meeting chat a group; a private channel a group, a standard or shared one a channel", () => {
  assertEquals(kindOf({ chatType: "oneOnOne" }), "direct");
  assertEquals(kindOf({ chatType: "group" }), "group");
  assertEquals(kindOf({ chatType: "meeting" }), "group");
  assertEquals(kindOf({ membershipType: "private" }), "group");
  assertEquals(kindOf({ membershipType: "standard" }), "channel");
  assertEquals(kindOf({ membershipType: "shared" }), "channel");
});

Deno.test("teams catch-up: the gap since the grant's newest Teams row — chats that spoke since, channel chains that moved since — as one live batch; a held message is told its edit, a new one is created, a reply lands under its root; kinds stamped", async () => {
  await withVault(async (creds) => {
    const CHAT2 = "19:7b5c1643d8d74a03afa0af9c02dd0ef2@thread.v2";
    const CHAT3 = "19:1111_2222@unq.gbl.spaces";
    const upn = "ana@contoso.com";
    const held: Event[] = [
      // a mail row, newer than anything Teams — not a Teams row, so not the gap's edge
      {
        id: "m0",
        ts: "2026-09-28T13:00:00.000Z",
        type: "message",
        envelope: {
          service: "microsoft",
          connection_address: upn,
          conversation: { address: "<x@contoso.com>", kind: "group" },
          external_id: "mail:x",
        },
        parts: [],
      } as unknown as Event,
      {
        id: "c1",
        ts: "2026-09-28T12:00:00.000Z",
        type: "message",
        envelope: {
          service: "microsoft",
          connection_address: upn,
          conversation: { address: CHAT, kind: "direct" },
          external_id: `teams:${CHAT}:1`,
        },
        parts: [{ type: "text", kind: "text", text: "old" }],
      } as Event,
      {
        id: "r1",
        ts: "2026-09-28T11:00:00.000Z",
        type: "message",
        envelope: {
          service: "microsoft",
          connection_address: upn,
          conversation: { address: `${TEAM}/${CHANNEL}`, kind: "channel" },
          external_id: `teams:${TEAM}/${CHANNEL}:r1`,
        },
        parts: [{ type: "text", kind: "text", text: "root" }],
      } as Event,
    ];
    const read = (q?: ReadQuery) =>
      Promise.resolve(
        held.filter((r) =>
          (!q?.externalId || r.envelope.external_id === q.externalId) &&
          (!q?.connection || r.envelope.connection_address === q.connection) &&
          (!q?.conversation || r.envelope.conversation.address === q.conversation) &&
          (!q?.filter || q.filter(r))
        ),
      );
    const calls: Call[] = [];
    const fetchApi = graph({
      "/me/chats": {
        value: [
          { id: CHAT, lastMessagePreview: { createdDateTime: "2026-09-28T12:30:00Z" } },
          { id: CHAT2, lastMessagePreview: { createdDateTime: "2026-09-28T12:10:00Z" } },
          // last spoke before the gap: the walk stops here
          { id: CHAT3, lastMessagePreview: { createdDateTime: "2026-09-28T11:00:00Z" } },
        ],
      },
      [`/chats/${CHAT}/messages`]: (c: Call) => {
        assertStringIncludes(
          c.url.search,
          "lastModifiedDateTime%20gt%202026-09-28T12%3A00%3A00.000Z",
        );
        return {
          value: [
            {
              id: "2",
              messageType: "message",
              createdDateTime: "2026-09-28T12:30:00Z",
              lastModifiedDateTime: "2026-09-28T12:30:00Z",
              from: { user: { id: "u-robin", displayName: "Robin" } },
              body: { contentType: "text", content: "new" },
            },
            {
              id: "1",
              messageType: "message",
              createdDateTime: "2026-09-28T11:50:00Z",
              lastModifiedDateTime: "2026-09-28T12:20:00Z",
              lastEditedDateTime: "2026-09-28T12:20:00Z",
              from: { user: { id: "u-robin", displayName: "Robin" } },
              body: { contentType: "text", content: "old, fixed" },
            },
            // deleted, and never heard: nothing to mark
            { id: "0", messageType: "message", deletedDateTime: "2026-09-28T12:05:00Z" },
          ],
        };
      },
      [`/chats/${CHAT}`]: {
        chatType: "oneOnOne",
        members: [{ userId: OID, displayName: "Ana" }, { userId: "u-robin", displayName: "Robin" }],
      },
      [`/chats/${CHAT2}/messages`]: {
        value: [{
          id: "9",
          messageType: "message",
          createdDateTime: "2026-09-28T12:10:00Z",
          lastModifiedDateTime: "2026-09-28T12:10:00Z",
          from: { user: { id: "u-x", displayName: "X" } },
          body: { contentType: "text", content: "ops!" },
        }],
      },
      [`/chats/${CHAT2}`]: { chatType: "group", topic: "Ops", members: [] },
      "/me/joinedTeams": { value: [{ id: TEAM }] },
      [`/teams/${TEAM}/channels`]: { value: [{ id: CHANNEL }] },
      [`/teams/${TEAM}`]: { displayName: "Contoso" },
      [`/teams/${TEAM}/channels/${CHANNEL}`]: { displayName: "leads", membershipType: "private" },
      [`/teams/${TEAM}/channels/${CHANNEL}/messages`]: {
        value: [
          {
            id: "r1",
            messageType: "message",
            createdDateTime: "2026-09-28T10:30:00Z",
            lastModifiedDateTime: "2026-09-28T11:00:00Z",
            from: { user: { id: "u-x", displayName: "X" } },
            body: { contentType: "text", content: "root" },
            replies: [{
              id: "p1",
              replyToId: "r1",
              messageType: "message",
              createdDateTime: "2026-09-28T11:30:00Z",
              lastModifiedDateTime: "2026-09-28T11:30:00Z",
              from: { user: { id: OID, displayName: "Ana" } },
              body: { contentType: "text", content: "reply" },
            }],
          },
          // a chain that last moved before the gap: the walk stops here
          {
            id: "r0",
            messageType: "message",
            createdDateTime: "2026-09-28T09:00:00Z",
            lastModifiedDateTime: "2026-09-28T09:00:00Z",
            body: { contentType: "text", content: "older" },
            replies: [],
          },
        ],
      },
    }, calls);
    const { publish, rows } = captor();
    const stamped: string[] = [];
    const done: [string, number][] = [];
    const catchUp = createTeamsCatchUp({
      publish,
      read,
      creds,
      broker: createGrantBroker({ creds }),
      store: {
        upsertMemberships: () => Promise.resolve(),
        stampKind: (_s, address, kind) => {
          stamped.push(`${address}=${kind}`);
          return Promise.resolve();
        },
      },
      save,
      fetchApi,
      now: () => NOW,
      onCaughtUp: (key, n) => done.push([key, n]),
      onError: (_k, err) => {
        throw err;
      },
    });
    await catchUp.run();

    assertEquals(done, [[KEY, 4]]);
    const by = (id: string) => rows.find((r) => r.envelope.external_id === id)!;
    const fresh = by(`teams:${CHAT}:2`);
    assertEquals(fresh.ts, "2026-09-28T12:30:00Z");
    assertEquals(fresh.envelope.conversation, { address: CHAT, kind: "direct", name: "Robin" });
    assertEquals(fresh.extra, undefined); // live, not history
    const edit = by(`teams:${CHAT}:1:edit:${Date.parse("2026-09-28T12:20:00Z")}`);
    assertEquals(edit.payload, { action: "edit", ref_external_id: `teams:${CHAT}:1` });
    assert(!rows.some((r) => r.envelope.external_id?.startsWith(`teams:${CHAT}:0`)));
    const ops = by(`teams:${CHAT2}:9`);
    assertEquals(ops.envelope.conversation, { address: CHAT2, kind: "group", name: "Ops" });
    const reply = by(`teams:${TEAM}/${CHANNEL}:p1`);
    assertEquals(reply.payload, {
      action: "reply",
      ref_external_id: `teams:${TEAM}/${CHANNEL}:r1`,
    });
    assertEquals(reply.envelope.conversation.kind, "group"); // a private channel
    assertEquals(reply.agent, { id: "ana" });
    assert(!rows.some((r) => r.envelope.external_id === `teams:${TEAM}/${CHANNEL}:r1`)); // held, unmoved
    assertEquals(stamped, [`${CHAT}=direct`, `${CHAT2}=group`, `${TEAM}/${CHANNEL}=group`]);
    assert(!calls.some((c) => c.path.includes(CHAT3))); // never asked
  });
});

Deno.test("teams catch-up: a grant with no Teams row was never heard — nothing is asked", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const { publish, rows } = captor();
    const catchUp = createTeamsCatchUp({
      publish,
      read: () => Promise.resolve([]),
      creds,
      broker: createGrantBroker({ creds }),
      save,
      fetchApi: graph({}, calls),
    });
    await catchUp.run();
    assertEquals(calls, []);
    assertEquals(rows, []);
  });
});
