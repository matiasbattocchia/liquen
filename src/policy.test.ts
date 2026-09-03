/**
 * policy: the RLS seam (§6). `scoped(log, policy)` must behave like a Postgres role —
 * USING before LIMIT on reads, WITH CHECK (all-or-nothing) on writes, filtered delivery
 * on the subscription (the Realtime shape).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Log, openLog } from "./store/log.ts";
import { policyFor, scoped } from "./policy.ts";
import type { Draft, Event, MessageEvent } from "./types.ts";

function msg(id: string, conversation: string, text: string): MessageEvent {
  return {
    id,
    ts: `2026-07-16T00:00:${id.padStart(2, "0")}Z`,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "org",
      conversation: { address: conversation },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

const inConv = (c: string) => (e: Event) => e.envelope.conversation.address === c;
const writesTo = (c: string) => (d: Draft) => d.envelope.conversation.address === c;

async function withLog(fn: (log: Log) => Promise<void> | void): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await fn(log);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("read: the policy applies BEFORE the limit — the window fills with visible events", async () => {
  await withLog(async (log) => {
    // interleave: private rows OUTNUMBER visible ones near the tail
    await log.publish([
      msg("01", "a", "mine-1"),
      msg("02", "b", "theirs"),
      msg("03", "a", "mine-2"),
      msg("04", "b", "theirs"),
      msg("05", "b", "theirs"),
      msg("06", "a", "mine-3"),
    ]);
    const view = scoped(log, { readable: inConv("a") });
    // post-hoc filtering would return ["06"] (limit 2 → rows 05,06 → one visible).
    // RLS fills the window first: the 2 most recent VISIBLE events, in append order.
    assertEquals((await view.read({ limit: 2 })).map((e) => e.id), ["03", "06"]);
    // and a caller's own filter composes (AND) instead of replacing the policy
    const mine1 = await view.read({ filter: (e) => e.id === "01" || e.id === "02" });
    assertEquals(mine1.map((e) => e.id), ["01"]);
  });
});

Deno.test("publish: WITH CHECK is all-or-nothing — one bad draft, nothing lands", async () => {
  await withLog(async (log) => {
    const view = scoped(log, { writable: writesTo("a") });
    await assertRejects(
      () => view.publish([msg("01", "a", "ok"), msg("02", "b", "forbidden")]),
      Error,
      "not writable",
    );
    assertEquals((await log.read()).length, 0); // the whole batch aborted, like Postgres
    await view.publish(msg("03", "a", "ok"));
    assertEquals((await log.read()).map((e) => e.id), ["03"]);
  });
});

Deno.test("publishAndRelease: an unwritable draft aborts BEFORE the lease is touched", async () => {
  await withLog(async (log) => {
    const view = scoped(log, { writable: writesTo("a") });
    const lock = log.lock("turn-x", 60_000);
    assertEquals(await lock.acquire(), "acquired");
    await assertRejects(() => view.publishAndRelease(msg("01", "b", "no"), lock.lease()));
    // the lease survives: the failed write released nothing (xi's catch pairs the release)
    const other = log.lock("turn-x", 60_000);
    assertEquals(await other.acquire(), "held");
    await lock.release();
  });
});

Deno.test("subscribe: delivery itself is filtered — each agent tails its own view (§6)", async () => {
  await withLog(async (log) => {
    const view = scoped(log, { readable: inConv("a") });
    const got: string[] = [];
    const off = view.subscribe((e) => got.push(e.id));
    await log.publish([
      msg("01", "a", "for me"),
      msg("02", "b", "not mine"),
      msg("03", "a", "me too"),
    ]);
    const t0 = Date.now();
    while (got.length < 2 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25));
    off();
    assertEquals(got, ["01", "03"]); // "02" never crossed the wire
    assert(!got.includes("02"));
  });
});

/* ── policyFor: the connections-map derivation (§6) ─────────────────────── */

const at = (service: string, connection: string, conversation: string, ts?: string): Event =>
  ({
    ts,
    envelope: { service, connection_address: connection, conversation: { address: conversation } },
  }) as Event;

