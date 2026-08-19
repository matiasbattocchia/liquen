import { assertEquals } from "@std/assert";
import { type AgentConfig, decide, gateOf, parseVerdict, relevant, type Wake } from "./xi.ts";
import type { Envelope, Event, Session } from "./types.ts";

const SESSION: Session = { id: "s1", agentId: "a1" };
const HOME = "home";
const WAKE: Wake = { home: HOME, agentId: "a1" };

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
  assertEquals(gate("send", {}), "ask");
  assertEquals(gate("bash", { command: "rm -rf /" }), "allow");
  assertEquals(gate("anything-an-mcp-server-brought", {}), "allow");
  // an org that wants the opposite writes the opposite — no code knows a tool's name
  const strict = gateOf([{ tool: "search", action: "allow" }, { tool: "*", action: "ask" }]);
  assertEquals(strict("search", {}), "allow");
  assertEquals(strict("bash", {}), "ask");
});

Deno.test("gateOf: scoped rules — where a send lands decides, most specific first (§9)", () => {
  // the org's three gating levels: conversation · connection (workspace/account) · global
  const gate = gateOf([
    { tool: "send", action: "deny", connection: "T042", conversation: "C042" },
    { tool: "send", action: "allow", connection: "T042" }, // the Slack workspace flows…
    { tool: "send", action: "ask" }, // …the WhatsApp number (any other connection) asks
    { tool: "*", action: "allow" },
  ]);
  assertEquals(gate("send", {}, { connection: "T042", conversation: "C042" }), "deny");
  assertEquals(gate("send", {}, { connection: "T042", conversation: "C099" }), "allow");
  assertEquals(gate("send", {}, { connection: "549115550000", conversation: "wa:g1" }), "ask");
  assertEquals(gate("send", {}, { conversation: "mind:a1" }), "ask"); // local: the bare rule
  assertEquals(gate("send", {}), "ask"); // no target ⇒ scoped rules never match
  assertEquals(gate("bash", {}), "allow"); // a placed rule never leaks onto placeless tools
});

Deno.test("parseVerdict: /{y,n} [conv|conn|all] [reason] — one syntax, every door (§9)", () => {
  assertEquals(parseVerdict("/y"), { behavior: "allow", scope: "once" });
  assertEquals(parseVerdict("/n ahora no"), {
    behavior: "deny",
    scope: "once",
    reason: "ahora no",
  });
  assertEquals(parseVerdict("/y conv"), { behavior: "allow", scope: "conversation" });
  assertEquals(parseVerdict("/n conn spam"), {
    behavior: "deny",
    scope: "connection",
    reason: "spam",
  });
  assertEquals(parseVerdict("/y all dale"), { behavior: "allow", scope: "all", reason: "dale" });
  // a note that merely STARTS like a scope word is a note — the word must stand alone
  assertEquals(parseVerdict("/y convenceme"), {
    behavior: "allow",
    scope: "once",
    reason: "convenceme",
  });
  assertEquals(parseVerdict("hola"), undefined);
});

/* ── owed: the one derivation every poke shares ───────────────────────── */

Deno.test("decide: an unanswered peer message → think; answered → nothing", () => {
  assertEquals(decide([peerMsg()], SESSION, WAKE), "think");
  assertEquals(decide([peerMsg(), selfMsg()], SESSION, WAKE), "ignore");
  assertEquals(decide([selfMsg(), peerMsg()], SESSION, WAKE), "think"); // a new one after
});

Deno.test("decide: the principal's stamped line is INPUT — agent + session, no turn_id (§3)", () => {
  // a repl line / alias mind copy: the harness stamps both authorship fields, and only
  // the missing turn_id keeps it answerable — session equality would call it ours
  const principal = () =>
    ev("message", {
      agent: { id: "a1", session_id: "s1" },
      envelope: { ...env(HOME), sender: { address: "matias", name: "matias" } },
    } as Partial<Event>);
  assertEquals(decide([principal()], SESSION, WAKE), "think");
  assertEquals(decide([principal(), selfMsg()], SESSION, WAKE), "ignore");
  assertEquals(decide([selfMsg(), principal()], SESSION, WAKE), "think");
});

