import { assert, assertEquals } from "@std/assert";
import { type createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, createGrantBroker, frontedFor, type TokenResponse } from "./grants.ts";
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

Deno.test("accessTokenFor: a static `token` rides as-is — nothing expires, nothing refreshes", async () => {
  await withVault(async (creds) => {
    await creds.put({ key: "github:ana", value: { token: "ghp_static" }, agentId: "ana" });
    let refreshed = false;
    const broker = createGrantBroker({
      creds,
      refresh: () => {
        refreshed = true;
        return Promise.resolve({ access_token: "never" });
      },
      installationToken: () => {
        refreshed = true;
        return Promise.resolve({ token: "never" });
      },
    });
    assertEquals(await broker.accessTokenFor(broker.issue("github:ana", "ana")), "ghp_static");
    assert(!refreshed, "a static token must not touch any issuer");
  });
});

Deno.test("accessTokenFor: the host binding — declared hosts spend, anything else is null", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: "github:ana",
      value: { token: "ghp_static" },
      agentId: "ana",
      extra: { hosts: ["api.github.com", "uploads.github.com"] },
    });
    const broker = createGrantBroker({ creds });
    const h = broker.issue("github:ana", "ana");
    assertEquals(await broker.accessTokenFor(h, "api.github.com"), "ghp_static");
    assertEquals(await broker.accessTokenFor(h, "api.github.com:8443"), "ghp_static"); // the port doesn't bind
    assertEquals(await broker.accessTokenFor(h, "httpbin.org"), null); // an echo endpoint gets nothing
    assertEquals(await broker.accessTokenFor(h), "ghp_static"); // no host: a broker-side caller
  });
});

Deno.test("accessTokenFor: a `*.` wildcard binds the suffix — never the apex or a look-alike", async () => {
  await withVault(async (creds) => {
    await seed(creds, { access_token: "ya29.t" }, {
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      hosts: ["*.googleapis.com"],
    });
    const broker = createGrantBroker({ creds });
    const h = broker.issue(KEY);
    assertEquals(await broker.accessTokenFor(h, "www.googleapis.com"), "ya29.t");
    assertEquals(await broker.accessTokenFor(h, "admin.googleapis.com"), "ya29.t");
    assertEquals(await broker.accessTokenFor(h, "googleapis.com"), null);
    assertEquals(await broker.accessTokenFor(h, "evil-googleapis.com"), null);
  });
});

Deno.test("accessTokenFor: a row declaring no hosts is unbound — the door's call", async () => {
  await withVault(async (creds) => {
    await creds.put({ key: "github:ana", value: { token: "ghp_static" } });
    const broker = createGrantBroker({ creds });
    assertEquals(
      await broker.accessTokenFor(broker.issue("github:ana"), "anywhere.example"),
      "ghp_static",
    );
  });
});

/** A throwaway RSA pair, the private half as GitHub downloads it (PKCS#1 PEM). */
function rsaPair(): { pem: string; pub: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: privateKey.export({ type: "pkcs1", format: "pem" }) as string, pub: publicKey };
}

Deno.test("appJwt: RS256 over the app id, ten minutes, iat backdated for skew", () => {
  const { pem, pub } = rsaPair();
  const jwt = appJwt("7", pem, 1_000_000_000_000);
  const [h, p, s] = jwt.split(".");
  const dec = (b: string) => JSON.parse(new TextDecoder().decode(decodeB64u(b)));
  assertEquals(dec(h), { alg: "RS256", typ: "JWT" });
  const claims = dec(p);
  assertEquals(claims.iss, "7");
  assertEquals(claims.iat, 1_000_000_000 - 60);
  assertEquals(claims.exp, claims.iat + 600);
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert(v.verify(pub, decodeB64u(s)), "the signature must verify against the app's key");
});

