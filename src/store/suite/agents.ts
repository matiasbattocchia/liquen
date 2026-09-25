/**
 * agents: the registry (§9). Folders + config.jsonc declare agents; `syncAgents` MIRRORS
 * the table to them — upsert present, delete absent — because the table is a projection
 * of what runs (the RLS substrate and the classifier's handle columns), never an archive.
 */

import { assertEquals } from "@std/assert";
import type { Substrate } from "./mod.ts";

export function agentsSuite(s: Substrate): void {
  Deno.test("syncAgents mirrors: upserts the given rows and deletes the rest", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.syncAgents([{ agentId: "ana", mind: "mind@ana" }, {
        agentId: "bo",
        mind: "mind@bo",
      }]);
      assertEquals(await log.agents(), [
        { agentId: "ana", mind: "mind@ana" },
        { agentId: "bo", mind: "mind@bo" },
      ]);

      // re-sync: ana's mind session moves, bo's folder is gone, cai appears
      await log.syncAgents([{ agentId: "ana", mind: "mind@ana2" }, {
        agentId: "cai",
        mind: "mind@cai",
      }]);
      assertEquals(await log.agents(), [
        { agentId: "ana", mind: "mind@ana2" }, // upserted, not duplicated
        { agentId: "cai", mind: "mind@cai" },
      ]);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("syncAgents mirrors the declared settings and handles; a sync without them clears", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      await log.syncAgents([{
        agentId: "ana",
        mind: "mind@ana",
        provider: "anthropic",
        model: "claude-opus-4-8",
        effort: "high",
        email: "ana@org.example",
        phone: "+5491155501234",
      }]);
      assertEquals(await log.agents(), [{
        agentId: "ana",
        mind: "mind@ana",
        provider: "anthropic",
        model: "claude-opus-4-8",
        effort: "high",
        email: "ana@org.example",
        phone: "+5491155501234",
      }]);

      // config.jsonc shrank — the mirror follows the declaration, it never remembers
      await log.syncAgents([{ agentId: "ana", mind: "mind@ana", email: "ana@org.example" }]);
      assertEquals(await log.agents(), [{
        agentId: "ana",
        mind: "mind@ana",
        email: "ana@org.example",
      }]);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("a row carries the settings its sessions run with, nulls kept: an agent IS its row (§9)", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const settings = {
        maxTokens: 4096,
        timezone: "America/Argentina/Buenos_Aires",
        tools: ["send", "bash"],
        rules: [{ tool: "send", action: "ask" as const }],
        since: "2026-09-25T00:00:00.000Z",
        gateHours: null, // an ask stands until answered — a value, not an absence
        sleepHours: null, // never sleeps
        processors: ["audio"],
      };
      await log.syncAgents([{ agentId: "ana", mind: "mind@ana", model: "claude-x", settings }]);
      assertEquals((await log.agents())[0].settings, settings);
      await log.syncAgents([{ agentId: "ana", mind: "mind@ana", model: "claude-x" }]);
      assertEquals((await log.agents())[0].settings, undefined); // the mirror never remembers
    } finally {
      await log.close();
      await store.drop();
    }
  });
}
