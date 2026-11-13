/**
 * agents: the roster and the configuration, as rows (§9). The tables are primary: a put
 * upserts and never deletes, a drop is total, and a setting is a leaf of `config`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Substrate } from "./mod.ts";
import { withStore } from "./mod.ts";

export function agentsSuite(s: Substrate): void {
  Deno.test("putAgents upserts the given rows and leaves the rest", async () => {
    await withStore(s, async (log) => {
      await log.putAgents([{ agentId: "ana", mind: "mind@ana" }, {
        agentId: "bo",
        mind: "mind@bo",
        email: "bo@org.example",
        phone: "+5491155501234",
      }]);
      await log.putAgents([{ agentId: "ana", mind: "mind@ana", name: "Ana" }, {
        agentId: "cai",
        mind: "mind@cai",
      }]);
      assertEquals(await log.agents(), [
        { agentId: "ana", mind: "mind@ana", name: "Ana" }, // upserted, not duplicated
        { agentId: "bo", mind: "mind@bo", email: "bo@org.example", phone: "+5491155501234" },
        { agentId: "cai", mind: "mind@cai" },
      ]);
    });
  });

  Deno.test("the backlog floor is written once: a put without one keeps the row's", async () => {
    await withStore(s, async (log) => {
      const since = "2026-09-25T00:00:00.000Z";
      await log.putAgents([{ agentId: "ana", mind: "mind@ana", since }]);
      await log.putAgents([{ agentId: "ana", mind: "mind@ana", name: "Ana" }]);
      assertEquals(await log.agents(), [{ agentId: "ana", mind: "mind@ana", name: "Ana", since }]);
    });
  });

  Deno.test("principals: a list, nobody, anyone, or left to ownership", async () => {
    await withStore(s, async (log) => {
      await log.putAgents([
        { agentId: "ana", mind: "mind@ana" },
        { agentId: "bot", mind: "mind@bot", principals: [] },
        { agentId: "sonar", mind: "mind@sonar", principals: "*" },
        { agentId: "ventas", mind: "mind@ventas", principals: ["ana"] },
      ]);
      const by = Object.fromEntries((await log.agents()).map((a) => [a.agentId, a.principals]));
      assertEquals(by, { ana: undefined, bot: [], sonar: "*", ventas: ["ana"] });
      // `"*"` names nobody: the view gives it no rows
      assertEquals(await log.principalsOf("sonar"), []);
      assertEquals(await log.principalsOf("ventas"), ["ana"]);
    });
  });

  Deno.test("config: a row is a key set, null is a value, and unset deletes the row", async () => {
    await withStore(s, async (log) => {
      await log.setConfig([
        { scope: "shared.agents", key: "model", value: "claude-x" },
        { scope: "shared.agents", key: "sleepHours", value: null },
        { scope: "agents.ana", key: "rules", value: [{ tool: "send", action: "ask" }] },
        { scope: "connections.slack", key: "", value: {} },
      ]);
      assertEquals(await log.config("shared.agents"), [
        { scope: "shared.agents", key: "model", value: "claude-x" },
        { scope: "shared.agents", key: "sleepHours", value: null },
      ]);
      await log.setConfig([{ scope: "shared.agents", key: "model", value: "claude-y" }]);
      await log.unsetConfig("shared.agents", ["sleepHours"]);
      await log.unsetConfig("connections.slack");
      assertEquals(await log.config(), [
        { scope: "agents.ana", key: "rules", value: [{ tool: "send", action: "ask" }] },
        { scope: "shared.agents", key: "model", value: "claude-y" },
      ]);
    });
  });

  Deno.test("runs: the agent's own mind, else the org's, else it runs", async () => {
    await withStore(s, async (log) => {
      await log.putAgents([
        { agentId: "ana", mind: "mind@ana" },
        { agentId: "bo", mind: "mind@bo", settings: { mind: false } },
        { agentId: "cai", mind: "mind@cai", settings: { mind: true } },
      ]);
      const runs = async () =>
        Object.fromEntries((await log.agents()).map((a) => [a.agentId, a.runs !== false]));
      assertEquals(await runs(), { ana: true, bo: false, cai: true });
      await log.setConfig([{ scope: "shared.agents", key: "mind", value: false }]);
      assertEquals(await runs(), { ana: false, bo: false, cai: true });
    });
  });

  Deno.test("dropAgent is total: what references the agent goes, its history stays", async () => {
    await withStore(s, async (log) => {
      await log.putAgents([
        { agentId: "ana", mind: "mind@ana", settings: { model: "claude-x" } },
        { agentId: "bo", mind: "mind@bo" },
      ]);
      await log.upsertConnections([
        { service: "slack", address: "T1:U1", agentId: "ana" },
        { service: "slack", address: "T1", extra: { mirrors: { rooms: { ana: "C1" } } } },
      ]);
      await log.upsertMemberships([
        { service: "slack", connection: "T1", conversation: "C9", agentId: "ana" },
        { service: "slack", connection: "T1", conversation: "C9", agentId: "bo" },
      ]);
      await log.remember({ agentId: "ana", tool: "send", action: "allow" });
      await log.meter({
        created_at: "2026-11-01T00:00:00.000Z",
        agent_id: "ana",
        model: "claude-x",
        input_tokens: 1,
        output_tokens: 1,
      });
      assertEquals((await log.aliases()).map((a) => a.agentId), ["ana"]);

      await log.dropAgent("ana");
      assertEquals((await log.agents()).map((a) => a.agentId), ["bo"]);
      assertEquals(await log.config("agents.ana"), []);
      assertEquals(await log.connection("slack", "T1:U1"), null);
      assertEquals(await log.remembered("ana"), []);
      // a room routed to it drops out of the aliases by the join; a peer's membership is its own
      assertEquals(await log.aliases(), []);
      assertEquals(await log.isMember("slack", "T1", "C9", "bo", "mind"), true);
      assertEquals(await log.isMember("slack", "T1", "C9", "ana", "mind"), false);
      // spend is history
      assertEquals((await log.spend({ agentId: "ana" })).length, 1);
      assertEquals(await log.lastTurns(), { ana: "2026-11-01T00:00:00.000Z" });
    });
  });

  Deno.test("dropAgent refuses while another agent's principals name it, naming who", async () => {
    await withStore(s, async (log) => {
      await log.putAgents([
        { agentId: "ana", mind: "mind@ana", principals: ["ana"] }, // names itself: waits on no one
        { agentId: "ventas", mind: "mind@ventas", principals: ["ana"] },
        { agentId: "sonar", mind: "mind@sonar", principals: "*" },
      ]);
      await assertRejects(
        async () => await log.dropAgent("ana"),
        Error,
        "ana is a principal of ventas",
      );
      assertEquals((await log.agents()).length, 3);
      await log.dropAgent("ventas");
      await log.dropAgent("ana");
      assertEquals((await log.agents()).map((a) => a.agentId), ["sonar"]);
    });
  });

  Deno.test("a row that names an agent needs the agent: the store refuses an orphan", async () => {
    await withStore(s, async (log) => {
      await assertRejects(async () => {
        await log.upsertConnections([{ service: "slack", address: "T1:U1", agentId: "ghost" }]);
      });
    });
  });

  Deno.test("the manifest keeps what the org took from releases, by key", async () => {
    await withStore(s, async (log) => {
      await log.setManifest({ release: "0.1.76", "doc:system/tools/bash": "abc" });
      await log.setManifest({ release: "0.1.77", "doc:system/tools/bash": null });
      const { schema, ...rest } = await log.manifest();
      assertEquals(rest, { release: "0.1.77" });
      assertEquals(Number(schema) > 0, true);
    });
  });
}
