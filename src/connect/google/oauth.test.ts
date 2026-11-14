import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createGoogleOAuth, type GoogleTokens, missingScopes } from "./oauth.ts";
import { openCredentials } from "../../store/credentials.ts";
import { membersAt } from "../../testing.ts";
import type { Draft, Event } from "../../types.ts";
import { newId } from "../../store/id.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";
import { DEFAULT_SCOPES } from "./config.ts";
import { fakeGate, ticket } from "../testing.ts";

const LINKED_AT = "2026-10-20T00:00:00.000Z";

/** The open sign-ins the tests start: ana's, the org's, and a reconnect pinned to ana's
 *  account. */
const TICKETS = [
  ticket("t-ana", { agentId: "ana", extra: { scopes: DEFAULT_SCOPES } }),
  ticket("t-org", { extra: { scopes: DEFAULT_SCOPES } }),
  ticket("t-again", {
    agentId: "ana",
    extra: { scopes: ["openid", "email"], account: "ana@example.com" },
  }),
];

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
  scope: "openid email https://www.googleapis.com/auth/calendar " +
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
  id_token: jwt({ email: "ana@example.com", sub: "108" }),
};

async function withOAuth(
  fn: (t: {
    published: Event[];
    exchanged: string[];
    connections: ConnectionRow[];
    memberships: MembershipRow[];
    creds: Awaited<ReturnType<typeof openCredentials>>;
    gate: ReturnType<typeof fakeGate>;
    start: (query?: string) => Promise<Response>;
    callback: (code: string, state: string) => Promise<Response>;
  }) => Promise<void>,
  tokens: GoogleTokens = TOKENS,
  opts: { defaultExchange?: boolean; refuse?: string } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await membersAt(dir, "ana", "bo");
  const creds = await openCredentials(dir);
  const published: Event[] = [];
  const exchanged: string[] = [];
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const gate = fakeGate(TICKETS, opts);
  const handler = createGoogleOAuth({
    config: () => Promise.resolve(CONFIG),
    gate,
    creds,
    now: () => LINKED_AT,
    // the map's write side in miniature: the grant creates anchor + binding (§4)
    store: {
      upsertConnections: (rows) => {
        connections.push(...rows);
        return Promise.resolve();
      },
      upsertMemberships: (rows) => {
        memberships.push(...rows);
        return Promise.resolve();
      },
    },
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    ...(opts.defaultExchange ? {} : {
      exchange: (code) => {
        exchanged.push(code);
        return Promise.resolve(tokens);
      },
    }),
  });
  try {
    await fn({
      published,
      exchanged,
      connections,
      memberships,
      creds,
      gate,
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

Deno.test("start: 302 to Google asking offline + incremental, the ticket's scopes", async () => {
  await withOAuth(async (t) => {
    const res = await t.start("?ticket=t-ana");
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

Deno.test("start: a reconnect asks what the ticket kept and preselects its account", async () => {
  await withOAuth(async (t) => {
    const res = await t.start("?ticket=t-again");
    const loc = new URL(res.headers.get("location")!);
    assertEquals(loc.searchParams.get("scope"), "openid email");
    assertEquals(loc.searchParams.get("login_hint"), "ana@example.com");
    assertEquals(
      new URL((await t.start("?ticket=t-ana")).headers.get("location")!)
        .searchParams.get("login_hint"),
      null,
    );
  });
});

Deno.test("start: a link with no live ticket is refused, and names nobody", async () => {
  await withOAuth(async (t) => {
    assertEquals((await t.start()).status, 410);
    assertEquals((await t.start("?ticket=nope")).status, 410);
    assertEquals((await t.start("?agent=ana")).status, 410); // a name is no ticket
  });
});

Deno.test("callback: the grant writes the map — vault, connection, membership, event", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?ticket=t-ana"));
    const res = await t.callback("c0de", state);
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "close this window");
    assertEquals(t.exchanged, ["c0de"]);
    // the ticket judged the account the id token vouched for, and heard it landed
    assertEquals(t.gate.seen.judged, [{
      ticket: "t-ana",
      who: { address: "ana@example.com", email: "ana@example.com" },
    }]);
    assertEquals(t.gate.seen.landed, [{ ticket: "t-ana", account: "ana@example.com" }]);
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
      // linked: up, whatever the row said before (a signed-out grant comes back here)
      extra: { state: "connected", connected_at: LINKED_AT, error: null },
    }]);
    assertEquals(t.memberships.length, 1);
    // the grant event names the account and the principal
    assertEquals(t.published.length, 1);
    const note = t.published[0];
    assert(note.type === "message");
    assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "for ana");
  });
});

