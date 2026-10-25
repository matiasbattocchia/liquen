import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSummary,
  compactionSpan,
  estTokens,
  floodAt,
  flooded,
  overflowed,
  skipped,
  turnOver,
} from "./compact.ts";
import { DEFAULT_COMPACT_AT } from "./config.ts";
import { applySummary, render, SILENCE } from "./render.ts";
import type {
  Event,
  MessageEvent,
  SummaryEvent,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { canned, stepping } from "./testing.ts";

let n = 0;
const SESSION = { id: "s1", agentId: "a1", conversation: "mind@a1" };

// the checkpoint instruction as seeded: the template itself, read like the doc would be
const PROMPT = () =>
  Deno.readTextFile(new URL("./seed/system/instructions/compaction.md", import.meta.url))
    .then((t) => t as string | null);

/** The window as nu hands it to the checkpoint: the next think's rendering, closing on
 *  the instruction. */
const windowOf = (events: Event[]) => (tail: string) =>
  render({ events, docs: [], session: SESSION, now: "2026-07-20T10:05:00Z", tail }).messages;

/** The text of a request's last block — where the instruction lands. */
const lastText = (p: Anthropic.MessageCreateParamsNonStreaming): string => {
  const content = p.messages.at(-1)!.content as { type: string; text?: string }[];
  return content.at(-1)!.text ?? "";
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

/** A budget the window is just over, and far from a flood: the threshold a test sets to make
 *  a checkpoint due. */
const over = (events: Event[]): number => estTokens(applySummary(events)) - 1;

Deno.test("span: under the threshold → null", () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  assertEquals(compactionSpan(events, SESSION, 1_000_000), null);
});

Deno.test("span: no closed region → null even over threshold", () => {
  const events = [msg("hola", false)]; // no closing self message
  assertEquals(compactionSpan(events, SESSION, over(events), 0), null);
});

Deno.test("span: covers the older closed events, keeps the recent budget", () => {
  const events = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("dos", false),
    msg("respuesta dos", true), // boundary
    msg("tres — trailing", false),
  ];
  const span = compactionSpan(events, SESSION, over(events), 200)!;
  assert(span !== null);
  // ~200 est. tokens keeps the recent tail (the trailing message included); the oldest
  // exchange gets covered
  assertEquals(span.covers[0], events[0].id);
  assert(span.covered.length >= 1 && span.covered.length < 4);
  assertEquals(span.covers[1], span.covered.at(-1)!.id);
  // the trailing message is never covered
  assert(!span.covered.includes(events[4]));
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
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: SESSION,
    model: "claude-x",
    compactAt: over(events),
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(transport));
  assert(out !== null && out.type === "summary");
  assertEquals(out.payload.covers[0], events[0].id);
  assertStringIncludes(out.parts[0].text, "informe viernes");
  // the window, laid out by render: the same blocks the next think would carry
  const think = render({ events, docs: [], session: SESSION, now: "2026-07-20T10:05:00Z" });
  assertEquals(seen[0].messages.slice(0, -1), think.messages.slice(0, -1));
  assertStringIncludes(JSON.stringify(seen[0].messages), "necesito el informe");
  assertStringIncludes(JSON.stringify(seen[0].messages), "dale, lo agendo");
  // the instruction closes the request where the anchor goes, naming where the archive ends
  const tail = lastText(seen[0]);
  assert(tail.startsWith("<archived-through>me: de nada</archived-through>\n\n"), tail);
  assertStringIncludes(tail, "The conversation above is being archived");
  assert(!JSON.stringify(seen[0].messages).includes("now: "));
  assert(!tail.includes("<conversation>\n"));
});

Deno.test("buildSummary: the archive ends where the kept tail begins — the quote is the last archived line", async () => {
  const events = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("dos", false),
    msg("respuesta dos", true),
    msg("tres", false),
  ];
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: over(events),
      keepRecent: 200, // keeps the last exchange and the trailing message
      prompt: PROMPT,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(canned([{ kind: "assistant", text: "## Open" }]));
    }),
  );
  assert(out !== null && out.type === "summary");
  const cut = events.find((e) => e.id === out.payload.covers[1])!;
  assert(cut !== events.at(-1)); // something was kept
  const who = cut.agent ? "me" : "Ana";
  assertStringIncludes(
    lastText(seen[0]),
    `<archived-through>${who}: ${cut.parts[0].text}</archived-through>`,
  );
  // and the kept tail is in the request, in view, after the line quoted
  assertStringIncludes(JSON.stringify(seen[0].messages), "tres");
});

