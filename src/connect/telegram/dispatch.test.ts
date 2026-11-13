import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createTelegramDispatch, type TelegramDispatchDeps } from "./dispatch.ts";
import { type FakeWire, fakeWire, SOL } from "./testing.ts";
import { DispatchError } from "../errors.ts";
import type { DeliveryPatch, Subscriber } from "../../store/log.ts";
import type { Draft, Event, EventId, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { TgOutbound } from "./wire.ts";

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
const outbound = (over: Partial<MessageEvent> = {}): Draft<MessageEvent> => ({
  ts: "2026-11-13T12:00:00Z",
  type: "message",
  envelope: {
    service: "telegram",
    connection_address: "700100",
    conversation: { address: "700200", kind: "direct" },
    status: "queued",
  },
  status: { state: "queued", queued_at: "2026-11-13T12:00:00Z" },
  agent: { id: "ana", session_id: "s1" },
  parts: [{ type: "text", kind: "text", text: "dale, nos **vemos**" }],
  ...over,
});

function harness(wire: FakeWire = fakeWire(), over: Partial<TelegramDispatchDeps> = {}) {
  const log = fakeLog();
  const failed: unknown[] = [];
  createTelegramDispatch({
    subscribe: log.subscribe,
    read: log.read,
    wireOf: (c) => (c === "700100" ? wire : undefined),
    setDelivery: log.setDelivery,
    onError: (_e, err) => failed.push(err),
    ...over,
  });
  return { log, wire, failed };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const sends = (wire: FakeWire) =>
  wire.calls.filter((c) => c.op === "send").map((c) => c.args as [string, TgOutbound]);

Deno.test("telegram dispatch: a text goes out as entities; the id backfills in the ingest's spelling", async () => {
  const { log, wire } = harness();
  log.push(outbound());
  await settle();
  assertEquals(sends(wire), [["700200", {
    text: "dale, nos vemos",
    entities: [{ type: "bold", offset: 10, length: 5 }],
  }]]);
  const patch = log.patches[0].patch;
  assertEquals(patch.external_id, "telegram:700100.501");
  assertEquals(patch.sender, { address: "700100", name: "Ana Paz" });
  assertEquals(patch.conversation, undefined);
  assertEquals(patch.status?.state, "dispatched");
});

Deno.test("telegram dispatch: a reply names the message it answers; a supergroup's id carries its chat", async () => {
  const { log, wire } = harness();
  log.push(outbound({
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "-1009000", kind: "group" },
      status: "queued",
    },
    payload: { action: "reply", ref_external_id: "telegram:700100.-1009000.77" },
  }));
  await settle();
  assertEquals(sends(wire)[0][1].reply, 77);
  assertEquals(log.patches[0].patch.external_id, "telegram:700100.-1009000.501");
});

Deno.test("telegram dispatch: a first contact by handle moves the row to the chat it landed in", async () => {
  const { log, wire } = harness();
  log.push(outbound({
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "@solruiz" },
      status: "queued",
    },
  }));
  await settle();
  assertEquals(sends(wire)[0][0], "@solruiz");
  assertEquals(log.patches[0].patch.conversation, {
    address: "700200",
    kind: "direct",
    name: "Sol Ruiz",
  });
});

Deno.test("telegram dispatch: an @Name the directory claims is a mention by id", async () => {
  const { log, wire } = harness(fakeWire(), {
    directory: () => Promise.resolve([{ address: "700200", name: "Sol Ruiz" }]),
  });
  log.push(outbound({ parts: [{ type: "text", kind: "text", text: "gracias @Sol Ruiz" }] }));
  await settle();
  assertEquals(sends(wire)[0][1].entities, [
    { type: "mention_name", offset: 8, length: 9, user: "700200" },
  ]);
});

