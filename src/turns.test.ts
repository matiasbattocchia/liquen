import { assertEquals, assertStringIncludes } from "@std/assert";
import { openedBy, price, readTurns, turnLine, turnsOf } from "./turns.ts";
import { openLog } from "./store/log.ts";
import type { Draft, Event } from "./types.ts";

const REF = { agentId: "ana", id: "mind" };
const HOME = "mind@ana";
let clock = Date.parse("2026-10-13T15:00:00Z");
let seq = 0;
const nextId = () => `01a1-${String(++seq).padStart(4, "0")}`;
const at = (s = 1) => new Date(clock += s * 1000).toISOString();
const here = (address = HOME) => ({
  service: "local",
  connection_address: "default",
  conversation: { address },
});

/** The principal's line through the door: the agent's mind, no turn_id. */
const said = (text: string, who = "matias"): Event => ({
  id: nextId(),
  ts: at(),
  type: "message",
  agent: { id: "ana", session_id: "mind" },
  envelope: { ...here(), sender: { address: who, name: who } },
  parts: [{ type: "text", kind: "text", text }],
} as Event);

const self = { id: "ana", session_id: "mind" };

/** One think step: its thinking (carrying the horizon it read), its calls or its closing. */
function step(
  turn: string,
  consumed: string,
  out: { calls?: string[]; text?: string; stop?: string },
): Event[] {
  const ts = at(2);
  const rows: Event[] = [{
    id: nextId(),
    ts,
    type: "thinking",
    agent: self,
    envelope: here(),
    payload: { turn_id: turn },
    parts: [{ type: "data", kind: "thinking", data: { thinking: "hm", signature: "s" } }],
    extra: { consumed },
  } as Event];
  for (const command of out.calls ?? []) {
    rows.push({
      id: nextId(),
      ts,
      type: "tool_use",
      agent: self,
      envelope: here(),
      payload: { turn_id: turn },
      parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command } } }],
    } as Event);
  }
  if (out.text !== undefined) {
    rows.push({
      id: nextId(),
      ts,
      type: "message",
      agent: self,
      envelope: here(),
      payload: { turn_id: turn },
      parts: [{ type: "text", kind: "text", text: out.text }],
    } as Event);
  }
  rows.at(-1)!.payload = { ...rows.at(-1)!.payload, stop_reason: out.stop ?? "end_turn" };
  return rows;
}

const result = (use: Event, flags: Record<string, boolean> = {}): Event => ({
  id: nextId(),
  ts: at(),
  type: "tool_result",
  agent: self,
  envelope: here(),
  payload: { turn_id: use.payload!.turn_id, ref_id: use.id },
  parts: [{ type: "data", kind: "tool_result", data: { output: "x", ...flags } }],
} as Event);

const harnessError = (error: string): Event => ({
  id: nextId(),
  ts: at(),
  type: "error",
  envelope: here(),
  parts: [{ type: "data", kind: "error", data: { error } }],
} as Event);

Deno.test("turnsOf: the steps from the look to the closing, opened by the news the first step read", () => {
  const hi = said("revisá el batch");
  const s1 = step("t1", hi.id, { calls: ["sonar batch", "ls"], stop: "tool_use" });
  const r1 = result(s1[1], { is_error: true });
  const r2 = result(s1[2]);
  const s2 = step("t2", r2.id, { text: "listo" });
  const sum: Event = {
    id: nextId(),
    ts: at(),
    type: "summary",
    agent: self,
    envelope: here(),
    payload: { turn_id: "t3", covers: [hi.id, r2.id] },
    parts: [{ type: "text", kind: "text", text: "## Open" }],
  } as Event;
  const [t] = turnsOf([hi, ...s1, r1, r2, ...s2, sum], REF);
  assertEquals(t.id, "t1");
  assertEquals(t.opener.kind, "message");
  assertEquals(openedBy(t.opener), 'message from matias "revisá el batch"');
  assertEquals(t.steps, ["t1", "t2"]);
  assertEquals([t.calls, t.tool_errors, t.end], [2, 1, "end_turn"]);
  assertEquals(t.started, hi.ts);
  assertEquals(t.ended, s2.at(-1)!.ts);
  assertEquals(t.span, { from: hi.id, to: s2.at(-1)!.id });
  assertEquals(t.checkpoint?.id, sum.id);
  // spend joins on the steps' keys; the checkpoint is its own call
  price([t], [
    { created_at: "", turn_id: "t1", model: "m", input_tokens: 100, output_tokens: 5 },
    {
      created_at: "",
      turn_id: "t2",
      model: "m",
      input_tokens: 20,
      output_tokens: 7,
      cache_read_tokens: 900,
    },
    {
      created_at: "",
      turn_id: "t3",
      kind: "checkpoint",
      model: "m",
      input_tokens: 1,
      output_tokens: 1,
    },
  ]);
  assertEquals(t.tokens, { input: 120, output: 12, cache_read: 900, cache_write: 0 });
  assertEquals(t.checkpoint?.tokens.input, 1);
  assertStringIncludes(turnLine(t), "2 steps · 2 calls · 1 tool error · tokens 120 in / 12 out");
  assertStringIncludes(turnLine(t), "end_turn · ");
});

