import { assertEquals } from "@std/assert";
import { type Log, openLog } from "./log.ts";
import { RETRY_BACKOFF_MS } from "./sweep.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";

// a clock of its own, far past any real stamp the store writes while the test runs
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

async function withLog(fn: (log: Log) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.upsertConnections([{ service: "slack", address: "T1", agentId: "ana" }]);
    await fn(log);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const outbound = (text: string): Draft<MessageEvent> => ({
  ts: iso(T0 - 10 * MIN),
  type: "message",
  agent: { id: "ana", session_id: "mind" },
  envelope: { service: "slack", connection_address: "T1", conversation: { address: "C1" } },
  parts: [{ type: "text", kind: "text", text }],
});

/** Our row, failed `ago` before T0 with `attempts` re-offers behind it. */
async function failed(
  log: Log,
  code: number | undefined,
  ago: number,
  attempts = 0,
): Promise<string> {
  const e = (await log.publish(outbound(`m-${code}-${ago}-${attempts}`)))!;
  await log.setDelivery(e.id, {
    status: {
      state: "failed",
      failed_at: iso(T0 - ago),
      error: "boom",
      error_code: code ?? null,
      ...(attempts ? { attempts } : {}),
    },
  });
  return e.id;
}

const row = async (log: Log, id: string): Promise<Event> =>
  (await log.read()).find((e) => e.id === id)!;

Deno.test("a transient failure past its rung is offered again: queued, stamped, counted — the failure stays as history", async () => {
  await withLog(async (log) => {
    const id = await failed(log, 503, 2 * MIN);
    assertEquals(log.sweep(iso(T0)), 1);
    const e = await row(log, id);
    assertEquals(e.envelope.status, "queued");
    assertEquals(e.status?.state, "queued");
    assertEquals(e.status?.queued_at, iso(T0));
    assertEquals(e.status?.attempts, 1);
    assertEquals(e.status?.failed_at, iso(T0 - 2 * MIN));
    assertEquals(e.status?.error_code, 503);
    // offered: nothing more to do until it fails again
    assertEquals(log.sweep(iso(T0 + MIN)), 0);
  });
});

Deno.test("the class decides: 4xx stays failed; 429 and a failure with no class go again", async () => {
  await withLog(async (log) => {
    const refused = await failed(log, 422, 5 * MIN);
    const limited = await failed(log, 429, 5 * MIN);
    const unreached = await failed(log, undefined, 5 * MIN);
    assertEquals(log.sweep(iso(T0)), 2);
    assertEquals((await row(log, refused)).envelope.status, "failed");
    assertEquals((await row(log, limited)).envelope.status, "queued");
    assertEquals((await row(log, unreached)).envelope.status, "queued");
  });
});

Deno.test("the ladder: each re-offer waits its own rung, and the last rung is the ceiling", async () => {
  await withLog(async (log) => {
    // one re-offer behind it ⇒ the second rung (5 min) governs
    const early = await failed(log, 503, 2 * MIN, 1);
    const due = await failed(log, 503, 6 * MIN, 1);
    // every rung spent ⇒ never again, however old
    const spent = await failed(log, 503, 48 * 60 * MIN, RETRY_BACKOFF_MS.length);
    assertEquals(log.sweep(iso(T0)), 1);
    assertEquals((await row(log, early)).envelope.status, "failed");
    assertEquals((await row(log, due)).status?.attempts, 2);
    assertEquals((await row(log, spent)).envelope.status, "failed");
  });
});

Deno.test("a failure the wire reported after naming the artifact is not the harness's to retry", async () => {
  await withLog(async (log) => {
    const e = (await log.publish(outbound("named")))!;
    await log.setDelivery(e.id, {
      external_id: "slack:T1:C1:1.0",
      status: { state: "failed", failed_at: iso(T0 - 5 * MIN), error: "bounced", error_code: null },
    });
    assertEquals(log.sweep(iso(T0)), 0);
  });
});

Deno.test("an offer nobody took stands in the row: a dispatcher opening later reads it, and the sweep does not repeat it", async () => {
  await withLog(async (log) => {
    const id = await failed(log, 503, 2 * MIN);
    assertEquals(log.sweep(iso(T0)), 1);
    // a dispatcher that comes up now starts its update stream live: the re-offer is behind it
    const seen: Event[] = [];
    const off = log.subscribe((e) => seen.push(e), { updates: true });
    await new Promise((r) => setTimeout(r, 400));
    off();
    assertEquals(seen.length, 0);
    // what it opens on instead
    const standing = await log.read({ service: "slack", types: ["message"], state: "queued" });
    assertEquals(standing.map((e) => [e.id, e.status?.queued_at]), [[id, iso(T0)]]);
    assertEquals(log.sweep(iso(T0 + 60 * MIN)), 0);
  });
});

Deno.test("the re-offer rides the update stream to a subscriber that asked — and to no one else", async () => {
  await withLog(async (log) => {
    const id = await failed(log, 503, 2 * MIN);
    const offers: Event[] = [];
    const wakes: Event[] = [];
    const offOffers = log.subscribe((e) => offers.push(e), { updates: true });
    const offWakes = log.subscribe((e) => wakes.push(e));
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(log.sweep(iso(T0)), 1);
    await new Promise((r) => setTimeout(r, 400));
    offOffers();
    offWakes();
    assertEquals(offers.map((e) => [e.id, e.envelope.status]), [[id, "queued"]]);
    assertEquals(wakes.length, 0); // a state move is not news
  });
});

Deno.test("presence is never re-offered: ephemera fails once, quietly", async () => {
  await withLog(async (log) => {
    const e = (await log.publish({ ...outbound("[thinking...]"), extra: { delta: true } }))!;
    await log.setDelivery(e.id, {
      status: { state: "failed", failed_at: iso(T0 - 10 * MIN), error: "boom" },
    });
    // a transient failure with no class, ten minutes past the first rung — an ordinary
    // row would go again; this one is only true while its turn runs
    assertEquals(log.sweep(iso(T0)), 0);
    assertEquals((await row(log, e.id)).status?.state, "failed");
  });
});
