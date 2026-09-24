import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMicrosoftOAuth, type MicrosoftTokens, missingScopes } from "./oauth.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Draft, Event } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";

const CONFIG = {
  clientId: "cid",
  clientSecret: "sec",
  tenant: "contoso.onmicrosoft.com",
  redirectUri: "https://x.example/oauth/microsoft/callback",
};

/** A JWT the way the test needs one: only the payload is ever read. */
function jwt(claims: Record<string, string>): string {
  const b64 = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `h.${b64}.s`;
}

const TOKENS: MicrosoftTokens = {
  access_token: "eyJ.short",
  refresh_token: "0.AAA.long",
  expires_in: 3599,
  scope: "User.Read Calendars.ReadWrite Mail.Read Mail.Send Chat.ReadWrite ChatMessage.Send " +
    "ChannelMessage.Read.All ChannelMessage.Send ChannelMessage.ReadWrite Team.ReadBasic.All " +
    "Channel.ReadBasic.All Files.ReadWrite",
  id_token: jwt({ preferred_username: "ana@contoso.com", oid: "o-1", tid: "t-1" }),
};

async function withOAuth(
  fn: (t: {
    published: Event[];
    connections: ConnectionRow[];
    memberships: MembershipRow[];
    creds: Awaited<ReturnType<typeof openCredentials>>;
    grants: { upn: string; agent?: string; missing: string[] }[];
    start: (query?: string) => Promise<Response>;
    callback: (query: string) => Promise<Response>;
  }) => Promise<void>,
  tokens: MicrosoftTokens = TOKENS,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  const published: Event[] = [];
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const grants: { upn: string; agent?: string; missing: string[] }[] = [];
  const handler = createMicrosoftOAuth({
    config: CONFIG,
    creds,
    onGrant: (g) => grants.push(g),
    store: {
      upsertConnections: (rows) => connections.push(...rows),
      upsertMemberships: (rows) => memberships.push(...rows),
    },
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    exchange: () => Promise.resolve(tokens),
  });
  try {
    await fn({
      published,
      connections,
      memberships,
      creds,
      grants,
      start: (query = "") =>
        handler(new Request(`https://x.example/oauth/microsoft/start${query}`)),
      callback: (query) =>
        handler(new Request(`https://x.example/oauth/microsoft/callback${query}`)),
    });
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function stateOf(res: Response): string {
  return new URL(res.headers.get("location")!).searchParams.get("state")!;
}

Deno.test("start: 302 to the app's tenant, default scopes, the member picks the account", async () => {
  await withOAuth(async (t) => {
    const res = await t.start();
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(
      loc.origin + loc.pathname,
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
    );
    assertEquals(loc.searchParams.get("client_id"), "cid");
    assertEquals(loc.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assertEquals(loc.searchParams.get("prompt"), "select_account");
    assertStringIncludes(loc.searchParams.get("scope")!, "offline_access"); // ⇒ a refresh token
    assertStringIncludes(loc.searchParams.get("scope")!, "Calendars.ReadWrite");
    assert(stateOf(res).length > 0);
  });
});

Deno.test("callback: the grant writes the map — vault, connection, membership, event", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?agent=ana"));
    const res = await t.callback(`?code=c0de&state=${state}`);
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "close this window");
    const row = (await t.creds.get("microsoft:ana@contoso.com"))!;
    assertEquals(row.value.refresh_token, "0.AAA.long");
    assertEquals(row.value.access_token, "eyJ.short");
    assertEquals(row.agentId, "ana");
    assertEquals(row.extra!.client_id, "cid"); // what the broker refreshes with
    assertEquals(row.extra!.oid, "o-1");
    assertEquals(row.extra!.tid, "t-1");
    // the proxy declaration rides every grant: main fronts it, the swap binds it (§9)
    assertEquals(row.extra!.env, "MICROSOFT_GRAPH_TOKEN");
    assertEquals(row.extra!.hosts, ["graph.microsoft.com"]);
    assertEquals(t.connections, [{
      service: "microsoft",
      address: "ana@contoso.com",
      agentId: "ana",
      credentialKey: "microsoft:ana@contoso.com",
    }]);
    assertEquals(t.memberships.length, 1);
    assertEquals(t.published.length, 1);
    assertEquals(t.published[0].envelope.service, "microsoft");
    assertEquals(t.grants, [{ upn: "ana@contoso.com", agent: "ana", missing: [] }]);
  });
});

Deno.test("callback: --org mints an ownerless grant — no membership, no owner", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start());
    assertEquals((await t.callback(`?code=c&state=${state}`)).status, 200);
    assertEquals((await t.creds.get("microsoft:ana@contoso.com"))!.agentId, undefined);
    assertEquals(t.connections[0].agentId, undefined);
    assertEquals(t.memberships, []);
  });
});

Deno.test("callback: a state is spent once; a refusal on the wire is reported as such", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start());
    assertEquals((await t.callback(`?code=c&state=${state}`)).status, 200);
    assertEquals((await t.callback(`?code=c&state=${state}`)).status, 400);
    const refused = await t.callback(
      "?error=access_denied&error_description=AADSTS65004%3A+User+declined+to+consent",
    );
    assertEquals(refused.status, 400);
    assertStringIncludes(await refused.text(), "declined to consent");
  });
});

Deno.test("callback: a shortfall is reported in the ask's spelling, OpenID scopes aside", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(
      await t.start("?agent=ana&scopes=openid%20offline_access%20User.Read%20Sites.ReadWrite.All"),
    );
    const res = await t.callback(`?code=c&state=${state}`);
    assertStringIncludes(await res.text(), "Sites.ReadWrite.All");
    assertEquals(t.grants[0].missing, ["Sites.ReadWrite.All"]);
  });
});

Deno.test("missingScopes: both spellings of a Graph permission are one", () => {
  assertEquals(
    missingScopes(
      ["openid", "https://graph.microsoft.com/Mail.Read", "Calendars.Read"],
      "Mail.Read https://graph.microsoft.com/Calendars.Read",
    ),
    [],
  );
  assertEquals(missingScopes(["Mail.Send"], "User.Read"), ["Mail.Send"]);
  assertEquals(missingScopes(["email", "offline_access"], undefined), []);
});