function decodeB64u(b: string): Uint8Array {
  const std = b.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(std.padEnd(Math.ceil(std.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
}

Deno.test("accessTokenFor: a github installation grant mints through the app's key, cached", async () => {
  await withVault(async (creds) => {
    const { pem, pub } = rsaPair();
    await creds.put({ key: "github:app:7", value: { private_key: pem } });
    await creds.put({
      key: "github:org",
      value: {},
      extra: { app_id: "7", installation_id: "42" },
    });
    const mints: { jwt: string; installation: string }[] = [];
    const future = new Date(Date.now() + 3600_000).toISOString();
    const broker = createGrantBroker({
      creds,
      installationToken: (jwt, installation) => {
        mints.push({ jwt, installation });
        return Promise.resolve({ token: "ghs_minted", expires_at: future });
      },
    });
    const h = broker.issue("github:org");
    assertEquals(await broker.accessTokenFor(h), "ghs_minted");
    assertEquals(mints[0].installation, "42");
    // the JWT handed to GitHub really is the app's: signed by the vaulted key, iss = app id
    const [jh, jp, js] = mints[0].jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${jh}.${jp}`);
    assert(v.verify(pub, decodeB64u(js)));
    assertEquals(JSON.parse(new TextDecoder().decode(decodeB64u(jp))).iss, "7");
    // written back: the next call is a cache hit until GitHub's expiry
    const row = (await creds.get("github:org"))!;
    assertEquals(row.value.access_token, "ghs_minted");
    assertEquals(row.extra!.expiry, future);
    assertEquals(await broker.accessTokenFor(h), "ghs_minted");
    assertEquals(mints.length, 1, "the fresh cached token must not re-mint");
  });
});

Deno.test("accessTokenFor: a github user grant refreshes, and the rotated token is kept", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: "github:app:7",
      value: { private_key: "unused here", client_id: "Iv1.abc", client_secret: "sec" },
    });
    await creds.put({
      key: "github:ana",
      value: { token: "", access_token: "ghu_old", refresh_token: "ghr_one" },
      agentId: "ana",
      // an app_id with no installation_id is the app's USER leg (the device flow's grant)
      extra: { app_id: "7", login: "ana-dev", expiry: "2020-01-01T00:00:00Z" },
    });
    const asked: URLSearchParams[] = [];
    const broker = createGrantBroker({
      creds,
      userToken: (body) => {
        asked.push(body);
        return Promise.resolve({
          access_token: "ghu_new",
          refresh_token: "ghr_two",
          expires_in: 28800,
        });
      },
    });
    const h = broker.issue("github:ana", "ana");
    assertEquals(await broker.accessTokenFor(h), "ghu_new");
    assertEquals(asked[0].get("grant_type"), "refresh_token");
    assertEquals(asked[0].get("refresh_token"), "ghr_one");
    // the app's own pair spends it — the client secret never leaves the broker
    assertEquals(asked[0].get("client_id"), "Iv1.abc");
    assertEquals(asked[0].get("client_secret"), "sec");
    // GitHub rotates: store the new refresh token or the next re-issue has nothing to spend
    const row = (await creds.get("github:ana"))!;
    assertEquals(row.value.access_token, "ghu_new");
    assertEquals(row.value.refresh_token, "ghr_two");
    assert(Date.parse(row.extra!.expiry as string) > Date.now());
    assertEquals(await broker.accessTokenFor(h), "ghu_new");
    assertEquals(asked.length, 1, "the fresh token must not re-spend the refresh token");
  });
});

Deno.test("accessTokenFor: a github user grant with no app to refresh by is null", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: "github:ana",
      value: { token: "", access_token: "ghu_old", refresh_token: "ghr_one" },
      extra: { app_id: "7" }, // the app row is gone — nothing can re-issue this
    });
    const broker = createGrantBroker({
      creds,
      userToken: () => Promise.reject(new Error("must not be called")),
    });
    assertEquals(await broker.accessTokenFor(broker.issue("github:ana")), null);
  });
});

Deno.test("frontedFor: an agent is fronted with the org's rows and its OWN — never a peer's", () => {
  const rows = [
    { key: "github:org", extra: { env: "GH_TOKEN" } },
    { key: "google:ana@x", agentId: "ana", extra: { env: "GOOGLE_WORKSPACE_CLI_TOKEN" } },
    { key: "google:bo@x", agentId: "bo", extra: { env: "GOOGLE_WORKSPACE_CLI_TOKEN" } },
    { key: "acme:one", extra: { env: "ACME_TOKEN" } },
    { key: "acme:two", extra: { env: "ACME_TOKEN" } },
    { key: "slack:T1:org", extra: {} }, // declares no var: nothing to front
  ];
  const keys = (agentId: string) => frontedFor(rows, agentId).map((r) => r.key);
  assertEquals(keys("ana"), ["github:org", "google:ana@x"]);
  assertEquals(keys("bo"), ["github:org", "google:bo@x"]);
  // a var only peers hold stays unset for the third agent; two org rows contending stay out
  assertEquals(keys("cy"), ["github:org"]);
});
