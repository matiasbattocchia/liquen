import { assertEquals, assertRejects } from "@std/assert";
import { connectTelegram, connectTelegramApp, type TelegramConnectDeps } from "./connect.ts";
import { SELF } from "./testing.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";
import type { CredentialRow } from "../../store/credentials.ts";
import type { Draft, Event } from "../../types.ts";
import { newId } from "../../store/id.ts";

const NOW = "2026-11-13T16:00:00.000Z";

function harness(over: Partial<TelegramConnectDeps> = {}) {
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const vault: CredentialRow[] = [];
  const published: Event[] = [];
  const deps: TelegramConnectDeps = {
    signIn: () => Promise.resolve({ session: "1AQAAA-session", self: SELF }),
    principal: "ana",
    creds: {
      put: (row) => {
        vault.push(row);
        return Promise.resolve();
      },
    },
    store: {
      upsertConnections: (rows) => {
        connections.push(...rows);
        return Promise.resolve();
      },
      upsertMemberships: (rows) => {
        memberships.push(...rows);
        return Promise.resolve();
      },
    },
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as TelegramConnectDeps["publish"],
    now: () => NOW,
    ...over,
  };
  return { deps, connections, memberships, vault, published };
}

Deno.test("telegram connect: a member's sign-in writes the vault, one owned row with its self chat, and the note", async () => {
  const h = harness();
  const { account } = await connectTelegram(h.deps);
  assertEquals(account, SELF);
  assertEquals(h.vault, [{
    key: "telegram:700100",
    value: { session: "1AQAAA-session" },
    agentId: "ana",
  }]);
  assertEquals(h.connections, [{
    service: "telegram",
    address: "700100",
    credentialKey: "telegram:700100",
    agentId: "ana",
    extra: {
      state: "connected",
      connected_at: NOW,
      error: null,
      name: "Ana Paz",
      username: "anapaz",
      mirrors: { self: "700100" },
      steering: null,
    },
  }]);
  assertEquals(h.memberships, [
    { service: "telegram", connection: "700100", conversation: "connect", agentId: "ana" },
  ]);
  assertEquals(h.published.length, 1);
  // the note is what a running connection takes the account up by
  assertEquals(h.published[0].envelope.conversation.address, "connect");
  assertEquals(h.published[0].envelope.sender?.address, "telegram-connect");
});

Deno.test("telegram connect: --steering keeps the account to its owner's mind, and says so", async () => {
  const h = harness({ steering: true });
  await connectTelegram(h.deps);
  assertEquals(h.connections[0].extra?.steering, true);
  assertEquals(h.connections[0].extra?.mirrors, { self: "700100" });
  const note = h.published[0].parts[0];
  assertEquals(
    note.type === "text" && note.text,
    "Telegram connected: @anapaz (700100) → ana, for steering",
  );
});

Deno.test("telegram connect: a shared account is kept to steering by nobody, before any sign-in", async () => {
  let signedIn = false;
  const h = harness({
    principal: undefined,
    steering: true,
    signIn: () => {
      signedIn = true;
      return Promise.resolve({ session: "s", self: SELF });
    },
  });
  await assertRejects(() => connectTelegram(h.deps), Error, "a shared account has no owner");
  assertEquals([signedIn, h.vault, h.connections, h.published], [false, [], [], []]);
});

Deno.test("telegram connect: a shared account is owned by nobody and mirrors no mind", async () => {
  const h = harness({ principal: undefined });
  await connectTelegram(h.deps);
  assertEquals(h.vault[0].agentId, undefined);
  assertEquals(h.connections[0].agentId, undefined);
  assertEquals(h.connections[0].extra?.mirrors, undefined);
  assertEquals(h.memberships, []);
});

Deno.test("telegram connect: a sign-in that fails writes nothing", async () => {
  const h = harness({ signIn: () => Promise.reject(new Error("PHONE_CODE_INVALID")) });
  await assertRejects(() => connectTelegram(h.deps), Error, "PHONE_CODE_INVALID");
  assertEquals([h.vault, h.connections, h.published], [[], [], []]);
});

Deno.test("telegram connect: the application is its id and hash, both or nothing", async () => {
  const vault: CredentialRow[] = [];
  const creds = {
    put: (row: CredentialRow) => {
      vault.push(row);
      return Promise.resolve();
    },
  };
  await connectTelegramApp({ apiId: "12345", apiHash: "0123abcd" }, creds);
  assertEquals(vault, [{ key: "telegram:app", value: { api_id: "12345", api_hash: "0123abcd" } }]);
  await assertRejects(() => connectTelegramApp({ apiId: "abc", apiHash: "x" }, creds));
  await assertRejects(() => connectTelegramApp({ apiId: "12345", apiHash: "" }, creds));
  assertEquals(vault.length, 1);
});
