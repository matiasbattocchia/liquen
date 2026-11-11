import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSummary,
  compactionSpan,
  overflowed,
  pinnedCut,
  RUNAWAY,
  runaway,
  summaryCap,
  tries,
  turnOver,
} from "./compact.ts";
import { applySummary, type Archive, estTokens, render, SILENCE } from "./render.ts";
import type {
  Event,
  MessageEvent,
  SummaryEvent,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { CallMeta } from "./mu.ts";
import { canned, stepping } from "./testing.ts";

let n = 0;
const SESSION = { id: "s1", agentId: "a1", conversation: "mind@a1" };

// the checkpoint instruction as seeded: the template itself, read like the doc would be
const PROMPT = () =>
  Deno.readTextFile(new URL("./seed/system/compaction.md", import.meta.url))
    .then((t) => t as string | null);

/** The window as nu hands it to the checkpoint: the thinks' rendering, through the span,
 *  closing on the instruction. */
const windowOf = (events: Event[]) => (archive: Archive) =>
  render({ events, docs: [], session: SESSION, now: "2026-07-20T10:05:00Z", archive }).messages;

/** The text of a request's last block — where the instruction lands, a system block's
 *  inside it. */
const lastText = (p: Anthropic.MessageCreateParamsNonStreaming): string => {
  const content = p.messages.at(-1)!.content as {
    type: string;
    text?: string;
    content?: { text: string }[];
  }[];
  const b = content.at(-1)!;
  return b.text ?? b.content?.[0]?.text ?? "";
};

/** `[compactAt, keepRecent]` that pin the cut at the first turn end at or past `events[at]`,
 *  the window one token over the threshold. */
const pinAt = (events: Event[], at: number): [number, number] => {
  const compactAt = estTokens(events) - 1;
  const span = events.slice(0, at + 1).reduce((s, e) => s + estTokens([e]), 0) - 1;
  return [compactAt, compactAt - span];
};

const msg = (text: string, self: boolean, conv = "mind@a1"): MessageEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "message",
  // turn_id is the voice mark (§3): a self message is turn output
  ...(self ? { agent: { id: "a1", session_id: "s1" }, payload: { turn_id: `M${n}` } } : {}),
  envelope: {
    service: "local",
    connection_address: "default",
    conversation: { address: conv },
    ...(self ? {} : { sender: { address: "ana", name: "Ana" } }),
  },
  parts: [{ type: "text", kind: "text", text }],
});

const summaryEv = (covers: [string, string], text: string): SummaryEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "summary",
  agent: { id: "a1", session_id: "s1" },
  envelope: {
    service: "local",
    connection_address: "default",
    conversation: { address: "mind@a1" },
  },
  payload: { covers },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("span: under the threshold → null", () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  assertEquals(compactionSpan(events, SESSION, 1_000_000), null);
});

Deno.test("span: no closed region → null even over threshold", () => {
  const events = [msg("hola", false)]; // no closing self message
  assertEquals(compactionSpan(events, SESSION, 1, 0), null);
});

Deno.test("span: covers the older closed events, keeps the recent budget", () => {
  const events = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("dos", false),
    msg("respuesta dos", true), // boundary
    msg("tres — trailing", false),
  ];
  const span = compactionSpan(events, SESSION, ...pinAt(events, 1))!;
  assert(span !== null);
  // the oldest exchange gets covered, the rest stays recent
  assertEquals(span.covered, events.slice(0, 2));
  assertEquals(span.covers, [events[0].id, events[1].id]);
  // the trailing message is never covered, however far the span reaches
  assert(!compactionSpan(events, SESSION, 1, 0)!.covered.includes(events[4]));
});

