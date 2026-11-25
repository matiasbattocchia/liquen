import { assertEquals, assertRejects } from "@std/assert";
import type { ConnectionRow } from "../store/connections.ts";
import { removeConnection, type RemoveDeps } from "./remove.ts";

/** The map, the vault and the catalog as plain values, and what each call did to them. */
function fake(rows: ConnectionRow[], keys: string[], enabled: string[], waiting = 0) {
  const state = {
    rows: [...rows],
    keys: [...keys],
    enabled: [...enabled],
    abandoned: [] as string[],
  };
  const deps: RemoveDeps = {
    store: {
      connections: () => Promise.resolve([...state.rows]),
      deleteConnections: (gone) => {
        state.rows = state.rows.filter((r) =>
          !gone.some((g) => g.service === r.service && g.address === r.address)
        );
        return Promise.resolve();
      },
      abandon: (service, connection) => {
        state.abandoned.push(`${service}:${connection}`);
        return Promise.resolve(waiting);
      },
    },
    creds: {
      list: () => Promise.resolve(state.keys.map((key) => ({ key, value: {} }))),
      delete: (key) => {
        const had = state.keys.includes(key);
        state.keys = state.keys.filter((k) => k !== key);
        return Promise.resolve(had);
      },
    },
    disable: (service: string) => {
      const had = state.enabled.includes(service);
      state.enabled = state.enabled.filter((s) => s !== service);
      return Promise.resolve(had);
    },
    services: ["slack", "google", "token"],
  };
  return { state, deps };
}

Deno.test("a connection goes with its secret, and its last one disables the service", async () => {
  const { state, deps } = fake(
    [
      { service: "google", address: "ana@x.io", agentId: "ana", credentialKey: "google:ana@x.io" },
      { service: "slack", address: "T1", credentialKey: "slack:T1:org" },
    ],
    ["google:ana@x.io", "slack:T1:org", "media:sign"],
    ["google", "slack"],
  );
  const said = await removeConnection("google:ana@x.io", deps);
  assertEquals(
    said.at(-1),
    "google itself still holds the grant — revoke it in the account's third-party access " +
      "(myaccount.google.com/connections) to end it",
  );
  assertEquals(state.rows.map((r) => r.service), ["slack"]);
  assertEquals(state.keys, ["slack:T1:org", "media:sign"]);
  assertEquals(state.enabled, ["slack"]);
  assertEquals(
    said.includes("no google connection is left: connections.google is disabled, its knobs kept"),
    true,
  );
});

Deno.test("the sends still waiting on a removed connection are given up, and the removal says how many", async () => {
  const { state, deps } = fake(
    [{ service: "slack", address: "T1", credentialKey: "slack:T1:org" }],
    ["slack:T1:org"],
    ["slack"],
    254,
  );
  const said = await removeConnection("slack:T1", deps);
  assertEquals(state.abandoned, ["slack:T1"]);
  assertEquals(said[1], "254 sends still waiting on it will not go out, now or at a sign-in");
  // none waiting, nothing said of them
  const quiet = fake(
    [{ service: "slack", address: "T1", credentialKey: "slack:T1:org" }],
    ["slack:T1:org"],
    ["slack"],
  );
  const words = await removeConnection("slack:T1", quiet.deps);
  assertEquals(words.some((w) => w.includes("will not go out")), false);
});

Deno.test("a secret another live connection authenticates with stays, and the service stays on", async () => {
  const { state, deps } = fake(
    [
      { service: "slack", address: "T1", credentialKey: "slack:T1:org" },
      { service: "slack", address: "T1:bot", credentialKey: "slack:T1:org" },
    ],
    ["slack:T1:org"],
    ["slack"],
  );
  const said = await removeConnection("slack:T1:bot", deps);
  assertEquals(state.rows.map((r) => r.address), ["T1"]);
  assertEquals(state.keys, ["slack:T1:org"]);
  assertEquals(state.enabled, ["slack"]);
  assertEquals(said[1], "its secret slack:T1:org stays — slack:T1 uses it too");
});

Deno.test("a token grant is its vault key; a connection's secret and the harness's own are not targets", async () => {
  const { state, deps } = fake(
    [{ service: "slack", address: "T1", credentialKey: "slack:T1:org" }],
    ["token:openai", "slack:T1:org", "media:sign"],
    ["slack"],
  );
  assertEquals(await removeConnection("token:openai", deps), ["token:openai is out of the vault"]);
  await assertRejects(
    () => removeConnection("slack:T1:org", deps),
    Error,
    "is the secret of slack:T1 — remove the connection",
  );
  await assertRejects(
    () => removeConnection("media:sign", deps),
    Error,
    "removable: slack:T1",
  );
  assertEquals(state.keys, ["slack:T1:org", "media:sign"]);
  assertEquals(state.rows.length, 1);
});

Deno.test("a connector that can end the platform's side does, while the secret still stands", async () => {
  const row = { service: "telegram", address: "700100", credentialKey: "telegram:700100" };
  const { state, deps } = fake([row], ["telegram:700100"], ["telegram"]);
  const seen: string[][] = [];
  deps.end = (r) => {
    seen.push([r.address, ...state.keys]);
    return Promise.resolve("its session on Telegram is ended");
  };
  const said = await removeConnection("telegram:700100", deps);
  assertEquals(seen, [["700100", "telegram:700100"]]);
  assertEquals(said.at(-1), "its session on Telegram is ended");
  assertEquals(state.keys, []);
});

Deno.test("an end that failed says so and where to revoke; one with nothing to end says the usual", async () => {
  const row = { service: "telegram", address: "700100", credentialKey: "telegram:700100" };
  const failing = fake([row], ["telegram:700100"], []);
  failing.deps.end = () => Promise.reject(new Error("FLOOD_WAIT_30"));
  assertEquals(
    (await removeConnection("telegram:700100", failing.deps)).at(-1),
    "telegram could not be reached to end it (FLOOD_WAIT_30) — revoke it in the account's " +
      "devices (Telegram → Settings → Devices)",
  );
  assertEquals(failing.state.rows, []);
  const other = fake(
    [{ service: "slack", address: "T1", credentialKey: "slack:T1:org" }],
    ["slack:T1:org"],
    [],
  );
  other.deps.end = () => Promise.resolve(undefined);
  assertEquals(
    (await removeConnection("slack:T1", other.deps)).at(-1),
    "slack itself still holds the grant — revoke it in the workspace's installed apps " +
      "(Settings → Manage apps) to end it",
  );
});
