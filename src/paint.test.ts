import { assertEquals } from "@std/assert";
import { painter, type Surface } from "./paint.ts";
import { tailOf } from "./line.ts";
import { ownVoice, textOf } from "./render.ts";
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
  // the fake screen keeps its tail the way a real one does: the painter asks for a closed
  // row or a blank one, and gets only what is missing
  const tail = tailOf();
  const put = (t: string) => {
    tail.note(t);
    screen += t;
  };
  const s: Surface = {
    session: SESSION,
    home: HOME,
    zone: ZONE,
    write: put,
    error: (t) => screen += `!${t}`,
    prompt: () => put(tail.owed(1)),
    gap: () => put(tail.owed(2)),
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
      "11 Sep 11:15 ❯ gracias\n",
  );
});

Deno.test("recap: a turn that said nothing shows as nothing", () => {
  const { p, screen } = surface();
  p.recap([
    asked("2026-09-11T14:13:00Z", "hola"),
    answered("2026-09-11T14:20:00Z", "<|SILENCE|>", { silence: true }),
  ]);
  assertEquals(plain(screen()), "11 Sep 11:13 ❯ hola\n");
});

Deno.test("recap: a line that came through a wire says which, as the live copy does", () => {
  const { p, screen } = surface();
  const wired: Event = {
    ...asked("2026-09-11T14:13:00Z", "buen día", "Matías (WhatsApp)"),
    extra: { via: { service: "whatsapp" } },
  };
  p.recap([wired]);
  assertEquals(plain(screen()), "11 Sep 11:13 ❯ [via whatsapp] buen día\n");
});

Deno.test("recap: the agent's markdown is shown as styles", () => {
  const { p, screen } = surface();
  p.recap([answered("2026-09-11T14:14:00Z", "## Plan\nprimero **esto**, después `eso`")]);
  assertEquals(
    screen(),
    `\x1b[2m11 Sep 11:14\x1b[0m • \x1b[1mPlan\x1b[22m\nprimero \x1b[1mesto\x1b[22m, después \x1b[36meso\x1b[39m\n`,
  );
});

Deno.test("recap: a bodiless row is not a line — a picture with no caption paints none", () => {
  const { p, screen } = surface();
  const media: Event = {
    ...asked("2026-09-11T14:13:00Z", ""),
    parts: [{ type: "data", kind: "search", data: {} }],
  } as Event;
  p.recap([media, answered("2026-09-11T14:14:00Z", "listo")]);
  assertEquals(plain(screen()), "11 Sep 11:14 • listo\n");
});

/* ── live: the agent's text, block by block ───────────────────────────────────── */

Deno.test("live: the agent's text opens with a blank line, the time and its mark, and closes with a blank line", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "el tuyo " });
  p.delta({ kind: "text", text: "y el de la clínica" });
  p.event(answered("2026-09-11T14:14:00Z", "el tuyo y el de la clínica"));
  assertEquals(plain(screen()), "11 Sep 11:14 • el tuyo y el de la clínica\n\n");
});

Deno.test("live: markdown streams as styles, a span held until it closes", () => {
  const { p, screen } = surface();
  p.delta({ kind: "text", text: "es **muy" });
  assertEquals(plain(screen()), "11 Sep 11:14 • es ");
  p.delta({ kind: "text", text: " simple** sí" });
  assertEquals(screen(), "\x1b[2m11 Sep 11:14\x1b[0m • es \x1b[1mmuy simple\x1b[22m sí");
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
  assertEquals(plain(screen()), "11 Sep 11:14 • listo.\n\n");
});

Deno.test("live: the principal's line through a wire is dated and marked like a recalled one", () => {
  const { p, screen } = surface();
  p.event({
    ...asked("2026-09-11T14:13:00Z", "buen día", "Matías (WhatsApp)"),
    extra: { via: { service: "whatsapp" } },
  });
  assertEquals(plain(screen()), "11 Sep 11:13 ❯ [via whatsapp] buen día\n");
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
  assertEquals(out.startsWith("11 Sep 11:14 • miro el calendario\n⚙ "), true);
  assertEquals(out.endsWith("\n\n11 Sep 11:14 • tenés dos turnos"), true);
});

