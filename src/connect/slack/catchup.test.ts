import { assert, assertEquals } from "@std/assert";
import { createSlackCatchUp, type SlackCatchUpDeps, slackLegs } from "./catchup.ts";
import type { SlackWebhookDeps } from "./ingest.ts";
import type { Appender, ReadQuery } from "../../store/log.ts";
import type { EnrollmentRow, MembershipRow } from "../../store/connections.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";

type Call = { method: string; params: Record<string, string>; token: string };

/** The Web API in miniature: answers by `<method>` (or `<method>@<token>` when the token
 *  decides), records every call. A route can be a function of the call. */
function webApi(
  routes: Record<string, unknown | ((c: Call) => unknown | Response)>,
  calls: Call[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: url.pathname.slice("/api/".length),
      params: Object.fromEntries(url.searchParams),
      token: new Headers(init?.headers).get("authorization")?.slice("Bearer ".length) ?? "",
    };
    calls.push(call);
    const route = routes[`${call.method}@${call.token}`] ?? routes[call.method];
    if (route === undefined) return Response.json({ ok: false, error: "unknown_method" });
    const ans = typeof route === "function" ? await (route as (c: Call) => unknown)(call) : route;
    return ans instanceof Response ? ans : Response.json({ ok: true, ...(ans as object) });
  }) as typeof fetch;
}

/** The log in miniature: rows to read back, publishes captured whole (one batch = one call). */
function fakeLog(rows: Event[]) {
  const batches: Draft<MessageEvent>[][] = [];
  const read = (q?: ReadQuery) =>
    Promise.resolve(
      rows.filter((r) =>
        (!q?.connection || r.envelope.connection_address === q.connection) &&
        (!q?.conversation || r.envelope.conversation.address === q.conversation)
      ),
    );
  const publish = ((one: Draft | Draft[]) => {
    const drafts = (Array.isArray(one) ? one : [one]) as Draft<MessageEvent>[];
    batches.push(drafts);
    const stored = drafts.map((e) => ({ ...e, id: newId() } as Event));
    return Promise.resolve(Array.isArray(one) ? stored : stored[0]);
  }) as Appender["publish"];
  return { read, publish, batches };
}

const row = (connection: string, conversation: string, ts: string): Event => ({
  id: newId(),
  ts,
  type: "message",
  envelope: {
    service: "slack",
    connection_address: connection,
    conversation: { address: conversation },
  },
  parts: [{ type: "text", kind: "text", text: "x" }],
} as Event);

function fakeStore(held: EnrollmentRow[] = []) {
  const upserts: MembershipRow[] = [];
  const deletes: MembershipRow[] = [];
  const store: NonNullable<SlackCatchUpDeps["store"]> = {
    connection: (_s, address) =>
      Promise.resolve(address === "T1:U1" ? { service: "slack", address, agentId: "ana" } : null),
    upsertMemberships: (rows) => {
      upserts.push(...rows);
      return Promise.resolve();
    },
    deleteMemberships: (rows) => {
      deletes.push(...rows);
      return Promise.resolve();
    },
    upsertConnections: () => Promise.resolve(),
    memberships: () => Promise.resolve(held),
  };
  return { store, upserts, deletes };
}

const names: NonNullable<SlackWebhookDeps["names"]> = {
  nameOf: (_t, u) => Promise.resolve(u === "U1" ? "Ana" : null),
  emailOf: () => Promise.resolve(null),
  learn: () => {},
  roomOf: (_t, c) => Promise.resolve(c === "C1" ? "general" : null),
  learnRoom: () => {},
};

const legs = () =>
  Promise.resolve(
    new Map([["T1", [
      { token: "xoxp-1", user: "U1", bot: false, owner: "ana" },
      { token: "xoxb-1", user: "UB", bot: true },
    ]]]),
  );

