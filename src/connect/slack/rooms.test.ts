import { assert, assertEquals, assertRejects } from "@std/assert";
import { slackChannelName, slackRooms } from "./rooms.ts";
import { DispatchError } from "../errors.ts";

interface Call {
  method: string;
  token: string;
  params: Record<string, string>;
}

/** A Slack that answers by method: each call recorded, the answer scripted. */
function fakeSlack(
  answer: (method: string, params: Record<string, string>) => unknown,
) {
  const calls: Call[] = [];
  const fetchApi = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const params = Object.fromEntries(new URLSearchParams(init?.body as string));
    const auth = (init?.headers as Record<string, string>).authorization;
    calls.push({ method, token: auth.replace("Bearer ", ""), params });
    return Promise.resolve(Response.json(answer(method, params)));
  }) as typeof fetch;
  return { calls, fetch: fetchApi };
}

const tokens: Record<string, string> = { "T1:a1": "xoxp-a1" };
const tokenFor = (connection: string, author?: string) =>
  Promise.resolve(tokens[`${connection}:${author}`] ?? "xoxb-org");

Deno.test("slack rooms: open — a direct room is conversations.open, a named one is created and its people invited", async () => {
  const { calls, fetch } = fakeSlack((method, params) => {
    if (method === "conversations.open") return { ok: true, channel: { id: "D1" } };
    if (method === "conversations.create") {
      return { ok: true, channel: { id: "C9", name: params.name } };
    }
    return { ok: true };
  });
  const port = slackRooms({ tokenFor, fetch });

  const direct = await port.open!({
    connection: "T1",
    agent: "a1",
    members: ["U1", "U2"],
    kind: "direct",
  });
  assertEquals(direct, { address: "D1", kind: "direct" });
  assertEquals(calls[0], {
    method: "conversations.open",
    token: "xoxp-a1", // the agent's own grant opens it — the one that posts in it
    params: { users: "U1,U2" },
  });

  const channel = await port.open!({
    connection: "T1",
    agent: "b2",
    members: ["U1"],
    name: "Ops Room",
    kind: "channel",
  });
  // the name comes back as Slack spelled it, which is what the send lands under
  assertEquals(channel, { address: "C9", kind: "channel", name: "ops-room" });
  assertEquals(calls[1], {
    method: "conversations.create",
    token: "xoxb-org", // no grant of b2's: the workspace bot
    params: { name: "ops-room", is_private: "false" },
  });
  assertEquals(calls[2], {
    method: "conversations.invite",
    token: "xoxb-org",
    params: { channel: "C9", users: "U1" },
  });

  await port.open!({ connection: "T1", agent: "a1", members: [], name: "ops", kind: "group" });
  assertEquals(calls[3].params, { name: "ops", is_private: "true" });
  assertEquals(calls.length, 4); // nobody to invite: no invite call
});

Deno.test("slack rooms: members pages through the roster; the verbs are one call each, a kick one a person", async () => {
  const { calls, fetch } = fakeSlack((method, params) => {
    if (method === "conversations.members") {
      return params.cursor
        ? { ok: true, members: ["U3"], response_metadata: { next_cursor: "" } }
        : { ok: true, members: ["U1", "U2"], response_metadata: { next_cursor: "p2" } };
    }
    return { ok: true };
  });
  const port = slackRooms({ tokenFor, fetch });
  const at = { connection: "T1", agent: "a1", conversation: "C1" };

  assertEquals(await port.members!(at), [{ address: "U1" }, { address: "U2" }, { address: "U3" }]);
  assertEquals(calls.map((c) => c.params), [
    { channel: "C1", limit: "200" },
    { channel: "C1", limit: "200", cursor: "p2" },
  ]);
  calls.length = 0;

  await port.join!(at);
  await port.leave!(at);
  await port.add!({ ...at, members: ["U4", "U5"] });
  await port.remove!({ ...at, members: ["U4", "U5"] });
  await port.rename!({ ...at, name: "#Ops Room" });
  assertEquals(calls.map((c) => [c.method, c.params]), [
    ["conversations.join", { channel: "C1" }],
    ["conversations.leave", { channel: "C1" }],
    ["conversations.invite", { channel: "C1", users: "U4,U5" }],
    ["conversations.kick", { channel: "C1", user: "U4" }],
    ["conversations.kick", { channel: "C1", user: "U5" }],
    ["conversations.rename", { channel: "C1", name: "ops-room" }],
  ]);
  assert(calls.every((c) => c.token === "xoxp-a1"));
});

Deno.test("slack rooms: a leg the grant cannot do refuses by naming the scope; the wire's other answers pass through", async () => {
  const { fetch } = fakeSlack((method) => {
    if (method === "conversations.invite") {
      return {
        ok: false,
        error: "missing_scope",
        needed: "channels:write.invites",
        provided: "chat:write",
      };
    }
    if (method === "conversations.open") return { ok: false, error: "too_many_users" };
    return { ok: true };
  });
  const port = slackRooms({ tokenFor, fetch });
  const err = await assertRejects(
    () => port.add!({ connection: "T1", agent: "a1", conversation: "C1", members: ["U4"] }),
    DispatchError,
    "conversations.invite: missing_scope — the grant lacks channels:write.invites; it gains the scope by signing in again",
  );
  assertEquals(err.code, 400); // a named refusal: the same call is refused again
  const other = await assertRejects(
    () => port.open!({ connection: "T1", agent: "a1", members: ["U1"], kind: "direct" }),
    DispatchError,
    "conversations.open: too_many_users",
  );
  assertEquals(other.code, 400);
});

Deno.test("slack rooms: a channel name as Slack takes one", () => {
  assertEquals(slackChannelName("#Ops Room"), "ops-room");
  assertEquals(slackChannelName("ventas_2026 — Q4"), "ventas_2026-q4");
  assertEquals(slackChannelName("x".repeat(90)).length, 80);
});
