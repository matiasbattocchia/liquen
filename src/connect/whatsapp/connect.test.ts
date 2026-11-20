import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { WABridgeSessions, WAPairingState } from "./connect.ts";
import { createWhatsappSignIn, PAIRING_WHERE } from "./signin.ts";
import type { Appender, ReadQuery } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import type { TicketRow } from "../../store/credentials.ts";
import { newId } from "../../store/id.ts";
import { ingestUrlOf, type WhatsappConfig } from "./config.ts";
import { fakeGate, ticket } from "../testing.ts";
import type { FlowCtx } from "../signin.ts";
import type { Json } from "../../types.ts";
import { basename } from "node:path";
import { materialize, starterConfig } from "../../config.ts";
import { serveIngest } from "../serve.ts";
import { openStore } from "../../store/mod.ts";
import { declareConnection } from "../../roster.ts";
import { readConfig } from "../../org.ts";

/** A scripted bridge: `create` answers the first state, each `pending` poll the next. */
function fakeBridge(first: WAPairingState, ...polls: WAPairingState[]) {
  const creates: Parameters<WABridgeSessions["create"]>[0][] = [];
  const asked: string[] = [];
  const bridge: WABridgeSessions = {
    create: (req) => {
      creates.push(req);
      return Promise.resolve(first);
    },
    pending: (id) => {
      asked.push(id);
      return Promise.resolve(polls.length > 1 ? polls.shift()! : polls[0]);
    },
  };
  return { bridge, creates, asked };
}

const CONFIG = {
  bridgeUrl: "http://bridge",
  ingestUrl: null,
  organizationId: "acme",
  historyDays: 60,
} as unknown as WhatsappConfig;

/** One pairing run against a scripted bridge: the flow as main runs it, its gate a fake.
 *  `heard` is the newest line the log holds of the number, `phone` the one on matias's row. */
function pairing(
  bridge: WABridgeSessions,
  t: TicketRow,
  opts: { refuse?: string; heard?: string; phone?: string } = {},
) {
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const published: Event[] = [];
  const read: ReadQuery[] = [];
  const ctx = {
    root: "/nowhere/acme",
    edge: { publicUrl: null, port: 8787 },
    log: {
      agents: () =>
        Promise.resolve([{
          agentId: "matias",
          mind: "mind@matias",
          ...(opts.phone ? { phone: opts.phone } : {}),
        }]),
      connections: () => Promise.resolve([]),
      aliases: () => Promise.resolve([]),
      read: (q: ReadQuery) => {
        read.push(q);
        return Promise.resolve(opts.heard ? [{ ts: opts.heard } as Event] : []);
      },
      upsertConnections: (rows: ConnectionRow[]) => {
        connections.push(...rows);
        return Promise.resolve();
      },
      upsertMemberships: (rows: MembershipRow[]) => {
        memberships.push(...rows);
        return Promise.resolve();
      },
      publish: ((e: Draft) => {
        const stored = { ...e, id: e.id ?? newId() } as Event;
        published.push(stored);
        return Promise.resolve(stored);
      }) as Appender["publish"],
    },
  } as unknown as FlowCtx;
  const gate = fakeGate([t], opts);
  const flow = createWhatsappSignIn({
    bridge: () => bridge,
    config: () => Promise.resolve(CONFIG),
    pollMs: 1,
  });
  const run = () => flow.run!(t, ctx, gate, new AbortController().signal);
  return { run, gate, connections, memberships, published, read };
}

const pending = (over: Partial<WAPairingState> = {}): WAPairingState => ({
  session_id: "p1",
  status: "pending",
  qr_code: "2@qr-one",
  ...over,
});

const MATIAS = ticket("t1", { service: "whatsapp", agentId: "matias", extra: {} });

