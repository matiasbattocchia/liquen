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

Deno.test("classifier: a bound grant row names the sender; else the pushname", async () => {
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
  assertEquals((published[0] as MessageEvent).envelope.sender?.name, "matias"); // grant wins
  assertEquals((published[1] as MessageEvent).envelope.sender?.name, "Ana"); // pushname
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

Deno.test("reaction + reply ref: kind reaction, re in extra.whatsapp (prefixed)", async () => {
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
  assertEquals((e.extra?.whatsapp as { re?: string }).re, externalId("wmw.orig.1"));
});

Deno.test("an edit republishes on the original id with new parts + edited_at", async () => {
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
  assertEquals(e.envelope.external_id, externalId("wmw.orig.1"));
  assertEquals(e.parts, [{ type: "text", kind: "text", text: "hola (corregido)" }]);
  assertEquals(
    (e.extra?.whatsapp as { edited_at?: string }).edited_at,
    "2026-08-11T12:05:00Z",
  );
});

Deno.test("a revoke is merge-only: no parts key, revoked_at in extra", async () => {
  const { handler, published } = harness();
  await handler(
    post(
      "/whatsapp-web-webhook",
      batch({
        revokes: [{ original_message_id: "wmw.orig.1", timestamp: "2026-08-11T12:06:00Z" }],
      }),
    ),
  );
  const e = published[0] as MessageEvent;
  assertEquals(e.envelope.external_id, externalId("wmw.orig.1"));
  assertEquals("parts" in e, false); // the json_patch no-op — stored parts survive
  assertEquals(
    (e.extra?.whatsapp as { revoked_at?: string }).revoked_at,
    "2026-08-11T12:06:00Z",
  );
});

Deno.test("a receipt maps to a merge-only status draft: furthest state + raw map", async () => {
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
  assertEquals(e.envelope.status, "read");
  assertEquals("parts" in e, false);
  assertEquals(
    (e.extra?.whatsapp as { status?: Record<string, unknown> }).status,
    { read: { "5491177777777": "2026-08-11T12:07:00Z" } },
  );
});

Deno.test("a history batch stamps extra.backfill beside the whatsapp sidecar", async () => {
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
  assertEquals(h2.extra?.backfill, true); // service-neutral key BESIDE the sidecar…
  assertEquals((h2.extra?.whatsapp as { re?: string }).re, externalId("wmw.orig.1")); // …which survives
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