Deno.test("decide: a directed peer send is not a closing — the answer is still owed", () => {
  assertEquals(decide([peerMsg(), selfMsg("wa:x")], SESSION, WAKE), "think");
});

Deno.test("decide: pending uses → act, whichever event poked", () => {
  assertEquals(decide([peerMsg(), use("u1")], SESSION, WAKE), "act");
});

Deno.test("decide: resolved uses with no turn output after → the closing think is owed", () => {
  assertEquals(decide([peerMsg(), use("u1"), result("u1")], SESSION, WAKE), "think");
});

Deno.test("decide: a closed chain with nothing new → quiescence (a poke that finds nothing)", () => {
  assertEquals(
    decide([peerMsg(), use("u1"), result("u1"), selfMsg()], SESSION, WAKE),
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
  assertEquals(decide([peerMsg(), u, req, pending], SESSION, WAKE), "think");
  // the verdict lands: the harness runs it and reports back
  assertEquals(decide([peerMsg(), u, req, pending, resp], SESSION, WAKE), "act");
  // …and once it has reported, that ask is done
  const done = ev("tool_result", {
    ...SELF,
    payload: { turn_id: "T1", ref_id: "u1", deferred: true },
  } as Partial<Event>);
  assertEquals(decide([peerMsg(), u, req, pending, resp, done], SESSION, WAKE), "think");
});

Deno.test("decide: a use with no result is always act — asking IS executing", () => {
  // the gate lives inside `act` now, so a use the policy will stop looks like any other:
  // it gets answered this turn, with `pending_approval`. Nothing waits in the transcript.
  assertEquals(decide([peerMsg(), use("u2")], SESSION, WAKE), "act");
});

Deno.test("decide: another session's unresolved uses are not ours", () => {
  const other = ev("tool_use", {
    agent: { id: "a2", session_id: "s2" },
    payload: { turn_id: "TX" },
    parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: {} } }],
  } as Partial<Event>);
  assertEquals(decide([other], SESSION, WAKE), "ignore");
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
  assertEquals(decide([oldMsg(), oldMsg(), oldMsg()], SESSION, WAKE), "ignore");
  // and a later live message is answered on its own terms, not the backlog's
  assertEquals(decide([oldMsg(), peerMsg()], SESSION, WAKE), "think");
  assertEquals(decide([oldMsg(), peerMsg(), selfMsg()], SESSION, WAKE), "ignore");
  // …including after a closing, where the horizon branch does the asking
  assertEquals(decide([selfMsg(), oldMsg()], SESSION, WAKE), "ignore");
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
  assertEquals(decide([peerMsg(), advisory], SESSION, WAKE), "think");
  assertEquals(decide([peerMsg(), failed], SESSION, WAKE), "ignore");
});

Deno.test("decide: the max_tokens continuation is bounded — 3 overflows and it stops", () => {
  const cut = () =>
    ev("error", {
      payload: { stop_reason: "max_tokens" },
      parts: [{ type: "data", kind: "error", data: { error: "cut off" } }],
    } as Partial<Event>);
  assertEquals(decide([peerMsg(), cut(), cut()], SESSION, WAKE), "think");
  assertEquals(decide([peerMsg(), cut(), cut(), cut()], SESSION, WAKE), "ignore"); // capped
});

Deno.test("decide: a trailing harness error ⇒ nothing owed (idle-after-error, §2)", () => {
  const err = ev("error", {
    parts: [{ type: "data", kind: "error", data: { error: "model overloaded" } }],
  } as Partial<Event>);
  // the peer message is still unanswered, so every other derivation says "think" …
  assertEquals(decide([peerMsg()], SESSION, WAKE), "think");
  // … but a trailing error means the think just FAILED: publishing it is itself the next
  // trigger, so re-deriving would hot-loop with no backoff. Stay idle.
  assertEquals(decide([peerMsg(), err], SESSION, WAKE), "ignore");
  // the next real event retries — an incoming message lands after the error
  assertEquals(decide([peerMsg(), err, peerMsg()], SESSION, WAKE), "think");
});

