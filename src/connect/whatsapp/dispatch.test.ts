import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  bridgeSend,
  createWhatsAppDispatch,
  type WADispatchRecord,
  type WhatsAppDispatchDeps,
} from "./dispatch.ts";
import { withTimeout } from "../http.ts";
import { externalId } from "./ingest.ts";
import { DispatchError } from "../errors.ts";
import type { DeliveryPatch, Subscriber } from "../../store/log.ts";
import type { Draft, Event, EventId, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";

/** A hand-cranked subscription: capture the listener, push events by hand. */
function fakeLog() {
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
    read: () => Promise.resolve([] as Event[]),
    push: (e: Draft) => deliver?.({ ...e, id: e.id ?? newId() } as Event),
    patches,
    setDelivery: (id: EventId, patch: DeliveryPatch) => {
      patches.push({ id, patch });
      return Promise.resolve();
    },
  };
}

/** An agent's message as the store hands it to the stream: born `queued` (§3). */
const outboundMessage = (over: Partial<MessageEvent> = {}): Draft<MessageEvent> => ({
  ts: "2026-08-11T12:00:00Z",
  type: "message",
  envelope: {
    service: "whatsapp",
    connection_address: "5491100000000",
    conversation: { address: "5491199999999", kind: "direct" },
    status: "queued",
  },
  status: { state: "queued", queued_at: "2026-08-11T12:00:00Z" },
  agent: { id: "matias", session_id: "s1" },
  parts: [{ type: "text", kind: "text", text: "dale, nos vemos" }],
  ...over,
});

