import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDispatcher, isOutbound } from "./dispatcher.ts";
import { DispatchError } from "./errors.ts";
import type { DeliveryPatch, Subscriber } from "../store/log.ts";
import type { Draft, Event, EventId, MessageEvent } from "../types.ts";
import { newId } from "../store/id.ts";

/** A hand-cranked subscription: capture the listener, push events by hand. `queued` is
 *  what the opening read answers — the offers standing before the dispatcher existed. */
function fakeLog(queued: Event[] = []) {
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
    read: () => Promise.resolve(queued),
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
  ts: "2026-09-04T12:00:00Z",
  type: "message",
  agent: { id: "a1", session_id: "s1" },
  envelope: {
    service: "github",
    connection_address: "conn",
    conversation: { address: "room" },
    status: "queued",
  },
  status: { state: "queued", queued_at: "2026-09-04T12:00:00Z" },
  parts: [{ type: "text", kind: "text", text: "hola" }],
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("dispatcher: only the service's outbound rows select — the world's and other services' never", () => {
  const ours = { ...outbound(), id: "1" } as Event;
  assertEquals(isOutbound(ours, "github"), true);
  assertEquals(isOutbound(ours, "slack"), false);
  const world = { ...outbound({ agent: undefined }), id: "2" } as Event;
  assertEquals(isOutbound(world, "github"), false);
  const echoed = {
    ...outbound({ envelope: { ...outbound().envelope, external_id: "svc:9" } }),
    id: "3",
  } as Event;
  assertEquals(isOutbound(echoed, "github"), false); // already on the wire
});

Deno.test("dispatcher: a post's answer backfills external_id + sender beside dispatched_at; onSent gets the wire id", async () => {
  const log = fakeLog();
  const sent: [string, string | undefined][] = [];
  createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: (e) => (e.parts[0] as { text: string }).text,
    post: (text) =>
      Promise.resolve({ id: `w-${text}`, external_id: `svc:w-${text}`, sender: { address: "me" } }),
    setDelivery: log.setDelivery,
    onSent: (e, id) => sent.push([e.id, id]),
  });
  log.push(outbound({ id: "e1" }));
  await settle();
  assertEquals(log.patches.length, 1);
  assertEquals(log.patches[0].id, "e1");
  assertEquals(log.patches[0].patch.external_id, "svc:w-hola");
  assertEquals(log.patches[0].patch.sender, { address: "me" });
  assertEquals(typeof log.patches[0].patch.status?.dispatched_at, "string");
  assertEquals(sent, [["e1", "w-hola"]]);
});

Deno.test("dispatcher: a select of null is nothing to send — no post, no stamp", async () => {
  const log = fakeLog();
  let posts = 0;
  createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: () => null,
    post: () => {
      posts++;
      return Promise.resolve({});
    },
    setDelivery: log.setDelivery,
  });
  log.push(outbound());
  await settle();
  assertEquals(posts, 0);
  assertEquals(log.patches.length, 0);
});

Deno.test("dispatcher: a throwing post ALWAYS stamps failed (error_code when it has a class) and reports", async () => {
  const log = fakeLog();
  const failed: unknown[] = [];
  const answers = [
    () => Promise.reject(new DispatchError("HTTP 503", 503)),
    () => Promise.reject(new TypeError("connection refused")),
    () => Promise.resolve({ id: "ok" }),
  ];
  createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: () => "x",
    post: () => answers.shift()!(),
    setDelivery: log.setDelivery,
    onError: (_e, err) => failed.push(err),
  });
  log.push(outbound({ id: "e1" }));
  log.push(outbound({ id: "e2" }));
  log.push(outbound({ id: "e3" }));
  await settle();
  assertEquals(failed.length, 2);
  // serialized: the stamps land in publish order, and a failure never blocks the next send
  assertEquals(log.patches.map((p) => p.id), ["e1", "e2", "e3"]);
  const [a, b, c] = log.patches.map((p) => p.patch.status!);
  assertEquals(a.state, "failed");
  assertEquals(a.error_code, 503);
  assertStringIncludes(String(a.error), "HTTP 503");
  assertEquals(b.state, "failed");
  assertEquals(b.error_code, null); // no class — and the merge removes any earlier one
  assertEquals(c.state, "dispatched");
  assertEquals(typeof c.dispatched_at, "string");
});

