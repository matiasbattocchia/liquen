import { assertEquals } from "@std/assert";
import type { AliasRow, ConnectionRow } from "../store/connections.ts";
import type { Draft } from "../types.ts";
import { keptToSelf, SELF_SERVICES, selfRefused } from "./self.ts";

const ROWS: ConnectionRow[] = [
  { service: "telegram", address: "700", agentId: "matias", extra: { self_only: true } },
  { service: "telegram", address: "800", agentId: "ana" },
];
const SURFACES: AliasRow[] = [
  {
    service: "telegram",
    connection: "700",
    conversation: "700",
    agentId: "matias",
    principal: "matias",
    live: true,
  },
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
  return { took, publish: keptToSelf(publish, store) };
}

Deno.test("keptToSelf: a self-only account publishes its chat with itself, the grant note and patches alone", async () => {
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
    line("700", "901", "3"), // a principal's DM: a mind surface, and still not the self chat
    line("700", "connect", "4"),
    line("700", "-100123", "5"), // a group
    patch,
  ]);
  assertEquals(took.length, 1);
  assertEquals(took[0].map((d) => d.envelope.conversation.address), ["700", "connect", ""]);
});

Deno.test("keptToSelf: any other account publishes as it would; a single line left out is null, a batch left empty never reaches the log", async () => {
  const { took, publish } = recorder();
  await publish([line("800", "555", "1"), line("800", "-100123", "2")]);
  assertEquals(took[0].length, 2);
  assertEquals(await publish(line("700", "555", "3")), null);
  assertEquals(await publish([line("700", "555", "4")]), []);
  assertEquals(took.length, 1);
});

Deno.test("selfRefused: only an owned account on a service with a chat with itself is kept to it", () => {
  assertEquals(SELF_SERVICES, ["telegram", "whatsapp"]);
  assertEquals(selfRefused({ service: "telegram", agent: "matias" }), undefined);
  assertEquals(
    selfRefused({ service: "whatsapp" })?.message,
    "--self keeps an account to its owner's chat with itself, and a shared account has no owner",
  );
  assertEquals(
    selfRefused({ service: "google", agent: "matias" })?.message,
    "google keeps no account to its chat with itself: telegram and whatsapp do",
  );
});