Deno.test("slack catch-up: the gap is read back per room from the log's newest row, threads included, as one live batch anchored as the events would be", async () => {
  // the workspace was last heard at 13:00 (in C5, a room no token lists any more); C1's
  // own newest row is 12:30
  const log = fakeLog([
    row("T1", "connect", "2026-09-28T11:00:00.000Z"),
    row("T1:UB", "C1", "2026-09-28T12:30:00.000Z"),
    row("T1:UB", "C1", "2026-09-28T12:00:00.000Z"),
    row("T1:UB", "C5", "2026-09-28T13:00:00.000Z"),
  ]);
  const { store, upserts, deletes } = fakeStore([
    { service: "slack", connection: "T1", conversation: "C9", agentId: "ana", sessionId: "s" },
    { service: "slack", connection: "T1", conversation: "C1", agentId: "ana", sessionId: "s" },
  ]);
  const calls: Call[] = [];
  let limited = false;
  const t = (iso: string) => (Date.parse(iso) / 1000).toFixed(3);
  const api = webApi({
    // the bot is in C1 (public) and C2 (private); ana in C1 and her DM D1
    "users.conversations@xoxb-1": {
      channels: [{ id: "C1" }, { id: "C2", is_private: true }],
      response_metadata: { next_cursor: "" },
    },
    "users.conversations@xoxp-1": { channels: [{ id: "C1" }, { id: "D1", is_im: true }] },
    "conversations.history": (c: Call) => {
      if (!limited) {
        limited = true;
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      if (c.params.channel === "C1") {
        assertEquals(c.params.oldest, t("2026-09-28T12:30:00.000Z")); // the room's own newest
        return {
          messages: [
            {
              ts: "1790598600.000100",
              user: "U7",
              text: "root",
              reply_count: 2,
              latest_reply: "1790598700.000300",
            },
            { ts: "1790598650.000200", user: "U1", text: "<@U7> mira" },
            { ts: "1790598660.000000", user: "U9", subtype: "channel_join", text: "joined" },
          ],
        };
      }
      assertEquals(c.params.oldest, t("2026-09-28T13:00:00.000Z")); // the workspace's newest
      return c.params.channel === "C2"
        ? { messages: [{ ts: "1790598610.000000", user: "U7", text: "private" }] }
        : { messages: [] };
    },
    "conversations.replies": (c: Call) => {
      assertEquals(c.params.ts, "1790598600.000100");
      return {
        messages: [
          { ts: "1790598600.000100", user: "U7", text: "root", reply_count: 2 },
          { ts: "1790598700.000300", user: "U1", text: "reply", thread_ts: "1790598600.000100" },
        ],
      };
    },
  }, calls);
  const done: [string, number][] = [];
  const catchUp = createSlackCatchUp({
    publish: log.publish,
    read: log.read,
    store,
    names,
    legs,
    api,
    onCaughtUp: (team, n) => done.push([team, n]),
    onError: (_t, err) => {
      throw err;
    },
  });
  await catchUp.run();

  assertEquals(done, [["T1", 5]]);
  assertEquals(log.batches.length, 1); // one batch per workspace
  const by = (id: string) => log.batches[0].find((d) => d.envelope.external_id === id)!;
  const root = by("slack:T1:C1:1790598600.000100");
  assertEquals(root.ts, "2026-09-28T12:30:00.000Z");
  assertEquals(root.envelope.connection_address, "T1:UB"); // the bot is in C1: its anchor
  assertEquals(root.envelope.conversation, { address: "C1", kind: "channel", name: "general" });
  assertEquals((root.extra?.slack as { authorizations: unknown }).authorizations, [
    { user_id: "UB", is_bot: true },
    { user_id: "U1" },
  ]);
  assertEquals(root.extra?.backfill, undefined); // live, not history
  const mention = by("slack:T1:C1:1790598650.000200");
  assertEquals(mention.agent, { id: "ana" }); // the classifier ran
  assertEquals((mention.parts[0] as { text: string }).text, "@U7 mira");
  const reply = by("slack:T1:C1:1790598700.000300");
  assertEquals(reply.payload, {
    action: "reply",
    ref_external_id: "slack:T1:C1:1790598600.000100",
  });
  const priv = by("slack:T1:C2:1790598610.000000");
  assertEquals(priv.envelope.conversation.kind, "group");
  // a join the gap swallowed is read back as the room's own line
  assertEquals(by("slack:T1:C1:1790598660.000000").parts, [
    { type: "data", kind: "room", data: { joined: [{ address: "U9" }] } },
  ]);
  // ana's token lists her rooms: joined C1 and D1, left C9 (the C1 messages' own
  // passive leg enrolls her there again — the same row)
  assertEquals([...new Set(upserts.map((m) => m.conversation))], ["C1", "D1"]);
  assertEquals(deletes.map((m) => m.conversation), ["C9"]);
  // the bot read C1 and C2 (bot first), ana's token her DM; the 429 was waited out
  const history = calls.filter((c) => c.method === "conversations.history");
  assertEquals(history.map((c) => `${c.params.channel}@${c.token}`), [
    "C1@xoxb-1",
    "C1@xoxb-1",
    "C2@xoxb-1",
    "D1@xoxp-1",
  ]);
});

Deno.test("slack catch-up: a workspace with no row was never heard — nothing is asked; a run joins the one in flight", async () => {
  const log = fakeLog([]);
  const calls: Call[] = [];
  const catchUp = createSlackCatchUp({
    publish: log.publish,
    read: log.read,
    legs,
    api: webApi({}, calls),
  });
  const a = catchUp.run();
  const b = catchUp.run();
  assert(a === b);
  await a;
  assertEquals(calls, []);
  assertEquals(log.batches, []);
});

Deno.test("slack catch-up: a refused call is the workspace's failure, said and not spun on", async () => {
  const log = fakeLog([row("T1", "connect", "2026-09-28T11:00:00.000Z")]);
  const errors: string[] = [];
  const catchUp = createSlackCatchUp({
    publish: log.publish,
    read: log.read,
    legs,
    api: webApi({ "users.conversations": { ok: false, error: "missing_scope" } }),
    onError: (team, err) => {
      errors.push(`${team}: ${(err as Error).message}`);
    },
  });
  await catchUp.run();
  assertEquals(errors, ["T1: users.conversations: missing_scope"]);
});

Deno.test("slackLegs: the bot's row and each user grant, by workspace; app and carrier rows are not legs", () => {
  const got = slackLegs([
    { key: "slack:app:A1", value: { client_id: "A1", client_secret: "s" } },
    { key: "slack:socket:A1", value: { app_token: "xapp-1" } },
    { key: "slack:T1:org", value: { token: "xoxb-1" }, extra: { bot_user: "UB" } },
    { key: "slack:T1:ana", value: { token: "xoxp-1" } },
    { key: "slack:T2:bo", value: { token: "xoxp-2" } },
    { key: "slack:T3:org", value: { token: "xoxb-3" } }, // no bot user recorded: not a leg
  ], [
    { service: "slack", address: "T1" },
    { service: "slack", address: "T1:U1", agentId: "ana", credentialKey: "slack:T1:ana" },
    { service: "slack", address: "T2:U2", agentId: "bo", credentialKey: "slack:T2:bo" },
  ]);
  assertEquals([...got.entries()], [
    ["T1", [
      { token: "xoxb-1", user: "UB", bot: true },
      { token: "xoxp-1", user: "U1", bot: false, owner: "ana" },
    ]],
    ["T2", [{ token: "xoxp-2", user: "U2", bot: false, owner: "bo" }]],
  ]);
});
