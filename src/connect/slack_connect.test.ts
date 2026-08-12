/**
 * slack connect: the paste door (§4). The paste is the grant, and the grant writes the
 * map — but only after Slack vouches for it: auth.test resolves the workspace (a token
 * string never identifies one) and a rejected token writes NOTHING.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { connectSlackUser, manifestUrl, userManifest } from "./slack_connect.ts";
import type { ConnectionRow, MembershipRow } from "../store/connections.ts";
import type { CredentialRow } from "../store/credentials.ts";
import type { Appender } from "../store/log.ts";
import type { Draft, Event } from "../types.ts";
import { newId } from "../store/id.ts";

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

Deno.test("connect: the prefill link embeds the manifest for api.slack.com to build from", () => {
  const url = manifestUrl({ display_information: { name: "mu" } });
  assertEquals(url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="), true);
  assertEquals(
    decodeURIComponent(url.split("manifest_json=")[1]),
    '{"display_information":{"name":"mu"}}',
  );
});