Deno.test("telegram dispatch: each file is a message, the first wearing the caption; then the pin and the card", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const storage = {
    get: () => Promise.resolve(bytes as Uint8Array<ArrayBuffer>),
  } as unknown as NonNullable<TelegramDispatchDeps["storage"]>;
  const { log, wire } = harness(fakeWire(), { storage });
  log.push(outbound({
    parts: [
      { type: "text", kind: "text", text: "los planos" },
      {
        type: "file",
        kind: "image",
        file: { mime_type: "image/png", uri: "storage://media/a.png", name: "a.png" },
      },
      {
        type: "file",
        kind: "document",
        file: { mime_type: "application/pdf", uri: "storage://media/b.pdf" },
      },
      { type: "data", kind: "location", data: { latitude: -32.89, longitude: -68.84 } },
      {
        type: "data",
        kind: "contacts",
        data: [{ name: { formatted_name: "Beto Paz" }, phones: [{ phone: "5492615550103" }] }],
      },
    ],
  }));
  await settle();
  const out = sends(wire).map(([, o]) => o);
  assertEquals(out.length, 4);
  assertEquals(out[0].text, "los planos");
  assertEquals(out[0].file, { bytes, mime: "image/png", kind: "image", name: "a.png" });
  assertEquals(out[1].text, undefined);
  assertEquals(out[1].file?.name, "b.pdf");
  assertEquals(out[2], { location: { latitude: -32.89, longitude: -68.84 } });
  assertEquals(out[3], { contact: { name: "Beto Paz", phone: "5492615550103" } });
  // the row is the first message
  assertEquals(log.patches[0].patch.external_id, "telegram:700100.501");
});

Deno.test("telegram dispatch: an edit, a delete and a reaction act on the message the row points at", async () => {
  const { log, wire } = harness();
  const ref = { ref_external_id: "telegram:700100.77" };
  log.push(outbound({
    payload: { action: "edit", ...ref },
    parts: [{ type: "text", kind: "text", text: "mejor *así*" }],
  }));
  log.push(outbound({ payload: { action: "delete", ...ref }, parts: [] }));
  log.push(outbound({
    payload: { action: "add", ...ref },
    parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
  }));
  log.push(outbound({
    payload: { action: "remove", ...ref },
    parts: [{ type: "data", kind: "reaction", data: { name: "👍" } }],
  }));
  await settle();
  assertEquals(wire.calls, [
    {
      op: "edit",
      args: ["700200", 77, "mejor así", [{ type: "italic", offset: 6, length: 3 }]],
    },
    { op: "delete", args: ["700200", [77]] },
    { op: "react", args: ["700200", 77, "👍"] },
    { op: "react", args: ["700200", 77, null] },
  ]);
  // a mutation mints no artifact of its own
  assert(log.patches.every((p) => p.patch.external_id === undefined));
  assert(log.patches.every((p) => p.patch.status?.state === "dispatched"));
});

Deno.test("telegram dispatch: Telegram's refusal stamps the row with its class; no session is a 503", async () => {
  const wire = fakeWire({
    send: () => Promise.reject(new DispatchError("FLOOD_WAIT_30", 429)),
  });
  const { log, failed } = harness(wire);
  log.push(outbound());
  await settle();
  assertEquals(log.patches[0].patch.status?.state, "failed");
  assertEquals(log.patches[0].patch.status?.error_code, 429);
  assertEquals(failed.length, 1);

  log.push(outbound({
    envelope: {
      service: "telegram",
      connection_address: "999",
      conversation: { address: "700200" },
      status: "queued",
    },
  }));
  await settle();
  assertEquals(log.patches[1].patch.status?.error_code, 503);
  assertStringIncludes(String(log.patches[1].patch.status?.error), "no Telegram session");
});

Deno.test("telegram dispatch: a file whose bytes are gone fails the send before anything is posted", async () => {
  const storage = {
    get: () => Promise.resolve(null),
  } as unknown as NonNullable<TelegramDispatchDeps["storage"]>;
  const { log, wire } = harness(fakeWire(), { storage });
  log.push(outbound({
    parts: [{
      type: "file",
      kind: "image",
      file: { mime_type: "image/png", uri: "storage://media/x.png" },
    }],
  }));
  await settle();
  assertEquals(sends(wire), []);
  assertEquals(log.patches[0].patch.status?.error_code, 400);
  void SOL;
});
