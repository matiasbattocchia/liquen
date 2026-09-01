/**
 * connections: memberships move with the wire (§4, §6). Upsert-only means a restart never
 * erases — and a channel LEAVE is a soft-delete: the membership's lifetime ends, but the
 * agent keeps what it has seen (events up to the stamp). A rejoin revives.
 */

import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";
import { aliasOf } from "./connections.ts";

Deno.test("memberships: a lifetime — leave keeps seen history, refuses the future, rejoin revives", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const row = { service: "slack", connection: "T1", conversation: "slack:T1:C1", agentId: "ana" };
  const member = (ts?: string) => log.isMember("slack", "T1", "slack:T1:C1", "ana", "mind", ts);
  try {
    assertEquals(member(), false);
    log.upsertMemberships([row, row]); // re-enroll: no duplicate, no error
    assertEquals(member(), true);

    log.deleteMemberships([row]);
    assertEquals(member(), false); // no ts asks about NOW — the lifetime is over
    assertEquals(member("2020-01-01T00:00:00Z"), true); // what ana has seen stays hers
    assertEquals(member("2100-01-01T00:00:00Z"), false); // the conversation's future is not
    log.deleteMemberships([row]); // stamping again is harmless
    assertEquals(member(), false);

    log.upsertMemberships([row]); // rejoin revives — the conversation whole again
    assertEquals(member(), true);
    assertEquals(member("2100-01-01T00:00:00Z"), true);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aliases: owned rows with a self_conversation, matched on the workspace root (§4)", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.upsertConnections([
      { service: "slack", address: "T1" }, // no owner, no binding — not an alias
      { service: "slack", address: "T1:U1", agentId: "ana", extra: { self_conversation: "D1" } },
      { service: "whatsapp", address: "549", agentId: "ana" }, // DERIVED: self-chat == own number
      { service: "whatsapp", address: "550" }, // ownerless (org number) — never a mind (§4)
      { service: "email", address: "ana@org", agentId: "ana" }, // owned, no binding
    ]);
    assertEquals(log.aliases(), [
      { service: "slack", connection: "T1:U1", conversation: "D1", agentId: "ana" },
      { service: "whatsapp", connection: "549", conversation: "549", agentId: "ana" },
    ]);

    const rows = log.aliases();
    // events anchor to a SIBLING of the grant (the workspace, the bot) — the root matches
    assertEquals(aliasOf(rows, "slack", "T1", "D1")?.agentId, "ana");
    assertEquals(aliasOf(rows, "slack", "T1:UBOT", "D1")?.agentId, "ana");
    assertEquals(aliasOf(rows, "whatsapp", "549", "549")?.agentId, "ana");
    // same conversation id on ANOTHER workspace/number is someone else's chat
    assertEquals(aliasOf(rows, "slack", "T2", "D1"), undefined);
    assertEquals(aliasOf(rows, "whatsapp", "550", "549"), undefined);
    assertEquals(aliasOf(rows, "slack", "T1", "C7"), undefined);

    // a revocation closes the gate, never the hiding: the binding keeps answering
    log.deleteConnections([{ service: "slack", address: "T1:U1" }]);
    assertEquals(log.aliases().length, 2);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
