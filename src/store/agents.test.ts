/**
 * agents: the registry (§9). Folders + config.json declare agents; `syncAgents` MIRRORS
 * the table to them — upsert present, delete absent — because the table is a projection
 * of what runs (the RLS substrate and the classifier's handle columns), never an archive.
 */

import { assertEquals } from "@std/assert";
import { openLog } from "./log.ts";

Deno.test("syncAgents mirrors: upserts the given rows and deletes the rest", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.syncAgents([{ agentId: "ana", home: "dm:ana" }, { agentId: "bo", home: "dm:bo" }]);
    assertEquals(log.agents(), [
      { agentId: "ana", home: "dm:ana" },
      { agentId: "bo", home: "dm:bo" },
    ]);

    // re-sync: ana's home moves, bo's folder is gone, cai appears
    log.syncAgents([{ agentId: "ana", home: "dm:ana2" }, { agentId: "cai", home: "dm:cai" }]);
    assertEquals(log.agents(), [
      { agentId: "ana", home: "dm:ana2" }, // upserted, not duplicated
      { agentId: "cai", home: "dm:cai" },
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
      home: "mind:ana",
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
      email: "ana@org.example",
      phone: "+5491155501234",
    }]);
    assertEquals(log.agents(), [{
      agentId: "ana",
      home: "mind:ana",
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
      email: "ana@org.example",
      phone: "+5491155501234",
    }]);

    // config.json shrank — the mirror follows the declaration, it never remembers
    log.syncAgents([{ agentId: "ana", home: "mind:ana", email: "ana@org.example" }]);
    assertEquals(log.agents(), [{ agentId: "ana", home: "mind:ana", email: "ana@org.example" }]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
