import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createSlackWebhook,
  httpSigningSecrets,
  looksLikeSignIn,
  slackNames,
  slackSocket,
  type SlackWebhookDeps,
  type WebhookHandler,
} from "./ingest.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";

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

/** The name directory in miniature: a seeded map, learns recorded. */
function fakeNames(seed: Record<string, string> = {}) {
  const known = new Map(Object.entries(seed)); // key: `${team}:${user}`
  const learned: string[] = [];
  const names: NonNullable<SlackWebhookDeps["names"]> = {
    nameOf: (team, user) => Promise.resolve(known.get(`${team}:${user}`) ?? null),
    learn: (team, user, name) => {
      known.set(`${team}:${user}`, name);
      learned.push(`${team}:${user}=${name}`);
    },
  };
  return { names, learned };
}

function harness(
  secret?: string,
  store?: SlackWebhookDeps["store"],
  media?: SlackWebhookDeps["media"],
  names?: SlackWebhookDeps["names"],
  publish?: Appender["publish"],
) {
  const published: Event[] = [];
  const work: Promise<void>[] = [];
  const raw: WebhookHandler = createSlackWebhook({
    // the store's `publish` in miniature: it mints ids (§3), both overloads
    publish: publish ?? (((one: Draft | Draft[]) => {
      const drafts = Array.isArray(one) ? one : [one];
      const stored = drafts.map((e) => ({ ...e, id: e.id ?? newId() } as Event));
      published.push(...stored);
      return Promise.resolve(Array.isArray(one) ? stored : stored[0]);
    }) as Appender["publish"]),
    store,
    media,
    names,
    ...(secret ? { signingSecrets: [secret] } : {}),
    track: (w) => work.push(w),
  });
  // the acked delivery keeps processing behind the response — `handler` settles it too,
  // so a test reads the log after the whole delivery; `raw` is the wire's view
  const handler: WebhookHandler = async (req) => {
    const res = await raw(req);
    await Promise.all(work);
    return res;
  };
  return { handler, raw, published };
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
  assertEquals(res.status, 200);
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

Deno.test("slack: message_changed is its OWN event — action edit + ref to the original", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        event_ts: "111.900",
        message: {
          ts: "111.222",
          user: "U7",
          text: "hola equipo (edited)",
          edited: { user: "U7", ts: "111.900" },
        },
        previous_message: { ts: "111.222", user: "U7", text: "hola equipo" },
      },
    })),
  );
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.external_id, "slack:T1:C1:111.900"); // its OWN identity
  assertEquals(m.payload?.action, "edit");
  assertEquals(m.payload?.ref_external_id, "slack:T1:C1:111.222"); // the original, untouched
  assertEquals((m.parts[0] as { text: string }).text, "hola equipo (edited)");
});

Deno.test("slack: a message_changed with the same text and no `edited` is not an edit — nothing publishes", async () => {
  const { handler, published } = harness(SECRET);
  // a link unfurl: Slack re-delivers the message with attachments, the text untouched
  const res = await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        event_ts: "111.900",
        message: { ts: "111.222", user: "U7", text: "mira https://a.io" },
        previous_message: { ts: "111.222", user: "U7", text: "mira https://a.io" },
      },
    })),
  );
  assertEquals(res.status, 200);
  assertEquals(published.length, 0);
});

Deno.test("slack: a message_changed whose text differs is an edit even without `edited`", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        event_ts: "111.900",
        message: { ts: "111.222", user: "U7", text: "b" },
        previous_message: { ts: "111.222", user: "U7", text: "a" },
      },
    })),
  );
  assertEquals(published.length, 1);
  assertEquals((published[0] as MessageEvent).payload?.action, "edit");
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
  assertEquals(res.status, 200);
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

