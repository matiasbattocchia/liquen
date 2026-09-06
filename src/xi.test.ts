import { assert, assertEquals } from "@std/assert";
import {
  type AgentConfig,
  anchored,
  decide,
  gateOf,
  parseVerdict,
  relevant,
  specsOf,
  type Wake,
  type XiPorts,
} from "./xi.ts";
import type { Envelope, Event, Session } from "./types.ts";

const MIND = "mind@a1"; // the session's own conversation (§4)
const SESSION: Session = { id: "mind", agentId: "a1", conversation: MIND };
const WAKE: Wake = {};

const env = (conversation: string): Envelope => ({
  service: "local",
  connection_address: "agent",
  conversation: { address: conversation },
});
const SELF = { agent: { id: "a1", session_id: "mind" } };

let n = 0;
/** Minimal event; ids are minted in call order so windows read as append order. */
function ev(type: Event["type"], over: Partial<Event> & { conv?: string } = {}): Event {
  const { conv, ...rest } = over;
  return {
    id: `e${String(++n).padStart(3, "0")}`,
    ts: "t",
    type,
    envelope: env(conv ?? MIND),
    parts: [],
    ...rest,
  } as Event;
}
const peerMsg = () => ev("message");
// a self message is turn OUTPUT: turn_id is the voice mark (§3 — the stamp alone no
// longer says which half, so ownVoice reads the turn)
const selfMsg = (conv = MIND) =>
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
  assertEquals(gate("send", {}, { conversation: "mind@a1" }), "ask"); // local: the bare rule
  assertEquals(gate("send", {}), "ask"); // no target ⇒ scoped rules never match
  assertEquals(gate("bash", {}), "allow"); // a placed rule never leaks onto placeless tools
});

Deno.test("parseVerdict: /{y,n} [once|conv|conn|always] [reason] — one syntax, every door (§9)", () => {
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
  assertEquals(parseVerdict("/y always dale"), {
    behavior: "allow",
    scope: "always",
    reason: "dale",
  });
  // the bare form said out loud — `/y` IS `/y once`, which is what makes `always` its opposite
  assertEquals(parseVerdict("/y once"), { behavior: "allow", scope: "once" });
  // a note that merely STARTS like a scope word is a note — the word must stand alone
  assertEquals(parseVerdict("/y convenceme"), {
    behavior: "allow",
    scope: "once",
    reason: "convenceme",
  });
  assertEquals(parseVerdict("hola"), undefined);
});

