import { assertEquals, assertRejects } from "@std/assert";
import { whatsappRooms } from "./rooms.ts";
import { DispatchError } from "../errors.ts";

const OWN = "5491100000000";
const GROUP = "120363001234567890@g.us";
const actor = { connection: OWN, agent: "ana" };

interface Call {
  method: string;
  path: string;
  token: string;
  body?: unknown;
}

/** A bridge that answers by `METHOD path`, each call recorded. */
type Route = unknown | ((c: Call) => unknown | Response);
function bridge(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchApi = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
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

Deno.test("whatsapp rooms: open — one person unnamed is their own chat, no call made", async () => {
  const { calls, fetch } = bridge({});
  const port = whatsappRooms("http://b", "tok", fetch);
  assertEquals(
    await port.open!({ ...actor, members: ["5492604586396", OWN], kind: "direct" }),
    { address: "5492604586396", kind: "direct" },
  );
  assertEquals(calls, []);
});

Deno.test("whatsapp rooms: open — a bare list of two, and a `#channel`, are refused with the way in", async () => {
  const { calls, fetch } = bridge({});
  const port = whatsappRooms("http://b", "tok", fetch);
  const list = await assertRejects(
    () => port.open!({ ...actor, members: ["5491", "5492"], kind: "direct" }),
    DispatchError,
    "name it with `subject`",
  );
  assertEquals(list.code, 400);
  const channel = await assertRejects(
    () => port.open!({ ...actor, members: ["5491"], name: "ops", kind: "channel" }),
    DispatchError,
    "groups only",
  );
  assertEquals(channel.code, 400);
  assertEquals(calls, []);
});

Deno.test("whatsapp rooms: open — a named list makes a group on the session, named as the bridge answers", async () => {
  const { calls, fetch } = bridge({
    [`POST /groups/${OWN}`]: {
      address: GROUP,
      name: "Q3 launch",
      members: [{ address: OWN, admin: true }, { address: "5491" }],
    },
  });
  const port = whatsappRooms("http://bridge.local", "tok", fetch);
  assertEquals(
    await port.open!({ ...actor, members: ["5491", "5492"], name: "Q3 launch", kind: "group" }),
    { address: GROUP, kind: "group", name: "Q3 launch" },
  );
  assertEquals(calls[0].token, "tok");
  assertEquals(calls[0].body, { name: "Q3 launch", members: ["5491", "5492"] });
});

Deno.test("whatsapp rooms: members — the roster, named where the bridge names them", async () => {
  const { fetch } = bridge({
    [`GET /groups/${OWN}/${GROUP}`]: {
      address: GROUP,
      name: "ops",
      members: [{ address: OWN, name: "Ana", admin: true }, { address: "5491" }],
    },
  });
  const port = whatsappRooms("http://b", "tok", fetch);
  assertEquals(await port.members!({ ...actor, conversation: GROUP }), [
    { address: OWN, name: "Ana" },
    { address: "5491" },
  ]);
});

Deno.test("whatsapp rooms: add, remove, rename and leave are one call each on the group; no join", async () => {
  const { calls, fetch } = bridge({
    [`POST /groups/${OWN}/${GROUP}/members`]: {},
    [`DELETE /groups/${OWN}/${GROUP}/members`]: {},
    [`PATCH /groups/${OWN}/${GROUP}`]: {},
    [`DELETE /groups/${OWN}/${GROUP}`]: {},
  });
  const port = whatsappRooms("http://b", "tok", fetch);
  const at = { ...actor, conversation: GROUP };
  await port.add!({ ...at, members: ["5491", "5492"] });
  await port.remove!({ ...at, members: ["5491"] });
  await port.rename!({ ...at, name: "ops 2" });
  await port.leave!(at);
  assertEquals(calls.map((c) => [c.method, c.path, c.body]), [
    ["POST", `/groups/${OWN}/${GROUP}/members`, { members: ["5491", "5492"] }],
    ["DELETE", `/groups/${OWN}/${GROUP}/members`, { members: ["5491"] }],
    ["PATCH", `/groups/${OWN}/${GROUP}`, { name: "ops 2" }],
    ["DELETE", `/groups/${OWN}/${GROUP}`, undefined],
  ]);
  assertEquals(port.join, undefined);
});

Deno.test("whatsapp rooms: the bridge's refusal is the call's failure, class and all", async () => {
  const { fetch } = bridge({
    [`POST /groups/${OWN}/${GROUP}/members`]: () =>
      new Response(
        "not added — 5491: 403 (their settings keep strangers from adding them — they join by invite)",
        { status: 422 },
      ),
    [`DELETE /groups/${OWN}/${GROUP}`]: () =>
      new Response("session not connected", { status: 503 }),
  });
  const port = whatsappRooms("http://b", "tok", fetch);
  const at = { ...actor, conversation: GROUP };
  const add = await assertRejects(
    () => port.add!({ ...at, members: ["5491"] }),
    DispatchError,
    "join by invite",
  );
  assertEquals(add.code, 422);
  const leave = await assertRejects(() => port.leave!(at), DispatchError, "HTTP 503");
  assertEquals(leave.code, 503);
});