Deno.test("slack: a bound sender enrolls; sender stays the bare wire id — no name of ours", async () => {
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
  assertEquals(m.envelope.sender, { address: "U7" }); // the wire id, nothing of ours
  // the classifier's authorship stamp (§3): the grant names the mind — id alone (no
  // session: a Slack client is not the harness; no turn_id: input, not voice)
  assertEquals(m.agent, { id: "matias" });
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
  assertEquals(m.agent, undefined); // and no grant ⇒ no authorship stamp (§3)
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
  assertEquals(m.envelope.sender, { address: "U7" });
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
  assertEquals(res.status, 200);
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
  assertEquals(res.status, 200);
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

Deno.test("slack: reaction_added/_removed are action events carrying a ReactionPart", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "reaction_added",
        user: "U7",
        reaction: "thumbsup",
        item: { type: "message", channel: "C1", ts: "111.222" },
        event_ts: "111.500",
      },
    })),
  );
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "reaction_removed",
        user: "U7",
        reaction: "thumbsup",
        item: { type: "message", channel: "C1", ts: "111.222" },
        event_ts: "111.600",
      },
    })),
  );
  assertEquals(published.length, 2);
  const [added, removed] = published as MessageEvent[];
  assertEquals(added.payload?.action, "add");
  assertEquals(added.payload?.ref_external_id, "slack:T1:C1:111.222");
  assertEquals(added.envelope.external_id, "slack:T1:C1:111.500"); // the delivery dedupes
  assertEquals(added.parts, [{ type: "data", kind: "reaction", data: { name: "thumbsup" } }]);
  assertEquals(removed.payload?.action, "remove");
});

Deno.test("slack: message_deleted is TWO drafts — the delete event + the deleted_at stamp", async () => {
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
  assertEquals(published.length, 2);
  const [del, stamp] = published as MessageEvent[];
  assertEquals(del.envelope.external_id, "slack:T1:C1:111.999"); // the delivery's own ts
  assertEquals(del.payload?.action, "delete");
  assertEquals(del.payload?.ref_external_id, "slack:T1:C1:111.222");
  assertEquals(del.parts, []);
  assertEquals(stamp.envelope.external_id, "slack:T1:C1:111.222"); // the deleted row's key
  assertEquals("parts" in stamp, false); // the json_patch no-op — stored parts survive (§3)
  assertEquals(stamp.status?.deleted_at, "111.999");
});

Deno.test("slack: the name directory stamps sender.name and decodes inline mentions", async () => {
  const { names } = fakeNames({ "T1:U7": "Rocío", "T1:U9": "Marco" });
  const { handler, published } = harness(SECRET, undefined, undefined, names);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "hola <@U9> y <@UX|viejo alias>, miren <@U9>",
        ts: "111.222",
      },
    })),
  );
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  // sender.name is the service's fact, pulled through the directory
  assertEquals(m.envelope.sender, { address: "U7", name: "Rocío" });
  // <@U9> decodes to the resolved name; <@UX|label> falls back to the wire's label;
  // the ADDRESSES ride payload.mentions (deduped) — the decode spends no wire fact
  assertEquals((m.parts[0] as { text: string }).text, "hola @Marco y @viejo alias, miren @Marco");
  assertEquals(m.payload?.mentions, [
    { address: "U9", name: "Marco" },
    { address: "UX", name: "viejo alias" },
  ]);
});

Deno.test("slack: user_change is the directory's push leg — learned, nothing published", async () => {
  const { names, learned } = fakeNames();
  const { handler, published } = harness(SECRET, undefined, undefined, names);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "user_change",
        user: { id: "U7", name: "rocio", profile: { display_name: "Rocío" } },
      },
    })),
  );
  assertEquals(published.length, 0);
  assertEquals(learned, ["T1:U7=Rocío"]); // display_name wins over the handle
  // the next delivery reads the learned fact
  await handler(await signedReq(messageEvent()));
  assertEquals((published[0] as MessageEvent).envelope.sender?.name, "Rocío");
});

Deno.test("slack: no directory ⇒ bare ids — sender unnamed, mentions decode to @<id>", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "ping <@U9>",
        ts: "111.222",
      },
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.sender, { address: "U7" });
  assertEquals((m.parts[0] as { text: string }).text, "ping @U9");
  assertEquals(m.payload?.mentions, [{ address: "U9" }]);
});

