/**
 * The SQLite adapter runs the roster suite; the handle rules beside it are pure and run
 * once, over no store.
 */

import { assertEquals } from "@std/assert";
import { sameHandle, speaksThrough } from "./roster.ts";
import { connections, roster, rosterSuite } from "./suite/roster.ts";
import { sqlite } from "./suite/mod.ts";

rosterSuite(sqlite);

Deno.test("sameHandle: phones agree on digits, emails on the folded string, nothing else", () => {
  assertEquals(sameHandle("+54 9 11 555-0001", "549115550001"), true);
  assertEquals(sameHandle("549115550001", "549115550002"), false);
  assertEquals(sameHandle("Ana@Acme.co", "ana@acme.co"), true);
  assertEquals(sameHandle("ana@acme.co", "549115550001"), false);
  assertEquals(sameHandle(undefined, "549115550001"), false);
  assertEquals(sameHandle("+", "-"), false); // no digits is no phone
});

Deno.test("speaksThrough: a handle claims the org account, ownership names the member's", () => {
  assertEquals(speaksThrough(roster[0], connections).map((c) => c.address), ["549115550001"]);
  assertEquals(speaksThrough(roster[2], connections).map((c) => c.address), ["549117770000"]);
  assertEquals(speaksThrough(roster[3], connections), []); // the Slack anchor claims nobody
});