Deno.test("policyFor: three branches — membership · shared (ownerless) · owned (private)", async () => {
  await withLog((log) => {
    log.upsertMemberships([
      { service: "local", connection: "agent", conversation: "mind@ana", agentId: "ana" },
    ]);
    log.upsertConnections([
      // ownerless + org-credentialed ⇒ the org's shared inbox (§6)
      { service: "whatsapp", address: "+549", credentialKey: "whatsapp:+549:org" },
      { service: "email", address: "ana@org", agentId: "ana" }, // owned ⇒ private
      { service: "slack", address: "T9" }, // a registration STUB: gate admission only
    ]);
    const ana = policyFor({ agentId: "ana", id: "mind" }, log);
    const bo = policyFor({ agentId: "bo", id: "mind" }, log);

    // branch 3: the mind is a one-member conversation — private by membership, no special case
    assert(ana.readable!(at("local", "agent", "mind@ana")));
    assert(!bo.readable!(at("local", "agent", "mind@ana")));
    // branch 1: ownerless + org credential = the org's — every agent reads it
    assert(ana.readable!(at("whatsapp", "+549", "wa:cust1")));
    assert(bo.readable!(at("whatsapp", "+549", "wa:cust1")));
    // a STUB (no owner, no org credential — a workspace with personal tokens only):
    // registered for the gate, but visibility rides membership alone
    assert(!ana.readable!(at("slack", "T9", "C9")));
    // branch 2: an owned account is the owner's ONLY (v0 resolver: owner name = agent name)
    assert(ana.readable!(at("email", "ana@org", "thread-7")));
    assert(!bo.readable!(at("email", "ana@org", "thread-7")));
    // no row at all (the local service, an unregistered pipe): membership is the only door
    assert(!ana.readable!(at("slack", "T05", "C123")));
    log.upsertMemberships([
      { service: "slack", connection: "T05", conversation: "C123", agentId: "ana" },
    ]);
    assert(ana.readable!(at("slack", "T05", "C123")));
    assert(!bo.readable!(at("slack", "T05", "C123")));
    // an unknown connection is unreadable, full stop
    assert(!ana.readable!(at("teams", "nobody", "x")));
  });
});

Deno.test("policyFor: soft-delete never touches visibility — revocation closes the gate only", async () => {
  await withLog((log) => {
    log.upsertConnections([{ service: "email", address: "ana@org", agentId: "ana" }]);
    const ana = policyFor({ agentId: "ana", id: "mind" }, log);
    assert(ana.readable!(at("email", "ana@org", "thread-7")));
    log.deleteConnections([{ service: "email", address: "ana@org" }]);
    // the history the grant ingested stays in ana's view — a running session is unaffected
    assert(ana.readable!(at("email", "ana@org", "thread-7")));
    assert(
      !policyFor({ agentId: "bo", id: "mind" }, log).readable!(at("email", "ana@org", "thread-7")),
    ); // still private
  });
});

Deno.test("policyFor: a membership is a lifetime — a leave keeps what the agent has seen", async () => {
  await withLog((log) => {
    const row = { service: "slack", connection: "T1", conversation: "C1", agentId: "ana" };
    log.upsertMemberships([row]);
    const ana = policyFor({ agentId: "ana", id: "mind" }, log);
    assert(ana.readable!(at("slack", "T1", "C1", "2026-08-11T10:00:00Z")));

    log.deleteMemberships([row]);
    // seen history stays in ana's view; the conversation's future does not — either side
    assert(ana.readable!(at("slack", "T1", "C1", "2020-01-01T00:00:00Z")));
    assert(!ana.readable!(at("slack", "T1", "C1", "2100-01-01T00:00:00Z")));
    assert(!ana.writable!(at("slack", "T1", "C1", "2100-01-01T00:00:00Z") as Draft));

    log.upsertMemberships([row]); // rejoin revives: the conversation whole again
    assert(ana.readable!(at("slack", "T1", "C1", "2100-01-01T00:00:00Z")));
  });
});

Deno.test("policyFor is LIVE: a mid-run bind is visible to the same closure (no restart)", async () => {
  await withLog((log) => {
    const bo = policyFor({ agentId: "bo", id: "mind" }, log); // built BEFORE the connection exists
    assert(!bo.readable!(at("whatsapp", "+549", "wa:c")));
    log.upsertConnections([
      { service: "whatsapp", address: "+549", credentialKey: "whatsapp:+549:org" },
    ]);
    assert(bo.readable!(at("whatsapp", "+549", "wa:c"))); // read-through, like the RLS join
    assert(bo.writable!(at("whatsapp", "+549", "wa:c") as Draft)); // same predicate, WITH CHECK side
  });
});

