/**
 * connections: memberships move with the wire (§4, §6). Upsert-only means a restart never
 * erases — and a channel LEAVE is a soft-delete: the membership's lifetime ends, but the
 * agent keeps what it has seen (events up to the stamp). A rejoin revives.
 */

import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";

Deno.test("memberships: a lifetime — leave keeps seen history, refuses the future, rejoin revives", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const row = { service: "slack", connection: "T1", conversation: "slack:T1:C1", agentId: "ana" };
  const member = (ts?: string) => log.isMember("slack", "T1", "slack:T1:C1", "ana", ts);
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