Deno.test("QR flow: poll to paired writes the owned anchor, membership, and note", async () => {
  const { bridge, creates } = fakeBridge(
    pending(),
    pending({ qr_code: "2@qr-two" }), // a rotation
    { session_id: "p1", status: "paired", address: "5491100000000" },
  );
  const { run, gate, connections, memberships, published } = pairing(bridge, MATIAS);
  await run();

  assertEquals(creates[0].agent_id, "matias"); // the pairing binds the ticket's agent
  assertEquals(creates[0].phone_number, undefined);
  assertEquals(creates[0].webhook_url, "http://localhost:8787/whatsapp/ingest"); // THIS org's door
  assertEquals(creates[0].organization_id, "acme");
  // the pending session is noted, so a restart takes the poll up
  assertEquals(gate.seen.noted.t1, { pending: "p1" });
  // every code the person needs, once each: the first QR and the rotation
  assertEquals(gate.seen.said.map((s) => "qr" in s.word ? s.word.qr : ""), [
    "2@qr-one",
    "2@qr-two",
  ]);
  assertEquals(gate.seen.judged, [{
    ticket: "t1",
    who: { address: "5491100000000", phone: "5491100000000" },
  }]);
  assertEquals(gate.seen.landed, [{ ticket: "t1", account: "5491100000000" }]);

  assertEquals(connections.length, 1);
  assertEquals(connections[0].service, "whatsapp");
  assertEquals(connections[0].address, "5491100000000");
  assertEquals(connections[0].agentId, "matias"); // owned ⇒ the classifier's grant row
  assertEquals(connections[0].extra?.state, "connected");
  assertEquals(memberships[0], {
    service: "whatsapp",
    connection: "5491100000000",
    conversation: "connect",
    agentId: "matias",
  });
  const note = published[0] as MessageEvent;
  assertEquals(note.envelope.connection_address, "5491100000000");
  assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "matias");
});

const PAIRED: WAPairingState = { session_id: "p1", status: "paired", address: "5491100000000" };

Deno.test("history: a pairing asks the phone from where the listening stopped on its number, within historyDays", async () => {
  // the number is the one on the agent's row; the log last heard it yesterday
  const heard = new Date(Date.now() - 86_400_000).toISOString();
  const known = fakeBridge(pending(), PAIRED);
  const one = pairing(known.bridge, MATIAS, { heard, phone: "+54 9 11 0000-0000" });
  await one.run();
  assertEquals(known.creates[0].history_since, heard);
  assertEquals(known.creates[0].no_history, undefined);
  assertEquals([one.read[0].service, one.read[0].connection], ["whatsapp", "5491100000000"]);

  // a QR pairing whose number nobody knows is asked the whole window
  const unknown = fakeBridge(pending(), PAIRED);
  const before = Date.now();
  await pairing(unknown.bridge, MATIAS, { heard }).run();
  const since = Date.parse(unknown.creates[0].history_since!);
  const window = 60 * 86_400_000;
  assertEquals(since >= before - window && since <= Date.now() - window, true);
});

Deno.test("history: --self asks the phone for none, and lands the mark", async () => {
  const self = ticket("t2", { service: "whatsapp", agentId: "matias", extra: { self: true } });
  const { bridge, creates } = fakeBridge(pending(), PAIRED);
  const { run, connections, read } = pairing(bridge, self, { phone: "5491100000000" });
  await run();
  assertEquals(creates[0].no_history, true);
  assertEquals(creates[0].history_since, undefined);
  assertEquals(read, []); // nothing to read where the listening stopped
  assertEquals(connections[0].extra?.self_only, true);
});

Deno.test("phone flow: the number rides create; the pairing code is the word", async () => {
  const { bridge, creates } = fakeBridge(
    pending({ qr_code: undefined, pairing_code: "ABCD-EFGH" }),
    { session_id: "p1", status: "paired", address: "5491100000000" },
  );
  const t = ticket("t1", {
    service: "whatsapp",
    agentId: "matias",
    extra: { pair: "+54 9 11 0000-0000" },
  });
  const { run, gate } = pairing(bridge, t);
  await run();
  assertEquals(creates[0].phone_number, "5491100000000");
  assertEquals(gate.seen.said[0].word, {
    code: "ABCD-EFGH",
    where: PAIRING_WHERE,
    until: t.deadline,
  });
});

