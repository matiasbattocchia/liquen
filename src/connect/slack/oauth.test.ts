import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createSlackOAuth, type SlackAccess } from "./oauth.ts";
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

// a member's sign-in on a workspace the app is already installed in: the user leg comes
// back carrying what the door asked for — Slack states the granted scopes on the exchange,
// and a token short of them fails at the call
const ACCESS: SlackAccess = {
  ok: true,
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
    start: (agent?: string) => Promise<Response>;
    callback: (code: string, state: string) => Promise<Response>;
  }) => Promise<void>,
  access: SlackAccess = ACCESS,
  opts: { defaultExchange?: boolean } = {},
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
    openSelfIm: () => Promise.resolve("D0SELF"),
    ...(opts.defaultExchange ? {} : {
      exchange: (code) => {
        exchanged.push(code);
        return Promise.resolve(access);
      },
    }),
  });
  try {
    await fn({
      handler,
      published,
      exchanged,
      connections,
      memberships,
      creds,
      start: (agent = "ana") =>
        handler(new Request(`https://x.example/oauth/slack/start?agent=${agent}`)),
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

Deno.test("start: mints a one-time state and 302s to Slack asking the user leg only", async () => {
  await withOAuth(async ({ start }) => {
    const res = await start();
    assertEquals(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.origin + loc.pathname, "https://slack.com/oauth/v2/authorize");
    assertEquals(loc.searchParams.get("client_id"), "cid");
    assertEquals(loc.searchParams.get("user_scope"), "chat:write,channels:history");
    // the bot is the org's and comes from the install — a member's sign-in never asks for it
    assertEquals(loc.searchParams.get("scope"), null);
    assertEquals(loc.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert(stateOf(res).length > 10);
    // two clicks get DIFFERENT states
    assert(stateOf(await start()) !== stateOf(res));
  });
});

Deno.test("start: a link naming nobody is refused — a user token is always someone's", async () => {
  await withOAuth(async ({ handler }) => {
    const res = await handler(new Request("https://x.example/oauth/slack/start"));
    assertEquals(res.status, 400);
  });
});

Deno.test("start: ?scopes= overrides the catalog's ask for that one link", async () => {
  await withOAuth(async ({ handler }) => {
    const res = await handler(
      new Request("https://x.example/oauth/slack/start?agent=ana&scopes=im:read,search:read"),
    );
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.searchParams.get("user_scope"), "im:read,search:read");
  });
});

Deno.test("callback: exchanges the code and lands the leg as a paste would — bound to the link's agent, addressed by Slack's id", async () => {
  await withOAuth(
    async ({ start, callback, creds, published, exchanged, connections, memberships }) => {
      const state = stateOf(await start("ana"));
      const res = await callback("code-1", state);
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "close this window");
      assertEquals(exchanged, ["code-1"]);
      // the vault row is the agent's, named at mint time
      const user = await creds.get("slack:T1:ana");
      assertEquals(user?.value, { token: "xoxp-ana-token" });
      assertEquals(user?.agentId, "ana");
      // the same two rows the paste door writes: the workspace stub and the OWNED grant
      // `<team>:<user>` with the Slack-verified id, the self-DM bound (§4)
      assertEquals(connections, [
        { service: "slack", address: "T1" },
        {
          service: "slack",
          address: "T1:U9",
          agentId: "ana",
          credentialKey: "slack:T1:ana",
          extra: { self_conversation: "D0SELF" },
        },
      ]);
      // the principal sees their own grant note even on a stub workspace (§6)
      assertEquals(memberships, [
        { service: "slack", connection: "T1", conversation: "connect", agentId: "ana" },
      ]);
      // the frontier is crossed as an event
      assertEquals(published.length, 1);
      const note = published[0] as MessageEvent;
      assertEquals(note.envelope.service, "slack");
      assertStringIncludes((note.parts[0] as { text: string }).text, "ana (slack user U9)");
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
    assertEquals(await creds.get("slack:T1:ana"), null);
    assertEquals(published.length, 0);
  }, { ok: false, error: "invalid_code" });
});

Deno.test("callback: an exchange with no user token is a failure, not an org grant", async () => {
  await withOAuth(async ({ start, callback, creds, connections }) => {
    const res = await callback("c1", stateOf(await start()));
    assertEquals(res.status, 502);
    assertStringIncludes(await res.text(), "no user token");
    assertEquals(await creds.get("slack:T1:org"), null); // the bot never lands through here
    assertEquals(connections.length, 0);
  }, { ok: true, access_token: "xoxb-bot-token", bot_user_id: "UBOT", team: { id: "T1" } });
});

Deno.test("callback: a sign-in that granted less than the ask says which scopes", async () => {
  await withOAuth(async ({ start, callback, creds, published }) => {
    const res = await callback("code-1", stateOf(await start()));
    // the sign-in COMPLETED — the leg is stored; the reach is what fell short
    assertEquals(res.status, 200);
    const page = await res.text();
    assertStringIncludes(page, "did not grant");
    assertStringIncludes(page, "channels:history");
    assert(await creds.get("slack:T1:ana") !== null);
    const note = published[0] as MessageEvent;
    assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "NOT granted");
  }, { ...ACCESS, authed_user: { ...ACCESS.authed_user!, scope: "chat:write" } });
});

Deno.test("callback: the default exchange's oauth.v2.access call carries a timeout signal", async () => {
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_i: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return Promise.resolve(Response.json(ACCESS));
  }) as typeof fetch;
  try {
    await withOAuth(
      async (t) => {
        const res = await t.callback("c1", stateOf(await t.start()));
        assertEquals(res.status, 200);
        assertEquals(t.connections.length > 0, true);
      },
      ACCESS,
      { defaultExchange: true },
    );
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(seen.length, 1);
  assert(seen[0].signal instanceof AbortSignal, "the exchange is bounded");
});
