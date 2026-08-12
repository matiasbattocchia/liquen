import { assertEquals } from "@std/assert";
import { type AgentConfig, decide, type Gate, relevant } from "./xi.ts";
import type { Envelope, Event, Session } from "./types.ts";

const SESSION: Session = { id: "s1", agentId: "a1" };
const HOME = "home";
const OPEN: Gate = () => false; // gating off unless a test opts in

const env = (conversation: string): Envelope => ({
  service: "local",
  connection_address: "agent",
  conversation: { address: conversation },
});
const SELF = { agent: { id: "a1", session_id: "s1" } };

let n = 0;
/** Minimal event; ids are minted in call order so windows read as append order. */
function ev(type: Event["type"], over: Partial<Event> & { conv?: string } = {}): Event {
  const { conv, ...rest } = over;
  return {
    id: `e${String(++n).padStart(3, "0")}`,
    ts: "t",
    type,
    envelope: env(conv ?? HOME),
    parts: [],
    ...rest,
  } as Event;
}
const peerMsg = () => ev("message");
const selfMsg = (conv = HOME) => ev("message", { ...SELF, conv });
const use = (id: string) =>
  ev("tool_use", {
    ...SELF,
    id,
    turnId: "T1",
    parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: {} } }],
  } as Partial<Event>);
const result = (cause: string) =>
  ev("tool_result", { ...SELF, cause, turnId: "T1" } as Partial<Event>);

/* ── owed: the one derivation every poke shares ───────────────────────── */

Deno.test("decide: an unanswered peer message → think; answered → nothing", () => {
  assertEquals(decide([peerMsg()], SESSION, HOME, OPEN), "think");
  assertEquals(decide([peerMsg(), selfMsg()], SESSION, HOME, OPEN), "ignore");
  assertEquals(decide([selfMsg(), peerMsg()], SESSION, HOME, OPEN), "think"); // a new one after
});

Deno.test("decide: a directed peer send is not a closing — the answer is still owed", () => {
  assertEquals(decide([peerMsg(), selfMsg("wa:x")], SESSION, HOME, OPEN), "think");
});

Deno.test("decide: pending uses → act, whichever event poked", () => {
  assertEquals(decide([peerMsg(), use("u1")], SESSION, HOME, OPEN), "act");
});

Deno.test("decide: resolved uses with no turn output after → the closing think is owed", () => {
  assertEquals(decide([peerMsg(), use("u1"), result("u1")], SESSION, HOME, OPEN), "think");
});

Deno.test("decide: a closed chain with nothing new → quiescence (a poke that finds nothing)", () => {
  assertEquals(
    decide([peerMsg(), use("u1"), result("u1"), selfMsg()], SESSION, HOME, OPEN),
    "ignore",
  );
});

Deno.test("decide: all pending uses waiting on a human → nothing (the response is the wake)", () => {
  const gated: Gate = () => true;
  const u = use("u1");
  const req = ev("permission_request", { ...SELF, cause: "u1" } as Partial<Event>);
  assertEquals(decide([peerMsg(), u, req], SESSION, HOME, gated), "ignore");
  // unrequested gate → act (the request must be surfaced)
  assertEquals(decide([peerMsg(), use("u2")], SESSION, HOME, gated), "act");
  // responded gate → act (settle it: run or deny-result)
  const resp = ev("permission_response", {
    parts: [{
      type: "data",
      kind: "permission_response",
      data: { behavior: "allow", scope: "once", request_id: "u1" },
    }],
  } as Partial<Event>);
  assertEquals(decide([peerMsg(), u, req, resp], SESSION, HOME, gated), "act");
});

Deno.test("decide: another session's unresolved uses are not ours", () => {
  const other = ev("tool_use", {
    agent: { id: "a2", session_id: "s2" },
    turnId: "TX",
    parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: {} } }],
  } as Partial<Event>);
  assertEquals(decide([other], SESSION, HOME, OPEN), "ignore");
});

/* ── relevant: the free gate over the ONE triggering event ────────────── */

const CONFIG: AgentConfig = {
  agentId: "a1",
  sessionId: "s1",
  home: HOME,
  model: "m",
  maxTokens: 1024,
};

Deno.test("relevant: what can imply work — messages, own tools, the human's move, alarms", () => {
  assertEquals(relevant(CONFIG, peerMsg()), true); // a peer's message IS the work
  assertEquals(relevant(CONFIG, selfMsg()), true); // our closing message: the self-poke
  assertEquals(relevant(CONFIG, use("u1")), true); // our own batch, to settle
  assertEquals(relevant(CONFIG, result("u1")), true);
  assertEquals(relevant(CONFIG, ev("permission_response")), true);
  assertEquals(relevant(CONFIG, ev("alarm")), true);
});

