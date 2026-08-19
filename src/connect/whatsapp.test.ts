import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createWhatsAppWebhook,
  externalId,
  kindOf,
  type WABatch,
  type WAMessage,
  type WhatsAppWebhookDeps,
} from "./whatsapp.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";
import { newId } from "../store/id.ts";
import type { Appender } from "../store/log.ts";
import type { ConnectionRow } from "../store/connections.ts";

const TOKEN = "wa-s3cret";

/** The map seam in miniature: grant rows in, connection upserts out. */
function fakeStore(conn?: ConnectionRow) {
  const upserts: ConnectionRow[] = [];
  const store: NonNullable<WhatsAppWebhookDeps["store"]> = {
    connection: (service, address) =>
      conn && conn.service === service && conn.address === address ? conn : null,
    upsertConnections: (rows) => upserts.push(...rows),
  };
  return { store, upserts };
}

function harness(deps: Partial<WhatsAppWebhookDeps> = {}) {
  const published: Event[] = [];
  const handler = createWhatsAppWebhook({
    // the store's `publish` in miniature — the ingest publishes the batch as one array
    publish: ((e: Draft | Draft[]) => {
      const drafts = Array.isArray(e) ? e : [e];
      const stored = drafts.map((d) => ({ ...d, id: d.id ?? newId() }) as Event);
      published.push(...stored);
      return Promise.resolve(Array.isArray(e) ? stored : stored[0]);
    }) as Appender["publish"],
    ...deps,
  });
  return { handler, published };
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

const batch = (over: Partial<WABatch> = {}): WABatch => ({
  organization_address: "5491100000000",
  ...over,
});

const textMessage = (over: Partial<WAMessage> = {}): WAMessage => ({
  external_id: "wmw.5491100000000.5491199999999.5491199999999.ABC",
  conversation_address: "5491199999999",
  sender_address: "5491199999999",
  content: { version: "1", type: "text", kind: "text", text: "hola" },
  timestamp: "2026-08-11T12:00:00Z",
  ...over,
});

Deno.test("kindOf reads the jid shape", () => {
  assertEquals(kindOf("5491199999999"), "direct");
  assertEquals(kindOf("123456-789@g.us"), "group");
  assertEquals(kindOf("123@broadcast"), "broadcast");
});

Deno.test("bridge token required when set — wrong or missing is 401", async () => {
  const { handler, published } = harness({ bridgeToken: TOKEN });
  assertEquals((await handler(post("/whatsapp-web-webhook", batch()))).status, 401);
  assertEquals(
    (await handler(post("/whatsapp-web-webhook", batch(), "wrong"))).status,
    401,
  );
  assertEquals(published.length, 0);
});

Deno.test("a text message maps: envelope, kind, prefixed external_id, parts", async () => {
  const { handler, published } = harness();
  const res = await handler(
    post("/whatsapp-web-webhook", batch({ messages: [textMessage()] })),
  );
  assertEquals(res.status, 200);
  assertEquals(published.length, 1);
  const e = published[0] as MessageEvent;
  assertEquals(e.type, "message");
  assertEquals(e.envelope.service, "whatsapp");
  assertEquals(e.envelope.connection_address, "5491100000000");
  assertEquals(e.envelope.conversation.address, "5491199999999");
  assertEquals(e.envelope.conversation.kind, "direct");
  assertEquals(e.envelope.sender?.address, "5491199999999");
  assertEquals(
    e.envelope.external_id,
    externalId("wmw.5491100000000.5491199999999.5491199999999.ABC"),
  );
  assertEquals(e.ts, "2026-08-11T12:00:00Z");
  assertEquals(e.parts, [{ type: "text", kind: "text", text: "hola" }]);
});

Deno.test("an echo (no sender, explicit status) keeps envelope.status, no sender", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [textMessage({
          sender_address: "",
          status: { sent: "2026-08-11T12:00:00Z" },
        })],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  assertEquals(e.envelope.sender, undefined);
  assertEquals(e.envelope.status, "sent");
});

Deno.test("the classifier stamps the principal (§3): a granted sender gets agent.id alone", async () => {
  const { store } = fakeStore({
    service: "whatsapp",
    address: "5491100000000",
    agentId: "matias",
  });
  const { handler, published } = harness({ store });
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [
          textMessage({ sender_address: "5491100000000" }), // own side: the principal's phone
          textMessage({ external_id: "wmw.x.y.z.2" }), // a peer — no grant row
        ],
      }),
    ),
  );
  // id alone — a phone is not the harness, so no session_id; and never a turn_id
  assertEquals((published[0] as MessageEvent).agent, { id: "matias" });
  assertEquals((published[0] as MessageEvent).payload?.turn_id, undefined);
  assertEquals((published[1] as MessageEvent).agent, undefined);
});

