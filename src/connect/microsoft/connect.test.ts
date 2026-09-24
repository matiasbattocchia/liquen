import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { APP_PREFIX, connectMicrosoftApp, localCallback, pickMicrosoftApp } from "./connect.ts";
import { doorAddress } from "../door.ts";
import { openCredentials } from "../../store/credentials.ts";

async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("app: the paste lands under its own id with its tenant; a re-paste rotates the secret", async () => {
  await withVault(async (creds) => {
    const key = await connectMicrosoftApp(
      { clientId: "cid1", clientSecret: "old", tenant: "t-1", redirectUri: "https://x/cb" },
      creds,
    );
    assertEquals(key, `${APP_PREFIX}cid1`);
    await connectMicrosoftApp({ clientId: "cid1", clientSecret: "new", tenant: "t-1" }, creds);
    const row = (await creds.get(key))!;
    assertEquals(row.value.client_secret, "new");
    assertEquals(row.extra?.tenant, "t-1");
    assertEquals(row.extra?.redirect_uri, "https://x/cb"); // the vault's merge keeps it
    await assertRejects(
      () => connectMicrosoftApp({ clientId: "cid2", clientSecret: "s", tenant: "" }, creds),
      Error,
      "tenant",
    );
  });
});

Deno.test("app: no public URI is the loopback door — the dev's own browser", () => {
  const door = doorAddress(localCallback(8792), 8792);
  assertEquals(door.loopback, true);
  assertEquals(door.port, 8792);
  assertEquals(door.start, "http://localhost:8792/oauth/microsoft/start");
});

Deno.test("pick: the only app is the choice; several demand a name; none is an error", async () => {
  await withVault(async (creds) => {
    await assertRejects(() => pickMicrosoftApp(creds), Error, "no microsoft app");
    await connectMicrosoftApp({ clientId: "cid1", clientSecret: "s", tenant: "t" }, creds);
    assertEquals((await pickMicrosoftApp(creds)).value.client_id, "cid1");
    await connectMicrosoftApp({ clientId: "cid2", clientSecret: "s", tenant: "t" }, creds);
    const err = await assertRejects(() => pickMicrosoftApp(creds), Error);
    assertStringIncludes(err.message, "--app");
    assertEquals((await pickMicrosoftApp(creds, "cid2")).value.client_id, "cid2");
  });
});
