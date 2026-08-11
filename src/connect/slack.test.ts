import { assertEquals, assertStringIncludes } from "@std/assert";
import { createSlackWebhook, type SlackWebhookDeps, type WebhookHandler } from "./slack.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";
import { newId } from "../store/id.ts";
import type { Appender } from "../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../store/connections.ts";

const SECRET = "sl-s3cret";
const enc = new TextEncoder();

/** The classifier + mirror seam in miniature: an owned connection in, membership traffic out. */
function fakeStore(conn: ConnectionRow) {
  const upserts: MembershipRow[] = [];
  const deletes: MembershipRow[] = [];
  const store: NonNullable<SlackWebhookDeps["store"]> = {
    connection: (service, address) =>
      conn.service === service && conn.address === address ? conn : null,
    upsertMemberships: (rows) => upserts.push(...rows),
    deleteMemberships: (rows) => deletes.push(...rows),
  };
  return { store, upserts, deletes };
}

/** Sign a body the way Slack does: v0=<hmac(v0:ts:body)>. */
async function sign(ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`));
  return `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function harness(
  secret?: string,
  store?: SlackWebhookDeps["store"],
  media?: SlackWebhookDeps["media"],
) {
  const published: Event[] = [];
  const handler: WebhookHandler = createSlackWebhook({
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    store,
    media,
    signingSecret: secret,
  });
  return { handler, published };
}

async function signedReq(payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("http://localhost/", {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await sign(ts, body),
    },
  });
}

const messageEvent = (over: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T1",
  authorizations: [{ user_id: "U1" }, { user_id: "U2" }],
  event: {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U7",
    text: "hola equipo",
    ts: "111.222",
  },
  ...over,
});

Deno.test("slack: url_verification echoes the challenge, never touches the log", async () => {
  const { handler, published } = harness(SECRET);
  const res = await handler(await signedReq({ type: "url_verification", challenge: "chz" }));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "chz");
  assertEquals(published.length, 0);
});

Deno.test("slack: a signed message maps to a bare channel address with the ts merge key", async () => {
  const { handler, published } = harness(SECRET);
  const res = await handler(await signedReq(messageEvent()));
  assertEquals(res.status, 202);
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.service, "slack");
  assertEquals(m.envelope.conversation.address, "C1");
  assertEquals(m.envelope.conversation.kind, "channel"); // stamped from channel_type (§4)
  assertEquals(m.envelope.external_id, "slack:T1:C1:111.222");
  assertEquals(m.envelope.sender?.address, "U7");
  assertEquals((m.parts[0] as { text: string }).text, "hola equipo");
  assertEquals((m.extra?.slack as { authorizations: unknown }).authorizations, [
    { user_id: "U1" },
    { user_id: "U2" },
  ]);
});

Deno.test("slack: message_changed carries the SAME external_id — an edit merges, never inserts", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { ts: "111.222", user: "U7", text: "hola equipo (edited)" },
      },
    })),
  );
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.external_id, "slack:T1:C1:111.222"); // same row at the store
  assertEquals((m.parts[0] as { text: string }).text, "hola equipo (edited)");
});

Deno.test("slack: a bad signature is rejected before the log", async () => {
  const { handler, published } = harness(SECRET);
  const body = JSON.stringify(messageEvent());
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
    }),
  );
  assertEquals(res.status, 401);
  assertEquals(published.length, 0);
});

Deno.test("slack: a stale timestamp is rejected (replay guard)", async () => {
  const { handler, published } = harness(SECRET);
  const body = JSON.stringify(messageEvent());
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: { "x-slack-request-timestamp": old, "x-slack-signature": await sign(old, body) },
    }),
  );
  assertEquals(res.status, 401);
  assertEquals(published.length, 0);
});

Deno.test("slack: membership events move the map store-side, never the log", async () => {
  const { handler, published } = harness(SECRET); // no store: acked, nothing else
  const res = await handler(
    await signedReq(messageEvent({
      event: { type: "member_joined_channel", channel: "C1", user: "U9", team: "T1" },
    })),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 0);
});

