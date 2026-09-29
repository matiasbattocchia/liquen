import { assert, assertEquals, assertRejects } from "@std/assert";
import { teamsChannelName, teamsRooms, teamsTopic } from "./rooms.ts";
import { DispatchError } from "../errors.ts";

const OID = "oid-ana";
const UPN = "ana@contoso.com";
const KEY = `microsoft:${UPN}`;
const TEAM = "team-1";
const CHANNEL = "19:chan@thread.tacv2";
const CHAT = "19:chat@thread.v2";

interface Call {
  method: string;
  path: string;
  token: string;
  body?: unknown;
}

/** A Graph that answers by `METHOD path` (after `/v1.0`), each call recorded. */
type Route = unknown | ((c: Call) => unknown | Response);
function graph(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchApi = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname).slice("/v1.0".length) + url.search,
      token: new Headers(init?.headers).get("authorization")!.replace("Bearer ", ""),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) return new Response("not found", { status: 404 });
    const ans = typeof route === "function" ? await (route as (c: Call) => unknown)(call) : route;
    return ans instanceof Response ? ans : Response.json(ans);
  }) as typeof fetch;
  return { calls, fetch: fetchApi };
}

const deps = {
  broker: {
    issue: (key: string) => `h:${key}`,
    accessTokenFor: (handle: string) => Promise.resolve(handle === `h:${KEY}` ? "eyJ.ana" : null),
  },
  creds: {
    get: (key: string) =>
      Promise.resolve(
        key === KEY
          ? { key, value: {}, extra: { oid: OID }, created_at: "", updated_at: "" }
          : null,
      ),
  },
};
const actor = { connection: UPN, agent: "ana" };
const bind = (id: string) => `https://graph.microsoft.com/v1.0/users('${id}')`;

Deno.test("teams rooms: open — one person is the oneOnOne chat, found or made, with the member in it", async () => {
  const { calls, fetch } = graph({ "POST /chats": { id: CHAT, chatType: "oneOnOne" } });
  const port = teamsRooms({ ...deps, fetch });

  const opened = await port.open!({ ...actor, members: ["u-bob", OID], kind: "direct" });
  assertEquals(opened, { address: CHAT, kind: "direct" });
  assertEquals(calls[0].token, "eyJ.ana");
  assertEquals(calls[0].body, {
    chatType: "oneOnOne",
    members: [
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": bind(OID),
      },
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": bind("u-bob"),
      },
    ],
  });

  // a list of two with no name has no room of its own on Teams
  const err = await assertRejects(
    () => port.open!({ ...actor, members: ["u-bob", "u-cy"], kind: "direct" }),
    DispatchError,
    "one to one",
  );
  assertEquals(err.code, 400);
  assertEquals(calls.length, 1);
});

Deno.test("teams rooms: open — a named group is a group chat under its topic, a #Team / Channel a standard channel in that team", async () => {
  const { calls, fetch } = graph({
    "POST /chats": (c: Call) => ({ id: CHAT, topic: (c.body as { topic: string }).topic }),
    "GET /me/joinedTeams": {
      value: [{ id: "team-0", displayName: "Sales" }, { id: TEAM, displayName: "Ops" }],
    },
    [`POST /teams/${TEAM}/channels`]: (c: Call) => ({
      id: CHANNEL,
      displayName: (c.body as { displayName: string }).displayName,
    }),
  });
  const port = teamsRooms({ ...deps, fetch });

  const group = await port.open!({
    ...actor,
    members: ["u-bob", "u-cy"],
    name: "Q3: launch",
    kind: "group",
  });
  assertEquals(group, { address: CHAT, kind: "group", name: "Q3 launch" });
  const made = calls[0].body as { chatType: string; topic: string; members: unknown[] };
  assertEquals(made.chatType, "group");
  assertEquals(made.topic, "Q3 launch");
  assertEquals(made.members.length, 3); // the member first, then the two named

  const channel = await port.open!({
    ...actor,
    members: ["u-bob"],
    name: "ops / Incidents",
    kind: "channel",
  });
  assertEquals(channel, {
    address: `${TEAM}/${CHANNEL}`,
    kind: "channel",
    name: "Ops / Incidents",
  });
  assertEquals(calls.at(-1)!.body, { displayName: "Incidents", membershipType: "standard" });

  // a channel named without its team, or in a team the member is not in
  await assertRejects(
    () => port.open!({ ...actor, members: [], name: "Incidents", kind: "channel" }),
    DispatchError,
    "`#Team / Channel`",
  );
  const missing = await assertRejects(
    () => port.open!({ ...actor, members: [], name: "Legal / Incidents", kind: "channel" }),
    DispatchError,
    'no team named "Legal"',
  );
  assertEquals(missing.code, 404);
});