Deno.test("buildSummary: mints a summary event; the request is the window as the think reads it, closing on the instruction", async () => {
  const events = [
    msg("necesito el informe para el viernes", false),
    msg("dale, lo agendo", true),
    msg("gracias", false),
    msg("de nada", true),
  ];
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const transport = (p: Anthropic.MessageCreateParamsNonStreaming) => {
    seen.push(p);
    return Promise.resolve(
      canned([{ kind: "assistant", text: "## Ongoing threads\n- informe viernes" }]),
    );
  };
  const [compactAt, keepRecent] = pinAt(events, 1);
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: SESSION,
    model: "claude-x",
    compactAt,
    keepRecent,
    prompt: PROMPT,
  }, stepping(transport));
  assert(out !== null && out.type === "summary");
  // the pinned cut: the first turn end past `compactAt − keepRecent`
  assertEquals(out.payload.covers, [events[0].id, events[1].id]);
  assertStringIncludes(out.parts[0].text, "informe viernes");
  // the span, laid out by render as every think drew it, the cut its one mark
  const think = render({
    events,
    docs: [],
    session: SESSION,
    now: "2026-07-20T10:05:00Z",
    cut: events[1].id,
  });
  assertEquals(
    seen[0].messages.slice(0, -1),
    think.messages.slice(0, 2).map((m, i) =>
      i === 1 ? m : {
        ...m,
        content: (m.content as Anthropic.TextBlockParam[]).map(({ cache_control: _, ...b }) => b),
      }
    ),
  );
  // the request ends where the span does: the instruction after the agent's own words is a
  // user turn of text, and nothing past the cut is in it
  const tail = lastText(seen[0]);
  assert(tail.startsWith('<system kind="checkpoint">\nThe conversation above'), tail);
  const all = JSON.stringify(seen[0].messages);
  for (const gone of ["gracias", "de nada", "now: ", "<conversation>\n"]) {
    assert(!all.includes(gone), gone);
  }
});

Deno.test("buildSummary: a span of tool work and a silent closing goes as the thinks drew it", async () => {
  const work = step(1);
  const quiet = msg(SILENCE, true);
  quiet.extra = { silence: true };
  const events: Event[] = [...work, quiet, msg("hola", false), msg("¡hola!", true)];
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const [compactAt, keepRecent] = pinAt(events, 3);
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt,
      keepRecent,
      prompt: PROMPT,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(canned([{ kind: "assistant", text: "## Open" }]));
    }),
  );
  assert(out !== null && out.type === "summary", JSON.stringify(out));
  assertEquals(out.payload.covers[1], quiet.id);
  const blocks = seen[0].messages.flatMap((m) => m.content as { type: string }[]);
  assertEquals(blocks.filter((b) => b.type === "tool_use").length, 1);
  assert(!lastText(seen[0]).includes("<conversation>\n"));
  assert(!JSON.stringify(seen[0].messages).includes("hola"));
});

Deno.test("buildSummary: folds a previous checkpoint via the merge prompt", async () => {
  const old = summaryEv(["e000", "e000"], "## Ongoing threads\n- viejo hilo");
  const events = [
    old,
    msg("novedad", false),
    msg("anotado", true),
  ];
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const transport = (p: Anthropic.MessageCreateParamsNonStreaming) => {
    seen.push(p);
    return Promise.resolve(canned([{ kind: "assistant", text: "## merged" }]));
  };
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(transport));
  assert(out !== null && out.type === "summary");
  // the previous checkpoint opens the window, as the think reads it
  const first = (seen[0].messages[0].content as { text: string }[])[0].text;
  assert(
    /^<checkpoint before="\w+">\n## Ongoing threads\n- viejo hilo\n<\/checkpoint>/.test(first),
    first,
  );
  assertStringIncludes(lastText(seen[0]), "If the conversation opens on a <checkpoint> block");
  assert(!JSON.stringify(seen[0].messages).includes("<previous-summary>\n"));
  assertEquals(out.payload.covers[0], old.payload.covers[0]); // chains from the previous summary's start
});

Deno.test("buildSummary: a call that never completes is an error, not a silent retry", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(() => Promise.reject(new Error("overloaded"))));
  assert(out !== null && out.type === "error");
  assertStringIncludes(out.parts[0].data.error as string, "checkpoint failed: overloaded");
  assert(out.agent === undefined); // harness-authored (§3)
});

/* ── ranges, chains, open loops, cuts ───────────────────────────────────── */