Deno.test("policyFor: the member is the (agent, session) pair — a sibling's room is not yours (§4)", async () => {
  await withLog((log) => {
    log.upsertMemberships([
      {
        service: "local",
        connection: "agent",
        conversation: "mind@ana",
        agentId: "ana",
        sessionId: "mind",
      },
      {
        service: "local",
        connection: "agent",
        conversation: "build@ana",
        agentId: "ana",
        sessionId: "build",
      },
    ]);
    const mind = policyFor({ agentId: "ana", id: "mind" }, log);
    const build = policyFor({ agentId: "ana", id: "build" }, log);

    // each session reads and writes where it is enrolled — enrollment IS the enforcement
    assert(mind.readable!(at("local", "agent", "mind@ana")));
    assert(build.readable!(at("local", "agent", "build@ana")));
    assert(!mind.readable!(at("local", "agent", "build@ana")));
    assert(!build.readable!(at("local", "agent", "mind@ana")));
    assert(!build.writable!(at("local", "agent", "mind@ana") as Draft));
    // …and a DM room both are in is how they reach each other, like two agents
    log.upsertMemberships([
      {
        service: "local",
        connection: "agent",
        conversation: "dm:build@ana:mind@ana",
        agentId: "ana",
        sessionId: "mind",
      },
      {
        service: "local",
        connection: "agent",
        conversation: "dm:build@ana:mind@ana",
        agentId: "ana",
        sessionId: "build",
      },
    ]);
    assert(mind.readable!(at("local", "agent", "dm:build@ana:mind@ana")));
    assert(build.readable!(at("local", "agent", "dm:build@ana:mind@ana")));
  });
});

Deno.test("policyFor: a connection grant opens the ROUTED session only — today the mind (§4)", async () => {
  await withLog((log) => {
    log.upsertConnections([
      { service: "whatsapp", address: "+549", credentialKey: "whatsapp:+549:org" }, // the org's
      { service: "email", address: "ana@org", agentId: "ana" }, // ana's own
    ]);
    const mind = policyFor({ agentId: "ana", id: "mind" }, log);
    const build = policyFor({ agentId: "ana", id: "build" }, log);

    // ownership stays the AGENT's; which session it opens is the routing function's say
    assert(mind.readable!(at("whatsapp", "+549", "wa:cust1")));
    assert(!build.readable!(at("whatsapp", "+549", "wa:cust1")));
    assert(mind.readable!(at("email", "ana@org", "thread-7")));
    assert(!build.readable!(at("email", "ana@org", "thread-7")));
    // an explicit enrollment still reaches a named session — routing is the default, not a wall
    log.upsertMemberships([
      {
        service: "email",
        connection: "ana@org",
        conversation: "thread-7",
        agentId: "ana",
        sessionId: "build",
      },
    ]);
    assert(build.readable!(at("email", "ana@org", "thread-7")));
  });
});

Deno.test("memberships: a wire-filled row (no session named) enrolls the routed session (§4)", async () => {
  await withLog((log) => {
    // the Slack membership mirror writes what the wire says — agent and room, no session
    log.upsertMemberships([
      { service: "slack", connection: "T1", conversation: "C1", agentId: "ana" },
    ]);
    assert(log.isMember("slack", "T1", "C1", "ana", "mind"));
    assert(!log.isMember("slack", "T1", "C1", "ana", "build"));
  });
});

Deno.test("policyFor: the mind-alias conversation is invisible to its own agent (§4)", async () => {
  await withLog((log) => {
    log.upsertConnections([
      { service: "slack", address: "T1" }, // the workspace anchor inbound events carry
      { service: "slack", address: "T1:U1", agentId: "ana", extra: { self_conversation: "D1" } },
    ]);
    const ana = policyFor({ agentId: "ana", id: "mind" }, log);

    // the self-DM is the mind's surface, not a world conversation: the mirror's copies are
    // ana's view of it — the wire events (anchored to the workspace OR the grant) are not,
    // and `send` can't reach it either (the principal is never a send target)
    assert(!ana.readable!(at("slack", "T1", "D1")));
    assert(!ana.readable!(at("slack", "T1:U1", "D1")));
    assert(!ana.writable!(at("slack", "T1", "D1") as Draft));
    // the rest of the owned account view is untouched
    assert(ana.readable!(at("slack", "T1:U1", "C7")));
  });
});
