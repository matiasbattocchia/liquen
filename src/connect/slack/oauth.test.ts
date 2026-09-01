import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createSlackOAuth, type SlackAccess } from "./oauth.ts";
import { DEFAULT_BOT_SCOPES } from "./config.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";

const CONFIG = {
  clientId: "cid",
  clientSecret: "sec",
  redirectUri: "https://x.example/oauth/slack/callback",
  userScopes: ["chat:write", "channels:history"],
};

// a FULL install: both legs come back carrying what the door asked for — Slack states
// the granted scopes on the exchange, and a token short of them fails at the call
const ACCESS: SlackAccess = {
  ok: true,
  access_token: "xoxb-bot-token",
  scope: DEFAULT_BOT_SCOPES.join(","),
  bot_user_id: "UBOT",
  team: { id: "T1", name: "turtle" },
  authed_user: {
    id: "U9",
    access_token: "xoxp-ana-token",
    scope: "chat:write,channels:history",
  },
};

async function withOAuth(
  fn: (t: {
    handler: (req: Request) => Promise<Response>;
    published: Event[];
    exchanged: string[];
    connections: ConnectionRow[];
    memberships: MembershipRow[];
    creds: Awaited<ReturnType<typeof openCredentials>>;
    start: () => Promise<Response>;
    callback: (code: string, state: string) => Promise<Response>;
  }) => Promise<void>,
  access: SlackAccess = ACCESS,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  const published: Event[] = [];
  const exchanged: string[] = [];
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const handler = createSlackOAuth({
    // the map's write side in miniature: the grant creates anchor + binding (§4)
    store: {
      upsertConnections: (rows) => connections.push(...rows),
      upsertMemberships: (rows) => memberships.push(...rows),
    },
    config: CONFIG,
    creds,
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    bindPrincipal: ({ team, user }) => Promise.resolve(`p:${team}:${user}`),
    exchange: (code) => {
      exchanged.push(code);
      return Promise.resolve(access);
    },
  });
  try {
    await fn({
      handler,
      published,
      exchanged,
      connections,
      memberships,
      creds,
      start: () => handler(new Request("https://x.example/oauth/slack/start")),
      callback: (code, state) =>
        handler(
          new Request(
            `https://x.example/oauth/slack/callback?code=${code}&state=${state}`,
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

Deno.test("start: mints a one-time state and 302s to Slack with both scope legs", async () => {
  await withOAuth(async ({ start }) => {
    const res = await start();
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.origin + loc.pathname, "https://slack.com/oauth/v2/authorize");
    assertEquals(loc.searchParams.get("client_id"), "cid");
    assertStringIncludes(loc.searchParams.get("scope")!, "chat:write"); // bot leg
    assertStringIncludes(loc.searchParams.get("user_scope")!, "channels:history"); // principal leg
    assert(stateOf(res).length > 10);
    // two clicks on the SHARED link get DIFFERENT states
    assert(stateOf(await start()) !== stateOf(res));
  });
});

Deno.test("callback: exchanges the code, stores both token legs, publishes the grant event", async () => {
  await withOAuth(
    async ({ start, callback, creds, published, exchanged, connections, memberships }) => {
      const state = stateOf(await start());
      const res = await callback("code-1", state);
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "close this window");
      assertEquals(exchanged, ["code-1"]);
      // org leg: the workspace bot token
      const bot = await creds.get("slack:T1:org");
      assertEquals(bot?.value, { token: "xoxb-bot-token" });
      // principal leg: the user token, bound via the Slack-verified identity
      const user = await creds.get("slack:T1:p:T1:U9");
      assertEquals(user?.value, { token: "xoxp-ana-token" });
      assertEquals(user?.agentId, "p:T1:U9");
      // the grant CREATES the map (§4): the bare workspace (the stub), the BOT's own
      // grant row (org-credentialed ⇒ the shared inbox), the principal's OWN grant
      assertEquals(connections, [
        { service: "slack", address: "T1" },
        { service: "slack", address: "T1:UBOT", credentialKey: "slack:T1:org" },
        {
          service: "slack",
          address: "T1:U9",
          agentId: "p:T1:U9",
          credentialKey: "slack:T1:p:T1:U9",
        },
      ]);
      // the principal sees their own grant note even on a stub workspace (§6)
      assertEquals(memberships, [
        { service: "slack", connection: "T1", conversation: "oauth", agentId: "p:T1:U9" },
      ]);
      // the frontier is crossed as an event
      assertEquals(published.length, 1);
      const note = published[0] as MessageEvent;
      assertEquals(note.envelope.service, "slack");
      assertStringIncludes((note.parts[0] as { text: string }).text, "p:T1:U9");
    },
  );
});

Deno.test("callback: a state cannot be used twice (replay dies)", async () => {
  await withOAuth(async ({ start, callback, published }) => {
    const state = stateOf(await start());
    assertEquals((await callback("c1", state)).status, 200);
    assertEquals((await callback("c2", state)).status, 400); // replay
    assertEquals(published.length, 1);
  });
});

Deno.test("callback: an unknown/forged state is rejected before any exchange", async () => {
  await withOAuth(async ({ callback, exchanged, published, connections }) => {
    const res = await callback("evil", "forged-state");
    assertEquals(res.status, 400);
    assertEquals(exchanged.length, 0); // never reached the exchange
    assertEquals(connections.length, 0); // and never wrote the map
    assertEquals(published.length, 0);
  });
});

Deno.test("callback: a failed exchange stores nothing and reports upstream", async () => {
  await withOAuth(async ({ start, callback, creds, published }) => {
    const state = stateOf(await start());
    const res = await callback("c1", state);
    assertEquals(res.status, 502);
    assertEquals(await creds.get("slack:T1:org"), null);
    assertEquals(published.length, 0);
  }, { ok: false, error: "invalid_code" });
});

Deno.test("callback: a user-only grant (member connect, app already installed) stores just the principal leg", async () => {
  await withOAuth(async ({ start, callback, creds }) => {
    const state = stateOf(await start());
    assertEquals((await callback("c1", state)).status, 200);
    assertEquals(
      await creds.get("slack:T1:org"),
      null, // no bot token in this grant — nothing stored for the org
    );
    const user = await creds.get("slack:T1:p:T1:U9");
    assertEquals(user?.value, { token: "xoxp-ana-token" });
  }, {
    ok: true,
    team: { id: "T1" },
    authed_user: { id: "U9", access_token: "xoxp-ana-token", scope: "chat:write" },
  });
});

Deno.test("callback: an install that granted less than the ask says which scopes", async () => {
  await withOAuth(async ({ start, callback, creds, published }) => {
    const res = await callback("code-1", stateOf(await start()));
    // the install COMPLETED — both legs are stored; the reach is what fell short
    assertEquals(res.status, 200);
    const page = await res.text();
    assertStringIncludes(page, "did not grant");
    assertStringIncludes(page, "im:history"); // a bot scope the install withheld
    assertStringIncludes(page, "channels:history"); // and a user one
    assert(await creds.get("slack:T1:org") !== undefined);
    const note = published[0] as MessageEvent;
    assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "NOT granted");
  }, {
    ...ACCESS,
    scope: "channels:history",
    authed_user: { ...ACCESS.authed_user!, scope: "chat:write" },
  });
});
