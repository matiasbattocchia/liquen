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

Deno.test("speaksThrough: an agent's own accounts and the org's credentialed ones", () => {
  const of = (i: number) => speaksThrough(roster[i], connections).map((c) => c.address);
  assertEquals(of(0), ["549115550001", "549118880000"]); // matias: his phone, the org's number
  assertEquals(of(2), ["549117770000", "549118880000"]); // ventas: its own number, the org's
  assertEquals(of(3), ["549118880000"]); // ops owns nothing: the org's alone; the stub is nobody's
});