const HERE = {
  service: "local" as const,
  connection_address: "default",
  conversation: { address: "mind@a1" },
};
const think = (turn: string): ThinkingEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "thinking",
  agent: { id: "a1", session_id: "s1" },
  payload: { turn_id: turn },
  envelope: HERE,
  parts: [{ type: "data", kind: "thinking", data: { thinking: "hm", signature: "sig" } }],
});
const use = (turn: string, command: string): ToolUseEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "tool_use",
  agent: { id: "a1", session_id: "s1" },
  payload: { turn_id: turn },
  envelope: HERE,
  parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command } } }],
});
const result = (turn: string, ref: string, output: string): ToolResultEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "tool_result",
  agent: { id: "a1", session_id: "s1" },
  payload: { turn_id: turn, ref_id: ref },
  envelope: HERE,
  parts: [{ type: "data", kind: "tool_result", data: { output } }],
});
/** One tool step: thinking · use · result, one turn. */
const step = (k: number): Event[] => {
  const t = `T${k}`;
  const u = use(t, `step ${k}`);
  return [think(t), u, result(t, u.id, `out ${k}`)];
};

Deno.test("span: a second checkpoint chains from the first's start, and its range is ordered", () => {
  const m1 = msg("uno", false);
  const m2 = msg("respuesta uno", true);
  const m3 = msg("dos", false);
  const m4 = msg("respuesta dos", true);
  const old = summaryEv([m1.id, m2.id], "## viejo"); // minted after m4 — its id is above them
  const m5 = msg("tres", false);
  const m6 = msg("respuesta tres", true);
  const m7 = msg("cuatro — trailing", false);
  const events = [m1, m2, m3, m4, old, m5, m6, m7];
  const span = compactionSpan(events, SESSION, 1, 150);
  assert(span !== null);
  assert(span.covered.includes(old) && span.covered.includes(m3));
  assert(!span.covered.includes(m7));
  assertEquals(span.covers[0], m1.id); // chains from the previous summary's start
  assert(span.covers[0] <= span.covers[1], `${span.covers[0]} > ${span.covers[1]}`);
  // the new checkpoint stands alone: applying it leaves neither the old one nor its span
  const next = summaryEv(span.covers, "## nuevo");
  const visible = applySummary([...events, next]);
  assertEquals(visible[0], next);
  assert(!visible.includes(old));
  assert(!visible.includes(m3) && !visible.includes(m4));
  assert(visible.includes(m7));
});

const errorEv = (error: string): Event => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "error",
  envelope: HERE,
  parts: [{ type: "data", kind: "error", data: { error } }],
});

Deno.test("span: a running turn is never cut short of a runaway — not even its closed history", () => {
  // a thinking block's signature binds everything its request held before it, and a
  // summary lands at the head of the window: written now, it would sit under every block
  // the turn replays on its next request (measured: `thinking_dropped … prefix_binding_
  // mismatch` on each of them, every step to the turn's end)
  const events: Event[] = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("hacé el informe", false),
  ];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  // over compactAt, and within RUNAWAY times it
  const heavy = Math.ceil(estTokens(events) / RUNAWAY);
  assertEquals(runaway(events, SESSION, heavy), false);
  assertEquals(compactionSpan(events, SESSION, heavy, 1), null);
  assertEquals(turnOver(events, SESSION), false);
  // the moment it closes, the same window compacts — and the whole turn is closed history:
  // a span whose weight falls inside it takes it whole, through the closing
  const closed = [...events, msg("listo", true)];
  assertEquals(turnOver(closed, SESSION), true);
  const span = compactionSpan(closed, SESSION, estTokens(closed.slice(0, 5)) + 1, 1);
  assert(span !== null);
  assertEquals(span.covered.at(-1), closed.at(-1));
});

Deno.test("span: the covered span ends where a turn ends — the turn its weight falls in goes whole", () => {
  // the summarizer reads a turn cut in half as a turn in flight: what its kept tail settled
  // (a batch acked, a reply sent) it records as still open
  const events: Event[] = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("hacé el informe", false),
  ];
  for (let k = 1; k <= 24; k++) events.push(...step(k));
  const closing = msg("listo, informe enviado", true);
  events.push(closing);
  // a span short of the first closing cuts there
  const span = compactionSpan(events, SESSION, ...pinAt(events, 1));
  assert(span !== null);
  assertEquals(span.covered, events.slice(0, 2));
  assertEquals(span.covers[1], events[1].id);
  // one whose weight falls among the steps takes their turn whole
  const whole = compactionSpan(events, SESSION, ...pinAt(events, 5));
  assertEquals(whole?.covered, events);
});

