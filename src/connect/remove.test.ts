import { assertEquals, assertRejects } from "@std/assert";
import type { ConnectionRow } from "../store/connections.ts";
import { removeConnection, type RemoveDeps } from "./remove.ts";

/** The map, the vault and the catalog as plain values, and what each call did to them. */
function fake(rows: ConnectionRow[], keys: string[], declared: string[]) {
  const state = { rows: [...rows], keys: [...keys], declared: [...declared] };
  const deps: RemoveDeps = {
    store: {
      connections: () => Promise.resolve([...state.rows]),
      deleteConnections: (gone) => {
        state.rows = state.rows.filter((r) =>
          !gone.some((g) => g.service === r.service && g.address === r.address)
        );
        return Promise.resolve();
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
    undeclare: (service) => {
      const had = state.declared.includes(service);
      state.declared = state.declared.filter((s) => s !== service);
      return Promise.resolve(had);
    },
    services: ["slack", "google", "token"],
  };
  return { state, deps };
}

Deno.test("a connection goes with its secret, and the service's section with its last one", async () => {
  const { state, deps } = fake(
    [
      { service: "google", address: "ana@x.io", agentId: "ana", credentialKey: "google:ana@x.io" },
      { service: "slack", address: "T1", credentialKey: "slack:T1:org" },
    ],
    ["google:ana@x.io", "slack:T1:org", "media:sign"],
    ["google", "slack"],
  );
  await removeConnection("google:ana@x.io", deps);
  assertEquals(state.rows.map((r) => r.service), ["slack"]);
  assertEquals(state.keys, ["slack:T1:org", "media:sign"]);
  assertEquals(state.declared, ["slack"]);
});

Deno.test("a secret another live connection authenticates with stays, and so does the section", async () => {
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
  assertEquals(state.declared, ["slack"]);
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
