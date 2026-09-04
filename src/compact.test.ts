import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildSummary, compactionSpan, estTokens } from "./compact.ts";
import { DEFAULT_COMPACT_AT, DEFAULT_WINDOW_LIMIT } from "./config.ts";
import { applySummary } from "./render.ts";
import type {
  Event,
  MessageEvent,
  SummaryEvent,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { canned } from "./testing.ts";

let n = 0;
const SESSION = { id: "s1", agentId: "a1", conversation: "mind@a1" };

const msg = (text: string, self: boolean, conv = "mind@a1"): MessageEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "message",
  // turn_id is the voice mark (§3): a self message is turn output
  ...(self ? { agent: { id: "a1", session_id: "s1" }, payload: { turn_id: `T${n}` } } : {}),
  envelope: {
    service: "local",
    connection_address: "agent",
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
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind@a1" } },
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
  const span = compactionSpan(events, SESSION, 1, 200)!;
  assert(span !== null);
  // ~200 est. tokens keeps the recent tail (the trailing message included); the oldest
  // exchange gets covered
  assertEquals(span.covers[0], events[0].id);
  assert(span.covered.length >= 1 && span.covered.length < 4);
  assertEquals(span.covers[1], span.covered.at(-1)!.id);
  // the trailing message is never covered
  assert(!span.covered.includes(events[4]));
});

Deno.test("buildSummary: mints a summary event; the checkpoint prompt carries the transcript", async () => {
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
  const out = await buildSummary({
    events,
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, transport);
  assert(out !== null && out.type === "summary");
  assertEquals(out.payload.covers[0], events[0].id);
  assertStringIncludes(out.parts[0].text, "informe viernes");
  const prompt = (seen[0].messages[0].content as { text: string }[])[0].text;
  assertStringIncludes(prompt, "[Ana @ mind@a1] necesito el informe");
  assertStringIncludes(prompt, "[me @ mind@a1] dale, lo agendo");
  // first checkpoint — no BLOCK (the unified instruction may mention the tag)
  assert(!prompt.includes("<previous-summary>\n"));
  assertEquals(seen[0].tools?.length ?? 0, 0); // bare call, no tools
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
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, transport);
  assert(out !== null && out.type === "summary");
  const prompt = (seen[0].messages[0].content as { text: string }[])[0].text;
  assertStringIncludes(prompt, "<previous-summary>\n## Ongoing threads\n- viejo hilo");
  assertStringIncludes(prompt, "PRESERVE everything still relevant");
  assertEquals(out.payload.covers[0], old.payload.covers[0]); // chains from the previous summary's start
});

Deno.test("buildSummary: a failed model call → null (silent; the next think retries)", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary({
    events,
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, () => Promise.reject(new Error("overloaded")));
  assertEquals(out, null);
});

/* ── the threshold has to be REACHABLE (§5) ─────────────────────────────── */

/** A message shaped like the ones a live store actually holds — uuidv7 ids, a platform
 *  external_id, phone-number addresses, denormalized names, delivery status. Measured at
 *  ~177 est. tokens each against a real WhatsApp+Slack log; the stripped `msg` above is
 *  ~76, which is why the fixture matters: a threshold tuned on toy events is a threshold
 *  tuned on nothing. */
const liveMsg = (i: number, self: boolean): MessageEvent => ({
  id: `01a01b76-c8f2-7000-9842-bbf7397${String(i).padStart(5, "0")}`,
  external_id: `whatsapp:wmw.5491133585694.5492612339930.3EB0532B70E43C89${i}`,
  ts: "2026-08-19T19:19:24.000Z",
  type: "message",
  ...(self
    ? {
      agent: { id: "matias", session_id: "matias" },
      payload: { turn_id: `01a01b76-b731-7000-ab14-0d4dcc47fdeb`, stop_reason: "end_turn" },
    }
    : {}),
  envelope: {
    service: "whatsapp",
    connection_address: "5491133585694",
    conversation: { address: "5492614694650", name: "Luciano Putignano", kind: "direct" },
    ...(self ? { status: { queued: true, delivered: true } } : {
      sender: { address: "5492614694650", name: "Luciano Putignano" },
    }),
  },
  parts: [{ type: "text", kind: "text", text: `una línea de conversación cualquiera, la ${i}` }],
} as MessageEvent);