Deno.test("span: when the window holds one turn, it goes whole", () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 24; k++) events.push(...step(k));
  events.push(msg("listo, informe enviado", true));
  const span = compactionSpan(events, SESSION, 1, 0);
  assert(span !== null);
  assertEquals(span.covered, events); // closed, so covered whole rather than half
  // a previous checkpoint at the head of the window is no turn of this window's: the turn
  // after it still goes whole, and the range chains from the checkpoint's start
  const old = summaryEv(["e000", "e000"], "## Open\n- informe");
  const chained = compactionSpan([old, ...events], SESSION, 1, 0);
  assert(chained !== null);
  assertEquals(chained.covered, [old, ...events]);
  assertEquals(chained.covers, ["e000", events.at(-1)!.id]);
  // and a window under the threshold leaves its one turn alone
  assertEquals(compactionSpan(events, SESSION, estTokens(events) + 1, 0), null);
});

Deno.test("pinnedCut: the cut stands still while the window grows, before any checkpoint is due", () => {
  const events = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("dos", false),
    msg("respuesta dos", true),
  ];
  const span = estTokens([events[0]]) + estTokens([events[1]]) - 1;
  // compactAt − keepRecent is the span's weight: the first closing reaches it
  const at = (es: Event[]) => pinnedCut(es, SESSION, span + 1_000, 1_000);
  assertEquals(at(events.slice(0, 1)), undefined); // no turn end yet
  assertEquals(at(events), events[1].id);
  const grown = [...events, msg("tres", false), msg("respuesta tres", true)];
  assertEquals(at(grown), events[1].id);
  // the checkpoint due on the grown window cuts there…
  const due = estTokens(grown) - 1;
  assertEquals(compactionSpan(grown, SESSION, due, due - span)?.covers[1], events[1].id);
  // …and one that waited until the window outgrew compactAt by a whole span takes the
  // next pin, leaving about keepRecent
  const late = compactionSpan(grown, SESSION, span + 1, 1);
  assert(late !== null && late.covers[1] > events[1].id);
});

Deno.test("span: a closing step's words stay together — the turn ends on its last row", () => {
  const ask = msg("uno", false);
  const first = msg("respuesta, primera parte", true);
  const second = msg("respuesta, segunda parte", true);
  second.payload = { turn_id: first.payload!.turn_id };
  const events = [ask, first, second, msg("dos", false), msg("respuesta dos", true)];
  // the span's weight falls between the two halves of the first closing
  const span = compactionSpan(events, SESSION, ...pinAt(events, events.indexOf(first)));
  assert(span !== null);
  assertEquals(span.covered, [ask, first, second]);
});

Deno.test("span: a dead turn is cut at a step's end, and leaves keepRecent like any window", () => {
  const events: Event[] = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("hacé el informe", false),
  ];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  const dead = [...events, errorEv("overloaded")];
  assertEquals(turnOver(dead, SESSION), true);
  const sixth = dead.findIndex((e) => e.type === "tool_result" && e.payload?.turn_id === "T6");
  const span = compactionSpan(dead, SESSION, ...pinAt(dead, sixth));
  assert(span !== null);
  assertEquals(span.covered, dead.slice(0, sixth + 1)); // steps 7 and 8 and the error stay
  // a live chain is never cut inside: the same window, its turn still running, waits
  assertEquals(compactionSpan(events, SESSION, ...pinAt(dead, sixth)), null);
  // a dead turn the tail holds whole (the API refused it under the estimate) goes whole
  const whole = compactionSpan(dead, SESSION, 1_000_000, 1_000_000 - 1);
  assertEquals(whole, null); // under the threshold, nothing refused: nothing to do
  const refused = [...events, errorEv("prompt is too long: 213462 tokens > 200000 maximum")];
  assertEquals(compactionSpan(refused, SESSION, 2_000_000, 1_000_000)!.covered, refused);
  // a step still waiting for its result holds the turn open past the error, and stays out
  const waiting = [...events, use("T9", "step 9"), errorEv("overloaded")];
  const partial = compactionSpan(waiting, SESSION, 1, 0);
  assert(partial !== null);
  assert(!partial.covered.some((e) => e.payload?.turn_id === "T9"));
});