function harness(send: WhatsAppDispatchDeps["send"], over: Partial<WhatsAppDispatchDeps> = {}) {
  const log = fakeLog();
  const sent: MessageEvent[] = [];
  const failed: { event: MessageEvent; err: unknown }[] = [];
  createWhatsAppDispatch({
    subscribe: log.subscribe,
    read: log.read,
    send,
    setDelivery: log.setDelivery,
    onSent: (e) => sent.push(e),
    onError: (event, err) => failed.push({ event, err }),
    ...over,
  });
  return { log, sent, failed };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("a text send maps to one record; the wmw id backfills external_id", async () => {
  const records: WADispatchRecord[] = [];
  const { log, sent } = harness((record) => {
    records.push(record);
    return Promise.resolve("wmw.out.1");
  });
  log.push(outboundMessage());
  await settle();

  assertEquals(records.length, 1);
  assertEquals(records[0].organization_address, "5491100000000");
  assertEquals(records[0].conversation_address, "5491199999999");
  assertEquals(records[0].content, {
    version: "1",
    type: "text",
    kind: "text",
    text: "dale, nos vemos",
  });
  assertEquals(sent.length, 1);
  assertEquals(log.patches.length, 1);
  assertEquals(log.patches[0].patch.external_id, externalId("wmw.out.1"));
  assertEquals(typeof log.patches[0].patch.status?.dispatched_at, "string");
});

Deno.test("non-whatsapp and world-authored events never dispatch", async () => {
  const records: WADispatchRecord[] = [];
  const { log } = harness((r) => {
    records.push(r);
    return Promise.resolve(undefined);
  });
  log.push(outboundMessage({ agent: undefined })); // the world wrote it
  log.push({
    ...outboundMessage(),
    envelope: { ...outboundMessage().envelope, service: "slack" },
  } as Draft<MessageEvent>);
  // the principal's echo: classifier-stamped (agent.id) but already on the wire
  // (external_id present) — never re-dispatched (§3)
  log.push(outboundMessage({
    agent: { id: "matias" },
    envelope: {
      ...outboundMessage().envelope,
      external_id: externalId("wmw.5491100000000.549.5491100000000.X"),
    },
  }));
  await settle();
  assertEquals(records.length, 0);
});

Deno.test("the send response names our side: sender rides the backfill patch (§4)", async () => {
  const { log } = harness(() =>
    Promise.resolve("wmw.5491100000000.5491199999999.5491100000000.OUT")
  );
  log.push(outboundMessage());
  await settle();
  // segment <own> of the returned id → sender.address, stamped WITH dispatched_at —
  // sender-presence now means "on the wire", no waiting for the echo
  assertEquals(log.patches[0].patch.sender, { address: "5491100000000" });
});

Deno.test("files: one call each, caption on the first, first id backfills", async () => {
  const records: WADispatchRecord[] = [];
  let n = 0;
  const { log } = harness((r) => {
    records.push(r);
    return Promise.resolve(`wmw.out.${++n}`);
  });
  log.push(outboundMessage({
    parts: [
      { type: "text", kind: "text", text: "las fotos" },
      { type: "file", kind: "image", file: { mime_type: "image/jpeg", uri: "file:///a.jpg" } },
      { type: "file", kind: "image", file: { mime_type: "image/jpeg", uri: "file:///b.jpg" } },
    ],
  }));
  await settle();

  assertEquals(records.length, 2);
  assertEquals(records[0].content.text, "las fotos"); // the caption seat
  assertEquals(records[1].content.text, undefined);
  assertEquals(records[0].content.type, "file");
  assertEquals(log.patches[0].patch.external_id, externalId("wmw.out.1")); // FIRST id
});

Deno.test("local file rides the mediaUrl seam; external link passes through", async () => {
  const urls: (string | undefined)[] = [];
  const { log } = harness(
    (_r, mediaUrl) => {
      urls.push(mediaUrl);
      return Promise.resolve("wmw.out.1");
    },
    { mediaUrl: (f) => Promise.resolve(`http://localhost:8792/m/${f.file.uri.slice(-5)}`) },
  );
  log.push(outboundMessage({
    parts: [
      { type: "file", kind: "image", file: { mime_type: "image/jpeg", uri: "file:///a.jpg" } },
      {
        type: "file",
        kind: "document",
        file: { mime_type: "application/pdf", uri: "https://x.com/doc.pdf" },
      },
    ],
  }));
  await settle();
  assertEquals(urls, ["http://localhost:8792/m/a.jpg", "https://x.com/doc.pdf"]);
});

Deno.test("a reaction maps to its own content with the raw wmw re_message_id", async () => {
  const records: WADispatchRecord[] = [];
  const { log } = harness((r) => {
    records.push(r);
    return Promise.resolve("wmw.out.1");
  });
  // the canonical shape (§3): ReactionPart + the ref/action on the event's payload
  log.push(outboundMessage({
    parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
    payload: { action: "add", ref_external_id: externalId("wmw.orig.7") },
  }));
  // action: "remove" un-reacts — WhatsApp's wire form is an EMPTY reaction
  log.push(outboundMessage({
    parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
    payload: { action: "remove", ref_external_id: externalId("wmw.orig.7") },
  }));
  await settle();
  assertEquals(records.length, 2);
  // the bridge's reaction shape (openbsp.go): the DataPart carries the glyph, and its
  // `action` is what makes a removal — WhatsApp un-reacts with an empty reaction
  assertEquals(records[0].content, {
    version: "1",
    type: "data",
    kind: "reaction",
    data: { action: "added", name: "👍", unicode: "👍" },
    re_message_id: "wmw.orig.7", // prefix stripped back to the bridge's id
  });
  assertEquals(records[1].content.data, { action: "removed" });
});

Deno.test("edit and delete act on the referent: one content, no body of their own", async () => {
  const records: WADispatchRecord[] = [];
  const { log } = harness((r) => {
    records.push(r);
    return Promise.resolve("wmw.out.1");
  });
  log.push(outboundMessage({
    parts: [{ type: "text", kind: "text", text: "mejor a las 10" }],
    payload: { action: "edit", ref_external_id: externalId("wmw.orig.7") },
  }));
  log.push(outboundMessage({
    parts: [],
    payload: { action: "delete", ref_external_id: externalId("wmw.orig.7") },
  }));
  await settle();
  assertEquals(records.length, 2);
  assertEquals(records[0].content, {
    version: "1",
    type: "data",
    kind: "edit",
    text: "mejor a las 10", // the replacement, not a new message
    re_message_id: "wmw.orig.7",
  });
  assertEquals(records[1].content, {
    version: "1",
    type: "data",
    kind: "revoke",
    re_message_id: "wmw.orig.7",
  });
});

Deno.test("a bridge refusal stamps failed with the HTTP status as error_code", async () => {
  const { log, failed } = harness(() =>
    Promise.reject(
      new DispatchError("bridge /dispatch HTTP 422: file part without media_url", 422),
    )
  );
  log.push(outboundMessage());
  await settle();
  assertEquals(failed.length, 1);
  assertEquals(log.patches.length, 1);
  const status = log.patches[0].patch.status!;
  assertEquals(status.state, "failed");
  assertStringIncludes(String(status.error), "HTTP 422");
  assertEquals(status.error_code, 422);
});

Deno.test("an error without an HTTP class stamps failed with a null error_code — the class is removed", async () => {
  const { log } = harness(() => Promise.reject(new TypeError("connection refused")));
  log.push(outboundMessage());
  await settle();
  const status = log.patches[0].patch.status!;
  assertEquals(status.state, "failed");
  assertEquals(status.error_code, null); // never reached the bridge — no class, and none kept
});

Deno.test("the directory claims @Name tokens — content.mentions for the bridge encoder", async () => {
  const records: WADispatchRecord[] = [];
  const { log } = harness((record) => {
    records.push(record);
    return Promise.resolve("wmw.out.9");
  }, {
    directory: (service, conversation) => {
      assertEquals([service, conversation], ["whatsapp", "5491199999999"]);
      return Promise.resolve([{ address: "5492604560911", name: "Euge" }]);
    },
  });
  log.push(outboundMessage({
    parts: [{ type: "text", kind: "text", text: "@Euge te paso la dirección" }],
  }));
  await settle();

  assertEquals(records.length, 1);
  // text ships as the agent wrote it — the BRIDGE rewrites @Name → @digits + MentionedJID
  assertEquals(records[0].content.text, "@Euge te paso la dirección");
  assertEquals(records[0].content.mentions, [{ address: "5492604560911", name: "Euge" }]);
});

Deno.test("the caption seat claims mentions too — the bridge encodes captions as well", async () => {
  const records: WADispatchRecord[] = [];
  const { log } = harness((record) => {
    records.push(record);
    return Promise.resolve("wmw.out.10");
  }, {
    directory: () => Promise.resolve([{ address: "5492604560911", name: "Euge" }]),
  });
  log.push(outboundMessage({
    parts: [
      { type: "text", kind: "text", text: "@Euge mirá la foto" },
      {
        type: "file",
        kind: "image",
        file: { mime_type: "image/jpeg", uri: "https://x/y.jpg" },
      },
    ],
  }));
  await settle();

  assertEquals(records.length, 1); // one file → the text rides as its caption
  assertEquals(records[0].content.type, "file");
  assertEquals(records[0].content.text, "@Euge mirá la foto");
  assertEquals(records[0].content.mentions, [{ address: "5492604560911", name: "Euge" }]);
});

/** A fetch that never answers on its own — only its signal ends it, as a stalled socket
 *  behaves under a real `fetch`. */
const hang =
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;

Deno.test("bridge send: a hung /dispatch call fails inside the fetch's bound", async () => {
  const send = bridgeSend("http://bridge.local", "tok", withTimeout(hang, 20));
  const t0 = Date.now();
  const err = await assertRejects(() =>
    send({
      id: "e1",
      external_id: "",
      organization_address: "5491100000000",
      conversation_address: "5491199999999",
      content: { version: "1", type: "text", kind: "text", text: "hola" },
      status: {},
    })
  );
  assert(err instanceof DOMException && err.name === "TimeoutError", String(err));
  assert(Date.now() - t0 < 1_000, "ended inside the bound");
});