Deno.test("compactAt sits below what a full window weighs — else the checkpoint never runs", () => {
  // The count cap fills first under live traffic (§2), so a threshold above what
  // `windowLimit` events can weigh is a checkpoint that never fires: this store held zero
  // summaries from the day it was written, and compaction — the mechanism the whole memory
  // story rests on — was unreachable code. This is that regression, in a test.
  const window = Array.from(
    { length: DEFAULT_WINDOW_LIMIT },
    (_, i) => liveMsg(i, i % 3 === 0),
  );
  const weight = estTokens(window);
  assert(
    weight > DEFAULT_COMPACT_AT,
    `a full window estimates ${weight} tokens, under the ${DEFAULT_COMPACT_AT} threshold — ` +
      "raise windowLimit or lower compactAt",
  );
  // and the span is real: older closed events get covered, the recent tail stays faithful
  const span = compactionSpan(window, {
    id: "matias",
    agentId: "matias",
    conversation: "5492614694650",
  });
  assert(span !== null, "a full window must produce a checkpoint span");
  assert(span.covered.length > 0 && span.covered.length < window.length);
});

/* ── ranges, chains, open loops, cuts ───────────────────────────────────── */

const HERE = {
  service: "local" as const,
  connection_address: "agent",
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

Deno.test("span: an open tool loop is cut between steps — never inside one", () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  const span = compactionSpan(events, SESSION, 1, 400);
  assert(span !== null);
  const last = span.covered.at(-1)!;
  assertEquals(last.type, "tool_result"); // a step's end
  const kept = events.slice(events.indexOf(last) + 1);
  assert(kept.length >= 3); // something IS kept
  assertEquals(kept[0].type, "thinking"); // and it starts on a whole step
  const coveredTurns = new Set(span.covered.map((e) => e.payload?.turn_id));
  assert(kept.every((e) => !coveredTurns.has(e.payload?.turn_id))); // no step straddles the cut
  assertEquals(span.covers[1], last.id);
});

Deno.test("buildSummary: an open loop's checkpoint carries the tool traffic — that IS the content", async () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary({
    events,
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 400,
  }, (p) => {
    seen.push(p);
    return Promise.resolve(canned([{ kind: "assistant", text: "## Ongoing threads\n- informe" }]));
  });
  assert(out !== null && out.type === "summary");
  const prompt = (seen[0].messages[0].content as { text: string }[])[0].text;
  assertStringIncludes(prompt, "bash(step 1)");
  assertStringIncludes(prompt, "out 1");
});

Deno.test("buildSummary: a cut checkpoint is an error, not a record", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary(
    {
      events,
      session: SESSION,
      model: "claude-x",
      compactAt: 1,
      keepRecent: 0,
    },
    () =>
      Promise.resolve(
        canned([{ kind: "assistant", text: "## Ongoing threads\n- cut" }], "max_tokens"),
      ),
  );
  assert(out !== null);
  assertEquals(out.type, "error");
});

Deno.test("buildSummary: an empty checkpoint is an error — not a silent retry on every wake", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary({
    events,
    session: SESSION,
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, () => Promise.resolve(canned([{ kind: "assistant", text: " \n" }])));
  assert(out !== null);
  assertEquals(out.type, "error");
});

Deno.test("estTokens weighs what renders — the wire sidecar never reaches the prompt", () => {
  const e = msg("hola", false);
  const heavy = { ...e, extra: { raw: { blob: "x".repeat(40_000) } } } as MessageEvent;
  assert(estTokens([heavy]) < estTokens([e]) + 50, `${estTokens([heavy])} vs ${estTokens([e])}`);
});