Deno.test("decide: a waiting gate never mutes the mind — the principal is still answered", () => {
  const req = ev("permission_request", { ...SELF, payload: { ref_id: "u1" } } as Partial<Event>);
  const pending = result("u1"); // asked AND answered, in the same act
  // the principal says something while the ask is still up: the model is free to reply —
  // its tool_use is already answered (`pending_approval`), so a turn has nothing to re-issue
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
  assertEquals(decide([peerMsg(), use("u1"), req, pending, principal], SESSION, WAKE), "think");
});

/* ── attention: three wake classes over the unanswered news (§2) ──────── */

const NOON = Date.parse("2026-08-19T12:00:00Z"); // UTC — WAKE carries no timezone
const at = (minAgo: number, base = NOON) => new Date(base - minAgo * 60_000).toISOString();
const world = (conv: string, minAgo: number, text = "shipping the report today") =>
  ev(
    "message",
    {
      conv,
      ts: at(minAgo),
      parts: [{ type: "text", kind: "text", text }],
    } as Partial<Event> & { conv?: string },
  );

Deno.test("attention: ambient world news defers until the digest interval", () => {
  assertEquals(decide([world("slack:C1", 1)], SESSION, WAKE, NOON), "ignore"); // fresh: waits
  assertEquals(decide([world("slack:C1", 6)], SESSION, WAKE, NOON), "think"); // past 5 min
});

Deno.test("attention: a pile deep enough wakes before the interval does", () => {
  const pile = Array.from({ length: 20 }, () => world("slack:C1", 0));
  assertEquals(decide(pile, SESSION, WAKE, NOON), "think");
  assertEquals(decide(pile.slice(0, 3), SESSION, WAKE, NOON), "ignore");
});

Deno.test("attention: a summons never waits — home, a DM, a reply to us, our name", () => {
  assertEquals(decide([world(HOME, 0)], SESSION, WAKE, NOON), "think");
  assertEquals(decide([world("dm:a1:b2", 0)], SESSION, WAKE, NOON), "think");
  assertEquals(decide([world("slack:C1", 0, "ping @a1 wdyt?")], SESSION, WAKE, NOON), "think");
  assertEquals(decide([world("slack:C1", 0, "banana1 talk")], SESSION, WAKE, NOON), "ignore");
  const mine = selfMsg("slack:C1");
  const reply = ev(
    "message",
    {
      conv: "slack:C1",
      ts: at(0),
      payload: { ref_id: mine.id },
      parts: [{ type: "text", kind: "text", text: "sure" }],
    } as Partial<Event> & { conv?: string },
  );
  assertEquals(decide([mine, reply], SESSION, WAKE, NOON), "think");
});

Deno.test("attention: an engaged conversation wakes now — your own last word is recent", () => {
  const spoke = (minAgo: number) =>
    ev(
      "message",
      {
        ...SELF,
        conv: "slack:C1",
        ts: at(minAgo),
        payload: { turn_id: "T0" },
      } as Partial<Event> & { conv?: string },
    );
  assertEquals(decide([spoke(3), world("slack:C1", 1)], SESSION, WAKE, NOON), "think");
  assertEquals(decide([spoke(60), world("slack:C1", 1)], SESSION, WAKE, NOON), "ignore");
});

Deno.test("attention: quiet hours stretch the digest; null switches quiet off", () => {
  const night = Date.parse("2026-08-19T03:00:00Z"); // inside the default 23-8 span (UTC)
  const msg = (base: number) =>
    // 10 min old, at `base`
    ev(
      "message",
      {
        conv: "slack:C1",
        ts: at(10, base),
        parts: [{ type: "text", kind: "text", text: "night shift" }],
      } as Partial<Event> & { conv?: string },
    );
  assertEquals(decide([msg(night)], SESSION, WAKE, night), "ignore"); // 10 < 60 quiet min
  assertEquals(decide([msg(NOON)], SESSION, WAKE, NOON), "think"); // 10 > 5 busy min
  assertEquals(decide([msg(night)], SESSION, { ...WAKE, quietHours: null }, night), "think");
});