Deno.test("buildSummary: a span that draws no block goes as a transcript — there is nothing to quote", async () => {
  // a turn that worked its tools and closed in silence: its closing draws no body
  const work = step(1);
  const quiet = msg(SILENCE, true);
  quiet.extra = { silence: true };
  const events: Event[] = [...work, quiet, msg("hola", false), msg("¡hola!", true)];
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: over(events),
      keepRecent: estTokens(events.slice(-2)) + 1, // keeps the last exchange, nothing more
      prompt: PROMPT,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(canned([{ kind: "assistant", text: "## Open" }]));
    }),
  );
  assert(out !== null && out.type === "summary", JSON.stringify(out));
  assertEquals(out.payload.covers[1], quiet.id);
  const prompt = lastText(seen[0]);
  assertStringIncludes(prompt, "<conversation>\n[me → bash(step 1)]");
  assert(!prompt.startsWith("<archived-through>"));
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
    compactAt: over(events),
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(transport));
  assert(out !== null && out.type === "summary");
  // the previous checkpoint opens the window, as the think reads it
  const first = (seen[0].messages[0].content as { text: string }[])[0].text;
  assert(first.startsWith("<checkpoint>\n## Ongoing threads\n- viejo hilo\n</checkpoint>"), first);
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
    compactAt: over(events),
    keepRecent: 0,
    prompt: PROMPT,
  }, stepping(() => Promise.reject(new Error("overloaded"))));
  assert(out !== null && out.type === "error");
  assertStringIncludes(out.parts[0].data.error as string, "checkpoint failed: overloaded");
  assert(out.agent === undefined); // harness-authored (§3)
});

/* ── the budget and the flood, at live weights (§5) ─────────────────────── */