Deno.test("live: thinking streams dim in a block of its own, and the answer follows marked", () => {
  const { p, screen } = surface();
  p.delta({ kind: "thinking", text: "veamos" });
  p.delta({ kind: "text", text: "listo" });
  assertEquals(plain(screen()), "veamos\n\n11 Sep 11:14 • listo");
});

// The screen's shape is asked for, never printed: whatever order the tail hands things
// over in, one blank row stands between blocks and no run of events grows a column.
Deno.test("live: blocks stand one blank row apart, however the turn goes", () => {
  const { p, screen } = surface();
  const gate: Event = {
    id: "g1",
    ts: "2026-09-11T14:14:00Z",
    type: "permission_request",
    payload: { ref_id: "u1" },
    agent: { id: AGENT, session_id: "mind" },
    envelope: { service: "local", connection_address: "agent", conversation: { address: HOME } },
    parts: [{ type: "data", kind: "permission_request", data: { detail: "send(...)" } }],
  } as unknown as Event;
  const use = {
    ...gate,
    id: "u1",
    type: "tool_use",
    payload: { turn_id: "t1" },
    parts: [{ type: "data", kind: "tool_use", data: { name: "send", input: {} } }],
  } as unknown as Event;
  const done = {
    ...use,
    id: "r1",
    type: "tool_result",
    parts: [{ type: "data", kind: "tool_result", data: { is_error: false, output: "ok" } }],
  } as unknown as Event;

  p.delta({ kind: "text", text: "mando" });
  p.event(use);
  p.event(gate);
  p.event(done);
  p.delta({ kind: "text", text: "listo" });
  p.event(answered("2026-09-11T14:14:00Z", "listo"));
  p.event(use); // a second call, straight after a closed turn
  p.event(done);

  const out = plain(screen());
  assertEquals(out.includes("\n\n\n"), false, `a column of blank lines:\n${JSON.stringify(out)}`);
  assertEquals(out.includes("mando\n⚙ send"), true); // the call sits under the words
  // the card stands under the call it asks about, in its block; the words are the next block
  assertEquals(out.includes("⚙ send(to: )\n? approve u1\n\n11 Sep 11:14 • listo"), true);
  // a call that did what it says adds no row of its own: the second one closes the screen
  assertEquals(out.endsWith("⚙ send(to: )\n"), true, JSON.stringify(out));
});

// A failure is the one outcome a reader has to act on, so it arrives with the reason
// already in hand: what the tool said, as it said it, under a call printed whole.
Deno.test("live: a call that failed says why, in the tool's own words", () => {
  const { p, screen } = surface();
  const use = {
    id: "u1",
    ts: "2026-09-11T14:14:00Z",
    type: "tool_use",
    payload: { turn_id: "t1" },
    agent: { id: AGENT, session_id: "mind" },
    envelope: { service: "local", connection_address: "agent", conversation: { address: HOME } },
    parts: [{
      type: "data",
      kind: "tool_use",
      data: { name: "read", input: { path: "data/media/agenda de la clínica" } },
    }],
  } as unknown as Event;
  const broke = {
    ...use,
    id: "r1",
    type: "tool_result",
    parts: [{
      type: "data",
      kind: "tool_result",
      data: {
        is_error: true,
        output: "No such file or directory (os error 2):\n  data/media/agenda de la clínica\n",
      },
    }],
  } as unknown as Event;

  p.event(use);
  p.event(broke);

  const out = plain(screen());
  assertEquals(
    out,
    "⚙ read(data/media/agenda de la clínica)\n" +
      "✗ No such file or directory (os error 2):\n  data/media/agenda de la clínica\n",
  );
});

