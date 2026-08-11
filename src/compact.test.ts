import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildSummary, compactionSpan } from "./compact.ts";
import type { MessageEvent, SummaryEvent } from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { canned } from "./testing.ts";

let n = 0;
const msg = (text: string, self: boolean, conv = "home"): MessageEvent => ({
  id: `e${String(++n).padStart(3, "0")}`,
  ts: "2026-07-20T10:00:00Z",
  type: "message",
  ...(self ? { agent: { id: "a1", session_id: "s1" } } : {}),
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
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind:a1" } },
  meta: { covers },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("span: under the threshold → null", () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  assertEquals(compactionSpan(events, "s1", "home", 1_000_000), null);
});

Deno.test("span: no closed region → null even over threshold", () => {
  const events = [msg("hola", false)]; // no closing self message
  assertEquals(compactionSpan(events, "s1", "home", 1, 0), null);
});

Deno.test("span: covers the older closed events, keeps the recent budget", () => {
  const events = [
    msg("uno", false),
    msg("respuesta uno", true),
    msg("dos", false),
    msg("respuesta dos", true), // boundary
    msg("tres — trailing", false),
  ];
  const span = compactionSpan(events, "s1", "home", 1, 150)!;
  assert(span !== null);
  // ~150 est. tokens keeps the recent tail; the oldest exchange gets covered
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
    sessionId: "s1",
    agentId: "a1",
    home: "home",
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, transport);
  assert(out !== null);
  assertEquals(out.type, "summary");
  assertEquals(out.meta.covers[0], events[0].id);
  assertStringIncludes(out.parts[0].text, "informe viernes");
  const prompt = (seen[0].messages[0].content as { text: string }[])[0].text;
  assertStringIncludes(prompt, "[Ana @ home] necesito el informe");
  assertStringIncludes(prompt, "[me @ home] dale, lo agendo");
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
    sessionId: "s1",
    agentId: "a1",
    home: "home",
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, transport);
  assert(out !== null);
  const prompt = (seen[0].messages[0].content as { text: string }[])[0].text;
  assertStringIncludes(prompt, "<previous-summary>\n## Ongoing threads\n- viejo hilo");
  assertStringIncludes(prompt, "PRESERVE everything still relevant");
  assertEquals(out.meta.covers[0], old.id); // chains from the previous summary's position
});

Deno.test("buildSummary: a failed model call → null (silent; the next think retries)", async () => {
  const events = [msg("hola", false), msg("¡hola!", true)];
  const out = await buildSummary({
    events,
    sessionId: "s1",
    agentId: "a1",
    home: "home",
    model: "claude-x",
    compactAt: 1,
    keepRecent: 0,
  }, () => Promise.reject(new Error("overloaded")));
  assertEquals(out, null);
});
