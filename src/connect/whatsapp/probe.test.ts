import { assertEquals } from "@std/assert";
import { bridgeStatus, createBridgeProbe, MISSES } from "./probe.ts";
import type { ConnectionRow } from "../../store/connections.ts";

/** The connections map as the probe reads and writes it: `extra` merges, a null drops. */
function map(rows: ConnectionRow[]) {
  const byKey = new Map(rows.map((r) => [`${r.service}:${r.address}`, r]));
  return {
    connections: () => Promise.resolve([...byKey.values()]),
    upsertConnections: (put: ConnectionRow[]) => {
      for (const r of put) {
        const was = byKey.get(`${r.service}:${r.address}`);
        const extra = { ...was?.extra, ...r.extra };
        for (const [k, v] of Object.entries(extra)) if (v === null) delete extra[k];
        byKey.set(`${r.service}:${r.address}`, { ...was, ...r, extra });
      }
      return Promise.resolve();
    },
    state: (address: string) => byKey.get(`whatsapp:${address}`)?.extra?.state,
    extra: (address: string) => byKey.get(`whatsapp:${address}`)?.extra ?? {},
  };
}

const T = "2026-10-20T12:00:00.000Z";

Deno.test("probe: a bridge silent MISSES rounds running marks its sessions bridge_down", async () => {
  const store = map([
    { service: "whatsapp", address: "549111", extra: { state: "connected" } },
    { service: "whatsapp", address: "549222", extra: { state: "signed_out" } },
    { service: "slack", address: "T1", extra: { state: "connected" } },
  ]);
  let asked = 0;
  const probe = createBridgeProbe({
    status: () => {
      asked++;
      return Promise.reject(new Error("connection refused"));
    },
    store,
    now: () => T,
  });
  for (let i = 1; i < MISSES; i++) await probe.tick();
  assertEquals(store.state("549111"), "connected"); // a restart passes without a word
  await probe.tick();
  // the outermost broken piece is what the rows say: nothing past the bridge is known
  assertEquals(store.state("549111"), "bridge_down");
  assertEquals(store.extra("549111").bridge_down_at, T);
  assertEquals(store.state("549222"), "bridge_down");
  assertEquals((await store.connections())[2].extra?.state, "connected"); // not WhatsApp's
  assertEquals(asked, MISSES); // one silence per round is the bridge's
});

Deno.test("probe: the bridge's first answer sets each session to its word", async () => {
  const store = map([
    { service: "whatsapp", address: "549111", extra: { state: "bridge_down" } },
    { service: "whatsapp", address: "549222", extra: { state: "bridge_down" } },
    { service: "whatsapp", address: "549333", extra: { state: "bridge_down" } },
    { service: "whatsapp", address: "549444", extra: { state: "unavailable" } },
  ]);
  const said: Record<string, { connected: boolean } | null> = {
    "549111": { connected: true },
    "549222": { connected: false },
    "549333": null,
    "549444": { connected: true },
  };
  let answered = 0;
  const probe = createBridgeProbe({
    status: (a) => Promise.resolve(said[a]),
    store,
    now: () => T,
    onAnswered: () => answered++,
  });
  await probe.tick();
  assertEquals(store.state("549111"), "connected");
  assertEquals(store.extra("549111").connected_at, T);
  assertEquals(store.state("549222"), "unavailable");
  assertEquals(store.state("549333"), "signed_out"); // a session the bridge does not hold
  assertEquals(store.state("549444"), "connected");
  assertEquals(answered, 1);
});

Deno.test("probe: an answered round sets a row the bridge disagrees with to its word, and keeps the since of one it agrees with", async () => {
  const store = map([
    // the map kept it after the bridge forgot it (a device unlinked while nobody heard)
    { service: "whatsapp", address: "549111", extra: { state: "connected" } },
    {
      service: "whatsapp",
      address: "549222",
      extra: { state: "unavailable", unavailable_at: "x" },
    },
    { service: "whatsapp", address: "549333", extra: { state: "suspended", suspended_at: "y" } },
    // a re-paired number the row still calls signed out
    { service: "whatsapp", address: "549444", extra: { state: "signed_out" } },
  ]);
  const said: Record<string, { connected: boolean } | null> = {
    "549111": null,
    "549222": { connected: false },
    "549333": { connected: false },
    "549444": { connected: true },
  };
  const probe = createBridgeProbe({ status: (a) => Promise.resolve(said[a]), store, now: () => T });
  await probe.tick();
  assertEquals(store.state("549111"), "signed_out");
  assertEquals(store.extra("549222").unavailable_at, "x"); // agreed: the since stays
  assertEquals(store.extra("549333").suspended_at, "y"); // a ban is truer than not connected
  assertEquals(store.state("549444"), "connected");
});

Deno.test("bridgeStatus: 404 is a session it does not hold, a refusal is a bridge not there", async () => {
  const answer = (status: number, body = "{}") => () =>
    Promise.resolve(new Response(body, { status }));
  const seen: string[] = [];
  const ok = bridgeStatus(
    "http://b",
    "tok",
    ((url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return Promise.resolve(new Response('{"connected":true}'));
    }) as typeof fetch,
  );
  assertEquals(await ok("549 111"), { connected: true });
  assertEquals(seen, ["http://b/sessions/549%20111 Bearer tok"]);
  assertEquals(await bridgeStatus("http://b", "t", answer(404) as typeof fetch)("549"), null);
  let threw = false;
  await bridgeStatus("http://b", "t", answer(401) as typeof fetch)("549").catch(() => threw = true);
  assertEquals(threw, true);
});