Deno.test("callback: no agent on the ticket ⇒ the org's grant — ownerless, no membership", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?ticket=t-org"));
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
    const state = stateOf(await t.start("?ticket=t-org"));
    assertEquals((await t.callback("c0de", state)).status, 200);
    assertEquals((await t.callback("c0de", state)).status, 400); // one-time
    assertEquals(t.exchanged, ["c0de"]); // the replay never reached the exchange
  });
});

Deno.test("callback: a second click's state finds its ticket settled by the first", async () => {
  await withOAuth(async (t) => {
    const first = stateOf(await t.start("?ticket=t-ana"));
    const second = stateOf(await t.start("?ticket=t-ana")); // the link opened again
    assertEquals((await t.callback("c0de", first)).status, 200);
    assertEquals((await t.callback("c0de", second)).status, 410);
    assertEquals(t.exchanged, ["c0de"]);
  });
});

Deno.test("callback: an account the ticket refuses writes nothing", async () => {
  await withOAuth(
    async (t) => {
      const res = await t.callback("c0de", stateOf(await t.start("?ticket=t-again")));
      assertEquals(res.status, 403);
      assertStringIncludes(await res.text(), "nothing was connected");
      assertEquals(t.connections, []);
      assertEquals(await t.creds.get("google:ana@example.com"), null);
      assertEquals(t.published, []);
      assertEquals(t.gate.seen.landed, []);
    },
    TOKENS,
    { refuse: "signed in as bo@example.com: nothing was connected" },
  );
});

Deno.test("callback: consent declined on the wire ends the sign-in it names", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?ticket=t-ana"));
    const handler = await t.callback("", state);
    assertEquals(handler.status, 400);
    assertEquals(t.gate.seen.failed.map((f) => f.ticket), ["t-ana"]);
    assertEquals(t.exchanged, []);
  });
});

Deno.test("callback: a re-consent without a refresh token keeps the stored one", async () => {
  await withOAuth(async (t) => {
    const first = stateOf(await t.start("?ticket=t-ana"));
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
    const state = stateOf(await t.start("?ticket=t-org"));
    const res = await t.callback("c0de", state);
    assertEquals(res.status, 502);
    assertEquals(t.connections, []);
    assertEquals(t.gate.seen.failed.map((f) => f.ticket), ["t-org"]);
  }, { access_token: "ya29.short" }); // no id_token on the wire
});

Deno.test("missingScopes: Google's shorthands are the same scope, not a shortfall", () => {
  // the ask says `email`, the grant says the full userinfo URL — comparing the two
  // spellings naively reports every healthy grant as partial
  assertEquals(
    missingScopes(
      ["openid", "email", "https://www.googleapis.com/auth/calendar"],
      "https://www.googleapis.com/auth/userinfo.email openid " +
        "https://www.googleapis.com/auth/calendar",
    ),
    [],
  );
  assertEquals(missingScopes(["openid", "profile"], "openid"), ["profile"]);
  assertEquals(missingScopes(["openid"], undefined), ["openid"]); // no scope on the wire
});

Deno.test("callback: a grant that dropped a scope says so — page, event, outcome", async () => {
  await withOAuth(async (t) => {
    const state = stateOf(await t.start("?ticket=t-ana"));
    const res = await t.callback("c0de", state);
    // the flow COMPLETED — the grant is real and stored; it just cannot do the work
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "auth/calendar");
    assertEquals(t.gate.seen.landed, [{
      ticket: "t-ana",
      account: "ana@example.com",
      missing: ["https://www.googleapis.com/auth/calendar"],
    }]);
    assertStringIncludes(t.published[0].parts[0].text!, "NOT granted: ");
    assert((await t.creds.get("google:ana@example.com")) !== undefined);
  }, {
    ...TOKENS,
    // the member left calendar unticked
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly " +
      "https://www.googleapis.com/auth/gmail.send",
  });
});

Deno.test("callback: the default exchange's token call carries a timeout signal", async () => {
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_i: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return Promise.resolve(Response.json(TOKENS));
  }) as typeof fetch;
  try {
    await withOAuth(
      async (t) => {
        const res = await t.callback("c1", stateOf(await t.start("?ticket=t-org")));
        assertEquals(res.status, 200);
        assertEquals(t.connections.length > 0, true);
      },
      TOKENS,
      { defaultExchange: true },
    );
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(seen.length, 1);
  assert(seen[0].signal instanceof AbortSignal, "the exchange is bounded");
});
