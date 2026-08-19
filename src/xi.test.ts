import { assertEquals } from "@std/assert";
import { type AgentConfig, decide, gateOf, relevant } from "./xi.ts";
import type { Envelope, Event, Session } from "./types.ts";

const SESSION: Session = { id: "s1", agentId: "a1" };
const HOME = "home";

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
// a self message is turn OUTPUT: turn_id is the voice mark (§3 — the stamp alone no
// longer says which half, so ownVoice reads the turn)
const selfMsg = (conv = HOME) =>
  ev(
    "message",
    { ...SELF, conv, payload: { turn_id: "T0" } } as Partial<Event> & { conv?: string },
  );
const use = (id: string) =>
  ev("tool_use", {
    ...SELF,
    id,
    payload: { turn_id: "T1" },
    parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: {} } }],
  } as Partial<Event>);
const result = (refId: string) =>
  ev("tool_result", { ...SELF, payload: { turn_id: "T1", ref_id: refId } } as Partial<Event>);

/* ── policy: a table, not a branch ────────────────────────────────────── */

Deno.test("gateOf: the default asks for send and for nothing else — bash by rule, not by name", () => {
  const gate = gateOf();
  assertEquals(gate("send", {}), true);
  assertEquals(gate("bash", { command: "rm -rf /" }), false);
  assertEquals(gate("anything-an-mcp-server-brought", {}), false);
  // an org that wants the opposite writes the opposite — no code knows a tool's name
  const strict = gateOf([{ tool: "search", ask: false }, { tool: "*", ask: true }]);
  assertEquals(strict("search", {}), false);
  assertEquals(strict("bash", {}), true);
});

/* ── owed: the one derivation every poke shares ───────────────────────── */

Deno.test("decide: an unanswered peer message → think; answered → nothing", () => {
  assertEquals(decide([peerMsg()], SESSION, HOME), "think");
  assertEquals(decide([peerMsg(), selfMsg()], SESSION, HOME), "ignore");
  assertEquals(decide([selfMsg(), peerMsg()], SESSION, HOME), "think"); // a new one after
});

Deno.test("decide: the principal's stamped line is INPUT — agent + session, no turn_id (§3)", () => {
  // a repl line / alias mind copy: the harness stamps both authorship fields, and only
  // the missing turn_id keeps it answerable — session equality would call it ours
  const principal = () =>
    ev("message", {
      agent: { id: "a1", session_id: "s1" },
      envelope: { ...env(HOME), sender: { address: "matias", name: "matias" } },
    } as Partial<Event>);
  assertEquals(decide([principal()], SESSION, HOME), "think");
  assertEquals(decide([principal(), selfMsg()], SESSION, HOME), "ignore");
  assertEquals(decide([selfMsg(), principal()], SESSION, HOME), "think");
});

Deno.test("decide: a directed peer send is not a closing — the answer is still owed", () => {
  assertEquals(decide([peerMsg(), selfMsg("wa:x")], SESSION, HOME), "think");
});

Deno.test("decide: pending uses → act, whichever event poked", () => {
  assertEquals(decide([peerMsg(), use("u1")], SESSION, HOME), "act");
});

Deno.test("decide: resolved uses with no turn output after → the closing think is owed", () => {
  assertEquals(decide([peerMsg(), use("u1"), result("u1")], SESSION, HOME), "think");
});

Deno.test("decide: a closed chain with nothing new → quiescence (a poke that finds nothing)", () => {
  assertEquals(
    decide([peerMsg(), use("u1"), result("u1"), selfMsg()], SESSION, HOME),
    "ignore",
  );
});

Deno.test("decide: an answered ask whose call has not run yet → act (the harness's errand)", () => {
  const u = use("u1");
  const req = ev("permission_request", { ...SELF, payload: { ref_id: "u1" } } as Partial<Event>);
  const pending = result("u1"); // the `pending_approval` answer act gave the model
  const resp = ev("permission_response", {
    payload: { ref_id: "u1" },
    parts: [{
      type: "data",
      kind: "permission_response",
      data: { behavior: "allow", scope: "once" },
    }],
  } as Partial<Event>);
  // asked but unanswered: the call is closed as far as the transcript goes — the model may
  // think, and what it owes now is whatever the conversation owes
  assertEquals(decide([peerMsg(), u, req, pending], SESSION, HOME), "think");
  // the verdict lands: the harness runs it and reports back
  assertEquals(decide([peerMsg(), u, req, pending, resp], SESSION, HOME), "act");
  // …and once it has reported, that ask is done
  const done = ev("tool_result", {
    ...SELF,
    payload: { turn_id: "T1", ref_id: "u1", deferred: true },
  } as Partial<Event>);
  assertEquals(decide([peerMsg(), u, req, pending, resp, done], SESSION, HOME), "think");
});

