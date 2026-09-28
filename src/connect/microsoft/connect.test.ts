import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { APP_PREFIX, appGuide, connectMicrosoftApp, pickMicrosoftApp } from "./connect.ts";
import { DEFAULT_SCOPES } from "./config.ts";
import { doorAddress } from "../door.ts";
import { callbackAddress } from "../../edge.ts";
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
      { clientId: "cid1", clientSecret: "old", tenant: "t-1" },
      creds,
    );
    assertEquals(key, `${APP_PREFIX}cid1`);
    await connectMicrosoftApp({ clientId: "cid1", clientSecret: "new", tenant: "t-1" }, creds);
    const row = (await creds.get(key))!;
    assertEquals(row.value.client_secret, "new");
    assertEquals(row.extra?.tenant, "t-1");
    await assertRejects(
      () => connectMicrosoftApp({ clientId: "cid2", clientSecret: "s", tenant: "" }, creds),
      Error,
      "tenant",
    );
  });
});

Deno.test("the callback: no public address is the loopback door — the dev's own browser; a public one binds oauthPort behind the edge", () => {
  const local = doorAddress(callbackAddress(null, "microsoft", 8792), 8792);
  assertEquals(local.loopback, true);
  assertEquals(local.port, 8792);
  assertEquals(local.start, "http://localhost:8792/microsoft/oauth/start");
  const remote = doorAddress(callbackAddress("https://acme.example.com", "microsoft", 8792), 8792);
  assertEquals(remote.loopback, false);
  assertEquals(remote.port, 8792);
  assertEquals(remote.callback, "https://acme.example.com/microsoft/oauth/callback");
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

Deno.test("app guide: the redirect URI to register, every scope a sign-in asks for, admin consent", () => {
  const guide = appGuide(callbackAddress(null, "microsoft", 8792), DEFAULT_SCOPES);
  assertStringIncludes(guide, "http://localhost:8792/microsoft/oauth/callback");
  // ticked by hand in the portal, so each one the catalog asks for is on the page
  for (const s of DEFAULT_SCOPES) assertStringIncludes(guide, s);
  assertStringIncludes(guide, "Grant admin consent");
  for (const l of guide.split("\n")) assertEquals(l.length <= 92, true, l);
});
