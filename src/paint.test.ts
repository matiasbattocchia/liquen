import { assertEquals } from "@std/assert";
import { painter, type Surface } from "./paint.ts";
import type { Event, Json, MessageEvent } from "./types.ts";

const AGENT = "laura";
const HOME = `mind@${AGENT}`;
const SESSION = { agentId: AGENT, id: "mind" };
const ZONE = "America/Argentina/Buenos_Aires";

// the colours are the surface's, not the transcript's: what a test reads is the words
// deno-lint-ignore no-control-regex
const COLOURS = /\x1b\[\d+m/g;
const plain = (s: string) => s.replaceAll(COLOURS, "");

/** The screen, as a string — the painter's whole output, escapes and all. */
function surface(over: Partial<Surface> = {}) {
  let screen = "";
  const s: Surface = {
    session: SESSION,
    home: HOME,
    zone: ZONE,
    write: (t) => screen += t,
    error: (t) => screen += `!${t}`,
    prompt: () => screen += "\n> ",
    thinking: true,
    clock: () => new Date("2026-09-11T14:14:00Z"),
    ...over,
  };
  return { p: painter(s), screen: () => screen };
}

/** The principal's half of a complex: a sender, no turn_id (§3). */
function asked(ts: string, text: string, name = "matias"): MessageEvent {
  return {
    id: `i-${ts}`,
    ts,
    type: "message",
    agent: { id: AGENT, session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: HOME },
      sender: { address: "matias", name },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

/** The agent's half: a turn_id, and nobody else's name on it. */
function answered(ts: string, text: string, extra?: Record<string, Json>): MessageEvent {
  return {
    id: `o-${ts}`,
    ts,
    type: "message",
    payload: { turn_id: `t-${ts}` },
    agent: { id: AGENT, session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: HOME },
    },
    parts: [{ type: "text", kind: "text", text }],
    ...(extra ? { extra } : {}),
  };
}

// The recap says when and who the way the live transcript does — the same stamps, the
// same marks — so the page reads like the transcript it precedes.
Deno.test("recap: every message wears its mark and its time, in the org's clock, a blank line between", () => {
  const { p, screen } = surface();
  p.recap([
    asked("2026-09-11T14:13:00Z", "qué calendarios podés ver?"),
    answered("2026-09-11T14:14:00Z", "el tuyo y el de la clínica"),
    asked("2026-09-11T14:15:00Z", "gracias"),
  ]);
  assertEquals(
    plain(screen()),
    "11 Sep 11:13 ❯ qué calendarios podés ver?\n\n" +
      "11 Sep 11:14 • el tuyo y el de la clínica\n\n" +
      "11 Sep 11:15 ❯ gracias\n\n",
  );
});

Deno.test("recap: a turn that said nothing shows as nothing", () => {
  const { p, screen } = surface();
  p.recap([
    asked("2026-09-11T14:13:00Z", "hola"),
    answered("2026-09-11T14:20:00Z", "<|SILENCE|>", { silence: true }),
  ]);
  assertEquals(plain(screen()), "11 Sep 11:13 ❯ hola\n\n");
});

Deno.test("recap: a line that came through a wire says which, as the live copy does", () => {
  const { p, screen } = surface();
  const wired: Event = {
    ...asked("2026-09-11T14:13:00Z", "buen día", "Matías (WhatsApp)"),
    extra: { via: { service: "whatsapp" } },
  };
  p.recap([wired]);
  assertEquals(plain(screen()), "11 Sep 11:13 ❯ [via whatsapp] buen día\n\n");
});

Deno.test("recap: the agent's markdown is shown as styles", () => {
  const { p, screen } = surface();
  p.recap([answered("2026-09-11T14:14:00Z", "## Plan\nprimero **esto**, después `eso`")]);
  assertEquals(
    screen(),
    `\x1b[2m11 Sep 11:14\x1b[0m • \x1b[1mPlan\x1b[22m\nprimero \x1b[1mesto\x1b[22m, después \x1b[36meso\x1b[39m\n\n`,
  );
});

Deno.test("recap: a bodiless row is not a line — a picture with no caption paints none", () => {
  const { p, screen } = surface();
  const media: Event = {
    ...asked("2026-09-11T14:13:00Z", ""),
    parts: [{ type: "data", kind: "search", data: {} }],
  } as Event;
  p.recap([media, answered("2026-09-11T14:14:00Z", "listo")]);
  assertEquals(plain(screen()), "11 Sep 11:14 • listo\n\n");
});

/* ── live: the agent's text, block by block ───────────────────────────────────── */

Deno.test("live: the agent's text opens with a blank line, the time and its mark, and closes with a blank line", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "el tuyo " });
  p.delta({ kind: "text", text: "y el de la clínica" });
  p.event(answered("2026-09-11T14:14:00Z", "el tuyo y el de la clínica"));
  assertEquals(plain(screen()), "\n11 Sep 11:14 • el tuyo y el de la clínica\n\n> ");
});

Deno.test("live: markdown streams as styles, a span held until it closes", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "es **muy" });
  assertEquals(plain(screen()), "\n11 Sep 11:14 • es ");
  p.delta({ kind: "text", text: " simple** sí" });
  assertEquals(screen(), "\n\x1b[2m11 Sep 11:14\x1b[0m • es \x1b[1mmuy simple\x1b[22m sí");
});

// an idle hour is sixty silent turns: each one painting a line's end would be a column
// of blank lines under the last thing said
Deno.test("live: a turn that says nothing paints nothing at all", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "<|SIL" });
  p.delta({ kind: "text", text: "ENCE|>" });
  p.event(answered("2026-09-11T14:20:00Z", "<|SILENCE|>", { silence: true }));
  assertEquals(plain(screen()), "");
});

Deno.test("live: the sentinel after words is not a word", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "listo." });
  p.delta({ kind: "text", text: "\n\n<|SILENCE|>" });
  p.event(answered("2026-09-11T14:14:00Z", "listo.\n\n<|SILENCE|>"));
  assertEquals(plain(screen()), "\n11 Sep 11:14 • listo.\n\n> ");
});

Deno.test("live: the principal's line through a wire is dated and marked like a recalled one", () => {
  const { p, screen } = surface();
  p.event({
    ...asked("2026-09-11T14:13:00Z", "buen día", "Matías (WhatsApp)"),
    extra: { via: { service: "whatsapp" } },
  });
  assertEquals(plain(screen()), "\n11 Sep 11:13 ❯ [via whatsapp] buen día\n> ");
});

Deno.test("live: text after a tool line is a block of its own, marked again", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "miro el calendario" });
  p.event({
    id: "u1",
    ts: "2026-09-11T14:14:00Z",
    type: "tool_use",
    payload: { turn_id: "t1" },
    agent: { id: AGENT, session_id: "mind" },
    envelope: { service: "local", connection_address: "agent", conversation: { address: HOME } },
    parts: [{ type: "data", kind: "tool_use", data: { name: "search", input: {} } }],
  } as unknown as Event);
  p.delta({ kind: "text", text: "tenés dos turnos" });
  const out = plain(screen());
  assertEquals(out.startsWith("\n11 Sep 11:14 • miro el calendario\n⚙ "), true);
  assertEquals(out.endsWith("\n\n11 Sep 11:14 • tenés dos turnos"), true);
});

Deno.test("live: thinking streams dim in a block of its own, and the answer follows marked", () => {
  const { p, screen } = surface();
  p.delta({ kind: "thinking", text: "veamos" });
  p.delta({ kind: "text", text: "listo" });
  assertEquals(plain(screen()), "\nveamos\n\n11 Sep 11:14 • listo");
});
