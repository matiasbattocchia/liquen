/**
 * agents: the registry (§9). Folders + config.jsonc declare agents; `syncAgents` MIRRORS
 * the table to them — upsert present, delete absent — because the table is a projection
 * of what runs (the RLS substrate and the classifier's handle columns), never an archive.
 */

import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";

Deno.test("syncAgents mirrors: upserts the given rows and deletes the rest", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.syncAgents([{ agentId: "ana", mind: "dm:ana" }, { agentId: "bo", mind: "dm:bo" }]);
    assertEquals(log.agents(), [
      { agentId: "ana", mind: "dm:ana" },
      { agentId: "bo", mind: "dm:bo" },
    ]);

    // re-sync: ana's mind session moves, bo's folder is gone, cai appears
    log.syncAgents([{ agentId: "ana", mind: "dm:ana2" }, { agentId: "cai", mind: "dm:cai" }]);
    assertEquals(log.agents(), [
      { agentId: "ana", mind: "dm:ana2" }, // upserted, not duplicated
      { agentId: "cai", mind: "dm:cai" },
    ]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncAgents mirrors the declared settings and handles; a sync without them clears", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.syncAgents([{
      agentId: "ana",
      mind: "mind:ana",
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
      email: "ana@org.example",
      phone: "+5491155501234",
    }]);
    assertEquals(log.agents(), [{
      agentId: "ana",
      mind: "mind:ana",
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
      email: "ana@org.example",
      phone: "+5491155501234",
    }]);

    // config.jsonc shrank — the mirror follows the declaration, it never remembers
    log.syncAgents([{ agentId: "ana", mind: "mind:ana", email: "ana@org.example" }]);
    assertEquals(log.agents(), [{ agentId: "ana", mind: "mind:ana", email: "ana@org.example" }]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
