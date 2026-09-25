import { assertEquals } from "@std/assert";
import type { AgentRow } from "../agents.ts";
import type { ConnectionRow } from "../connections.ts";
import { speaksThrough } from "../roster.ts";
import type { Log } from "../log.ts";
import { type Substrate, withStore } from "./mod.ts";

export const roster: AgentRow[] = [
  { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "+54 9 11 555-0001" },
  { agentId: "sol", mind: "mind@sol", name: "Sol", phone: "549115550002", runs: false },
  { agentId: "ventas", mind: "mind@ventas", name: "Ventas", phone: "549117770000" },
  { agentId: "bot", mind: "mind@bot", principals: [] },
];
export const connections: ConnectionRow[] = [
  { service: "whatsapp", address: "549115550001", agentId: "matias" }, // a member's phone
  { service: "whatsapp", address: "549117770000", credentialKey: "whatsapp:549117770000" }, // the org's
  { service: "slack", address: "T1" }, // an org anchor nobody's handle claims
];

export function rosterSuite(s: Substrate): void {
  /** The views, over a store holding these rows. */
  async function withRoster(
    agents: AgentRow[],
    rows: ConnectionRow[],
    fn: (log: Log) => Promise<void> | void,
  ): Promise<void> {
    await withStore(s, async (log) => {
      await log.syncAgents(agents);
      await log.upsertConnections(rows);
      await fn(log);
    });
  }

  /** The derived DMs alone — the store's own bindings (self-chats) are `connections.test`'s. */
  const dms = async (log: Log) => (await log.aliases()).filter((a) => a.principal !== a.agentId);

  Deno.test("principalsOf: the list when declared, the roster for an org agent, oneself otherwise", async () => {
    await withRoster(roster, connections, async (log) => {
      assertEquals(await log.principalsOf("matias"), ["matias"]);
      assertEquals(await log.principalsOf("ventas"), ["bot", "matias", "sol", "ventas"]);
      assertEquals(await log.principalsOf("bot"), []);
      assertEquals(await log.principalsOf("nobody"), []);
    });
    const lent = roster.map((a) => a.agentId === "matias" ? { ...a, principals: ["sol"] } : a);
    await withRoster(lent, connections, async (log) => {
      assertEquals(await log.principalsOf("matias"), ["sol"]);
    });
  });

  Deno.test("aliases: each principal's DM with the agent's number, the self-chat left to the binding", async () => {
    await withRoster(roster, connections, async (log) => {
      assertEquals(await dms(log), [
        // ventas, the org number: one DM per principal with a phone — its own number excluded
        {
          service: "whatsapp",
          connection: "549117770000",
          conversation: "549115550001",
          agentId: "ventas",
          principal: "matias",
          live: true,
        },
        {
          service: "whatsapp",
          connection: "549117770000",
          conversation: "549115550002",
          agentId: "ventas",
          principal: "sol",
          live: true,
        },
      ]);
    });
    // a member lending their own number to a co-driver: the co-driver's DM is a surface too
    const lent = roster.map((a) =>
      a.agentId === "matias" ? { ...a, principals: ["matias", "sol"] } : a
    );
    await withRoster(lent, connections, async (log) => {
      assertEquals(
        (await dms(log)).filter((r) => r.agentId === "matias").map((r) => r.conversation),
        ["549115550002"],
      );
    });
  });

  Deno.test("slack: the bot row names its agent, and the recorded DMs of principals are its surfaces", async () => {
    const agents: AgentRow[] = [
      { agentId: "matias", mind: "mind@matias", email: "matias@acme.co" },
      { agentId: "sol", mind: "mind@sol", email: "sol@acme.co", runs: false },
      { agentId: "ventas", mind: "mind@ventas" },
    ];
    const connections: ConnectionRow[] = [
      { service: "slack", address: "T1" },
      {
        service: "slack",
        address: "T1:UBOT",
        credentialKey: "slack:T1:org",
        // the bot door's mark, and the ingest's record of who has DMed the bot
        extra: { agent: "ventas", dms: { sol: "D77", matias: "D78", stranger: "D79" } },
      },
    ];
    assertEquals(speaksThrough(agents[2], connections).map((c) => c.address), ["T1:UBOT"]);
    await withRoster(agents, connections, async (log) => {
      assertEquals(await log.principalsOf("ventas"), ["matias", "sol", "ventas"]);
      assertEquals((await dms(log)).sort((a, b) => a.conversation.localeCompare(b.conversation)), [
        {
          service: "slack",
          connection: "T1:UBOT",
          conversation: "D77",
          agentId: "ventas",
          principal: "sol",
          live: true,
        },
        {
          service: "slack",
          connection: "T1:UBOT",
          conversation: "D78",
          agentId: "ventas",
          principal: "matias",
          live: true,
        },
      ]);
    });
  });

  Deno.test("a revoked account speaks for nobody: its DMs are surfaces no longer", async () => {
    await withRoster(roster, connections, async (log) => {
      await log.deleteConnections([{ service: "whatsapp", address: "549117770000" }]);
      assertEquals(await dms(log), []);
      assertEquals(await log.principalsOf("ventas"), ["ventas"]); // no org account ⇒ itself
    });
  });
}