Deno.test("span: a turn that ran away is cut at a step's end, leaves keepRecent, and never folds what it has not read", () => {
  const events: Event[] = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("hacé el informe", false),
  ];
  for (let k = 1; k <= 20; k++) events.push(...step(k));
  const light = Math.floor(estTokens(events) / RUNAWAY) - 1; // RUNAWAY times over it
  const keepRecent = estTokens(events.slice(-3)); // the last step
  assert(keepRecent < light);
  assertEquals(runaway(events, SESSION, light), true);
  const span = compactionSpan(events, SESSION, light, keepRecent);
  assert(span !== null);
  assertEquals(span.running, true);
  const last = span.covered.at(-1)!;
  assertEquals(last.type, "tool_result"); // a step's end
  assert(events.slice(events.indexOf(last) + 1).some((e) => e.type === "tool_use")); // kept
  // a line that landed while the last step ran is input the turn has not read: it stays out
  const ninth = use("T9", "step 9");
  const landed = msg("¿y el informe?", false);
  const late = [...events, think("T9"), ninth, landed, result("T9", ninth.id, "out 9")];
  const unread = compactionSpan(late, SESSION, light, 0);
  assert(unread !== null);
  assert(!unread.covered.includes(landed));
  // a call still waiting for its result: the step is not whole, nothing is cut
  const waiting = [...events, think("T9"), use("T9", "step 9")];
  assertEquals(runaway(waiting, SESSION, light), false);
  assertEquals(compactionSpan(waiting, SESSION, light, keepRecent), null);
});

Deno.test("render: behind a checkpoint written inside the turn, its steps are narration and the steps after it keep their thinking", () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  const floor = summaryEv([events[0].id, events[3].id], "## Open\n- informe"); // step 1
  floor.payload = { ...floor.payload, running: true };
  const after = step(4); // written after the record, against its prefix
  const draw = (record: SummaryEvent) =>
    JSON.stringify(
      render({
        events: [record, ...events.slice(4), ...after],
        docs: [],
        session: SESSION,
        now: "2026-07-20T10:05:00Z",
      }).messages,
    );
  const drawn = draw(floor);
  assertStringIncludes(drawn, '<system kind=\\"tool_result\\">bash(step 2) → out 2</system>');
  assert(!drawn.includes('"command":"step 2"'), drawn); // step 2 is no call
  assertStringIncludes(drawn, '"tool_use"'); // step 4 is
  assertStringIncludes(drawn, '"thinking"');
  // a record written between turns leaves a live turn's calls as calls
  const between = { ...floor, payload: { covers: floor.payload.covers } } as SummaryEvent;
  assertStringIncludes(draw(between), '"name":"bash","input":{"command":"step 2"}');
});

Deno.test("render: behind the checkpoint, a dead turn's steps are told as narration — no open call goes out without its thinking", () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  const died = errorEv("overloaded");
  const advisory = errorEv("your previous turn hit the output token limit");
  advisory.payload = { stop_reason: "max_tokens" };
  const closing = msg("listo", true);
  const floor = summaryEv([events[0].id, events[3].id], "## Open\n- informe"); // step 1
  const asked = msg("¿y?", false);
  const draw = (rows: Event[]) =>
    JSON.stringify(
      render({
        events: [floor, ...rows, asked],
        docs: [],
        session: SESSION,
        now: "2026-07-20T10:05:00Z",
      })
        .messages,
    );
  const dead = draw([...events.slice(4), died]);
  assert(!dead.includes('"tool_use"') && !dead.includes('"thinking"'), dead);
  assertStringIncludes(dead, '<system kind=\\"tool_result\\">bash(step 2) → out 2</system>');
  assertStringIncludes(dead, '<system kind=\\"error\\">overloaded</system>');
  // a turn that closed, or goes on past a cut at the ceiling, keeps its calls as calls
  assertStringIncludes(draw([...events.slice(4), closing]), '"tool_use"');
  assertStringIncludes(
    draw([...events.slice(4, 7), advisory, ...events.slice(7), closing]),
    '"tool_use"',
  );
});