Deno.test("slack: channel_type stamps conversation.kind — im/mpim are direct (§4)", async () => {
  for (
    const [channel_type, kind] of [
      ["im", "direct"],
      ["mpim", "direct"],
      ["group", "group"],
      ["channel", "channel"],
    ]
  ) {
    const { handler, published } = harness(SECRET);
    await handler(
      await signedReq(messageEvent({
        event: { type: "message", channel: "C1", channel_type, user: "U7", text: "x", ts: "1.2" },
      })),
    );
    assertEquals((published[0] as MessageEvent).envelope.conversation.kind, kind);
  }
});

Deno.test("slack: a bound sender classifies — named, enrolled; the anchor is the WORKSPACE", async () => {
  const { store, upserts } = fakeStore({
    // the paste door's write: the user GRANT `<team>:<user>` — the identity map
    service: "slack",
    address: "T1:U7",
    agentId: "matias",
  });
  const { handler, published } = harness(SECRET, store);
  await handler(await signedReq(messageEvent({ authorizations: [{ user_id: "U7" }] })));

  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.connection_address, "T1"); // events anchor to the workspace (§4)
  assertEquals(m.envelope.sender, { address: "U7", name: "matias" }); // wire id stays honest
  assertEquals((m.extra?.slack as { authorizations: unknown }).authorizations, [
    { user_id: "U7" },
  ]);
  assertEquals(m.envelope.external_id, "slack:T1:C1:111.222");
  // the passive mirror: the delivery proves its authorized user is in the conversation
  assertEquals(upserts, [
    { service: "slack", connection: "T1", conversation: "C1", agentId: "matias" },
  ]);
});