// Reopening a surface must not rewrite history into a mind that only ever talked: the
// calls it made, the outcomes and the cards it raised were the transcript too.
Deno.test("recap: the work shows, not just the words — and an open card is still answerable", () => {
  const gates: string[] = [];
  const { p, screen } = surface({ onGate: (ref) => gates.push(ref) });
  const at = (id: string, type: string, data: Json, payload: Record<string, Json> = {}): Event => ({
    id,
    ts: "2026-09-11T14:14:00Z",
    type,
    payload: { turn_id: "t1", ...payload },
    agent: { id: AGENT, session_id: "mind" },
    envelope: { service: "local", connection_address: "agent", conversation: { address: HOME } },
    parts: [{ type: "data", kind: type, data }],
  } as unknown as Event);

  p.recap([
    asked("2026-09-11T14:13:00Z", "mandale el saludo a Verónica"),
    at("u1", "tool_use", { name: "send", input: {} }),
    at("r1", "tool_result", { is_error: false, output: "ok" }),
    at(
      "g1",
      "permission_request",
      { tool: "send", call: "send(…)", detail: "send(to: Verónica)" },
      {
        ref_id: "u1",
      },
    ),
    at("g2", "permission_request", { tool: "send", call: "send(…)", detail: "send(to: Sofía)" }, {
      ref_id: "u2",
    }),
    at("p1", "permission_response", { behavior: "allow", scope: "once" }, { ref_id: "u2" }),
    answered("2026-09-11T14:14:00Z", "queda pendiente tu aprobación"),
  ]);

  const out = plain(screen());
  assertEquals(out.includes("⚙ send"), true); // the call it made
  assertEquals(out.includes("✓"), false); // which went fine, and so says nothing else
  // a card under a call the page shows is the ask and its handle, nothing repeated; one
  // whose call the page never showed names it whole
  assertEquals(out.includes("⚙ send(to: )\n? approve u1\n"), true);
  assertEquals(out.includes("? approve u2 send(to: Sofía)\n— u2 allowed once"), true);
  assertEquals(out.includes("answered"), false); // the answer is a row, not a mark on the ask
  assertEquals(gates, ["u1"]); // only the open one joins the pile `/y` answers
  assertEquals(out.includes("\n\n\n"), false);
});

// The transcript is append-only: a row written is never rewritten, so what a reopened
// surface prints for a window is exactly what the live screen printed as it happened —
// the ask, the answer, the outcome each on the row its own event bought.
Deno.test("a recap prints exactly what the live screen printed", () => {
  const TS = "2026-09-11T14:14:00Z";
  const at = (id: string, type: string, data: Json, payload: Record<string, Json> = {}): Event => ({
    id,
    ts: TS,
    type,
    payload: { turn_id: "t1", ...payload },
    agent: { id: AGENT, session_id: "mind" },
    envelope: { service: "local", connection_address: "agent", conversation: { address: HOME } },
    parts: [{ type: "data", kind: type, data }],
  } as unknown as Event);
  // the principal's own lines are the screen's to echo, not the painter's: they stand
  // outside the comparison, as does the blank row a live screen stands ready on
  const history: Event[] = [
    at("u1", "tool_use", { name: "send", input: { to: "Roxi", text: "Terrada 1439" } }),
    at("g1", "permission_request", {
      tool: "send",
      call: "send(to: Roxi)",
      detail: "send(to: Roxana Casol (5492616510433), text: Terrada 1439)",
      lands: ["Roxana Casol (5492616510433)"],
    }, { ref_id: "u1" }),
    at("r1", "tool_result", { is_error: false, output: { status: "pending_approval" } }, {
      ref_id: "u1",
    }),
    at("p1", "permission_response", { behavior: "allow", scope: "conversation" }, { ref_id: "u1" }),
    {
      ...at("r2", "tool_result", { is_error: false, output: "sent" }, {
        ref_id: "u1",
        deferred: true,
      }),
      parts: [{
        type: "data",
        kind: "tool_result",
        text: "send(to: Roxi)",
        data: { is_error: false, output: "sent" },
      }],
    } as unknown as Event,
    at("u2", "tool_use", { name: "bash", input: { command: "date" } }),
    at("r3", "tool_result", { is_error: true, output: "Command exited with code 1" }, {
      ref_id: "u2",
    }),
    answered(TS, "listo, enviada"),
  ];

  const live = surface();
  for (const e of history) {
    if (e.type === "message" && ownVoice(e, SESSION)) {
      live.p.delta({ kind: "text", text: textOf(e) });
    }
    live.p.event(e);
  }
  const again = surface();
  again.p.recap(history);

  const seen = plain(live.screen());
  assertEquals(plain(again.screen()).trimEnd(), seen.trimEnd());
  assertEquals(
    seen.includes(
      "⚙ send(to: Roxi, text: Terrada 1439)\n" +
        "? approve u1 → Roxana Casol (5492616510433)\n" +
        "— u1 allowed for this conversation\n\n" +
        "send(to: Roxi) → sent\n\n" +
        "⚙ bash(date)\n✗ Command exited with code 1\n",
    ),
    true,
    JSON.stringify(seen),
  );
});
