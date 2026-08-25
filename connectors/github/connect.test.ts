import { assert, assertEquals, assertRejects } from "@std/assert";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  APP_PREFIX,
  connectGithubApp,
  connectGithubBot,
  connectGithubUser,
  GRANT_ENV,
  GRANT_HOSTS,
  type Installation,
  ORG_KEY,
} from "./connect.ts";
import { openCredentials } from "../../src/connector.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../src/connector.ts";

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

/** The map + log writes, captured: what each door claims to write, verbatim. */
function harness() {
  const connections: unknown[] = [];
  const memberships: unknown[] = [];
  const notes: Draft<MessageEvent>[] = [];
  return {
    connections,
    memberships,
    notes,
    store: {
      upsertConnections: (rows: unknown[]) => connections.push(...rows),
      upsertMemberships: (rows: unknown[]) => memberships.push(...rows),
    },
    publish: ((e: Draft<Event>) => {
      notes.push(e as Draft<MessageEvent>);
      return Promise.resolve({ ...e, id: "n1" } as Event);
    }) as Appender["publish"],
  };
}

function pkcs1Pem(): { pem: string; pub: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: privateKey.export({ type: "pkcs1", format: "pem" }) as string, pub: publicKey };
}

Deno.test("app door: the App's credentials land under its own id — and re-pastes merge", async () => {
  await withVault(async (creds) => {
    const { pem } = pkcs1Pem();
    const key = await connectGithubApp(
      { appId: "7", privateKey: pem, webhookSecret: "whs" },
      creds,
    );
    assertEquals(key, `${APP_PREFIX}7`);
    const row = (await creds.get(key))!;
    assertEquals(row.value.private_key, pem);
    assertEquals(row.value.webhook_secret, "whs");
    // rotating one field keeps its siblings (the vault's merge)
    await connectGithubApp({ appId: "7", privateKey: pem, clientId: "Iv1.x" }, creds);
    const merged = (await creds.get(key))!;
    assertEquals(merged.value.webhook_secret, "whs");
    assertEquals(merged.value.client_id, "Iv1.x");
  });
});

Deno.test("app door: a non-numeric id or a non-PEM key writes nothing", async () => {
  await withVault(async (creds) => {
    await assertRejects(() => connectGithubApp({ appId: "my-app", privateKey: "x" }, creds));
    await assertRejects(() => connectGithubApp({ appId: "7", privateKey: "not a key" }, creds));
    assertEquals(await creds.list(APP_PREFIX), []);
  });
});

Deno.test("bot door: binds the single installation — anchor org-credentialed, mint coords vaulted", async () => {
  await withVault(async (creds) => {
    const { pem, pub } = pkcs1Pem();
    await connectGithubApp({ appId: "7", privateKey: pem }, creds);
    const h = harness();
    const jwts: string[] = [];
    const out = await connectGithubBot({
      creds,
      store: h.store,
      publish: h.publish,
      listInstallations: (jwt: string) => {
        jwts.push(jwt);
        return Promise.resolve([{ id: 42, account: { login: "acme" } }]);
      },
      now: () => "2026-08-25T00:00:00Z",
    });
    assertEquals(out, { appId: "7", installationId: "42", account: "acme" });
    // the discovery ran over the app's OWN JWT — the door proved the key before writing
    const [jh, jp, js] = jwts[0].split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${jh}.${jp}`);
    const b64 = jp.replaceAll("-", "+").replaceAll("_", "/");
    assertEquals(
      JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))).iss,
      "7",
    );
    const sig = js.replaceAll("-", "+").replaceAll("_", "/");
    assert(v.verify(
      pub,
      Uint8Array.from(
        atob(sig.padEnd(Math.ceil(sig.length / 4) * 4, "=")),
        (c) => c.charCodeAt(0),
      ),
    ));
    // ONE row: the service anchor, org-credentialed (§6)
    assertEquals(h.connections, [
      { service: "github", address: "github", credentialKey: ORG_KEY },
    ]);
    const row = (await creds.get(ORG_KEY))!;
    assertEquals(row.extra, {
      app_id: "7",
      installation_id: "42",
      account: "acme",
      env: GRANT_ENV,
      hosts: GRANT_HOSTS,
    });
    assertEquals(row.value.access_token, undefined); // minted on demand, never here
    assertEquals(h.notes.length, 1);
    assertEquals(h.notes[0].envelope.connection_address, "github");
  });
});

Deno.test("bot door: no app, no installation, or an ambiguous one — throws, writes nothing", async () => {
  await withVault(async (creds) => {
    const h = harness();
    const deps = { creds, store: h.store, publish: h.publish };
    await assertRejects(() => connectGithubBot(deps), Error, "no github app");

    const { pem } = pkcs1Pem();
    await connectGithubApp({ appId: "7", privateKey: pem }, creds);
    const withInstalls = (installs: Installation[]) => ({
      ...deps,
      listInstallations: () => Promise.resolve(installs),
    });
    await assertRejects(() => connectGithubBot(withInstalls([])), Error, "installed nowhere");
    const two = [{ id: 1, account: { login: "a" } }, { id: 2, account: { login: "b" } }];
    await assertRejects(() => connectGithubBot(withInstalls(two)), Error, "several");
    // …unless the arg names one — by account or by id
    const picked = await connectGithubBot(withInstalls(two), "b");
    assertEquals(picked.installationId, "2");
  });
});

Deno.test("user door: a verified paste writes the anchor, the owned leg, and the grant", async () => {
  await withVault(async (creds) => {
    const h = harness();
    const out = await connectGithubUser("ghp_abc123", {
      principal: "ana",
      creds,
      store: h.store,
      publish: h.publish,
      whoami: (token: string) =>
        Promise.resolve(token === "ghp_abc123" ? { login: "ana-dev" } : { message: "bad" }),
      now: () => "2026-08-25T00:00:00Z",
    });
    assertEquals(out, { login: "ana-dev" });
    assertEquals(h.connections, [
      { service: "github", address: "github" }, // the anchor — what opens the publish gate
      { service: "github", address: "ana-dev", agentId: "ana", credentialKey: "github:ana" },
    ]);
    assertEquals(h.memberships, [
      { service: "github", connection: "github", conversation: "connect", agentId: "ana" },
    ]);
    const row = (await creds.get("github:ana"))!;
    assertEquals(row.value.token, "ghp_abc123");
    assertEquals(row.agentId, "ana");
    assertEquals(row.extra, { login: "ana-dev", env: GRANT_ENV, hosts: GRANT_HOSTS });
  });
});

Deno.test("user door: a wrong-shaped paste or a rejected token writes nothing", async () => {
  await withVault(async (creds) => {
    const h = harness();
    const deps = {
      principal: "ana",
      creds,
      store: h.store,
      publish: h.publish,
      whoami: () => Promise.resolve({ message: "Bad credentials" }),
    };
    // the webhook secret / client secret sitting beside the token on the app page
    await assertRejects(() => connectGithubUser("s3cr3t-not-a-token", deps), Error, "not a GitHub");
    await assertRejects(() => connectGithubUser("ghp_rejected", deps), Error, "Bad credentials");
    assertEquals(h.connections, []);
    assertEquals(await creds.get("github:ana"), null);
  });
});
