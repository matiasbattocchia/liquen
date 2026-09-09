import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  connectWhatsApp,
  type WABridgeSessions,
  type WAPairingState,
  type WhatsAppConnectDeps,
} from "./connect.ts";
import type { Appender } from "../../store/log.ts";
import type { ConnectionRow, MembershipRow } from "../../store/connections.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import { newId } from "../../store/id.ts";

/** A scripted bridge: `create` answers the first state, each `pending` poll the next. */
function fakeBridge(first: WAPairingState, ...polls: WAPairingState[]) {
  const creates: Parameters<WABridgeSessions["create"]>[0][] = [];
  const bridge: WABridgeSessions = {
    create: (req) => {
      creates.push(req);
      return Promise.resolve(first);
    },
    pending: () => Promise.resolve(polls.length > 1 ? polls.shift()! : polls[0]),
  };
  return { bridge, creates };
}

function harness(bridge: WABridgeSessions, over: Partial<WhatsAppConnectDeps> = {}) {
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const published: Event[] = [];
  const states: WAPairingState[] = [];
  const deps: WhatsAppConnectDeps = {
    bridge,
    principal: "matias",
    store: {
      upsertConnections: (rows) => connections.push(...rows),
      upsertMemberships: (rows) => memberships.push(...rows),
    },
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    onState: (s) => states.push(s),
    ...over,
  };
  return { deps, connections, memberships, published, states };
}

const pending = (over: Partial<WAPairingState> = {}): WAPairingState => ({
  session_id: "p1",
  status: "pending",
  qr_code: "2@qr-one",
  ...over,
});

Deno.test("QR flow: poll to paired writes the owned anchor, membership, and note", async () => {
  const { bridge, creates } = fakeBridge(
    pending(),
    pending({ qr_code: "2@qr-two" }), // a rotation
    { session_id: "p1", status: "paired", address: "5491100000000" },
  );
  const { deps, connections, memberships, published, states } = harness(bridge);

  const { address } = await connectWhatsApp(deps, 1);

  assertEquals(address, "5491100000000");
  assertEquals(creates[0].agent_id, "matias"); // the pairing binds the principal
  assertEquals(creates[0].phone_number, undefined);
  // every visible change surfaced: first QR, the rotation, the paired flip
  assertEquals(states.map((s) => s.qr_code ?? s.status), ["2@qr-one", "2@qr-two", "paired"]);

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

Deno.test("phone flow: the number rides create; the pairing code surfaces", async () => {
  const { bridge, creates } = fakeBridge(
    pending({ qr_code: undefined, pairing_code: "ABCD-EFGH" }),
    { session_id: "p1", status: "paired", address: "5491100000000" },
  );
  const { deps, states } = harness(bridge, { phoneNumber: "5491100000000" });

  await connectWhatsApp(deps, 1);
  assertEquals(creates[0].phone_number, "5491100000000");
  assertEquals(states[0].pairing_code, "ABCD-EFGH");
});

Deno.test("a failed pairing throws and writes NOTHING", async () => {
  const { bridge } = fakeBridge(
    pending(),
    { session_id: "p1", status: "error", error: "pairing timed out" },
  );
  const { deps, connections, memberships, published } = harness(bridge);

  await assertRejects(() => connectWhatsApp(deps, 1), Error, "pairing timed out");
  assertEquals(connections.length, 0);
  assertEquals(memberships.length, 0);
  assertEquals(published.length, 0);
});

Deno.test("--org: the pairing binds nobody — an ownerless, credentialed row and no membership (§4)", async () => {
  const { bridge, creates } = fakeBridge(
    pending(),
    { session_id: "p1", status: "paired", address: "5491177700000" },
  );
  const { deps, connections, memberships, published } = harness(bridge, { principal: undefined });

  await connectWhatsApp(deps, 1);

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