Deno.test("sender.name is the SERVICE's display fact: the pushname, never a lookup", async () => {
  const { store } = fakeStore({
    service: "whatsapp",
    address: "5491199999999",
    agentId: "matias",
  });
  const { handler, published } = harness({ store });
  // pushname arrives in the same batch — the cache feeds later batches too
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        contacts: [{ address: "5491177777777", extra: { name: "Ana" } }],
        messages: [
          textMessage(),
          textMessage({
            external_id: "wmw.x.y.z.2",
            sender_address: "5491177777777",
            conversation_address: "5491177777777",
          }),
        ],
      }),
    ),
  );
  assertEquals((published[0] as MessageEvent).envelope.sender?.name, undefined); // no lookup
  assertEquals((published[1] as MessageEvent).envelope.sender?.name, "Ana"); // pushname
});

Deno.test("the message's own names win: a row names its people without any cache", async () => {
  const { handler, published } = harness();
  const group = "123-456@g.us";
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        // a cache that disagrees — the pushname the wire once shouted, against the name
        // this account keeps for the same person in its address book
        contacts: [{ address: "5491177777777", extra: { name: "gv 🇮🇹" } }],
        messages: [
          textMessage({
            external_id: "wmw.n.a.m.1",
            sender_address: "5491177777777",
            conversation_address: "5491177777777",
            sender_name: "Gianvito",
            conversation_name: "Gianvito",
          }),
          textMessage({
            external_id: "wmw.n.a.m.2",
            conversation_address: group,
            sender_address: "5491177777777",
            sender_name: "Gianvito",
            conversation_name: "Asado",
          }),
        ],
      }),
    ),
  );
  const dm = published[0] as MessageEvent;
  assertEquals(dm.envelope.sender?.name, "Gianvito");
  assertEquals(dm.envelope.conversation.name, "Gianvito"); // a DM is named by its peer
  const grp = published[1] as MessageEvent;
  assertEquals(grp.envelope.sender?.name, "Gianvito");
  assertEquals(grp.envelope.conversation.name, "Asado");
});

Deno.test("group subject denormalizes onto messages (same batch and later ones)", async () => {
  const { handler, published } = harness();
  const group = "123-456@g.us";
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        groups: [{ address: group, name: "Asado" }],
        messages: [textMessage({ conversation_address: group, external_id: "wmw.a.b.c.1" })],
      }),
    ),
  );
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [textMessage({ conversation_address: group, external_id: "wmw.a.b.c.2" })],
      }),
    ),
  );
  for (const e of published as MessageEvent[]) {
    assertEquals(e.envelope.conversation.kind, "group");
    assertEquals(e.envelope.conversation.name, "Asado");
  }
});

Deno.test("file content maps to a FilePart with caption; data to a DataPart", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [
          textMessage({
            external_id: "wmw.f.1",
            content: {
              version: "1",
              type: "file",
              kind: "image",
              text: "mirá",
              file: { mime_type: "image/jpeg", uri: "file:///data/x.jpg", size: 123 },
            },
          }),
          textMessage({
            external_id: "wmw.d.1",
            content: {
              version: "1",
              type: "data",
              kind: "location",
              data: { latitude: -34.6, longitude: -58.4 },
            },
          }),
        ],
      }),
    ),
  );
  const [f, d] = published as MessageEvent[];
  assertEquals(f.parts[0], {
    type: "file",
    kind: "image",
    file: { mime_type: "image/jpeg", uri: "file:///data/x.jpg", size: 123 },
    text: "mirá",
  });
  assertEquals(d.parts[0], {
    type: "data",
    kind: "location",
    data: { latitude: -34.6, longitude: -58.4 },
  });
});

Deno.test("inline mention tokens get named: @<digits> → @name, unnamed stays digits", async () => {
  const { handler, published } = harness();
  await handler(post(
    "/whatsapp-web-webhook",
    batch({
      contacts: [{ address: "5492604560911", extra: { name: "Euge" } }],
      messages: [textMessage({
        conversation_address: "123456-789@g.us",
        content: {
          version: "1",
          type: "text",
          kind: "text",
          // canonical digits both in the text and in mentions — the bridge already put
          // the token in our namespace (a lid group's lids never reach us)
          text: "@5492604560911 y @5491177777777 vengan",
          mentions: [{ address: "5492604560911" }, { address: "5491177777777" }],
        },
      })],
    }),
  ));
  const e = published[0] as MessageEvent;
  // the known one wears its pushname; nobody has named the other, so digits stand
  assertEquals(e.parts, [{ type: "text", kind: "text", text: "@Euge y @5491177777777 vengan" }]);
  assertEquals(e.payload?.mentions, [
    { address: "5492604560911" },
    { address: "5491177777777" },
  ]);
});

Deno.test("reaction + reply ref: the target is payload.ref_external_id, action add", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [textMessage({
          external_id: "wmw.r.1",
          content: {
            version: "1",
            type: "text",
            kind: "reaction",
            text: "👍",
            re_message_id: "wmw.orig.1",
          },
        })],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  assertEquals(e.parts[0], { type: "text", kind: "reaction", text: "👍" });
  assertEquals(e.payload?.ref_external_id, externalId("wmw.orig.1"));
  assertEquals(e.payload?.action, "add"); // a reaction ADDS a part to its referent (§3)
});

