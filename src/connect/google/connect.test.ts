import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { APP_PREFIX, appGuide, connectGoogleApp, pickGoogleApp } from "./connect.ts";
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

Deno.test("app: the paste lands under its own id — several apps coexist", async () => {
  await withVault(async (creds) => {
    const key = await connectGoogleApp({ clientId: "cid1", clientSecret: "sec1" }, creds);
    assertEquals(key, `${APP_PREFIX}cid1`);
    await connectGoogleApp({ clientId: "cid2", clientSecret: "sec2" }, creds);
    const rows = await creds.list(APP_PREFIX);
    assertEquals(rows.map((r) => r.value.client_id), ["cid1", "cid2"]);
  });
});

Deno.test("the callback: no public address is this machine's edge — the dev's own browser; a public one is a member anywhere", () => {
  // what the app door prints to register is what a sign-in sends: one expression
  const local = doorAddress(callbackAddress({ publicUrl: null, port: 8787 }, "google"));
  assertEquals(local.loopback, true);
  assertEquals(local.start, "http://localhost:8787/google/oauth/start");
  const remote = doorAddress(
    callbackAddress({ publicUrl: "https://acme.example.com", port: 8787 }, "google"),
  );
  assertEquals(remote.loopback, false);
  assertEquals(remote.callback, "https://acme.example.com/google/oauth/callback");
});

Deno.test("app: a re-paste rotates the secret", async () => {
  await withVault(async (creds) => {
    await connectGoogleApp({ clientId: "cid1", clientSecret: "old" }, creds);
    await connectGoogleApp({ clientId: "cid1", clientSecret: "new" }, creds);
    const row = (await creds.get(`${APP_PREFIX}cid1`))!;
    assertEquals(row.value.client_secret, "new");
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

Deno.test("app guide: the APIs the scopes reach, every scope, the redirect URI to register", () => {
  const guide = appGuide(
    callbackAddress({ publicUrl: null, port: 8787 }, "google"),
    DEFAULT_SCOPES,
  );
  assertStringIncludes(guide, "enable Google Calendar API, Gmail API.");
  for (const s of DEFAULT_SCOPES) assertStringIncludes(guide, s);
  assertStringIncludes(guide, "http://localhost:8787/google/oauth/callback");
  // a scope with no known API still says which API is owed
  assertStringIncludes(
    appGuide("x", ["https://www.googleapis.com/auth/youtube"]),
    "the API behind https://www.googleapis.com/auth/youtube",
  );
});