Deno.test("turnsOf: a wake opens by its handle; a cut ends the turn; a failed first think is a turn", () => {
  const wake: Event = {
    id: nextId(),
    ts: at(),
    type: "alarm",
    envelope: here(),
    extra: { timer: { id: "w", session_id: "mind", name: "poll" } },
    parts: [{ type: "text", kind: "alarm", text: "Time to poll" }],
  } as Event;
  const s1 = step("w1", wake.id, { calls: ["sleep 100"], stop: "tool_use" });
  const cut: Event = {
    id: nextId(),
    ts: at(),
    type: "control",
    agent: self,
    envelope: { ...here(), sender: { address: "matias" } },
    payload: { control: "cancel" },
    parts: [{ type: "text", kind: "text", text: "/cancel" }],
  } as Event;
  const cancelled = result(s1[1], { is_error: true, cancelled: true });
  const again = said("y ahora?");
  const failed = harnessError("the model refused the key");
  const turns = turnsOf([wake, ...s1, cut, cancelled, again, failed], REF);
  assertEquals(turns.length, 2);
  assertEquals(openedBy(turns[0].opener), "wake poll");
  assertEquals(turns[0].end, "cancel");
  assertEquals(turns[0].tool_errors, 0); // the cut is no tool's failure
  assertEquals(turns[0].span.to, cancelled.id); // its cancelled results still belong to it
  assertEquals([turns[1].id, turns[1].end, turns[1].error], [
    failed.id,
    "error",
    "the model refused the key",
  ]);
  assertEquals(turns[1].steps, []);
});

Deno.test("turnsOf: news no step of the open turn read opens the next; news a step read does not", () => {
  const ask = said("top 5 deals?");
  const s1 = step("c1", ask.id, { calls: ["sonar api GET /engagements"], stop: "tool_use" });
  const nudge = said("solo los abiertos");
  const r1 = result(s1[1]);
  // the second step read past the nudge (steering); the closing's call was in flight when
  // the wake fired, so its horizon stops short of it
  const s2 = step("c2", r1.id, { calls: ["sonar api GET /pipelines"], stop: "tool_use" });
  const r2 = result(s2[1]);
  const wake: Event = {
    id: nextId(),
    ts: at(),
    type: "alarm",
    envelope: here(),
    extra: { timer: { id: "w", session_id: "mind", name: "poll" } },
    parts: [{ type: "text", kind: "alarm", text: "Time to poll" }],
  } as Event;
  const reply = step("c3", r2.id, { text: "here are the top 5" });
  // the next turn's horizon is the agent's own reply: the wake sits before it, unread till now
  const next = step("w1", reply.at(-1)!.id, { calls: ["sonar batch"], stop: "tool_use" });
  const turns = turnsOf([ask, ...s1, nudge, r1, ...s2, r2, wake, ...reply, ...next], REF);
  assertEquals(turns.length, 2);
  assertEquals(openedBy(turns[0].opener), 'message from matias "top 5 deals?"');
  assertEquals(openedBy(turns[1].opener), "wake poll");
  assertEquals(turns[1].started, wake.ts);
});

Deno.test("turnsOf: a principal's line the mirror copied in from a surface opens a turn, named by it", () => {
  const copy: Event = {
    ...said("abrí la ficha", "Matías"),
    extra: { via: { event: "wa-1", service: "whatsapp", conversation: "5491100000000" } },
  } as Event;
  const turns = turnsOf([copy, ...step("m1", copy.id, { text: "listo" })], REF);
  assertEquals(openedBy(turns[0].opener), 'message from Matías via whatsapp "abrí la ficha"');
});

Deno.test("turnsOf: an error mid-act is not the end when a step follows; a trailing one is", () => {
  const hi = said("hacé");
  const s1 = step("e1", hi.id, { calls: ["x"], stop: "tool_use" });
  const mid = harnessError("cannot pin a conversation rule");
  const r = result(s1[1]);
  const s2 = step("e2", r.id, { calls: ["y"], stop: "tool_use" });
  const r2 = result(s2[1]);
  const dead = harnessError("overloaded");
  const turns = turnsOf([hi, ...s1, mid, r, ...s2, r2, dead], REF);
  assertEquals(turns.length, 1);
  assertEquals([turns[0].end, turns[0].error, turns[0].steps.length], ["error", "overloaded", 2]);
  // and with no end at all, the turn is still open
  const open = turnsOf([hi, ...s1], REF);
  assertEquals(open[0].end, "open");
});

Deno.test("readTurns: off the store — priced from usage, an opener outside the room looked up by id", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    // a peer's line in another room is what the first step read last
    const peer = await log.publish({
      ts: at(),
      type: "message",
      agent: { id: "bo", session_id: "mind" },
      envelope: { ...here("mind@ana,mind@bo"), sender: { address: "mind@bo", name: "Sam" } },
      parts: [{ type: "text", kind: "text", text: "any news?" }],
    } as Draft);
    const rows = [...step("p1", peer!.id, { text: "none yet" })];
    for (const e of rows) {
      const { id: _, ...draft } = e;
      await log.publish(draft as Draft);
    }
    const stored = await log.read({ types: ["thinking"] });
    assertEquals(stored.length, 1);
    await log.meter({
      created_at: at(),
      agent_id: "ana",
      turn_id: "p1",
      kind: "think",
      model: "m",
      input_tokens: 42,
      output_tokens: 3,
    });
    const [t] = await readTurns(log, REF);
    assertEquals(openedBy(t.opener), 'message from Sam "any news?"');
    assertEquals(t.tokens.input, 42);
    assertEquals(t.started, peer!.ts);
    assertEquals((await readTurns(log, REF, 0)).length, 0);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
