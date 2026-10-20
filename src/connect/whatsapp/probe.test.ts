import { assertEquals } from "@std/assert";
import { bridgeStatus, createBridgeProbe, MISSES } from "./probe.ts";
import type { ConnectionRow } from "../../store/connections.ts";

/** The connections map as the probe reads and writes it: `extra` merges. */
function map(rows: ConnectionRow[]) {
  const byKey = new Map(rows.map((r) => [`${r.service}:${r.address}`, r]));
  return {
    connections: () => Promise.resolve([...byKey.values()]),
    upsertConnections: (put: ConnectionRow[]) => {
      for (const r of put) {
        const was = byKey.get(`${r.service}:${r.address}`);
        byKey.set(`${r.service}:${r.address}`, {
          ...was,
          ...r,
          extra: { ...was?.extra, ...r.extra },
        });
      }
      return Promise.resolve();
    },
    state: (address: string) => byKey.get(`whatsapp:${address}`)?.extra?.state,
  };
}

const T = "2026-10-20T12:00:00.000Z";

Deno.test("probe: a bridge silent MISSES rounds running marks its sessions unreachable; a logged-out one stays the bridge's", async () => {
  const store = map([
    { service: "whatsapp", address: "549111", extra: { state: "connected" } },
    { service: "whatsapp", address: "549222", extra: { state: "logged_out" } },
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
  assertEquals(store.state("549111"), "bridge_unreachable");
  assertEquals((await store.connections())[0].extra?.bridge_unreachable_at, T);
  assertEquals(store.state("549222"), "logged_out");
  assertEquals((await store.connections())[2].extra?.state, "connected"); // not WhatsApp's
  assertEquals(asked, MISSES); // one silence per round is the bridge's
});

Deno.test("probe: the bridge's first answer takes the mark back, with the state it gives each session", async () => {
  const store = map([
    { service: "whatsapp", address: "549111", extra: { state: "bridge_unreachable" } },
    { service: "whatsapp", address: "549222", extra: { state: "bridge_unreachable" } },
    { service: "whatsapp", address: "549333", extra: { state: "bridge_unreachable" } },
    { service: "whatsapp", address: "549444", extra: { state: "disconnected" } },
  ]);
  const said: Record<string, { connected: boolean } | null> = {
    "549111": { connected: true },
    "549222": { connected: false },
    "549333": null,
    "549444": { connected: true },
  };
  let answered = 0;
  const probe = createBridgeProbe({
    status: (address) => Promise.resolve(said[address]),
    store,
    now: () => T,
    onAnswered: () => answered++,
  });
  await probe.tick();
  assertEquals(
    ["549111", "549222", "549333", "549444"].map(store.state),
    ["connected", "disconnected", "unpaired", "connected"],
  );
  assertEquals(answered, 1);
});

Deno.test("probe: an answered round sets a row the bridge disagrees with to its word; logged out stays the bridge's", async () => {
  const store = map([
    // the map kept it, the bridge lost it: it says connected while nothing flows
    { service: "whatsapp", address: "549111", extra: { state: "connected" } },
    { service: "whatsapp", address: "549222", extra: { state: "connected" } },
    { service: "whatsapp", address: "549333", extra: { state: "logged_out" } },
  ]);
  const writes: string[] = [];
  const probe = createBridgeProbe({
    status: (address) => Promise.resolve(address === "549222" ? { connected: true } : null),
    store: {
      ...store,
      upsertConnections: (rows) => {
        writes.push(...rows.map((r) => r.address));
        return store.upsertConnections(rows);
      },
    },
  });
  await probe.tick();
  assertEquals(["549111", "549222", "549333"].map(store.state), [
    "unpaired",
    "connected",
    "logged_out",
  ]);
  assertEquals(writes, ["549111"]); // only where the row said otherwise
  await probe.tick();
  assertEquals(writes, ["549111"]);
});

Deno.test("probe: one answered round between silences starts the count again", async () => {
  const store = map([{ service: "whatsapp", address: "549111", extra: { state: "connected" } }]);
  let up = false;
  const probe = createBridgeProbe({
    status: () => up ? Promise.resolve({ connected: true }) : Promise.reject(new Error("down")),
    store,
  });
  for (let i = 1; i < MISSES; i++) await probe.tick();
  up = true;
  await probe.tick();
  up = false;
  for (let i = 1; i < MISSES; i++) await probe.tick();
  assertEquals(store.state("549111"), "connected");
});

Deno.test("bridgeStatus: the session's state on 200, null on 404, a throw on any other answer", async () => {
  const calls: string[] = [];
  const fake =
    (status: number, body = "{}") => (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      return Promise.resolve(new Response(body, { status }));
    };
  assertEquals(
    await bridgeStatus("http://b", "tok", fake(200, '{"connected":true}') as typeof fetch)("549 1"),
    { connected: true },
  );
  assertEquals(calls, ["http://b/sessions/549%201 Bearer tok"]);
  assertEquals(await bridgeStatus("http://b", "tok", fake(404) as typeof fetch)("549111"), null);
  let threw = false;
  await bridgeStatus("http://b", "tok", fake(502) as typeof fetch)("549111").catch(() =>
    threw = true
  );
  assertEquals(threw, true);
});
