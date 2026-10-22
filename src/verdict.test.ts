import { assertEquals } from "@std/assert";
import {
  answer,
  type Answered,
  answerLine,
  answerRows,
  parseVerdict,
  reactionVerdict,
  settle,
} from "./verdict.ts";
import type { Draft, Event, PermissionRequestEvent, PermissionResponseEvent } from "./types.ts";

Deno.test("reactionVerdict: a thumb or a heart is /y, a thumb down or a gasp is /n, a robot is /y conv (§9)", () => {
  assertEquals(reactionVerdict("👍"), { behavior: "allow", scope: "once" });
  assertEquals(reactionVerdict("❤️"), { behavior: "allow", scope: "once" });
  assertEquals(reactionVerdict("👎"), { behavior: "deny", scope: "once" });
  assertEquals(reactionVerdict("😮"), { behavior: "deny", scope: "once" });
  // the phone's spelling: a skin tone or a variation selector is the same reaction
  assertEquals(reactionVerdict("👍🏻"), { behavior: "allow", scope: "once" });
  assertEquals(reactionVerdict("❤"), { behavior: "allow", scope: "once" });
  // Slack names its reactions
  assertEquals(reactionVerdict("+1"), { behavior: "allow", scope: "once" });
  assertEquals(reactionVerdict("-1"), { behavior: "deny", scope: "once" });
  // a robot lets the agent loose in the conversation, under either spelling
  assertEquals(reactionVerdict("🤖"), { behavior: "allow", scope: "conversation" });
  assertEquals(reactionVerdict("robot_face"), { behavior: "allow", scope: "conversation" });
  // the rest of the bar says nothing
  assertEquals(reactionVerdict("😂"), undefined);
  assertEquals(reactionVerdict("🙏"), undefined);
  assertEquals(reactionVerdict(""), undefined);
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

/** A card asking about `use`, as the store hands open cards back: oldest first. */
const card = (id: string, use: string): PermissionRequestEvent => ({
  id,
  ts: "2026-10-07T12:00:00Z",
  type: "permission_request",
  payload: { ref_id: use },
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind@a" } },
  parts: [{
    type: "data",
    kind: "permission_request",
    data: { tool: "send", call: "send(…)", detail: "send(…)" },
  }],
});

Deno.test("answer: a line or a reaction finds its cards by one rule, wherever it was given", () => {
  const older = card("c1", "0190aaaa-0000-7000-8000-00000000a1b2");
  const newer = card("c2", "0190bbbb-0000-7000-8000-00000000c3d4");
  const open = [older, newer];
  const once = { behavior: "allow", scope: "once" } as const;
  // a handle in the line — the terminal's pointing — answers that card wherever it stands
  assertEquals(answer({ line: "/y 00a1b2" }, open), {
    refs: [older.payload.ref_id],
    verdict: once,
  });
  // a quote — a surface's pointing — likewise
  assertEquals(answer({ line: "/y" }, open, older), {
    refs: [older.payload.ref_id],
    verdict: once,
  });
  assertEquals(answer({ glyph: "👍🏻" }, open, older), {
    refs: [older.payload.ref_id],
    verdict: once,
  });
  assertEquals(answer({ glyph: "🤖" }, open, older), {
    refs: [older.payload.ref_id],
    verdict: { behavior: "allow", scope: "conversation" },
  });
  // pointing at nothing answers the newest, and the handle is never read as the reason
  assertEquals(answer({ line: "/n too early" }, open), {
    refs: [newer.payload.ref_id],
    verdict: { behavior: "deny", scope: "once", reason: "too early" },
  });
  assertEquals(answer({ line: "/n 00a1b2 too early" }, open), {
    refs: [older.payload.ref_id],
    verdict: { behavior: "deny", scope: "once", reason: "too early" },
  });
  // `all` is every card open now, in the order they were asked
  assertEquals((answer({ line: "/y all" }, open) as { refs: string[] }).refs, [
    older.payload.ref_id,
    newer.payload.ref_id,
  ]);
  // what settles nothing says why
  assertEquals(answer({ line: "/y 99ffee" }, open), "no card 99ffee is waiting");
  assertEquals(answer({ line: "/y" }, []), "no approval is waiting");
  assertEquals(
    answer({ line: "/y" }, [newer], older),
    "that approval was already answered — 1 still waiting, /y answers the newest",
  );
  assertEquals(answer({ glyph: "👍" }, [], older), "that approval was already answered");
  assertEquals(typeof answer({ line: "/nope" }, open), "string");
  assertEquals(typeof answer({ glyph: "😂" }, open, older), "string");
});

Deno.test("answerRows: one settlement per card, the line on the first and nowhere else", () => {
  const rows = answerRows(
    { refs: ["u1", "u2"], verdict: { behavior: "allow", scope: "once", every: true } },
    "/y all",
    {
      agent: { id: "a", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@a" },
        sender: { address: "matias", name: "matias" },
      },
    },
  );
  assertEquals(rows.map((r) => r.payload.ref_id), ["u1", "u2"]);
  const [first, rest] = rows as unknown as PermissionResponseEvent[];
  assertEquals([answerLine(first), answerLine(rest)], ["/y all", undefined]);
  assertEquals(first.envelope.sender?.address, "matias");
  // a settlement nobody gave a line to — the clock's, the agent's — carries none
  const lapse = {
    ...first,
    parts: [{
      type: "data",
      kind: "permission_response",
      data: { behavior: "deny", scope: "once" },
    }],
  } as unknown as Event as PermissionResponseEvent;
  assertEquals(answerLine(lapse), undefined);
});

Deno.test("settle: the line rides the first card the store keeps — one lost to a race does not take it", async () => {
  const from = {
    agent: { id: "a", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a" },
    },
  } as const;
  const all: Answered = {
    refs: ["u1", "u2", "u3"],
    verdict: { behavior: "allow", scope: "once", every: true },
  };
  // a store where u1 was ruled on first: its settlement is not kept
  const store = (ruled: string[]) => async (rows: Draft<PermissionResponseEvent>[]) =>
    await Promise.resolve(
      rows.filter((r) => !ruled.includes(r.payload.ref_id))
        .map((r, i) => ({ ...r, id: `${r.payload.ref_id}-${i}` }) as unknown as Event),
    );
  const kept = await settle(store(["u1"]), all, "/y all", from) as PermissionResponseEvent[];
  assertEquals(kept.map((e) => e.payload.ref_id), ["u2", "u3"]);
  assertEquals(kept.map(answerLine), ["/y all", undefined]);
  // every card lost: the answer is refused, with the sentence
  assertEquals(
    await settle(store(["u1", "u2", "u3"]), all, "/y all", from),
    "that approval was already answered",
  );
});