Deno.test("slack: an unbound sender stays unclassified; the authorized grant still enrolls", async () => {
  const { store, upserts } = fakeStore({
    service: "slack",
    address: "T1:U7",
    agentId: "matias",
  });
  const { handler, published } = harness(SECRET, store);
  await handler(
    await signedReq(messageEvent({
      authorizations: [{ user_id: "U7" }],
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U2",
        text: "hola",
        ts: "3.4",
      },
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.sender, { address: "U2" }); // no name — the sender isn't ours
  // the delivery itself proves the authorized user sees this conversation
  assertEquals(upserts, [
    { service: "slack", connection: "T1", conversation: "C1", agentId: "matias" },
  ]);
});

Deno.test("slack: a fully unbound delivery maps purely — no verdict, no membership", async () => {
  const { store, upserts } = fakeStore({
    service: "slack",
    address: "T1:U7",
    agentId: "matias",
  });
  const { handler, published } = harness(SECRET, store);
  // someone else's app delivered this copy: U2 has no grant row, sender unbound
  await handler(
    await signedReq(messageEvent({
      authorizations: [{ user_id: "U2" }],
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U2",
        text: "x",
        ts: "9.9",
      },
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.connection_address, "T1"); // the workspace, whoever delivered
  assertEquals(m.envelope.sender, { address: "U2" });
  assertEquals(upserts, []);
});

Deno.test("slack: a bot-witnessed delivery anchors to the BOT's grant — the shared inbox (§4)", async () => {
  const { store, upserts } = fakeStore({
    service: "slack",
    address: "T1:U7",
    agentId: "matias",
  });
  const { handler, published } = harness(SECRET, store);
  await handler(
    await signedReq(messageEvent({
      authorizations: [{ user_id: "UBOT", is_bot: true }, { user_id: "U7" }],
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.connection_address, "T1:UBOT"); // the workspace reads as the org here
  assertEquals(m.envelope.sender, { address: "U7", name: "matias" });
  // the bound human still enrolls (under the workspace); the bot never does — not an agent
  assertEquals(upserts, [
    { service: "slack", connection: "T1", conversation: "C1", agentId: "matias" },
  ]);
});

Deno.test("slack: one shared-app delivery enrolls EVERY bound grant (§4 passive mirror)", async () => {
  const rows = [
    { service: "slack", address: "T1:U7", agentId: "matias" },
    { service: "slack", address: "T1:U9", agentId: "ana" },
  ];
  const upserts: MembershipRow[] = [];
  const store: NonNullable<SlackWebhookDeps["store"]> = {
    connection: (service, address) =>
      rows.find((r) => r.service === service && r.address === address) ?? null,
    upsertMemberships: (r) => upserts.push(...r),
    deleteMemberships: () => {},
  };
  const { handler } = harness(SECRET, store);
  // ONE copy (one app, two grants): both principals are authorized, U2 is nobody's
  await handler(
    await signedReq(messageEvent({
      authorizations: [{ user_id: "U7" }, { user_id: "U9" }, { user_id: "U2" }],
    })),
  );
  assertEquals(upserts, [
    { service: "slack", connection: "T1", conversation: "C1", agentId: "matias" },
    { service: "slack", connection: "T1", conversation: "C1", agentId: "ana" },
  ]);
});

Deno.test("slack: member_joined/left mirror bound users; a leave revokes (§6 live policy)", async () => {
  const { store, upserts, deletes } = fakeStore({
    service: "slack",
    address: "T1:U9",
    agentId: "ana",
  });
  const { handler, published } = harness(SECRET, store);
  const row = { service: "slack", connection: "T1", conversation: "C1", agentId: "ana" };
  const auths = [{ user_id: "U9" }];

  await handler(
    await signedReq(messageEvent({
      authorizations: auths,
      event: { type: "member_joined_channel", channel: "C1", user: "U9", team: "T1" },
    })),
  );
  assertEquals(upserts, [row]);

  await handler(
    await signedReq(messageEvent({
      authorizations: auths,
      event: { type: "member_left_channel", channel: "C1", user: "U9", team: "T1" },
    })),
  );
  assertEquals(deletes, [row]);

  // someone ELSE joining is that leg's fact, not this one's — nothing moves here
  await handler(
    await signedReq(messageEvent({
      authorizations: auths,
      event: { type: "member_joined_channel", channel: "C1", user: "U404", team: "T1" },
    })),
  );
  assertEquals(upserts.length, 1);
  assertEquals(published.length, 0); // membership traffic never touches the log
});

Deno.test("slack: unsigned accepted when no secret (the Socket Mode carrier path)", async () => {
  const { handler, published } = harness(); // no secret — carrier already authed by xapp
  const res = await handler(
    new Request("http://localhost/", { method: "POST", body: JSON.stringify(messageEvent()) }),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 1);
});

Deno.test("slack: file attachments land through the media seam — file-only messages publish", async () => {
  const fetched: { file: unknown; ctx: unknown }[] = [];
  const media: SlackWebhookDeps["media"] = (file, ctx) => {
    fetched.push({ file, ctx });
    return Promise.resolve({
      type: "file",
      kind: "image",
      file: { mime_type: "image/png", uri: "/data/conversations/C1/media/ab12.png", size: 3 },
    });
  };
  const { handler, published } = harness(SECRET, undefined, media);
  const res = await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "", // caption-less share: the file alone is the message
        ts: "333.444",
        files: [{ id: "F1", name: "shot.png", mimetype: "image/png", url_private: "https://x/y" }],
      },
    })),
  );
  assertEquals(res.status, 202);
  const m = published[0] as MessageEvent;
  assertEquals(m.parts.length, 1); // no empty text part
  assertEquals(m.parts[0].type, "file");
  assertEquals((m.parts[0] as { file: { uri: string } }).file.uri.endsWith("ab12.png"), true);
  assertEquals(m.envelope.external_id, "slack:T1:C1:333.444"); // same merge key as any message
  // the seam got the delivery's authorized users — the token-resolution candidates
  assertEquals((fetched[0].ctx as { users: string[] }).users, ["U1", "U2"]);
});

Deno.test("slack: a failed download drops the file, keeps the text; no media seam ⇒ text only", async () => {
  const media: SlackWebhookDeps["media"] = () => Promise.resolve(null);
  const { handler, published } = harness(SECRET, undefined, media);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "mira esto",
        ts: "555.666",
        files: [{ id: "F1", name: "shot.png", mimetype: "image/png", url_private: "https://x/y" }],
      },
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.parts.length, 1);
  assertEquals((m.parts[0] as { text: string }).text, "mira esto");
});

Deno.test("slack: message_deleted is merge-only — no parts, deleted_at in extra", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "111.222",
        event_ts: "111.999",
      },
    })),
  );
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.external_id, "slack:T1:C1:111.222"); // the deleted row's key
  assertEquals("parts" in m, false); // the json_patch no-op — stored parts survive (§3)
  assertEquals((m.extra?.slack as { deleted_at: string }).deleted_at, "111.999");
});