Deno.test("teams rooms: members, add, remove, leave, rename — the chat legs and the channel legs", async () => {
  const members = [
    { id: "m-ana", userId: OID, displayName: "Ana" },
    { id: "m-bob", userId: "u-bob", displayName: "Bob" },
    { id: "m-bot", displayName: "A bot" },
  ];
  const { calls, fetch } = graph({
    [`GET /chats/${CHAT}/members`]: {
      value: members.slice(0, 1),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/chats/${CHAT}/members?$skiptoken=2`,
    },
    [`GET /chats/${CHAT}/members?$skiptoken=2`]: { value: members.slice(1) },
    [`GET /teams/${TEAM}/channels/${CHANNEL}/members`]: { value: members },
    [`POST /chats/${CHAT}/members`]: () => new Response(null, { status: 201 }),
    [`POST /teams/${TEAM}/channels/${CHANNEL}/members`]: () => new Response(null, { status: 201 }),
    [`DELETE /chats/${CHAT}/members/m-bob`]: () => new Response(null, { status: 204 }),
    [`DELETE /teams/${TEAM}/channels/${CHANNEL}/members/m-ana`]: () =>
      new Response(null, { status: 204 }),
    [`PATCH /chats/${CHAT}`]: () => new Response(null, { status: 204 }),
    [`PATCH /teams/${TEAM}/channels/${CHANNEL}`]: () => new Response(null, { status: 204 }),
  });
  const port = teamsRooms({ ...deps, fetch });

  // a paged roster is walked to its end; a member with no user id (an app) is not a person
  const chatRoster = await port.members!({ ...actor, conversation: CHAT });
  assertEquals(chatRoster, [{ address: OID, name: "Ana" }, { address: "u-bob", name: "Bob" }]);
  const channelRoster = await port.members!({ ...actor, conversation: `${TEAM}/${CHANNEL}` });
  assertEquals(channelRoster, [{ address: OID, name: "Ana" }, { address: "u-bob", name: "Bob" }]);

  await port.add!({ ...actor, conversation: CHAT, members: ["u-cy"] });
  assertEquals(calls.at(-1)!.body, {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: ["owner"],
    "user@odata.bind": bind("u-cy"),
    visibleHistoryStartDateTime: "0001-01-01T00:00:00Z",
  });
  await port.add!({ ...actor, conversation: `${TEAM}/${CHANNEL}`, members: ["u-cy"] });
  assertEquals(calls.at(-1)!.body, {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: [],
    "user@odata.bind": bind("u-cy"),
  });

  await port.remove!({ ...actor, conversation: CHAT, members: ["u-bob"] });
  assertEquals(calls.at(-1)!.method, "DELETE");
  assertEquals(calls.at(-1)!.path, `/chats/${CHAT}/members/m-bob`);
  const gone = await assertRejects(
    () => port.remove!({ ...actor, conversation: CHAT, members: ["u-zed"] }),
    DispatchError,
    "u-zed is not in the room",
  );
  assertEquals(gone.code, 404);

  await port.leave!({ ...actor, conversation: `${TEAM}/${CHANNEL}` });
  assertEquals(calls.at(-1)!.path, `/teams/${TEAM}/channels/${CHANNEL}/members/m-ana`);

  await port.rename!({ ...actor, conversation: CHAT, name: "Q4: launch" });
  assertEquals(calls.at(-1)!.body, { topic: "Q4 launch" });
  await port.rename!({ ...actor, conversation: `${TEAM}/${CHANNEL}`, name: "#Incidents & Alerts" });
  assertEquals(calls.at(-1)!.body, { displayName: "Incidents Alerts" });

  assert(port.join === undefined);
});

Deno.test("teams rooms: a 403 names the permission the leg needs; another refusal keeps Graph's word and status", async () => {
  const { fetch } = graph({
    "POST /chats": () =>
      Response.json({ error: { code: "Forbidden", message: "Missing scope" } }, { status: 403 }),
    [`PATCH /chats/${CHAT}`]: () =>
      Response.json({ error: { code: "BadRequest", message: "topic on oneOnOne" } }, {
        status: 400,
      }),
  });
  const port = teamsRooms({ ...deps, fetch });

  const lacks = await assertRejects(
    () => port.open!({ ...actor, members: ["u-bob"], kind: "direct" }),
    DispatchError,
    "chat: the grant lacks Chat.Create; it gains the permission by signing in again",
  );
  assertEquals(lacks.code, 403);

  const bad = await assertRejects(
    () => port.rename!({ ...actor, conversation: CHAT, name: "x" }),
    DispatchError,
    "chat rename: HTTP 400",
  );
  assertEquals(bad.code, 400);

  // an account the vault has no grant for
  const nobody = await assertRejects(
    () => port.members!({ connection: "bo@contoso.com", agent: "bo", conversation: CHAT }),
    DispatchError,
    "no access token for microsoft:bo@contoso.com",
  );
  assertEquals(nobody.code, 401);
});

Deno.test("teams rooms: a topic and a channel name as Graph takes them", () => {
  assertEquals(teamsTopic("  Q3:  launch : plan "), "Q3 launch plan");
  assertEquals(teamsTopic("x".repeat(300)).length, 250);
  assertEquals(teamsChannelName("#Ops / Incidents?"), "Ops Incidents");
  assertEquals(teamsChannelName("_.hidden"), "hidden");
  assertEquals(teamsChannelName("a".repeat(60)).length, 50);
});