Deno.test("a restart takes the poll up from the noted session, minting nothing", async () => {
  const { bridge, creates, asked } = fakeBridge(
    pending(),
    { session_id: "p7", status: "paired", address: "5491100000000" },
  );
  const t = ticket("t1", { service: "whatsapp", agentId: "matias", extra: { pending: "p7" } });
  const { run, gate } = pairing(bridge, t);
  await run();
  assertEquals(creates, []);
  assertEquals(asked[0], "p7");
  assertEquals(gate.seen.landed.length, 1);
});

Deno.test("a failed pairing throws and writes NOTHING", async () => {
  const { bridge } = fakeBridge(
    pending(),
    { session_id: "p1", status: "error", error: "pairing timed out" },
  );
  const { run, connections, memberships, published } = pairing(bridge, MATIAS);
  await assertRejects(run, Error, "pairing timed out");
  assertEquals(connections.length, 0);
  assertEquals(memberships.length, 0);
  assertEquals(published.length, 0);
});

Deno.test("a number the ticket refuses writes NOTHING", async () => {
  const { bridge } = fakeBridge(
    pending(),
    { session_id: "p1", status: "paired", address: "5491100000000" },
  );
  const { run, gate, connections, published } = pairing(bridge, MATIAS, {
    refuse: "paired 5491100000000, which is not matias's number",
  });
  await run();
  assertEquals(connections, []);
  assertEquals(published, []);
  assertEquals(gate.seen.landed, []);
});

Deno.test("a shared number binds nobody — an ownerless, credentialed row and no membership (§4)", async () => {
  const { bridge, creates } = fakeBridge(
    pending(),
    { session_id: "p1", status: "paired", address: "5491177700000" },
  );
  const { run, connections, memberships, published } = pairing(
    bridge,
    ticket("t1", { service: "whatsapp", extra: {} }),
  );
  await run();

  assertEquals(creates[0].agent_id, undefined);
  assertEquals(connections, [{
    service: "whatsapp",
    address: "5491177700000",
    credentialKey: "whatsapp:5491177700000",
    extra: connections[0].extra,
  }]);
  assertEquals(memberships, []);
  const note = published[0] as MessageEvent;
  assertStringIncludes(note.parts[0].type === "text" ? note.parts[0].text : "", "the org");
});

Deno.test("an org's first pairing declares WhatsApp, its tenant named after the folder; a later one declares nothing", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, materialize(starterConfig()));
  const ingest = await serveIngest(root, "whatsapp", () => new Response("ok"));
  const declared: [string, Record<string, Json> | undefined][] = [];
  // main's hook: the declaration in the store, as main writes it
  const ctx = {
    root,
    declare: async (service: string, knobs?: Record<string, Json>) => {
      declared.push([service, knobs]);
      const log = await (await openStore(root)).log();
      try {
        await declareConnection(log, service, knobs);
      } finally {
        await log.close();
      }
    },
  } as unknown as FlowCtx;
  const flow = createWhatsappSignIn({ bridge: () => fakeBridge(pending()).bridge });
  try {
    const tenant = basename(root);
    assertEquals(await flow.prepare({ service: "whatsapp" }, ctx), { organizationId: tenant });
    assertEquals(declared, [["whatsapp", { organizationId: tenant }]]);
    assertEquals((await readConfig(root)).connections.whatsapp?.organizationId, tenant);
    assertEquals(await flow.prepare({ service: "whatsapp" }, ctx), { organizationId: tenant });
    assertEquals(declared.length, 1);
  } finally {
    await ingest.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ingestUrlOf: the declared address, else this machine's edge", () => {
  assertEquals(ingestUrlOf({ ingestUrl: null }, 8787), "http://localhost:8787/whatsapp/ingest");
  assertEquals(
    ingestUrlOf({ ingestUrl: "http://host.docker.internal:8787/whatsapp/ingest" }, 8787),
    "http://host.docker.internal:8787/whatsapp/ingest",
  );
});
