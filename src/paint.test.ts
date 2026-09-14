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

// The recap is the only place a surface says who and when: live, the principal's own line
// is on screen because they typed it, and the answer streams in while they watch.
Deno.test("recap: every message says who said it and when, in the org's clock", () => {
  const { p, screen } = surface();
  p.recap([
    asked("2026-09-11T14:13:00Z", "qué calendarios podés ver?"),
    answered("2026-09-11T14:14:00Z", "el tuyo y el de la clínica"),
  ]);
  assertEquals(
    plain(screen()),
    "11 Sep 11:13 matias  qué calendarios podés ver?\n" +
      "11 Sep 11:14 laura  el tuyo y el de la clínica\n",
  );
});

Deno.test("recap: a turn that said nothing shows as nothing", () => {
  const { p, screen } = surface();
  p.recap([
    asked("2026-09-11T14:13:00Z", "hola"),
    answered("2026-09-11T14:20:00Z", "<|SILENCE|>", { silence: true }),
  ]);
  assertEquals(plain(screen()), "11 Sep 11:13 matias  hola\n");
});

Deno.test("recap: a wire's name is the one it signed with", () => {
  const { p, screen } = surface();
  p.recap([asked("2026-09-11T14:13:00Z", "buen día", "Matías (WhatsApp)")]);
  assertEquals(
    plain(screen()),
    "11 Sep 11:13 Matías (WhatsApp)  buen día\n",
  );
});

Deno.test("recap: a bodiless row is not a line — a picture with no caption paints none", () => {
  const { p, screen } = surface();
  const media: Event = {
    ...asked("2026-09-11T14:13:00Z", ""),
    parts: [{ type: "data", kind: "search", data: {} }],
  } as Event;
  p.recap([media, answered("2026-09-11T14:14:00Z", "listo")]);
  assertEquals(plain(screen()), "11 Sep 11:14 laura  listo\n");
});
