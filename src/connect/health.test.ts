import { assertEquals } from "@std/assert";
import { beat, linked, rowsOf, setState } from "./health.ts";
import { type Log, openLog } from "../store/log.ts";

async function withLog(fn: (log: Log) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await fn(log);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const extraOf = async (log: Log, address: string) =>
  (await log.connections()).find((r) => r.address === address)?.extra ?? {};

Deno.test("setState: stamps the moment a row moves, never again while it stays", async () => {
  await withLog(async (log) => {
    const row = { service: "google", address: "ana@x.io" };
    await log.upsertConnections([row]);
    assertEquals(await setState(log, row, "failing", { error: "503", now: "T1" }), true);
    assertEquals(await setState(log, row, "failing", { error: "503", now: "T2" }), false);
    assertEquals(await extraOf(log, "ana@x.io"), {
      state: "failing",
      failing_at: "T1",
      error: "503",
    });
    // a new reason rides along without moving the since
    await setState(log, row, "failing", { error: "429", now: "T3" });
    assertEquals((await extraOf(log, "ana@x.io")).failing_at, "T1");
    assertEquals((await extraOf(log, "ana@x.io")).error, "429");
    // up again: stamped, and no reason left standing
    await setState(log, row, "connected", { now: "T4" });
    const up = await extraOf(log, "ana@x.io");
    assertEquals(up.state, "connected");
    assertEquals(up.connected_at, "T4");
    assertEquals(up.error, undefined);
  });
});

Deno.test("setState: a removed connection stays removed — no state revives it", async () => {
  await withLog(async (log) => {
    const row = { service: "whatsapp", address: "549" };
    await log.upsertConnections([row]);
    await log.deleteConnections([row]);
    assertEquals(await setState(log, row, "signed_out"), false);
    assertEquals(await log.connections(), []);
  });
});

Deno.test("rowsOf: the rows a refused credential authenticates, else the one the refusal came through", async () => {
  await withLog(async (log) => {
    await log.upsertConnections([
      { service: "github", address: "github", credentialKey: "github:org" },
      { service: "github", address: "ana-dev", agentId: "ana", credentialKey: "github:ana" },
    ]);
    const by = async (at: { key?: string; address?: string }) =>
      (await rowsOf(log, "github", at)).map((r) => r.address);
    assertEquals(await by({ key: "github:ana", address: "github" }), ["ana-dev"]);
    assertEquals(await by({ key: "github:gone", address: "github" }), ["github"]);
    assertEquals(await by({ address: "github" }), ["github"]);
  });
});

Deno.test("beat: heard_at on every live row of the service, and on nobody else's", async () => {
  await withLog(async (log) => {
    await log.upsertConnections([
      { service: "slack", address: "T1", extra: { state: "connected" } },
      { service: "slack", address: "T1:U1" },
      { service: "google", address: "ana@x.io" },
    ]);
    await beat(log, "slack", "T9");
    assertEquals(await extraOf(log, "T1"), { state: "connected", heard_at: "T9" });
    assertEquals((await extraOf(log, "T1:U1")).heard_at, "T9");
    assertEquals((await extraOf(log, "ana@x.io")).heard_at, undefined);
  });
});

Deno.test("linked: a door's row is up, with no reason left standing from before", async () => {
  await withLog(async (log) => {
    const row = { service: "google", address: "ana@x.io" };
    await log.upsertConnections([row]);
    await setState(log, row, "signed_out", { error: "invalid_grant", now: "T1" });
    await log.upsertConnections([{ ...row, extra: linked("T2") }]);
    const up = await extraOf(log, "ana@x.io");
    assertEquals(up.state, "connected");
    assertEquals(up.connected_at, "T2");
    assertEquals(up.error, undefined);
  });
});
