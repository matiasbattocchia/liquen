import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { APP_PREFIX, connectGoogleApp, pickGoogleApp } from "./connect.ts";
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

Deno.test("app: the paste lands under its own id — several apps coexist", async () => {
  await withVault(async (creds) => {
    const key = await connectGoogleApp(
      { clientId: "cid1", clientSecret: "sec1", redirectUri: "https://x/cb" },
      creds,
    );
    assertEquals(key, `${APP_PREFIX}cid1`);
    await connectGoogleApp({ clientId: "cid2", clientSecret: "sec2" }, creds);
    const rows = await creds.list(APP_PREFIX);
    assertEquals(rows.map((r) => r.value.client_id), ["cid1", "cid2"]);
    assertEquals(rows[0].extra?.redirect_uri, "https://x/cb");
  });
});

Deno.test("app: a re-paste rotates the secret, the sidecar survives (vault merge)", async () => {
  await withVault(async (creds) => {
    await connectGoogleApp(
      { clientId: "cid1", clientSecret: "old", redirectUri: "https://x/cb" },
      creds,
    );
    await connectGoogleApp({ clientId: "cid1", clientSecret: "new" }, creds);
    const row = (await creds.get(`${APP_PREFIX}cid1`))!;
    assertEquals(row.value.client_secret, "new");
    assertEquals(row.extra?.redirect_uri, "https://x/cb");
  });
});

Deno.test("pick: the only app is the choice; several demand a name; none is an error", async () => {
  await withVault(async (creds) => {
    await assertRejects(() => pickGoogleApp(creds), Error, "no google app");
    await connectGoogleApp({ clientId: "cid1", clientSecret: "s" }, creds);
    assertEquals((await pickGoogleApp(creds)).value.client_id, "cid1");
    await connectGoogleApp({ clientId: "cid2", clientSecret: "s" }, creds);
    const err = await assertRejects(() => pickGoogleApp(creds), Error);
    assertStringIncludes(err.message, "--app");
    assertStringIncludes(err.message, "cid2");
    assertEquals((await pickGoogleApp(creds, "cid2")).value.client_id, "cid2");
    await assertRejects(() => pickGoogleApp(creds, "nope"), Error, "no app nope");
  });
});
