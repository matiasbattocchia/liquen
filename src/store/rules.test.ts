import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";

Deno.test("standing rules: upsert by scope, most specific first, newest replaces", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.remember({ agentId: "a1", tool: "send", action: "allow" });
    log.remember({ agentId: "a1", tool: "send", action: "allow", connection: "T042" });
    log.remember({
      agentId: "a1",
      tool: "send",
      action: "allow",
      connection: "T042",
      conversation: "C042",
    });
    // most specific first: conversation over connection over global
    assertEquals(log.remembered("a1").map((r) => r.conversation ?? r.connection ?? "*"), [
      "C042",
      "T042",
      "*",
    ]);
    // a later verdict on the SAME scope replaces the action — one row per scope, no pile-up
    log.remember({
      agentId: "a1",
      tool: "send",
      action: "deny",
      connection: "T042",
      conversation: "C042",
    });
    const rows = log.remembered("a1");
    assertEquals(rows.length, 3);
    assertEquals(rows[0], {
      agentId: "a1",
      tool: "send",
      action: "deny",
      connection: "T042",
      conversation: "C042",
    });
    // per agent: another agent's table is its own
    assertEquals(log.remembered("a2"), []);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