Deno.test("parseVerdict: `all` is HOW MANY cards, `always` is how long — two axes", () => {
  assertEquals(parseVerdict("/y all"), { behavior: "allow", scope: "once", every: true });
  assertEquals(parseVerdict("/n all después lo veo"), {
    behavior: "deny",
    scope: "once",
    reason: "después lo veo",
    every: true,
  });
  // the widest SCOPE is its own word, and answers the one card it was typed at
  assertEquals(parseVerdict("/y always"), { behavior: "allow", scope: "always" });
  // a bare word answers one card, once — the two words are the two ends of that sentence
  assertEquals(parseVerdict("/y"), { behavior: "allow", scope: "once" });
  // a word that merely STARTS like one of them is a reason: the token must stand alone
  assertEquals(parseVerdict("/n allá vemos"), {
    behavior: "deny",
    scope: "once",
    reason: "allá vemos",
  });
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
      agent: { id: "a1", session_id: "mind" },
      envelope: { ...env(MIND), sender: { address: "matias", name: "matias" } },
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

Deno.test("decide: a trailing cancelled row idles the turn it closed, and the next word wakes", () => {
  const closed = ev("control", {
    payload: { control: "cancelled" },
    parts: [{ type: "text", kind: "text", text: "cancelled by your principal" }],
  } as Partial<Event>);
  // the cut act: uses answered, but no closing think is owed — the principal said drop it
  assertEquals(decide([peerMsg(), use("u1"), result("u1"), closed], SESSION, WAKE), "ignore");
  // the cut think: the message it was answering stays unanswered, and stays idle
  assertEquals(decide([peerMsg(), closed], SESSION, WAKE), "ignore");
  assertEquals(decide([peerMsg(), closed, peerMsg()], SESSION, WAKE), "think");
});

Deno.test("decide: the agent's own settlement (a cancel — turn_id) is never the errand", () => {
  const u = use("u1");
  const req = ev("permission_request", { ...SELF, payload: { ref_id: "u1" } } as Partial<Event>);
  const pending = result("u1");
  const settle = (payload: Record<string, string>) =>
    ev("permission_response", {
      payload,
      parts: [{
        type: "data",
        kind: "permission_response",
        data: { behavior: "deny", scope: "once", reason: "withdrawn by the agent" },
      }],
    } as Partial<Event>);
  // someone else's ruling → the errand; the model's own withdrawal (turn-marked, §3) → its
  // cancel tool_result is already the record, so nothing is owed
  assertEquals(
    decide([peerMsg(), u, req, pending, settle({ ref_id: "u1" }), selfMsg()], SESSION, WAKE),
    "act",
  );
  assertEquals(
    decide(
      [peerMsg(), u, req, pending, settle({ ref_id: "u1", turn_id: "T2" }), selfMsg()],
      SESSION,
      WAKE,
    ),
    "ignore",
  );
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
  sessionId: "mind",
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

/* ── silenced (§5): backfill · muted · archived are readable, but owe nothing ── */

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

Deno.test("silenced: a muted or archived chat's message never wakes — not even a summons", () => {
  const muted = ev("message", { extra: { muted: true } } as Partial<Event>);
  const archived = ev("message", { extra: { archived: true } } as Partial<Event>);
  // the trigger predicate skips the invocation outright…
  assertEquals(relevant(CONFIG, muted), false);
  assertEquals(relevant(CONFIG, archived), false);
  // …and the window side agrees: these land in MIND — the strongest summons — and still
  // wake nothing (the principal muted the chat; the agent honors it)
  assertEquals(decide([muted], SESSION, WAKE), "ignore");
  assertEquals(decide([archived, muted], SESSION, WAKE), "ignore");
  // a live message beside them is answered on its own terms
  assertEquals(decide([muted, peerMsg()], SESSION, WAKE), "think");
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
    agent: { id: "a1", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: MIND },
      sender: { address: "matias" },
    },
    parts: [{ type: "text", kind: "text", text: "y las otras?" }],
  } as Partial<Event>);
  assertEquals(decide([peerMsg(), use("u1"), req, pending, principal], SESSION, WAKE), "think");
});

/* ── attention: the ladder over the unanswered news (§2) ──────────────── */

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
/** A turn closing in the session's own room — where the agent last LOOKED, and so where
 *  rule 5 counts from. */
const looked = (minAgo: number, who: Partial<Event> = SELF) =>
  ev(
    "message",
    { ...who, conv: MIND, ts: at(minAgo), payload: { turn_id: "T0" } } as
      & Partial<Event>
      & { conv?: string },
  );

Deno.test("attention: the world is checked on the interval, counted from the LAST LOOK", () => {
  assertEquals(decide([looked(1), world("slack:C1", 0)], SESSION, WAKE, NOON), "ignore");
  assertEquals(decide([looked(16), world("slack:C1", 0)], SESSION, WAKE, NOON), "think");
  // the news landing 14 min into the interval is read at the next check, one minute later —
  // not fifteen minutes after ITSELF, which is what a pile-age clock would have done
  assertEquals(decide([looked(16), world("slack:C1", 14)], SESSION, WAKE, NOON), "think");
  // and an agent that has never looked is due now: it has been away, it picks the phone up
  assertEquals(decide([world("slack:C1", 0)], SESSION, WAKE, NOON), "think");
});

Deno.test("attention: a NAMED session is reactive — no digest cadence, no sleep window (§4)", () => {
  const s: Session = { id: "build", agentId: "a1", conversation: "build@a1" };
  const self = { agent: { id: "a1", session_id: "build" } };
  const dm = "dm:build@a1:mind@a1";
  const line = world(dm, 0);
  const look = ev(
    "message",
    { ...self, conv: "build@a1", ts: at(1), payload: { turn_id: "T0" } } as
      & Partial<Event>
      & { conv?: string },
  );
  // a look one minute ago would defer the MIND to the digest; the named session answers now
  assertEquals(decide([look, line], s, WAKE, NOON), "think");
  // …and the night never falls on it either
  const night = Date.parse("2026-08-19T03:00:00Z"); // inside the default 23-8 span (UTC)
  assertEquals(decide([world(dm, 0, "seguí")], s, WAKE, night), "think");
});

Deno.test("attention: a pile deep enough wakes before the interval does", () => {
  const pile = Array.from({ length: 25 }, () => world("slack:C1", 0));
  assertEquals(decide([looked(1), ...pile], SESSION, WAKE, NOON), "think");
  assertEquals(decide([looked(1), ...pile.slice(0, 3)], SESSION, WAKE, NOON), "ignore");
  // the depth is the WORLD's, not one room's: the same 25 spread over five conversations
  // is the same amount of unread, and counts the same
  const spread = Array.from({ length: 25 }, (_, i) => world(`slack:C${i % 5}`, 0));
  assertEquals(decide([looked(1), ...spread], SESSION, WAKE, NOON), "think");
});

/** A voice note: all it can show the model is `<audio/>` — somebody spoke, contents sealed. */
const note = (conv: string, minAgo: number, id = "wa:n1") =>
  ev(
    "message",
    {
      ts: at(minAgo),
      envelope: { ...env(conv), external_id: id },
      parts: [{
        type: "file",
        kind: "audio",
        file: { mime_type: "audio/ogg", uri: "file:///n.ogg" },
      }],
    } as Partial<Event> & { conv?: string },
  );
/** Its words, landing minutes later as an `add` riding on the note (§3). */
const said = (conv: string, minAgo: number, ref = "wa:n1") =>
  ev(
    "message",
    {
      conv,
      ts: at(minAgo),
      payload: { action: "add", ref_external_id: ref },
      parts: [{ type: "text", kind: "transcript", text: "te comento por qué te escribo" }],
    } as Partial<Event> & { conv?: string },
  );

Deno.test("attention: the words of a note ALREADY LOOKED AT wake now — they are that note", () => {
  const C = "slack:C1";
  // the turn that read the note got `<audio/>` and could judge nothing; six minutes later
  // the words arrive, and that is the first moment the message can be read at all
  assertEquals(decide([note(C, 20), looked(10), said(C, 0)], SESSION, WAKE, NOON), "think");
  // …and it is the WORDS that wake: the same window without them has nothing owed
  assertEquals(decide([note(C, 20), looked(10)], SESSION, WAKE, NOON), "ignore");
  // a note still unread needs none of this — its words sit in the same pile it does, and
  // the digest reads the two together
  assertEquals(decide([looked(10), note(C, 5), said(C, 4)], SESSION, WAKE, NOON), "ignore");
  // inheritance is not an exemption: the night still swallows it, like the note itself
  assertEquals(
    decide([note(C, 20), looked(10), said(C, 0)], SESSION, { sleepHours: "0-23" }, NOON),
    "ignore",
  );
});

Deno.test("attention: a note and its words are ONE arrival, not two", () => {
  const notes = Array.from({ length: 13 }, (_, i) => note(`slack:C${i % 5}`, 5, `wa:n${i}`));
  const words = notes.map((_n, i) => said(`slack:C${i % 5}`, 4, `wa:n${i}`));
  // 26 rows, 13 things that happened — counting both halves would fake a pile deep enough
  assertEquals(decide([looked(10), ...notes, ...words], SESSION, WAKE, NOON), "ignore");
});

Deno.test("attention: the summons is the mind alias and NOTHING else", () => {
  assertEquals(decide([looked(1), world(MIND, 0)], SESSION, WAKE, NOON), "think");
  // a DM is a hail to the PRINCIPAL's account, in a room the agent is a bystander in
  assertEquals(decide([looked(1), world("wa:5491133585694", 0)], SESSION, WAKE, NOON), "ignore");
  // its name said out loud, by someone who is not its principal, is still the world
  assertEquals(
    decide([looked(1), world("slack:C1", 0, "ping @a1 wdyt?")], SESSION, WAKE, NOON),
    "ignore",
  );
});

Deno.test("attention: a reply to us wakes only while we hold the floor — else the digest", () => {
  const reply = (mine: Event, minAgo: number) =>
    ev(
      "message",
      {
        conv: "slack:C1",
        ts: at(minAgo),
        payload: { ref_id: mine.id },
        parts: [{ type: "text", kind: "text", text: "sure" }],
      } as Partial<Event> & { conv?: string },
    );
  const spoke = (minAgo: number) =>
    ev(
      "message",
      { ...SELF, conv: "slack:C1", ts: at(minAgo), payload: { turn_id: "T0" } } as
        & Partial<Event>
        & { conv?: string },
    );
  const fresh = spoke(3);
  assertEquals(decide([fresh, looked(1), reply(fresh, 0)], SESSION, WAKE, NOON), "think");
  const stale = spoke(60);
  assertEquals(decide([stale, looked(1), reply(stale, 0)], SESSION, WAKE, NOON), "ignore");
});

Deno.test("attention: engagement is HOLDING THE FLOOR — our word last, and recent", () => {
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
  // the look is recent in both, so rule 5 says wait: what answers is the floor, or nothing
  assertEquals(decide([spoke(3), looked(1), world("slack:C1", 0)], SESSION, WAKE, NOON), "think");
  assertEquals(decide([spoke(60), looked(1), world("slack:C1", 0)], SESSION, WAKE, NOON), "ignore");
});

Deno.test("attention: the principal speaking in a conversation ENDS engagement, at once", () => {
  // A wire echo carries `agent.id` (the classifier stamps it from their grant) and NO
  // session_id — an unstamped row reads as the ROUTED session's, the one world traffic
  // belongs to (§4): the mind, which this session is.
  const s: Session = { id: "mind", agentId: "a1", conversation: MIND };
  const self = { agent: { id: "a1", session_id: "mind" } };
  const byHand = (minAgo: number) =>
    ev("message", {
      agent: { id: "a1" }, // their phone in hand: no session_id, and never a turn_id
      ts: at(minAgo),
      envelope: { ...env("slack:C1"), sender: { address: "matias", name: "matias" } },
      parts: [{ type: "text", kind: "text", text: "yo sigo desde acá" }],
    } as Partial<Event>);
  const spoke = () =>
    ev(
      "message",
      { ...self, conv: "slack:C1", ts: at(4), payload: { turn_id: "T0" } } as
        & Partial<Event>
        & { conv?: string },
    );
  const look = looked(1, self); // recent, so rule 5 defers and only the floor can answer
  // our word is 4 min old — engaged, but for their line landing after it
  assertEquals(decide([spoke(), look, world("slack:C1", 0)], s, WAKE, NOON), "think");
  assertEquals(decide([spoke(), byHand(3), look, world("slack:C1", 0)], s, WAKE, NOON), "ignore");
  // and the floor comes back the moment the agent speaks again
  assertEquals(
    decide([spoke(), byHand(3), spoke(), look, world("slack:C1", 0)], s, WAKE, NOON),
    "think",
  );
});

Deno.test("attention: asleep, the ambient world waits for morning — the principal never does", () => {
  const night = Date.parse("2026-08-19T03:00:00Z"); // inside the default 23-8 span (UTC)
  const ambient = (base: number, minAgo = 10) =>
    ev(
      "message",
      {
        conv: "slack:C1",
        ts: at(minAgo, base),
        parts: [{ type: "text", kind: "text", text: "night shift" }],
      } as Partial<Event> & { conv?: string },
    );
  // by day the interval decides; at night nothing does — the same news, twice
  assertEquals(decide([ambient(NOON, 16)], SESSION, WAKE, NOON), "think");
  assertEquals(decide([ambient(night, 16)], SESSION, WAKE, night), "ignore");
  // and sleep BEATS the pile: a night that fills the room still waits for the morning,
  // which is the whole difference between sleeping and a slower cadence
  const pile = Array.from({ length: 40 }, (_, i) => ambient(night, 300 - i));
  assertEquals(decide(pile, SESSION, WAKE, night), "ignore");
  assertEquals(decide(pile, SESSION, { ...WAKE, sleepHours: null }, night), "think");
  // what still gets through at 3am: their own line to the session, and a conversation we hold
  const own = ev(
    "message",
    {
      ts: at(1, night),
      parts: [{ type: "text", kind: "text", text: "che" }],
    } as Partial<Event> & { conv?: string },
  );
  assertEquals(decide([...pile, own], SESSION, WAKE, night), "think");
});

/* ── the scheduled wake (§10): an alarm is news the agent addressed to itself ── */

/** A fired timer, as main publishes it: harness-authored (no `agent`), the note as text. */
const alarm = (minAgo: number, base = NOON, conv = "slack:C1") =>
  ev(
    "alarm",
    {
      conv,
      ts: at(minAgo, base),
      parts: [{ type: "text", kind: "alarm", text: "send the appointment reminders" }],
    } as Partial<Event> & { conv?: string },
  );

Deno.test("alarm: a fired wake is answered NOW — no digest to wait for, no night to sleep", () => {
  // a turn closed five minutes ago, so the interval is not up: ambient news waits (§2)…
  const looked = (base = NOON) =>
    ev("message", { ...SELF, ts: at(5, base), payload: { turn_id: "T9" } } as Partial<Event>);
  assertEquals(decide([looked(), world("slack:C1", 3)], SESSION, WAKE, NOON), "ignore");
  // …but the agent set this one itself, at a time it chose: deferring it answers a question
  // nobody asked
  assertEquals(decide([looked(), alarm(3)], SESSION, WAKE, NOON), "think");
  // and 3am is exactly when a 3am alarm means to fire
  const night = Date.parse("2026-08-19T03:00:00Z"); // inside the default 23-8 span
  assertEquals(decide([looked(night), world("slack:C1", 3, "x")], SESSION, WAKE, night), "ignore");
  assertEquals(decide([looked(night), alarm(3, night)], SESSION, WAKE, night), "think");
});

Deno.test("alarm: once a turn has read past it, it stops asking — the horizon rules", () => {
  const a = alarm(5);
  // the closing message carries the horizon it consumed (§2): the alarm is behind it
  const closed = ev("message", {
    ...SELF,
    ts: at(1),
    payload: { turn_id: "T9" },
    extra: { consumed: a.id },
  } as Partial<Event>);
  assertEquals(decide([a], SESSION, WAKE, NOON), "think");
  assertEquals(decide([a, closed], SESSION, WAKE, NOON), "ignore");
});

/* ── anchored (§5): the window's floor stands still, so the prompt prefix caches ── */

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** `count` events five minutes apart from midnight — a steady trickle across two buckets. */
const trickle = (count: number): Event[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `w${String(i).padStart(3, "0")}`,
    ts: new Date(T0 + i * 5 * 60_000).toISOString(),
    type: "message",
    envelope: env(MIND),
    parts: [],
  } as Event));

