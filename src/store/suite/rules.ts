import { assertEquals } from "@std/assert";
import type { Substrate } from "./mod.ts";

export function rulesSuite(s: Substrate): void {
  Deno.test("standing rules: upsert by scope, most specific first, newest replaces", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.remember({ agentId: "a1", tool: "send", action: "allow" });
      await log.remember({ agentId: "a1", tool: "send", action: "allow", connection: "T042" });
      await log.remember({
        agentId: "a1",
        tool: "send",
        action: "allow",
        connection: "T042",
        conversation: "C042",
      });
      // most specific first: conversation over connection over global
      assertEquals((await log.remembered("a1")).map((r) => r.conversation ?? r.connection ?? "*"), [
        "C042",
        "T042",
        "*",
      ]);
      // a later verdict on the SAME scope replaces the action — one row per scope, no pile-up
      await log.remember({
        agentId: "a1",
        tool: "send",
        action: "deny",
        connection: "T042",
        conversation: "C042",
      });
      const rows = await log.remembered("a1");
      assertEquals(rows.length, 3);
      assertEquals(rows[0], {
        agentId: "a1",
        tool: "send",
        action: "deny",
        connection: "T042",
        conversation: "C042",
      });
      // per agent: another agent's table is its own
      assertEquals(await log.remembered("a2"), []);
    } finally {
      await log.close();
      await store.drop();
    }
  });
}
