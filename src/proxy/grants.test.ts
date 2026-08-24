import { assert, assertEquals } from "@std/assert";
import { createGrantBroker, type TokenResponse } from "./grants.ts";
import { openCredentials } from "../store/credentials.ts";

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

const KEY = "google:ana@example.com";

async function seed(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  grant: Record<string, string>,
  extra: Record<string, unknown>,
): Promise<void> {
  await creds.put({ key: "google:app:cid", value: { client_id: "cid", client_secret: "sec" } });
  await creds.put({
    key: KEY,
    value: grant,
    agentId: "ana",
    extra: { client_id: "cid", ...extra },
  });
}

Deno.test("issue: a handle is opaque, idempotent per key, and reveals no secret", async () => {
  await withVault(async (creds) => {
    const broker = createGrantBroker({ creds });
    const h = broker.issue(KEY, "ana");
    assert(h.startsWith("mu-grant-"));
    assertEquals(broker.issue(KEY, "ana"), h); // idempotent
    assertEquals(broker.resolve(h), { credentialKey: KEY, agentId: "ana" });
    assertEquals(broker.resolve("mu-grant-nope"), null);
    assertEquals(await broker.accessTokenFor("mu-grant-nope"), null); // opaque, unresolvable
  });
});

Deno.test("accessTokenFor: a fresh stored token is returned without a refresh", async () => {
  await withVault(async (creds) => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await seed(creds, { access_token: "ya29.fresh", refresh_token: "1//r" }, { expiry: future });
    let refreshed = false;
    const broker = createGrantBroker({
      creds,
      refresh: () => {
        refreshed = true;
        return Promise.resolve({ access_token: "ya29.new" });
      },
    });
    const h = broker.issue(KEY);
    assertEquals(await broker.accessTokenFor(h), "ya29.fresh");
    assert(!refreshed, "a fresh token must not trigger a refresh");
  });
});

Deno.test("accessTokenFor: an expired token refreshes, and the new one is written back", async () => {
  await withVault(async (creds) => {
    const past = new Date(Date.now() - 1000).toISOString();
    await seed(creds, { access_token: "ya29.old", refresh_token: "1//r" }, { expiry: past });
    const bodies: URLSearchParams[] = [];
    const broker = createGrantBroker({
      creds,
      refresh: (body) => {
        bodies.push(body);
        return Promise.resolve({ access_token: "ya29.new", expires_in: 3599 });
      },
    });
    const h = broker.issue(KEY);
    assertEquals(await broker.accessTokenFor(h), "ya29.new");
    // the refresh spent the refresh_token with the app's own secret
    assertEquals(bodies[0].get("grant_type"), "refresh_token");
    assertEquals(bodies[0].get("refresh_token"), "1//r");
    assertEquals(bodies[0].get("client_secret"), "sec");
    // written back, so the NEXT call is a cache hit
    const row = (await creds.get(KEY))!;
    assertEquals(row.value.access_token, "ya29.new");
    assertEquals(await broker.accessTokenFor(h), "ya29.new");
  });
});

Deno.test("accessTokenFor: concurrent calls on an expired grant refresh exactly once", async () => {
  await withVault(async (creds) => {
    await seed(creds, { access_token: "ya29.old", refresh_token: "1//r" }, {});
    let calls = 0;
    const broker = createGrantBroker({
      creds,
      refresh: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { access_token: "ya29.new", expires_in: 3599 };
      },
    });
    const h = broker.issue(KEY);
    const all = await Promise.all([1, 2, 3, 4].map(() => broker.accessTokenFor(h)));
    assertEquals(all, ["ya29.new", "ya29.new", "ya29.new", "ya29.new"]);
    assertEquals(calls, 1, "one in-flight refresh, shared");
  });
});

Deno.test("accessTokenFor: a failed refresh yields null — the proxy will 401", async () => {
  await withVault(async (creds) => {
    await seed(creds, { access_token: "ya29.old", refresh_token: "1//r" }, {});
    const broker = createGrantBroker({
      creds,
      refresh: () => Promise.resolve({ error: "invalid_grant" } as TokenResponse),
    });
    assertEquals(await broker.accessTokenFor(broker.issue(KEY)), null);
  });
});

Deno.test("accessTokenFor: an unknown handle is null, never a throw", async () => {
  await withVault(async (creds) => {
    const broker = createGrantBroker({ creds });
    assertEquals(await broker.accessTokenFor("mu-grant-ghost"), null);
  });
});