Deno.test("span: the API's ceiling is the one hard one — a refused request compacts under the threshold", () => {
  const events: Event[] = [msg("uno", false), msg("respuesta uno", true), msg("dos", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  const refused = [...events, errorEv("prompt is too long: 213462 tokens > 200000 maximum")];
  assert(overflowed(refused));
  // Gemini's wording, as a refused think and as the checkpoint it then could not write
  const gemini = "400 The input token count exceeds the maximum number of tokens allowed 1048576.";
  assert(overflowed([...events, errorEv(gemini)]));
  assert(overflowed([...events, errorEv(`checkpoint failed: ${gemini}`)]));
  const counted = "400 The input token count (35868) exceeds the maximum number of tokens " +
    "allowed (32768).";
  assert(overflowed([...events, errorEv(counted)])); // the count there or not
  assert(!overflowed([...events, errorEv("overloaded")]));
  assertEquals(compactionSpan([...events, errorEv("overloaded")], SESSION, 1_000_000, 0), null);
  const span = compactionSpan(refused, SESSION, 1_000_000, 0);
  assert(span !== null);
  assertEquals(span.covered, refused);
});

const REFUSED = "prompt is too long: 213462 tokens > 200000 maximum";

/** A checkpoint that failed a try: its call answered without a record. */
const triedEv = (error: string): Event => {
  const e = errorEv(`checkpoint failed: ${error}`);
  (e.parts[0] as { data: object }).data = { error: `checkpoint failed: ${error}`, attempt: true };
  return e;
};

/** A checkpoint over a dead turn, its requests kept; `answer` stands in for the API. */
const ladder = async (
  events: Event[],
  answer: () => Promise<Anthropic.Message> = () =>
    Promise.resolve(canned([{ kind: "assistant", text: "## Open\n- informe" }])),
  tools?: Anthropic.Tool[],
) => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const metas: (CallMeta | undefined)[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      effort: "high",
      compactAt: 1,
      keepRecent: 400,
      prompt: PROMPT,
      ...(tools ? { tools } : {}),
    },
    stepping((p, _emit, meta) => {
      seen.push(p);
      metas.push(meta);
      return answer();
    }),
  );
  return { out, seen, metas };
};

Deno.test("tries: the checkpoints since the floor that answered without a record", () => {
  const before = triedEv(REFUSED);
  const floor = summaryEv([before.id, before.id], "## viejo");
  const events = [
    before, // an uncovered row the floor's read still holds: the climb before it is done
    floor,
    msg("hola", false),
    errorEv(REFUSED), // a think's refusal is no try: the checkpoint sends less than it did
    errorEv("checkpoint failed: overloaded"), // weather, retried in nu and never billed
    triedEv("cut off at the output ceiling"),
  ];
  assertEquals(tries(events), 1);
  assertEquals(tries(events.slice(0, 5)), 0);
});

Deno.test("buildSummary: the first try is the window, and a refusal for size is a try", async () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  events.push(errorEv(REFUSED));
  const { out, seen } = await ladder(events, () => Promise.reject(new Error(`400 ${REFUSED}`)));
  const sent = JSON.stringify(seen[0].messages);
  assertStringIncludes(sent, '"thinking"');
  assertStringIncludes(sent, '"tool_use"');
  assertEquals(seen[0].output_config, { effort: "high" }); // the think's, so its cache holds
  assert(out !== null && out.type === "error");
  assertEquals(out.parts[0].data.attempt, true);
  // weather is no try
  const { out: down } = await ladder(events, () => Promise.reject(new Error("fetch failed")));
  assert(down !== null && down.type === "error");
  assertEquals(down.parts[0].data.attempt, undefined);
});

Deno.test("buildSummary: a cut or empty record is a try", async () => {
  const events: Event[] = [msg("hacé el informe", false), ...step(1), errorEv("overloaded")];
  const cut = await ladder(events, () =>
    Promise.resolve({
      ...canned([{ kind: "assistant", text: "## Open\n- inf" }]),
      stop_reason: "max_tokens",
    }));
  assert(cut.out !== null && cut.out.type === "error");
  assertEquals(cut.out.parts[0].data.attempt, true);
  const empty = await ladder(events, () => Promise.resolve(canned([])));
  assert(empty.out !== null && empty.out.type === "error");
  assertEquals(empty.out.parts[0].data.attempt, true);
  // the output ran into the context window: the record is cut all the same
  const full = await ladder(events, () =>
    Promise.resolve({
      ...canned([{ kind: "assistant", text: "## Open\n- inf" }]),
      stop_reason: "model_context_window_exceeded",
    } as unknown as Anthropic.Message));
  assert(full.out !== null && full.out.type === "error");
  assertEquals(full.out.parts[0].data.attempt, true);
});