Deno.test("decide: a use with no result is always act — asking IS executing", () => {
  // the gate lives inside `act` now, so a use the policy will stop looks like any other:
  // it gets answered this turn, with `pending_approval`. Nothing waits in the transcript.
  assertEquals(decide([peerMsg(), use("u2")], SESSION, HOME), "act");
});

Deno.test("decide: another session's unresolved uses are not ours", () => {
  const other = ev("tool_use", {
    agent: { id: "a2", session_id: "s2" },
    payload: { turn_id: "TX" },
    parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: {} } }],
  } as Partial<Event>);
  assertEquals(decide([other], SESSION, HOME), "ignore");
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
  assertEquals(decide([oldMsg(), oldMsg(), oldMsg()], SESSION, HOME), "ignore");
  // and a later live message is answered on its own terms, not the backlog's
  assertEquals(decide([oldMsg(), peerMsg()], SESSION, HOME), "think");
  assertEquals(decide([oldMsg(), peerMsg(), selfMsg()], SESSION, HOME), "ignore");
  // …including after a closing, where the horizon branch does the asking
  assertEquals(decide([selfMsg(), oldMsg()], SESSION, HOME), "ignore");
});

/* ── idle-after-error: the one policy the event-class filter used to hold ── */

Deno.test("decide: order-independent — a truncated turn continues, a failed one idles", () => {
  const advisory = ev("error", {
    payload: { stop_reason: "max_tokens" }, // nu stamps the turn's outcome on its last event
    parts: [{ type: "data", kind: "error", data: { error: "cut off mid-generation" } }],
  } as Partial<Event>);
  const failed = ev("error", {
    parts: [{ type: "data", kind: "error", data: { error: "overloaded" } }],
  } as Partial<Event>);
  // both are `error` events in trailing position; the STAMP tells them apart, so neither
  // rule depends on being tested first
  assertEquals(decide([peerMsg(), advisory], SESSION, HOME), "think");
  assertEquals(decide([peerMsg(), failed], SESSION, HOME), "ignore");
});

Deno.test("decide: the max_tokens continuation is bounded — 3 overflows and it stops", () => {
  const cut = () =>
    ev("error", {
      payload: { stop_reason: "max_tokens" },
      parts: [{ type: "data", kind: "error", data: { error: "cut off" } }],
    } as Partial<Event>);
  assertEquals(decide([peerMsg(), cut(), cut()], SESSION, HOME), "think");
  assertEquals(decide([peerMsg(), cut(), cut(), cut()], SESSION, HOME), "ignore"); // capped
});

Deno.test("decide: a trailing harness error ⇒ nothing owed (idle-after-error, §2)", () => {
  const err = ev("error", {
    parts: [{ type: "data", kind: "error", data: { error: "model overloaded" } }],
  } as Partial<Event>);
  // the peer message is still unanswered, so every other derivation says "think" …
  assertEquals(decide([peerMsg()], SESSION, HOME), "think");
  // … but a trailing error means the think just FAILED: publishing it is itself the next
  // trigger, so re-deriving would hot-loop with no backoff. Stay idle.
  assertEquals(decide([peerMsg(), err], SESSION, HOME), "ignore");
  // the next real event retries — an incoming message lands after the error
  assertEquals(decide([peerMsg(), err, peerMsg()], SESSION, HOME), "think");
});

Deno.test("decide: a waiting gate never mutes the mind — the principal is still answered", () => {
  const req = ev("permission_request", { ...SELF, payload: { ref_id: "u1" } } as Partial<Event>);
  const pending = result("u1"); // asked AND answered, in the same act
  // the principal says something while the ask is still up: the model is free to reply. A
  // turn used to re-issue the tool_use it never got an answer to (live, 2026-08-18: a bare
  // `/y` against two cards produced two more cards) — answering the call is what fixed it.
  const principal = ev("message", {
    agent: { id: "a1", session_id: "s1" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: HOME },
      sender: { address: "matias" },
    },
    parts: [{ type: "text", kind: "text", text: "y las otras?" }],
  } as Partial<Event>);
  assertEquals(decide([peerMsg(), use("u1"), req, pending, principal], SESSION, HOME), "think");
});
