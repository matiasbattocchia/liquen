import { assertEquals } from "@std/assert";
import type { AliasRow, ConnectionRow } from "../store/connections.ts";
import type { Draft } from "../types.ts";
import { STEERED, steered, steeringRefused } from "./steering.ts";

const ROWS: ConnectionRow[] = [
  { service: "telegram", address: "700", agentId: "matias", extra: { steering: true } },
  { service: "telegram", address: "800", agentId: "ana" },
];
const SURFACES: AliasRow[] = [
  { service: "telegram", connection: "700", conversation: "700", agentId: "matias", live: true },
  {
    service: "telegram",
    connection: "700",
    conversation: "901",
    agentId: "matias",
    principal: "lu",
    live: true,
  },
];

const store = {
  connection: (service: string, address: string) =>
    Promise.resolve(ROWS.find((r) => r.service === service && r.address === address) ?? null),
  aliases: () => Promise.resolve(SURFACES),
};

const line = (account: string, chat: string, id: string): Draft => ({
  ts: "2026-11-20T12:00:00.000Z",
  type: "message",
  envelope: {
    service: "telegram",
    connection_address: account,
    conversation: { address: chat },
    external_id: `telegram:${account}.${id}`,
  },
  parts: [{ type: "text", kind: "text", text: id }],
});

function recorder() {
  const took: Draft[][] = [];
  const publish = (one: Draft | Draft[]) => {
    const drafts = Array.isArray(one) ? one : [one];
    took.push(drafts);
    return Promise.resolve(Array.isArray(one) ? drafts : drafts[0]);
  };
  return { took, publish: steered(publish, store) };
}

Deno.test("steered: an account kept to steering publishes its mind surfaces, the grant note and patches alone", async () => {
  const { took, publish } = recorder();
  const patch = {
    ts: "2026-11-20T12:00:00.000Z",
    type: "message",
    envelope: {
      service: "telegram",
      connection_address: "700",
      conversation: { address: "" },
      external_id: "telegram:700.3",
    },
    status: { state: "read" },
  } as unknown as Draft;
  await publish([
    line("700", "700", "1"), // Saved Messages
    line("700", "555", "2"), // a stranger
    line("700", "901", "3"), // a principal's DM
    line("700", "connect", "4"),
    line("700", "-100123", "5"), // a group
    patch,
  ]);
  assertEquals(took.length, 1);
  assertEquals(took[0].map((d) => d.envelope.conversation.address), ["700", "901", "connect", ""]);
});

Deno.test("steered: any other account publishes as it would; a single line left out is null, a batch left empty never reaches the log", async () => {
  const { took, publish } = recorder();
  await publish([line("800", "555", "1"), line("800", "-100123", "2")]);
  assertEquals(took[0].length, 2);
  assertEquals(await publish(line("700", "555", "3")), null);
  assertEquals(await publish([line("700", "555", "4")]), []);
  assertEquals(took.length, 1);
});

Deno.test("steering: only an owned account on a service with a chat with itself is kept to steering", () => {
  assertEquals(STEERED, ["telegram", "whatsapp"]);
  assertEquals(steeringRefused({ service: "telegram", agent: "matias" }), undefined);
  assertEquals(
    steeringRefused({ service: "whatsapp" })?.message,
    "--steering keeps an account to its owner's mind, and a shared account has no owner",
  );
  assertEquals(
    steeringRefused({ service: "google", agent: "matias" })?.message,
    "google keeps no account to steering: telegram and whatsapp do",
  );
});