Deno.test("buildSummary: the first try abstains, a call in place of the record is a try, and the lean try forbids the call", async () => {
  const tools: Anthropic.Tool[] = [{ name: "bash", input_schema: { type: "object" } }];
  const events: Event[] = [msg("hacé el informe", false), ...step(1), errorEv("overloaded")];
  const first = await ladder(
    events,
    () =>
      Promise.resolve(canned([
        { kind: "assistant", text: "Let me check first." },
        { kind: "tool_use", name: "bash", input: { command: "ls" } },
      ], "tool_use")),
    tools,
  );
  // the think's tools, no call wanted: Anthropic's `none`, which keeps them in the prompt,
  // and the wire whose `none` drops them reads `abstain`
  assertEquals(first.seen[0].tools, tools);
  assertEquals(first.seen[0].tool_choice, { type: "none" });
  assertEquals(first.metas[0]?.abstain, true);
  assert(first.out !== null && first.out.type === "error");
  assertEquals(first.out.parts[0].data.attempt, true);
  const lean = await ladder([...events, triedEv("the model called a tool")], undefined, tools);
  assertEquals(lean.seen[0].tools, tools);
  assertEquals(lean.seen[0].tool_choice, { type: "none" });
  assertEquals(lean.metas[0]?.abstain, undefined);
  assert(lean.out !== null && lean.out.type === "summary");
});

Deno.test("buildSummary: a turn cut while it runs is offered the tools with none callable — mid-loop, a call is the likelier answer", async () => {
  const tools: Anthropic.Tool[] = [{ name: "bash", input_schema: { type: "object" } }];
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 20; k++) events.push(...step(k));
  const compactAt = Math.floor(estTokens(events) / RUNAWAY) - 1;
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt,
      keepRecent: estTokens(events.slice(-3)),
      prompt: PROMPT,
      tools,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(canned([{ kind: "assistant", text: "## Open\n- informe" }]));
    }),
  );
  assert(out !== null && out.type === "summary");
  assertEquals(out.payload.running, true);
  assertEquals(seen[0].tool_choice, { type: "none" });
});

Deno.test("summaryCap: half the span a record replaces, never past the agent's own cap", () => {
  assertEquals(summaryCap(50_000, 20_000, 64_000), 15_000);
  assertEquals(summaryCap(150_000, 20_000, 64_000), 64_000);
  assertEquals(summaryCap(), 15_000);
});

Deno.test("buildSummary: after a failed try the window goes lean at low effort — no thinking, each call and its outcome one clipped line, the rest as the window draws it", async () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  const long = use("T4", "x".repeat(2_000));
  events.push(think("T4"), long, result("T4", long.id, "y".repeat(2_000)));
  events.push(errorEv(REFUSED), triedEv(REFUSED));
  const { out, seen } = await ladder(events);
  assert(out !== null && out.type === "summary");
  assertEquals(seen[0].output_config, { effort: "low" });
  const sent = JSON.stringify(seen[0].messages);
  assert(!sent.includes('"thinking"'), "no thinking block");
  assert(!sent.includes('"tool_use"') && !sent.includes('"tool_result"'), "no tool blocks");
  assertStringIncludes(sent, "hacé el informe"); // what it was asked
  assertStringIncludes(sent, '<system kind=\\"tool_result\\">bash(step 1) → out 1</system>');
  assertStringIncludes(sent, `${"x".repeat(100)}`);
  assert(!sent.includes("x".repeat(500)) && !sent.includes("y".repeat(500)), "both sides clipped");
  assertStringIncludes(sent, "prompt is too long"); // and how it ended
  assertStringIncludes(lastText(seen[0]), "Write a checkpoint");
});

