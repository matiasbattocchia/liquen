import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createGoogleOAuth, type GoogleTokens } from "./oauth.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Draft, Event } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";

const CONFIG = {
  clientId: "cid",
  clientSecret: "sec",
  redirectUri: "https://x.example/oauth/google/callback",
};

/** A JWT the way the test needs one: only the payload is ever read. */
function jwt(claims: Record<string, string>): string {
  const b64 = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `h.${b64}.s`;
}

const TOKENS: GoogleTokens = {
  access_token: "ya29.short",
  refresh_token: "1//long",
  expires_in: 3599,
  scope: "openid email https://www.googleapis.com/auth/calendar",
  id_token: jwt({ email: "ana@example.com", sub: "108" }),
};

async function withOAuth(
  fn: (t: {
    published: Event[];
    exchanged: string[];
    connections: ConnectionRow[];
    memberships: MembershipRow[];
    creds: Awaited<ReturnType<typeof openCredentials>>;
    start: (query?: string) => Promise<Response>;
    callback: (code: string, state: string) => Promise<Response>;
  }) => Promise<void>,
  tokens: GoogleTokens = TOKENS,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  const published: Event[] = [];
  const exchanged: string[] = [];
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const handler = createGoogleOAuth({
    config: CONFIG,
    creds,
    // the map's write side in miniature: the grant creates anchor + binding (§4)
    store: {
      upsertConnections: (rows) => connections.push(...rows),
      upsertMemberships: (rows) => memberships.push(...rows),
    },
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    exchange: (code) => {
      exchanged.push(code);
      return Promise.resolve(tokens);
    },
  });
  try {
    await fn({
      published,
      exchanged,
      connections,
      memberships,
      creds,
      start: (query = "") => handler(new Request(`https://x.example/oauth/google/start${query}`)),
      callback: (code, state) =>
        handler(
          new Request(
            `https://x.example/oauth/google/callback?code=${code}&state=${state}`,
          ),
        ),
    });
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

/** Pull the state out of the 302's location. */
function stateOf(res: Response): string {
  const loc = new URL(res.headers.get("location")!);
  return loc.searchParams.get("state")!;
}

Deno.test("start: 302 to Google asking offline + incremental, default scopes", async () => {
  await withOAuth(async (t) => {
    const res = await t.start();
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assertEquals(loc.searchParams.get("client_id"), "cid");
    assertEquals(loc.searchParams.get("access_type"), "offline"); // ⇒ a refresh token
    assertEquals(loc.searchParams.get("prompt"), "consent"); // …on EVERY pass (see header)
    assertEquals(loc.searchParams.get("include_granted_scopes"), "true"); // incremental
    assertStringIncludes(loc.searchParams.get("scope")!, "auth/calendar");
    assert(stateOf(res).length > 0);
  });
});

Deno.test("start: ?scopes= narrows the ask — the member decides, not the door", async () => {
  await withOAuth(async (t) => {
    const res = await t.start("?scopes=openid%20email%20readonly.scope");
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.searchParams.get("scope"), "openid email readonly.scope");
  });
});

Deno.test("callback: the grant writes the map — vault, connection, membership, event", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?agent=ana"));
    const res = await t.callback("c0de", state);
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "close this window");
    assertEquals(t.exchanged, ["c0de"]);
    // the vault row: the refresh token IS the grant, owned by the principal
    const row = (await t.creds.get("google:ana@example.com"))!;
    assertEquals(row.value.refresh_token, "1//long");
    assertEquals(row.value.access_token, "ya29.short");
    assertEquals(row.agentId, "ana");
    assertStringIncludes(row.extra!.scope as string, "auth/calendar");
    // the proxy declaration rides every grant: main fronts it, the swap binds it (§9)
    assertEquals(row.extra!.env, "GOOGLE_WORKSPACE_CLI_TOKEN");
    assertEquals(row.extra!.hosts, ["*.googleapis.com"]);
    // the connection anchor, owned ⇒ private (§6), pointing at the vault row
    assertEquals(t.connections, [{
      service: "google",
      address: "ana@example.com",
      agentId: "ana",
      credentialKey: "google:ana@example.com",
    }]);
    assertEquals(t.memberships.length, 1);
    // the grant event names the account and the principal
    assertEquals(t.published.length, 1);
    const note = t.published[0];
    assert(note.type === "message");
    assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "for ana");
  });
});

Deno.test("callback: no agent in the state ⇒ the org's grant — ownerless, no membership", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start());
    await t.callback("c0de", state);
    const row = (await t.creds.get("google:ana@example.com"))!;
    assertEquals(row.agentId, undefined);
    assertEquals(t.connections[0].agentId, undefined);
    assertEquals(t.memberships, []);
  });
});

Deno.test("callback: a forged or replayed state dies at the door", async () => {
  await withOAuth(async (t) => {
    assertEquals((await t.callback("c0de", "forged")).status, 400);
    const state = stateOf(await t.start());
    assertEquals((await t.callback("c0de", state)).status, 200);
    assertEquals((await t.callback("c0de", state)).status, 400); // one-time
    assertEquals(t.exchanged, ["c0de"]); // the replay never reached the exchange
  });
});

Deno.test("callback: a re-consent without a refresh token keeps the stored one", async () => {
  await withOAuth(async (t) => {
    const first = stateOf(await t.start("?agent=ana"));
    await t.callback("c0de", first);
    await t.creds.put({
      key: "google:ana@example.com",
      value: { access_token: "ya29.newer" }, // the wire carried no refresh_token
    });
    const row = (await t.creds.get("google:ana@example.com"))!;
    assertEquals(row.value.refresh_token, "1//long"); // merge, not clobber (the vault)
    assertEquals(row.value.access_token, "ya29.newer");
  });
});

Deno.test("callback: an exchange without identity is a failure, not a nameless row", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start());
    const res = await t.callback("c0de", state);
    assertEquals(res.status, 502);
    assertEquals(t.connections, []);
  }, { access_token: "ya29.short" }); // no id_token on the wire
});