/** The global fetch swapped for one that records each call's init and answers `body`. */
function stubFetch(body: () => unknown) {
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_i: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return Promise.resolve(Response.json(body()));
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

Deno.test("slack: the name directory's users.info call carries a timeout signal", async () => {
  const stub = stubFetch(() => ({ ok: true, user: { profile: { display_name: "Ana" } } }));
  try {
    const names = slackNames(() => Promise.resolve("xoxb-t"));
    assertEquals(await names.nameOf("T1", "U1"), "Ana");
  } finally {
    stub.restore();
  }
  assertEquals(stub.seen.length, 1);
  assert(stub.seen[0].signal instanceof AbortSignal, "the call is bounded");
});

Deno.test("slack: an event POST is acked 200 before its processing settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stored: Event[] = [];
  const publish = ((one: Draft | Draft[]) => {
    const drafts = Array.isArray(one) ? one : [one];
    const rows = drafts.map((e) => ({ ...e, id: e.id ?? newId() } as Event));
    // the store is slow: nothing lands until the gate opens
    return gate.then(() => {
      stored.push(...rows);
      return Array.isArray(one) ? rows : rows[0];
    });
  }) as Appender["publish"];
  const { raw, handler } = harness(SECRET, undefined, undefined, undefined, publish);
  const res = raw(await signedReq(messageEvent()));
  let timer!: ReturnType<typeof setTimeout>;
  const waited = new Promise<string>((r) => (timer = setTimeout(() => r("waited"), 300)));
  const first = await Promise.race([res.then(() => "acked"), waited]);
  clearTimeout(timer);
  assertEquals(first, "acked");
  assertEquals((await res).status, 200);
  assertEquals(stored.length, 0); // the ack came first
  release();
  await handler(await signedReq(messageEvent({ event: { ...messageEvent().event, ts: "2.2" } })));
  assertEquals(stored.length, 2); // the processing behind the ack still landed
});

Deno.test("slack: a delivery whose processing fails is still acked 200, and the failure is logged", async () => {
  const publish = (() => Promise.reject(new Error("disk full"))) as unknown as Appender["publish"];
  const { handler } = harness(SECRET, undefined, undefined, undefined, publish);
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const res = await handler(await signedReq(messageEvent()));
    assertEquals(res.status, 200);
  } finally {
    console.error = real;
  }
  assertEquals(logged.length, 1);
  assertStringIncludes(logged[0], "disk full");
});

Deno.test("looksLikeSignIn: an HTML answer to a non-HTML file is Slack's sign-in page", () => {
  assertEquals(looksLikeSignIn("image/png", "text/html; charset=utf-8"), true);
  assertEquals(looksLikeSignIn(undefined, "text/html"), true);
  assertEquals(looksLikeSignIn("text/html", "text/html; charset=utf-8"), false); // an HTML share IS html
  assertEquals(looksLikeSignIn("image/png", "image/png"), false);
  assertEquals(looksLikeSignIn("image/png", null), false); // no header, no verdict
});

Deno.test("slack: a threaded reply carries action reply + ref to the thread root", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "en el hilo",
        ts: "222.333",
        thread_ts: "111.222", // the root's ts — Slack threads are one level deep
      },
    })),
  );
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.envelope.external_id, "slack:T1:C1:222.333");
  assertEquals(m.payload?.action, "reply");
  assertEquals(m.payload?.ref_external_id, "slack:T1:C1:111.222");
});

Deno.test("slack: a thread root (thread_ts = its own ts) is a plain message, not a reply", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U7",
        text: "abro hilo",
        ts: "111.222",
        thread_ts: "111.222",
        reply_count: 3,
      },
    })),
  );
  assertEquals(published.length, 1);
  assertEquals((published[0] as MessageEvent).payload, undefined);
});

Deno.test("slack: an edit inside a thread stays an edit — the reply relation is the original's", async () => {
  const { handler, published } = harness(SECRET);
  await handler(
    await signedReq(messageEvent({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        event_ts: "222.900",
        message: {
          ts: "222.333",
          thread_ts: "111.222",
          user: "U7",
          text: "en el hilo (edited)",
          edited: { user: "U7", ts: "222.900" },
        },
        previous_message: { ts: "222.333", thread_ts: "111.222", user: "U7", text: "en el hilo" },
      },
    })),
  );
  const m = published[0] as MessageEvent;
  assertEquals(m.payload?.action, "edit");
  assertEquals(m.payload?.ref_external_id, "slack:T1:C1:222.333");
});

