/**
 * slack connect: the paste door (§4). The paste is the grant, and the grant writes the
 * map — but only after Slack vouches for it: auth.test resolves the workspace (a token
 * string never identifies one) and a rejected token writes NOTHING.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { missingScopes } from "./config.ts";
import {
  connectSlackApp,
  connectSlackBot,
  connectSlackUser,
  manifestUrl,
  pickSlackApp,
  slackHave,
  slackNext,
  userManifest,
  withScopes,
} from "./connect.ts";
import { DEFAULT_BOT_SCOPES, DEFAULT_USER_SCOPES } from "./config.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";
import type { CredentialRow } from "../../store/credentials.ts";
import type { Appender } from "../../store/log.ts";
import type { Draft, Event } from "../../types.ts";
import { newId } from "../../store/id.ts";

function harness() {
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const credentials: CredentialRow[] = [];
  const published: Event[] = [];
  return {
    connections,
    memberships,
    credentials,
    published,
    deps: {
      principal: "matias",
      openSelfIm: () => Promise.resolve<string | undefined>("D0SELF"),
      creds: {
        put: (row: CredentialRow) => {
          credentials.push(row);
          return Promise.resolve();
        },
      },
      store: {
        upsertConnections: (rows: ConnectionRow[]) => connections.push(...rows),
        upsertMemberships: (rows: MembershipRow[]) => memberships.push(...rows),
      },
      publish: ((e: Draft) => {
        const stored = { ...e, id: e.id ?? newId() } as Event;
        published.push(stored);
        return Promise.resolve(stored);
      }) as Appender["publish"],
    },
  };
}

Deno.test("connect: a verified paste registers the workspace + the owned grant + note", async () => {
  const h = harness();
  const { team, user } = await connectSlackUser("xoxp-secret", {
    ...h.deps,
    authTest: () => Promise.resolve({ ok: true, team_id: "T1", user_id: "U7" }),
  });

  assertEquals({ team, user }, { team: "T1", user: "U7" });
  // the workspace (the anchor events carry — registering it opens the gate) and the
  // grant `<team>:<user>` (identity + credential edge, §4)
  assertEquals(h.connections, [
    { service: "slack", address: "T1" },
    {
      service: "slack",
      address: "T1:U7",
      agentId: "matias",
      credentialKey: "slack:T1:matias",
      // the mind-alias binding (§4): the self-DM, resolved with the grant in hand
      extra: { self_conversation: "D0SELF" },
    },
  ]);
  assertEquals(h.credentials, [
    { key: "slack:T1:matias", value: { token: "xoxp-secret" }, agentId: "matias" },
  ]);
  // the note is the principal's to see — membership carries it on a stub workspace (§6)
  assertEquals(h.memberships, [
    { service: "slack", connection: "T1", conversation: "connect", agentId: "matias" },
  ]);
  assertEquals(h.published.length, 1); // the grant crossed the frontier as an event
});

Deno.test("connect: an unresolvable self-DM still grants — just without the alias binding", async () => {
  const h = harness();
  await connectSlackUser("xoxp-secret", {
    ...h.deps,
    authTest: () => Promise.resolve({ ok: true, team_id: "T1", user_id: "U7" }),
    openSelfIm: () => Promise.reject(new Error("missing_scope")),
  });
  assertEquals(h.connections[1], {
    service: "slack",
    address: "T1:U7",
    agentId: "matias",
    credentialKey: "slack:T1:matias",
  });
  assertEquals(h.published.length, 1); // the note still crosses (and says the alias is unbound)
});

Deno.test("connect: a BOT token paste is refused by shape — auth.test would vouch for it", async () => {
  const h = harness();
  await assertRejects(
    () =>
      connectSlackUser("xoxb-bot-token", {
        ...h.deps,
        // auth.test WOULD say ok (with the bot's own user id) — the guard must fire first
        authTest: () => Promise.resolve({ ok: true, team_id: "T1", user_id: "UBOT" }),
      }),
    Error,
    "BOT token",
  );
  assertEquals(h.connections.length, 0); // the bot's handle never binds to a human
  assertEquals(h.credentials.length, 0);
});

Deno.test("connect: a rejected token writes NOTHING — verify before the map", async () => {
  const h = harness();
  await assertRejects(
    () =>
      connectSlackUser("xoxp-forged", {
        ...h.deps,
        authTest: () => Promise.resolve({ ok: false, error: "invalid_auth" }),
      }),
    Error,
    "invalid_auth",
  );
  assertEquals(h.connections.length, 0);
  assertEquals(h.credentials.length, 0);
  assertEquals(h.published.length, 0);
});

Deno.test("connect: the default door mints a USER-ONLY app — every bot limb dropped", () => {
  const m = userManifest({
    display_information: { name: "mu" },
    features: { bot_user: { display_name: "mu" } },
    oauth_config: { scopes: { bot: ["chat:write"], user: ["chat:write", "im:history"] } },
    settings: {
      event_subscriptions: { bot_events: ["message.im"], user_events: ["message.im"] },
      socket_mode_enabled: true,
    },
  }) as Record<string, Record<string, unknown>>;
  assertEquals(m.features, undefined); // bot_user gone; empty features pruned
  assertEquals(m.oauth_config.scopes, { user: ["chat:write", "im:history"] });
  assertEquals(m.settings.event_subscriptions, { user_events: ["message.im"] });
  assertEquals(m.settings.socket_mode_enabled, true); // the carrier stays
});

Deno.test("connect: the manifest's consent comes from the catalog, not the seed", async () => {
  const seed = JSON.parse(
    await Deno.readTextFile(new URL("../../seed/slack-manifest.json", import.meta.url)),
  ) as { oauth_config: Record<string, unknown> };
  // the seed is the app's SHAPE — it must not carry a second copy of the scope lists
  assertEquals(seed.oauth_config.scopes, undefined);
  assert(Array.isArray(seed.oauth_config.redirect_urls), "the shape is still there");

  const filled = withScopes(seed, { bot: DEFAULT_BOT_SCOPES, user: DEFAULT_USER_SCOPES }) as {
    oauth_config: { scopes: Record<string, string[]>; redirect_urls: string[] };
  };
  assertEquals(filled.oauth_config.scopes.bot, DEFAULT_BOT_SCOPES);
  assertEquals(filled.oauth_config.scopes.user, DEFAULT_USER_SCOPES);
  assert(filled.oauth_config.redirect_urls.length > 0, "injection kept the rest of the section");
  // and the user door drops the bot leg from what it just filled in
  const user = userManifest(filled) as { oauth_config: { scopes: Record<string, string[]> } };
  assertEquals(user.oauth_config.scopes, { user: DEFAULT_USER_SCOPES });
});

Deno.test("connect: the prefill link embeds the manifest for api.slack.com to build from", () => {
  const url = manifestUrl({ display_information: { name: "mu" } });
  assertEquals(url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="), true);
  assertEquals(
    decodeURIComponent(url.split("manifest_json=")[1]),
    '{"display_information":{"name":"mu"}}',
  );
});

Deno.test("bot door: xoxb (+ xapp) → the org-credentialed anchor + the vault blob", async () => {
  const h = harness();
  const { team, botUser } = await connectSlackBot("xoxb-bot", {
    ...h.deps,
    authTest: () =>
      Promise.resolve({ ok: true, team_id: "T1", user_id: "UBOT", url: "https://x.slack.com" }),
  }, "xapp-carrier");

  assertEquals({ team, botUser }, { team: "T1", botUser: "UBOT" });
  // ONE row: the workspace anchor, org-credentialed — no owner, no membership (§6)
  assertEquals(h.connections, [{ service: "slack", address: "T1", credentialKey: "slack:T1:org" }]);
  assertEquals(h.memberships.length, 0);
  assertEquals(h.credentials[0].key, "slack:T1:org");
  assertEquals(h.credentials[0].value, { token: "xoxb-bot", app_token: "xapp-carrier" });
  assertEquals(h.credentials[0].extra?.bot_user, "UBOT");
  assertEquals(h.published.length, 1); // the note crossed the frontier as an event
});

Deno.test("bot door: a USER token is refused by shape and points at the user door", async () => {
  const h = harness();
  await assertRejects(
    () =>
      connectSlackBot("xoxp-user", {
        ...h.deps,
        authTest: () => Promise.resolve({ ok: true, team_id: "T1", user_id: "U7" }),
      }),
    Error,
    "mu connect slack user",
  );
  assertEquals(h.connections.length, 0);
  assertEquals(h.credentials.length, 0);
});

Deno.test("app door: the client lands under its own id; pick = only one, or by id", async () => {
  const rows = new Map<string, CredentialRow>();
  const creds = {
    put: (r: CredentialRow) => {
      rows.set(r.key, r);
      return Promise.resolve();
    },
    get: (k: string) => Promise.resolve(rows.get(k) ?? null),
    list: (p: string) => Promise.resolve([...rows.values()].filter((r) => r.key.startsWith(p))),
  };
  await assertRejects(() => pickSlackApp(creds), Error, "mu connect slack app");
  const key = await connectSlackApp(
    { clientId: "123.456", clientSecret: "sec", redirectUri: "https://org.example/cb" },
    creds,
  );
  assertEquals(key, "slack:app:123.456");
  assertEquals((await pickSlackApp(creds)).value.client_id, "123.456");
  assertEquals(
    (await pickSlackApp(creds, "123.456")).extra?.redirect_uri,
    "https://org.example/cb",
  );
  await connectSlackApp({ clientId: "789.000", clientSecret: "sec2" }, creds);
  await assertRejects(() => pickSlackApp(creds), Error, "--app"); // several ⇒ pick explicitly
});

Deno.test("connect: a paste short of the ask is stored, and says what it cannot do", async () => {
  const h = harness();
  const { missing } = await connectSlackUser("xoxp-secret", {
    ...h.deps,
    asked: ["chat:write", "channels:history", "files:read"],
    // the header Slack answers with — the only account a PASTED token gives of its reach
    authTest: () =>
      Promise.resolve({
        ok: true,
        team_id: "T1",
        user_id: "U7",
        scopes: ["identify", "chat:write", "channels:history"],
      }),
  });

  assertEquals(missing, ["files:read"]);
  // the grant still LANDS — it is real, it just cannot do everything asked of it
  assertEquals(h.connections.length, 2);
  const note = h.published[0];
  assert(note.type === "message" && note.parts[0].type === "text");
  assertStringIncludes(note.parts[0].text, "NOT granted: files:read");
});

Deno.test("connect: a token carrying the whole ask claims no shortfall", async () => {
  const h = harness();
  const { missing } = await connectSlackUser("xoxp-secret", {
    ...h.deps,
    asked: ["chat:write"],
    authTest: () =>
      Promise.resolve({ ok: true, team_id: "T1", user_id: "U7", scopes: ["chat:write"] }),
  });
  assertEquals(missing, []);
  const note = h.published[0];
  assert(note.type === "message" && note.parts[0].type === "text");
  assert(!note.parts[0].text.includes("NOT granted"));
});

Deno.test("connect: the bot door weighs the paste against the org's bot scopes", async () => {
  const h = harness();
  const { missing } = await connectSlackBot("xoxb-secret", {
    creds: h.deps.creds,
    store: h.deps.store,
    publish: h.deps.publish,
    asked: ["chat:write", "users:read"],
    authTest: () =>
      Promise.resolve({ ok: true, team_id: "T1", user_id: "UBOT", scopes: ["chat:write"] }),
  });
  assertEquals(missing, ["users:read"]);
});

Deno.test("missingScopes: a token with no scopes on the wire owes the whole ask", () => {
  assertEquals(missingScopes(["a", "b"], undefined), ["a", "b"]);
  assertEquals(missingScopes(["a", "b"], "b,a"), []); // comma-separated, any order
  assertEquals(missingScopes(["a"], ["a", "extra"]), []); // extra reach is not a shortfall
});

Deno.test("slackHave: the vault's slack rows sort into app, bot, carrier, user", () => {
  assertEquals(
    slackHave([
      { key: "slack:app:cid", value: { client_id: "cid" } },
      { key: "slack:T1:org", value: { token: "xoxb-x", app_token: "xapp-x" } },
      { key: "slack:T1:matias", value: { token: "xoxp-x" } },
    ]),
    { app: true, bot: true, appToken: true, user: true },
  );
  // a bot pasted without the second token is a bot with NO carrier
  assertEquals(
    slackHave([{ key: "slack:T1:org", value: { token: "xoxb-x" } }]),
    { app: false, bot: true, appToken: false, user: false },
  );
});

Deno.test("slackNext: a user leg alone is told inbound has no carrier yet", () => {
  const next = slackNext({ app: false, bot: false, appToken: false, user: true });
  assertEquals(next.length, 2); // the bot (with its carrier), and the oauth client
  assertStringIncludes(next[0], "mu connect slack bot");
  assertStringIncludes(next[0], "PUBLIC request URL"); // the alternative, named
  assertStringIncludes(next[1], "mu connect slack app");
});

Deno.test("slackNext: a bot without its app-level token is told where to generate one", () => {
  const next = slackNext({ app: true, bot: true, appToken: false, user: false });
  assertEquals(next.length, 1);
  assertStringIncludes(next[0], "App-Level Tokens");
  assertStringIncludes(next[0], "connections:write");
});

Deno.test("slackNext: an app and nothing else is told an app is not a grant", () => {
  const next = slackNext({ app: true, bot: false, appToken: false, user: false });
  assertStringIncludes(next[0], "no identity yet");
});

Deno.test("slackNext: carrier + both legs owes nothing", () => {
  assertEquals(slackNext({ app: true, bot: true, appToken: true, user: true }), []);
});