Deno.test("buildSummary: two failed tries, the checkpoint is written with no call — the previous record, and where the rest starts for search", async () => {
  const old = msg("viejo", false);
  const floor = summaryEv([old.id, old.id], "## Open\n- lo de ayer");
  const asked = msg("hacé el informe", false);
  asked.ts = "2026-07-20T10:01:00Z";
  const events: Event[] = [floor, asked];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  events.push(errorEv(REFUSED), triedEv(REFUSED), triedEv("cut off at the output ceiling"));
  const { out, seen } = await ladder(events);
  assertEquals(seen.length, 0); // nothing left to fail
  assert(out !== null && out.type === "summary");
  assertEquals(out.payload.covers, [old.id, events.at(-1)!.id]); // the floor moves past it all
  const text = out.parts[0].text;
  assert(text.startsWith("## Open\n- lo de ayer\n\n"), text);
  assertStringIncludes(text, "1 message in 1 conversation and 3 calls of yours");
  assertStringIncludes(text, "after 2026-07-20T10:00:59.999Z");
  assertStringIncludes(text, "calls: true");
  assert(!text.includes("before"), "the tag's `before` closes the stretch");
});

Deno.test("buildSummary: a dead turn's chain reaches the checkpoint whole — trailing, so render lays it out", async () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  events.push(errorEv("overloaded"));
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: 1,
      keepRecent: 400,
      prompt: PROMPT,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(canned([{ kind: "assistant", text: "## Open\n- informe" }]));
    }),
  );
  assert(out !== null && out.type === "summary");
  const blocks = seen[0].messages.flatMap((m) => m.content as { type: string }[]);
  assertEquals(blocks.filter((b) => b.type === "tool_use").length, 3);
  assertEquals(blocks.filter((b) => b.type === "tool_result").length, 3);
  assertStringIncludes(JSON.stringify(blocks), "overloaded"); // the row that killed it
  // the span ends on a user turn, so the instruction is a system block in it
  const last = seen[0].messages.at(-1)!.content as { type: string }[];
  assertEquals(last.at(-1)!.type, "mid_conv_system");
  assert(lastText(seen[0]).startsWith("The conversation above is being archived"));
});

Deno.test("buildSummary: a cut checkpoint is an error, not a record", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: 1,
      keepRecent: 0,
      prompt: PROMPT,
    },
    stepping(() =>
      Promise.resolve(
        canned([{ kind: "assistant", text: "## Ongoing threads\n- cut" }], "max_tokens"),
      )
    ),
  );
  assert(out !== null);
  assertEquals(out.type, "error");
});

Deno.test("buildSummary: an empty checkpoint is an error — not a silent retry on every wake", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(() => Promise.resolve(canned([{ kind: "assistant", text: " \n" }]))));
  assert(out !== null);
  assertEquals(out.type, "error");
});

Deno.test("buildSummary: a missing instruction doc is an error — the checkpoint has no other source", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  let calls = 0;
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: 1,
      keepRecent: 0,
      prompt: () => Promise.resolve(null),
    },
    stepping(() => {
      calls++;
      return Promise.resolve(canned([{ kind: "assistant", text: "## Conversations" }]));
    }),
  );
  assertEquals(calls, 0); // nothing to send: no call is made
  assert(out !== null && out.type === "error");
  assertStringIncludes(JSON.stringify(out.parts[0].data), "compaction.md is missing");
});

Deno.test("estTokens weighs what renders — the wire sidecar never reaches the prompt", () => {
  const e = msg("hola", false);
  const heavy = { ...e, extra: { raw: { blob: "x".repeat(40_000) } } } as MessageEvent;
  assert(estTokens([heavy]) < estTokens([e]) + 50, `${estTokens([heavy])} vs ${estTokens([e])}`);
});

Deno.test("span: a message the closing never consumed is never checkpointed away", () => {
  const m1 = msg("uno", false);
  const m2 = msg("respuesta uno", true);
  const m3 = msg("dos", false);
  const late = msg("tres — landed mid-turn", false); // before the closing, after its horizon
  const closing = msg("respuesta dos", true);
  closing.extra = { consumed: m3.id };
  const m6 = msg("cuatro — trailing", false);
  const events = [m1, m2, m3, late, closing, m6];
  const span = compactionSpan(events, SESSION, 1, 1);
  assert(span !== null);
  assert(!span.covered.includes(late));
  // the range the checkpoint stands for must not swallow it either: applying the
  // checkpoint leaves the unanswered input in the window
  const visible = applySummary([...events, summaryEv(span.covers, "## nuevo")]);
  assert(visible.includes(late), "unconsumed input hidden behind the checkpoint");
});
