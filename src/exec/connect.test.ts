import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { answerOf, askOf, connectTool } from "./connect.ts";
import type { AgentRow } from "../store/agents.ts";
import type { ConnectionRow } from "../store/connections.ts";
import type { SignInAsk } from "../connect/signin.ts";

const AGENTS = [
  { agentId: "matias", mind: "mind@matias", email: "matias@example.com", phone: "+5492610000001" },
  { agentId: "ana", mind: "mind@ana", email: "ana@example.com", phone: "+5492610000002" },
  { agentId: "bo", mind: "mind@bo" },
] as AgentRow[];

const CONNECTIONS: ConnectionRow[] = [
  { service: "google", address: "matias@example.com", agentId: "matias" },
  { service: "google", address: "ana@example.com", agentId: "ana" },
  { service: "google", address: "team@example.com", credentialKey: "google:team@example.com" },
  { service: "whatsapp", address: "5492610000009", agentId: "matias" },
];

const log = {
  agents: () => Promise.resolve(AGENTS),
  connections: () => Promise.resolve(CONNECTIONS),
};
const ask = (input: Record<string, unknown>, agentId = "matias") => askOf(input, { agentId, log });

Deno.test("askOf: a new account is the caller's own, and checks nothing", async () => {
  assertEquals(await ask({ service: "google" }), { service: "google", agent: "matias" });
  assertEquals(await ask({ service: "google", for: "matias" }), {
    service: "google",
    agent: "matias",
  });
});

Deno.test("askOf: a grant for another lands only as the handle on their row", async () => {
  assertEquals(await ask({ service: "google", for: "ana" }), {
    service: "google",
    agent: "ana",
    email: "ana@example.com",
  });
  assertEquals(await ask({ service: "whatsapp", for: "ana" }), {
    service: "whatsapp",
    agent: "ana",
    phone: "+5492610000002",
    pair: "+5492610000002",
  });
  await assertRejects(() => ask({ service: "google", for: "bo" }), Error, "no email");
  await assertRejects(() => ask({ service: "github", for: "ana" }), Error, "GitHub takes no");
  await assertRejects(() => ask({ service: "google", for: "eve" }), Error, 'no agent "eve"');
});

Deno.test("askOf: a reconnect is a connection the caller may sign in, keeping its owner", async () => {
  assertEquals(await ask({ service: "google", account: "Matias@Example.com" }), {
    service: "google",
    agent: "matias",
    account: "matias@example.com",
  });
  // a shared account binds nobody
  assertEquals(await ask({ service: "google", account: "team@example.com" }), {
    service: "google",
    account: "team@example.com",
  });
  // another's, only for them
  await assertRejects(
    () => ask({ service: "google", account: "ana@example.com" }),
    Error,
    "is ana's",
  );
  assertEquals(await ask({ service: "google", account: "ana@example.com", for: "ana" }), {
    service: "google",
    agent: "ana",
    account: "ana@example.com",
  });
  // a WhatsApp number pairs again by code, minted for that number
  assertEquals(await ask({ service: "whatsapp", account: "5492610000009" }), {
    service: "whatsapp",
    agent: "matias",
    account: "5492610000009",
    pair: "5492610000009",
  });
  await assertRejects(
    () => ask({ service: "google", account: "nobody@example.com" }),
    Error,
    "no connection here",
  );
});

Deno.test("askOf: WhatsApp needs a phone; a service that signs in elsewhere is named", async () => {
  await assertRejects(() => ask({ service: "whatsapp" }, "bo"), Error, "no phone");
  await assertRejects(() => ask({ service: "telegram" }), Error, "`liquen connect telegram`");
  await assertRejects(() => ask({}), Error, "say `service`");
});

Deno.test("connect: the first word is the answer, async, and the call waits on the ticket", async () => {
  const asked: SignInAsk[] = [];
  const tool = connectTool({
    agentId: "matias",
    sessionId: "mind",
    log,
    clock: () => "15:42",
    signIns: {
      open: (a) => {
        asked.push(a);
        return Promise.resolve({
          link: "https://x.example/start?ticket=t",
          until: 0,
          loopback: true,
        });
      },
    },
  });
  const out = await tool.execute(
    { service: "google" },
    new AbortController().signal,
    undefined,
    { id: "use-1", turn_id: "turn-1" },
  ) as { output: string; async?: true };
  assertEquals(out.async, true);
  assertStringIncludes(out.output, "https://x.example/start?ticket=t");
  assertStringIncludes(out.output, "good until 15:42, and it opens only in a browser");
  assertEquals(asked[0].caller?.use, { id: "use-1", turn_id: "turn-1" });
  assertEquals(asked[0].caller?.agentId, "matias");
});

Deno.test("answerOf: a code says where it is typed", () => {
  assertEquals(
    answerOf({ code: "ABCD-EFGH", where: "On the phone: link a device.", until: 0 }, () => "9:05"),
    "The code is ABCD-EFGH. On the phone: link a device. It is good until 9:05. You are told " +
      "when it lands.",
  );
});