Deno.test("dispatcher: a stamp that itself fails still reaches onError", async () => {
  const log = fakeLog();
  const failed: unknown[] = [];
  createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: () => "x",
    post: () => Promise.reject(new Error("boom")),
    setDelivery: () => Promise.reject(new Error("db closed")),
    onError: (_e, err) => failed.push(err),
  });
  log.push(outbound());
  await settle();
  assertEquals(failed.length, 1);
  assertEquals((failed[0] as Error).message, "boom");
});

/** The row as the update stream hands it back: `envelope.status` mirrors `status.state`. */
const staged = (id: string, status: MessageEvent["status"]): Draft<MessageEvent> =>
  outbound({
    id,
    status,
    envelope: { ...outbound().envelope, ...(status?.state ? { status: status.state } : {}) },
  });

Deno.test("dispatcher: the lifecycle gates the offer — queued selects; unstamped, dispatched or failed never", () => {
  const offered = staged("2", { state: "queued", queued_at: "2026-09-04T12:01:00Z" }) as Event;
  assertEquals(isOutbound(offered, "github"), true);
  // no lifecycle: a row the store never offered (the mind's own `local` traffic is one)
  const { status: _s, ...bare } = outbound();
  const unstamped = {
    ...bare,
    id: "1",
    envelope: { service: "github", connection_address: "conn", conversation: { address: "room" } },
  } as Event;
  assertEquals(isOutbound(unstamped, "github"), false);
  // on the wire without an artifact of its own (a reaction): dispatched, no external_id
  const reacted = staged("3", { state: "dispatched", dispatched_at: "…" }) as Event;
  assertEquals(isOutbound(reacted, "github"), false);
  const failed = staged("4", { state: "failed", failed_at: "…" }) as Event;
  assertEquals(isOutbound(failed, "github"), false);
});

Deno.test("dispatcher: a re-offer posts again; the same offer repeated does not (one offer, one post)", async () => {
  const log = fakeLog();
  const answers = [
    () => Promise.reject(new DispatchError("HTTP 503", 503)),
    () => Promise.resolve({ id: "ok" }),
    () => Promise.resolve({ id: "again?" }),
  ];
  let posts = 0;
  createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: () => "x",
    post: () => {
      posts++;
      return answers.shift()!();
    },
    setDelivery: log.setDelivery,
  });
  log.push(outbound({ id: "e1" }));
  await settle();
  assertEquals(posts, 1);
  assertEquals(log.patches[0].patch.status?.state, "failed");
  // the sweeper moved it back to queued: the stream hands the row over again
  const offer = staged("e1", { state: "queued", queued_at: "2026-09-04T12:05:00Z", attempts: 1 });
  log.push(offer);
  await settle();
  assertEquals(posts, 2);
  assertEquals(log.patches[1].patch.status?.state, "dispatched");
  // the same offer seen again (at-least-once delivery): this process already posted it
  log.push(offer);
  await settle();
  assertEquals(posts, 2);
  // a newborn row seen twice is one offer too
  log.push(outbound({ id: "e2" }));
  log.push(outbound({ id: "e2" }));
  await settle();
  assertEquals(posts, 3);
});

Deno.test("dispatcher: it opens on the offers standing before it existed — read off the rows, posted once", async () => {
  const standing = { ...outbound(), id: "old" } as Event;
  const log = fakeLog([
    standing,
    {
      ...outbound({ envelope: { ...outbound().envelope, service: "slack" } }),
      id: "theirs",
    } as Event,
  ]);
  const posted: string[] = [];
  const stop = createDispatcher<string>({
    subscribe: log.subscribe,
    read: log.read,
    service: "github",
    select: (e) => e.id,
    post: (work) => {
      posted.push(work);
      return Promise.resolve({ id: "ok" });
    },
    setDelivery: log.setDelivery,
  });
  // the stream hands the same row over while the read is in flight: one offer, one post
  log.push(standing);
  await stop();
  assertEquals(posted, ["old"]);
  assertEquals(log.patches.map((p) => [p.id, p.patch.status?.state]), [["old", "dispatched"]]);
});
