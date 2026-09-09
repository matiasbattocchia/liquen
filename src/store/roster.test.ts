import { assertEquals } from "@std/assert";
import type { AgentRow } from "./agents.ts";
import type { ConnectionRow } from "./connections.ts";
import { dmAliases, orgOwned, principalsOf, sameHandle, speaksThrough } from "./roster.ts";

const roster: AgentRow[] = [
  { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "+54 9 11 555-0001" },
  { agentId: "sol", mind: "mind@sol", name: "Sol", phone: "549115550002", runs: false },
  { agentId: "ventas", mind: "mind@ventas", name: "Ventas", phone: "549117770000" },
  { agentId: "bot", mind: "mind@bot", principals: [] },
];
const connections: ConnectionRow[] = [
  { service: "whatsapp", address: "549115550001", agentId: "matias" }, // a member's phone
  { service: "whatsapp", address: "549117770000", credentialKey: "whatsapp:549117770000" }, // the org's
  { service: "slack", address: "T1" }, // an org anchor nobody's handle claims
];

Deno.test("sameHandle: phones agree on digits, emails on the folded string, nothing else", () => {
  assertEquals(sameHandle("+54 9 11 555-0001", "549115550001"), true);
  assertEquals(sameHandle("549115550001", "549115550002"), false);
  assertEquals(sameHandle("Ana@Acme.co", "ana@acme.co"), true);
  assertEquals(sameHandle("ana@acme.co", "549115550001"), false);
  assertEquals(sameHandle(undefined, "549115550001"), false);
  assertEquals(sameHandle("+", "-"), false); // no digits is no phone
});

Deno.test("speaksThrough / orgOwned: a handle claims the org account, ownership names the member's", () => {
  assertEquals(speaksThrough(roster[0], connections).map((c) => c.address), ["549115550001"]);
  assertEquals(speaksThrough(roster[2], connections).map((c) => c.address), ["549117770000"]);
  assertEquals(orgOwned(roster[0], connections), false);
  assertEquals(orgOwned(roster[2], connections), true);
  assertEquals(orgOwned(roster[3], connections), false); // the Slack anchor claims nobody
});

Deno.test("principalsOf: the list when declared, the roster for an org agent, oneself otherwise", () => {
  assertEquals(principalsOf("matias", roster, connections), ["matias"]);
  assertEquals(principalsOf("ventas", roster, connections), ["matias", "sol", "ventas", "bot"]);
  assertEquals(principalsOf("bot", roster, connections), []);
  assertEquals(principalsOf("nobody", roster, connections), []);
  const lent = roster.map((a) => a.agentId === "matias" ? { ...a, principals: ["sol"] } : a);
  assertEquals(principalsOf("matias", lent, connections), ["sol"]);
});

Deno.test("dmAliases: each principal's DM with the agent's number, the self-chat left to the store", () => {
  const rows = dmAliases(roster, connections);
  assertEquals(rows, [
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
  // a member lending their own number to a co-driver: the co-driver's DM is a surface too
  const lent = roster.map((a) =>
    a.agentId === "matias" ? { ...a, principals: ["matias", "sol"] } : a
  );
  assertEquals(
    dmAliases(lent, connections).filter((r) => r.agentId === "matias").map((r) => r.conversation),
    ["549115550002"],
  );
});

Deno.test("slack: the bot row names its agent, and the recorded DMs of principals are its surfaces", () => {
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
  assertEquals(principalsOf("ventas", agents, connections), ["matias", "sol", "ventas"]);
  assertEquals(dmAliases(agents, connections), [
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