Deno.test("slack: without `track` the handler answers only once the publish landed — 500 on failure", async () => {
  const stored: Event[] = [];
  let fail = true;
  const publish = ((one: Draft | Draft[]) => {
    if (fail) return Promise.reject(new Error("disk full"));
    const drafts = Array.isArray(one) ? one : [one];
    const rows = drafts.map((e) => ({ ...e, id: e.id ?? newId() } as Event));
    stored.push(...rows);
    return Promise.resolve(Array.isArray(one) ? rows : rows[0]);
  }) as Appender["publish"];
  const handler = createSlackWebhook({ publish });
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const refused = await handler(
      new Request("http://localhost/", { method: "POST", body: JSON.stringify(messageEvent()) }),
    );
    assertEquals(refused.status, 500);
    assertStringIncludes(await refused.text(), "disk full");
    assertEquals(stored.length, 0);
    fail = false;
    const accepted = await handler(
      new Request("http://localhost/", { method: "POST", body: JSON.stringify(messageEvent()) }),
    );
    assertEquals(accepted.status, 200);
    assertEquals(stored.length, 1); // the answer came AFTER the row landed
  } finally {
    console.error = real;
  }
});

/** A Slack Socket Mode endpoint in miniature: on open it delivers one events_api envelope
 *  and redelivers it every `RESEND_MS` until an ack names it. Records every ack. */
function fakeSocketMode(envelope: { envelope_id: string; payload: unknown }, RESEND_MS: number) {
  const acks: string[] = [];
  const order: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const deliver = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "events_api", ...envelope }));
      const t = setTimeout(() => {
        timers.delete(t);
        if (!acks.includes(envelope.envelope_id)) deliver();
      }, RESEND_MS);
      timers.add(t);
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "hello" })); // no envelope_id — nothing to ack
      deliver();
    };
    socket.onmessage = (e) => {
      const ack = JSON.parse(String(e.data)) as { envelope_id?: string };
      if (ack.envelope_id) {
        acks.push(ack.envelope_id);
        order.push(`ack:${ack.envelope_id}`);
      }
    };
    return response;
  });
  const url = `ws://127.0.0.1:${server.addr.port}/`;
  const close = async () => {
    for (const t of timers) clearTimeout(t);
    await server.shutdown();
  };
  return { url, acks, order, close };
}

Deno.test("slack socket: an envelope is acked only after its delivery landed — a refused one is redelivered", async () => {
  const wire = fakeSocketMode({ envelope_id: "env-1", payload: messageEvent() }, 200);
  let calls = 0;
  const handler: WebhookHandler = async (req) => {
    const body = await req.json() as { event: { text: string } };
    assertEquals(body.event.text, "hola equipo"); // the payload rides as the synthetic POST
    calls += 1;
    const status = calls === 1 ? 500 : 200;
    await new Promise((r) => setTimeout(r, 10));
    wire.order.push(`handled:${calls}:${status}`);
    return new Response(status === 200 ? "accepted" : "disk full", { status });
  };
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  const stop = slackSocket("xapp-1-A1-2-3", handler, { open: () => Promise.resolve(wire.url) });
  try {
    const t0 = Date.now();
    while (wire.acks.length === 0 && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 250)); // long enough for a stray second ack
  } finally {
    console.error = real;
    await stop();
    await wire.close();
  }
  assertEquals(wire.acks, ["env-1"]); // exactly one ack, naming the envelope
  assertEquals(calls, 2); // the refusal was redelivered
  assertEquals(wire.order, ["handled:1:500", "handled:2:200", "ack:env-1"]); // ack AFTER the landing
  assertEquals(logged.length, 1); // the refusal is on stderr
  assertStringIncludes(logged[0], "env-1");
});

Deno.test("HTTP mode: every app's signing secret verifies, and no app means no server", async () => {
  const many = createSlackWebhook({
    publish: (() => Promise.resolve(undefined)) as unknown as Appender["publish"],
    signingSecrets: ["another-app", SECRET],
  });
  const challenge = { type: "url_verification", challenge: "c1" };
  assertEquals((await many(await signedReq(challenge))).status, 200);
  const other = createSlackWebhook({
    publish: (() => Promise.resolve(undefined)) as unknown as Appender["publish"],
    signingSecrets: ["another-app"],
  });
  assertEquals((await other(await signedReq(challenge))).status, 401);
  // the vault's app rows → the secrets the server verifies with; an empty set is a refusal
  // to bind, never an open door
  const row = (s: string) => ({ key: `slack:app:${s}`, value: { signing_secret: s } });
  assertEquals(httpSigningSecrets([row("a"), row(""), row("b")]), ["a", "b"]);
  assertThrows(() => httpSigningSecrets([]), Error, "signing secret");
  assertThrows(() => httpSigningSecrets([row("")]), Error, "signing secret");
});