Deno.test("a GLYPHLESS reaction is a removal — the wire truth outranks the bridge's label", async () => {
  // WhatsApp spells "un-react" as an empty reaction; a bridge that ships `{}` without
  // classifying it must still land as remove, never as an empty add
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        messages: [textMessage({
          external_id: "wmw.r.2",
          content: {
            version: "1",
            type: "data",
            kind: "reaction",
            data: {},
            re_message_id: "wmw.orig.1",
          },
        })],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  assertEquals(e.payload?.action, "remove");
});

Deno.test("an edit is its OWN event: action edit + ref to the original, new parts", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        edits: [{
          original_message_id: "wmw.orig.1",
          text: "hola (corregido)",
          timestamp: "2026-08-11T12:05:00Z",
        }],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  // its own identity (synthetic here — an older-bridge batch without external_id),
  // NEVER the original's: the original row stays sealed, the edit renders later (§3)
  assertEquals(e.envelope.external_id?.includes("edit.wmw.orig.1"), true);
  assertEquals(e.payload?.action, "edit");
  assertEquals(e.payload?.ref_external_id, externalId("wmw.orig.1"));
  assertEquals(e.parts, [{ type: "text", kind: "text", text: "hola (corregido)" }]);
});

Deno.test("a revoke is TWO drafts: the delete event + deleted_at on the original", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        revokes: [{ original_message_id: "wmw.orig.1", timestamp: "2026-08-11T12:06:00Z" }],
      }),
    ),
  );
  const [del, stamp] = published as MessageEvent[];
  assertEquals(del.payload?.action, "delete");
  assertEquals(del.payload?.ref_external_id, externalId("wmw.orig.1"));
  assertEquals(del.parts, []); // delete removes ALL parts — the event carries none
  assertEquals(stamp.envelope.external_id, externalId("wmw.orig.1"));
  assertEquals("parts" in stamp, false); // the json_patch no-op — stored parts survive
  assertEquals(stamp.status?.deleted_at, "2026-08-11T12:06:00Z");
});

Deno.test("a receipt maps to a merge-only status draft: state + read_at map", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        statuses: [{
          external_id: "wmw.orig.1",
          conversation_address: "5491199999999",
          status: { read: { "5491177777777": "2026-08-11T12:07:00Z" } },
        }],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  assertEquals(e.envelope.external_id, externalId("wmw.orig.1"));
  assertEquals(e.status?.state, "read");
  assertEquals("parts" in e, false);
  assertEquals(e.status?.read_at, { "5491177777777": "2026-08-11T12:07:00Z" });
});

Deno.test("a history batch stamps extra.backfill; the reply ref rides payload", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        history: true,
        messages: [
          textMessage(),
          textMessage({
            external_id: "wmw.h.2",
            content: {
              version: "1",
              type: "text",
              kind: "text",
              text: "reply",
              re_message_id: "wmw.orig.1",
            },
          }),
        ],
      }),
    ),
  );
  // live traffic for comparison — no flag
  await handler(
    post("/whatsapp-web-webhook", batch({ messages: [textMessage({ external_id: "wmw.l.1" })] })),
  );
  const [h1, h2, live] = published as MessageEvent[];
  assertEquals(h1.extra?.backfill, true);
  assertEquals(h2.extra?.backfill, true); // the service-neutral key…
  assertEquals(h2.payload?.ref_external_id, externalId("wmw.orig.1")); // …beside the typed ref
  assertEquals(h2.payload?.action, "reply");
  assertEquals(live.extra?.backfill, undefined);
});

Deno.test("sessions/events: connected upserts the connection row (the gate)", async () => {
  const { store, upserts } = fakeStore();
  const { handler } = harness({ store });
  const res = await handler(
    post("/whatsapp-web-management/sessions/events", {
      event: "connected",
      organization_id: "org-1",
      address: "5491100000000",
      agent_id: "matias",
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].service, "whatsapp");
  assertEquals(upserts[0].address, "5491100000000");
  assertEquals(upserts[0].agentId, "matias"); // personal session ⇒ the grant binds
  assertEquals(upserts[0].extra?.state, "connected");
});

Deno.test("media route stores bytes and answers the uri", async () => {
  const { handler } = harness({
    media: (bytes, meta) =>
      Promise.resolve({
        mime_type: meta.mime_type ?? "application/octet-stream",
        uri: `file:///data/${meta.connection}/${meta.name} (${bytes.length}b)`,
        size: bytes.length,
      }),
  });
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" }));
  form.set("organization_address", "5491100000000");
  const res = await handler(
    new Request("http://localhost/whatsapp-web-webhook/media", { method: "POST", body: form }),
  );
  assertEquals(res.status, 200);
  const out = await res.json() as { uri: string };
  assertStringIncludes(out.uri, "5491100000000/foto.jpg (3b)");
});