Deno.test("anchored: a shorter-than-limit window is already its own floor", () => {
  const rows = trickle(3);
  assertEquals(anchored(rows, 4), rows);
});

Deno.test("anchored: the floor holds through a whole bucket of appends, then jumps once", () => {
  // limit 4, events at :00 :05 … — a plain tail would start one event later every time
  const floorOf = (n: number) => anchored(trickle(n), 4)[0].id;
  // 12 events ⇒ the tail's floor is :40, which snaps back to the 00:30 bucket
  assertEquals(floorOf(12), "w006"); // :30
  // and it STAYS there while the tail's floor walks :45 → :55 inside that same bucket
  assertEquals(floorOf(13), "w006");
  assertEquals(floorOf(14), "w006");
  assertEquals(floorOf(15), "w006");
  // …until the tail's floor reaches 1:00 — one re-anchor, one cache write, then still again
  assertEquals(floorOf(16), "w012"); // 1:00
  assertEquals(floorOf(17), "w012");
});

Deno.test("anchored: the window is the limit PLUS whatever shares the floor's bucket", () => {
  const kept = anchored(trickle(12), 4);
  assertEquals(kept.length, 6); // :30 … :55 — never fewer than the limit
  assertEquals(kept.at(-1)!.id, "w011"); // and the newest is always kept
});

/* ── specsOf: the offer is config's to shape ──────────────────────────── */

Deno.test("specsOf: `tools` names what the model sees — unset offers everything", () => {
  const bash = { spec: { name: "bash", description: "", input_schema: { type: "object" } } };
  const ports = { exec: { bash } } as unknown as XiPorts;
  const names = (tools?: string[]) => specsOf(ports, { ...CONFIG, tools }).map((t) => t.name);
  assertEquals(names(), ["send", "search", "schedule", "cancel", "bash"]);
  // the coding-agent shape: built-ins and exec filter alike, by name
  assertEquals(names(["search", "schedule", "cancel", "bash"]), [
    "search",
    "schedule",
    "cancel",
    "bash",
  ]);
  assertEquals(names([]), []); // an empty list is a model with no tools at all
});

Deno.test("anchored: a late-stamped row inside the window is kept — position sets the floor", () => {
  const rows = trickle(12);
  // appended last, stamped before the floor's bucket: an offline-synced message
  const late = { ...rows[0], id: "w999", ts: new Date(T0 - 60_000).toISOString() } as Event;
  const kept = anchored([...rows, late], 4);
  assert(kept.includes(late));
  assertEquals(kept[0].id, "w006"); // the floor still snaps to the bucket
});
