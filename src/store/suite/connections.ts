/**
 * connections: memberships move with the wire (§4, §6). Upsert-only means a restart never
 * erases — and a channel LEAVE is a soft-delete: the membership's lifetime ends, but the
 * agent keeps what it has seen (events up to the stamp). A rejoin revives.
 */

import { assertEquals } from "@std/assert";
import { aliasOf } from "../connections.ts";
import type { Substrate } from "./mod.ts";

export function connectionsSuite(s: Substrate): void {
  Deno.test("connections(): the live map, extra and all — a soft-deleted grant is not listed", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.upsertConnections([
        { service: "whatsapp", address: "549", agentId: "ana", extra: { state: "connected" } },
        { service: "slack", address: "T1", credentialKey: "slack:T1:org" },
        { service: "google", address: "gone@x.io", agentId: "ana" },
      ]);
      await log.deleteConnections([{ service: "google", address: "gone@x.io" }]);
      assertEquals(await log.connections(), [
        { service: "slack", address: "T1", credentialKey: "slack:T1:org" },
        { service: "whatsapp", address: "549", agentId: "ana", extra: { state: "connected" } },
      ]);
      assertEquals((await log.connection("google", "gone@x.io"))?.agentId, "ana"); // identity persists
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("memberships: a lifetime — leave keeps seen history, refuses the future, rejoin revives", async () => {
    const store = await s.fresh();
    const log = await store.open();
    const row = { service: "slack", connection: "T1", conversation: "slack:T1:C1", agentId: "ana" };
    const member = (ts?: string) => log.isMember("slack", "T1", "slack:T1:C1", "ana", "mind", ts);
    try {
      assertEquals(await member(), false);
      await log.upsertMemberships([row, row]); // re-enroll: no duplicate, no error
      assertEquals(await member(), true);

      await log.deleteMemberships([row]);
      assertEquals(await member(), false); // no ts asks about NOW — the lifetime is over
      assertEquals(await member("2020-01-01T00:00:00Z"), true); // what ana has seen stays hers
      assertEquals(await member("2100-01-01T00:00:00Z"), false); // the conversation's future is not
      await log.deleteMemberships([row]); // stamping again is harmless
      assertEquals(await member(), false);

      await log.upsertMemberships([row]); // rejoin revives — the conversation whole again
      assertEquals(await member(), true);
      assertEquals(await member("2100-01-01T00:00:00Z"), true);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("aliases: owned rows with a self_conversation, matched on the workspace root (§4)", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.upsertConnections([
        { service: "slack", address: "T1" }, // no owner, no binding — not an alias
        { service: "slack", address: "T1:U1", agentId: "ana", extra: { self_conversation: "D1" } },
        { service: "whatsapp", address: "549", agentId: "ana" }, // DERIVED: self-chat == own number
        { service: "whatsapp", address: "550" }, // ownerless (org number) — never a mind (§4)
        { service: "email", address: "ana@org", agentId: "ana" }, // owned, no binding
      ]);
      assertEquals(await log.aliases(), [
        {
          service: "slack",
          connection: "T1:U1",
          conversation: "D1",
          agentId: "ana",
          principal: "ana",
          live: true,
        },
        {
          service: "whatsapp",
          connection: "549",
          conversation: "549",
          agentId: "ana",
          principal: "ana",
          live: true,
        },
      ]);

      const rows = await log.aliases();
      // events anchor to a SIBLING of the grant (the workspace, the bot) — the root matches
      assertEquals(aliasOf(rows, "slack", "T1", "D1")?.agentId, "ana");
      assertEquals(aliasOf(rows, "slack", "T1:UBOT", "D1")?.agentId, "ana");
      assertEquals(aliasOf(rows, "whatsapp", "549", "549")?.agentId, "ana");
      // same conversation id on ANOTHER workspace/number is someone else's chat
      assertEquals(aliasOf(rows, "slack", "T2", "D1"), undefined);
      assertEquals(aliasOf(rows, "whatsapp", "550", "549"), undefined);
      assertEquals(aliasOf(rows, "slack", "T1", "C7"), undefined);

      // a revocation closes the gate, never the hiding: the binding keeps answering — but
      // the surface is no longer one somebody holds
      await log.deleteConnections([{ service: "slack", address: "T1:U1" }]);
      assertEquals(aliasOf(await log.aliases(), "slack", "T1", "D1")?.agentId, "ana");
      assertEquals((await log.aliases()).map((a) => a.live), [false, true]);
      // a re-grant revives it
      await log.upsertConnections([{ service: "slack", address: "T1:U1", agentId: "ana" }]);
      assertEquals((await log.aliases()).map((a) => a.live), [true, true]);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("aliases: a principal's DM with the org number is a surface of the org agent's mind (§4)", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.syncAgents([
        { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "549115550001" },
        { agentId: "ventas", mind: "mind@ventas", name: "Ventas", phone: "549117770000" },
      ]);
      await log.upsertConnections([
        { service: "whatsapp", address: "549115550001", agentId: "matias" },
        { service: "whatsapp", address: "549117770000", credentialKey: "whatsapp:549117770000" },
      ]);
      assertEquals(await log.principalsOf("ventas"), ["matias", "ventas"]);
      assertEquals(await log.principalsOf("matias"), ["matias"]);
      assertEquals(await log.aliases(), [
        // the store's own: the member's self-chat
        {
          service: "whatsapp",
          connection: "549115550001",
          conversation: "549115550001",
          agentId: "matias",
          principal: "matias",
          live: true,
        },
        // derived: matias's DM with the org number, a surface of ventas's mind
        {
          service: "whatsapp",
          connection: "549117770000",
          conversation: "549115550001",
          agentId: "ventas",
          principal: "matias",
          live: true,
        },
      ]);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("memberships(): every enrollment, ended ones stamped, in key order", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.upsertMemberships([
        { service: "slack", connection: "T1", conversation: "slack:T1:C9", agentId: "bo" },
        { service: "slack", connection: "T1", conversation: "slack:T1:C1", agentId: "ana" },
        { service: "mail", connection: "ana@x.io", conversation: "thread-1", agentId: "ana" },
      ]);
      await log.deleteMemberships([
        { service: "slack", connection: "T1", conversation: "slack:T1:C9", agentId: "bo" },
      ]);
      const found = await log.memberships();
      assertEquals(found.map((m) => `${m.service} ${m.conversation} ${m.agentId}/${m.sessionId}`), [
        "mail thread-1 ana/mind",
        "slack slack:T1:C1 ana/mind",
        "slack slack:T1:C9 bo/mind",
      ]);
      assertEquals(found.map((m) => m.deletedAt !== undefined), [false, false, true]);
    } finally {
      await log.close();
      await store.drop();
    }
  });
}