Deno.test("relevant: a summary wakes — the checkpoint DISPLACED a turn; its insert carries it", () => {
  assertEquals(relevant(CONFIG, ev("summary", SELF)), true);
});

Deno.test("relevant: spectators cost nothing — no read, no lease", () => {
  for (const type of ["thinking", "permission_request", "control"] as const) {
    assertEquals(relevant(CONFIG, ev(type, SELF)), false);
  }
  // an error is a PERMANENT failure until something new arrives — `decide` agrees from the
  // window side (trailing error ⇒ ignore), so waking here would hot-loop a failing think
  assertEquals(relevant(CONFIG, ev("error")), false);
  assertEquals(relevant(CONFIG, { ...peerMsg(), type: "quantum" } as unknown as Event), false);
});

Deno.test("relevant: another session's tool events are not ours", () => {
  const other = { agent: { id: "a2", session_id: "s2" } };
  assertEquals(relevant(CONFIG, ev("tool_use", other)), false);
  assertEquals(relevant(CONFIG, ev("tool_result", other)), false);
});

/* ── backfill: imported history is readable, but owes nothing ─────────── */

const oldMsg = () => ev("message", { extra: { backfill: true } } as Partial<Event>);

Deno.test("relevant: a backfilled message never pokes — a pairing sync is not the work", () => {
  assertEquals(relevant(CONFIG, oldMsg()), false);
  assertEquals(relevant(CONFIG, peerMsg()), true); // live traffic is untouched
  // the flag is service-neutral and rides beside the sidecar, not inside it
  assertEquals(
    relevant(CONFIG, ev("message", { extra: { whatsapp: { re: "x" } } } as Partial<Event>)),
    true,
  );
});

Deno.test("decide: backfilled peers are not unanswered — the NEXT live event sees past them", () => {
  // the import alone owes nothing, however much of it lands
  assertEquals(decide([oldMsg(), oldMsg(), oldMsg()], SESSION, HOME, OPEN), "ignore");
  // and a later live message is answered on its own terms, not the backlog's
  assertEquals(decide([oldMsg(), peerMsg()], SESSION, HOME, OPEN), "think");
  assertEquals(decide([oldMsg(), peerMsg(), selfMsg()], SESSION, HOME, OPEN), "ignore");
  // …including after a closing, where the horizon branch does the asking
  assertEquals(decide([selfMsg(), oldMsg()], SESSION, HOME, OPEN), "ignore");
});

/* ── idle-after-error: the one policy the event-class filter used to hold ── */

Deno.test("decide: order-independent — a truncated turn continues, a failed one idles", () => {
  const advisory = ev("error", {
    meta: { stop: "max_tokens" }, // nu stamps the turn's outcome on its last event
    parts: [{ type: "data", kind: "error", data: { error: "cut off mid-generation" } }],
  } as Partial<Event>);
  const failed = ev("error", {
    parts: [{ type: "data", kind: "error", data: { error: "overloaded" } }],
  } as Partial<Event>);
  // both are `error` events in trailing position; the STAMP tells them apart, so neither
  // rule depends on being tested first
  assertEquals(decide([peerMsg(), advisory], SESSION, HOME, OPEN), "think");
  assertEquals(decide([peerMsg(), failed], SESSION, HOME, OPEN), "ignore");
});

Deno.test("decide: the max_tokens continuation is bounded — 3 overflows and it stops", () => {
  const cut = () =>
    ev("error", {
      meta: { stop: "max_tokens" },
      parts: [{ type: "data", kind: "error", data: { error: "cut off" } }],
    } as Partial<Event>);
  assertEquals(decide([peerMsg(), cut(), cut()], SESSION, HOME, OPEN), "think");
  assertEquals(decide([peerMsg(), cut(), cut(), cut()], SESSION, HOME, OPEN), "ignore"); // capped
});

Deno.test("decide: a trailing harness error ⇒ nothing owed (idle-after-error, §2)", () => {
  const err = ev("error", {
    parts: [{ type: "data", kind: "error", data: { error: "model overloaded" } }],
  } as Partial<Event>);
  // the peer message is still unanswered, so every other derivation says "think" …
  assertEquals(decide([peerMsg()], SESSION, HOME, OPEN), "think");
  // … but a trailing error means the think just FAILED: publishing it is itself the next
  // trigger, so re-deriving would hot-loop with no backoff. Stay idle.
  assertEquals(decide([peerMsg(), err], SESSION, HOME, OPEN), "ignore");
  // the next real event retries — an incoming message lands after the error
  assertEquals(decide([peerMsg(), err, peerMsg()], SESSION, HOME, OPEN), "think");
});