/** A message shaped like the ones a live store actually holds — uuidv7 ids, a platform
 *  external_id, phone-number addresses, denormalized names, delivery status. Measured at
 *  ~125 est. tokens each against a real WhatsApp+Slack log; the stripped `msg` above is
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

const LIVE = { id: "matias", agentId: "matias", conversation: "5492614694650" };

Deno.test("span: a window past compactAt and short of a flood is a record — cut where a turn ends", () => {
  const window = Array.from({ length: 600 }, (_, i) => liveMsg(i, i % 3 === 0));
  const weight = estTokens(window);
  assert(weight > DEFAULT_COMPACT_AT && weight <= floodAt(), `${weight}`);
  assert(!flooded(window));
  const span = compactionSpan(window, LIVE);
  assert(span !== null && !span.flood);
  assert(span.covered.length > 0 && span.covered.length < window.length);
  assert(span.covered.at(-1)!.agent !== undefined); // the turn's own closing
});

Deno.test("span: past floodAt the window is a flood — the cut falls past unanswered lines, and the tail is what stays", () => {
  const floor = summaryEv(["0", "0"], "## Open\n- the report");
  const closing = [liveMsg(0, false), liveMsg(1, true)];
  const flood = Array.from({ length: 1200 }, (_, i) => liveMsg(i + 2, false)); // none answered
  const events: Event[] = [floor, ...closing, ...flood];
  assert(flooded(events));
  const span = compactionSpan(events, LIVE);
  assert(span !== null && span.flood);
  assert(span.covered.some((e) => flood.includes(e as MessageEvent))); // input, skipped
  const tail = events.slice(span.covered.length);
  assert(tail.length > 0 && tail.every((e) => flood.includes(e as MessageEvent)));
  // the tail is keepRecent's: everything that fits, and not one row more — weighed row by
  // row, as the walk weighs it
  const weigh = (es: Event[]) => es.reduce((sum, e) => sum + estTokens([e]), 0);
  assert(weigh(tail) <= 20_000);
  assert(weigh([span.covered.at(-1)!, ...tail]) > 20_000);
  assertEquals(span.covers, ["0", span.covered.at(-1)!.id]); // chained from the floor
});

Deno.test("span: a flood never splits the rows a dead turn wrote — its thinking replays", () => {
  const closing = [msg("uno", false), msg("respuesta uno", true)];
  const flood = Array.from({ length: 30 }, (_, i) => msg(`línea ${i}`, false));
  const turn = [...step(1), ...step(2), errorEv("overloaded")];
  const events: Event[] = [...closing, ...flood, ...turn];
  const compactAt = Math.floor(estTokens(events) / 3);
  // keepRecent ends inside the turn's rows: the cut steps back below the whole turn
  const span = compactionSpan(events, SESSION, compactAt, estTokens(turn.slice(-3)))!;
  assert(span !== null && span.flood);
  assert(!span.covered.some((e) => turn.includes(e)));
  assertEquals(span.covered.at(-1), flood.at(-1));
});

Deno.test("buildSummary: a flood's checkpoint takes no call — the previous record, and the stretch it skipped", async () => {
  const floor = summaryEv(["0", "0"], "## Open\n- the report");
  const flood = Array.from({ length: 1200 }, (_, i) => liveMsg(i + 1, false));
  const events: Event[] = [floor, liveMsg(0, true), ...flood];
  const span = compactionSpan(events, LIVE)!;
  const out = await buildSummary({
    events,
    window: windowOf(events),
    session: LIVE,
    model: "claude-x",
    prompt: () => Promise.resolve(null), // never read: a flood writes no request
  }, stepping(() => Promise.reject(new Error("a flood makes no call"))));
  assert(out !== null && out.type === "summary", JSON.stringify(out));
  assertEquals(out.payload.covers, span.covers);
  assertEquals(out.parts[0].text, skipped(span.covered));
  assert(out.parts[0].text.startsWith("## Open\n- the report\n\nNot read: everything after"));
});

Deno.test("skipped: the stamp is the minute after the newest skipped row, in UTC, so `before` still reaches it", () => {
  const at = (ts: string) => ({ ...liveMsg(1, false), ts }) as Event;
  assertEquals(
    skipped([at("2026-08-19T19:19:24.000Z"), at("2026-08-19T18:00:00.000Z")]),
    "Not read: everything up to 2026-08-19T19:20Z. More arrived than one window holds; " +
      "search reads it.",
  );
  assertStringIncludes(skipped([at("2026-08-19T19:19:00.000Z")]), "up to 2026-08-19T19:19Z.");
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
  const span = compactionSpan(events, SESSION, over(events), 150);
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

Deno.test("span: a running turn is never cut, whatever it weighs — not even its closed history", () => {
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
  assertEquals(compactionSpan(events, SESSION, over(events), 0), null);
  assertEquals(turnOver(events, SESSION), false);
  // the moment it closes, the same window compacts — and the whole turn is closed history
  const closed = [...events, msg("listo", true)];
  assertEquals(turnOver(closed, SESSION), true);
  const span = compactionSpan(closed, SESSION, over(closed), 0);
  assert(span !== null);
  assertEquals(span.covered.at(-1), closed.at(-1)); // through the closing
});

Deno.test("span: the covered span ends where a turn ends — a keepRecent cut inside the last turn falls back to the turn before it", () => {
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
  const span = compactionSpan(events, SESSION, over(events), 1_000); // the last few steps
  assert(span !== null);
  assertEquals(span.covered, events.slice(0, 2)); // through the previous turn's closing
  assertEquals(span.covers[1], events[1].id);
});

Deno.test("span: when the turn the keepRecent cut falls in is the window's first, it goes whole", () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 24; k++) events.push(...step(k));
  events.push(msg("listo, informe enviado", true));
  const span = compactionSpan(events, SESSION, over(events), 1_000);
  assert(span !== null);
  assertEquals(span.covered, events); // closed, so covered whole rather than half
  // a previous checkpoint at the head of the window is no turn of this window's: the turn
  // after it still goes whole, and the range chains from the checkpoint's start
  const old = summaryEv(["e000", "e000"], "## Open\n- informe");
  const chained = compactionSpan([old, ...events], SESSION, over([old, ...events]), 1_000);
  assert(chained !== null);
  assertEquals(chained.covered, [old, ...events]);
  assertEquals(chained.covers, ["e000", events.at(-1)!.id]);
  // and a window that fits keepRecent whole leaves its one turn alone
  assertEquals(compactionSpan(events, SESSION, over(events), 1_000_000), null);
});

Deno.test("span: a closing step's words stay together — the turn ends on its last row", () => {
  const ask = msg("uno", false);
  const first = msg("respuesta, primera parte", true);
  const second = msg("respuesta, segunda parte", true);
  second.payload = { turn_id: first.payload!.turn_id };
  const events = [ask, first, second, msg("dos", false), msg("respuesta dos", true)];
  const at = events.indexOf(first);
  // keepRecent sized so the budget cut falls between the two halves of the first closing
  const keep = estTokens(events.slice(at + 1)) + 1;
  const span = compactionSpan(events, SESSION, over(events), keep);
  assert(span !== null);
  assertEquals(span.covered, [ask, first, second]);
});

Deno.test("span: a dead turn is covered whole, down to the row that killed it", () => {
  const events: Event[] = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("hacé el informe", false),
  ];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  const dead = [...events, errorEv("overloaded")];
  assertEquals(turnOver(dead, SESSION), true);
  const span = compactionSpan(dead, SESSION, over(dead), 400); // keepRecent would keep half the chain…
  assert(span !== null);
  assertEquals(span.covered, dead); // …but nothing continues a dead turn: it goes whole
  assertEquals(span.covers[1], dead.at(-1)!.id);
  // a step still waiting for its result holds the turn open past the error, and stays out
  const waiting = [...events, use("T9", "step 9"), errorEv("overloaded")];
  const partial = compactionSpan(waiting, SESSION, over(waiting), 0);
  assert(partial !== null);
  assert(!partial.covered.some((e) => e.payload?.turn_id === "T9"));
});

Deno.test("span: the API's ceiling is the one hard one — a refused request compacts under the threshold", () => {
  const events: Event[] = [msg("uno", false), msg("respuesta uno", true), msg("dos", false)];
  for (let k = 1; k <= 3; k++) events.push(...step(k));
  const refused = [...events, errorEv("prompt is too long: 213462 tokens > 200000 maximum")];
  assert(overflowed(refused));
  assert(!overflowed([...events, errorEv("overloaded")]));
  assertEquals(compactionSpan([...events, errorEv("overloaded")], SESSION, 1_000_000, 0), null);
  const span = compactionSpan(refused, SESSION, 1_000_000, 0);
  assert(span !== null);
  assertEquals(span.covered, refused);
});

Deno.test("buildSummary: a window the API refused goes as a transcript — the tool traffic and the error ARE the content", async () => {
  const events: Event[] = [msg("hacé el informe", false)];
  for (let k = 1; k <= 8; k++) events.push(...step(k));
  events.push(errorEv("prompt is too long: 213462 tokens > 200000 maximum"));
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: over(events),
      keepRecent: 400,
      prompt: PROMPT,
    },
    stepping((p) => {
      seen.push(p);
      return Promise.resolve(
        canned([{ kind: "assistant", text: "## Ongoing threads\n- informe" }]),
      );
    }),
  );
  assert(out !== null && out.type === "summary");
  assertEquals(seen[0].messages.length, 1); // the one block: sending the window again would be refused again
  const prompt = lastText(seen[0]);
  assertStringIncludes(prompt, "<conversation>\n[Ana @ mind@a1] hacé el informe"); // what it was asked
  assertStringIncludes(prompt, "bash(step 1)");
  assertStringIncludes(prompt, "out 1");
  assertStringIncludes(prompt, "[error] prompt is too long"); // and how it ended
  assertStringIncludes(prompt, "When the conversation comes as a <conversation> block");
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
      compactAt: over(events),
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
  assertStringIncludes(lastText(seen[0]), "<archived-through>error: overloaded</archived-through>");
});

Deno.test("buildSummary: a cut checkpoint is an error, not a record", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary(
    {
      events,
      window: windowOf(events),
      session: SESSION,
      model: "claude-x",
      compactAt: over(events),
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
    compactAt: over(events),
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
      compactAt: over(events),
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
  const span = compactionSpan(events, SESSION, over(events), 1);
  assert(span !== null);
  assert(!span.covered.includes(late));
  // the range the checkpoint stands for must not swallow it either: applying the
  // checkpoint leaves the unanswered input in the window
  const visible = applySummary([...events, summaryEv(span.covers, "## nuevo")]);
  assert(visible.includes(late), "unconsumed input hidden behind the checkpoint");
});
