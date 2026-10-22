/**
 * verdict.ts — a principal's answer to an approval card (§9), from wherever they gave it.
 *
 * The terminal types `/y`, a phone replies `/y` to the card or puts a thumb on it: three
 * shapes of one act, read here by one rule and logged as one shape. The door calls this
 * for a terminal's line, the mirror's fan-in for a surface's line or reaction; both write
 * what comes back, and nothing else turns words into a settlement. What is logged is the
 * settlement itself — a `permission_response` per card, the first carrying the line that
 * gave it — so the mind holds no message the model does not read.
 *
 * WHICH card a word answers: the one it points at — a handle in the line (the terminal's
 * way), or the card it replies to or reacts on (a surface's). A word that points at
 * nothing answers the newest card. `all` answers every card open now, in the order they
 * were asked. A pointer at a card no longer open answers nothing, and says so: on a phone
 * two copies of the same ask can sit side by side, only one of them live.
 */

import { type Words, words } from "./i18n.ts";
import { shortId } from "./render.ts";
import type {
  Draft,
  Event,
  EventId,
  PermissionRequestEvent,
  PermissionResponseEvent,
  PermissionVerdict,
  Refusal,
} from "./types.ts";

/* ── the vocabulary ───────────────────────────────────────────────────── */

/** `/{y,n} [once|conv|conn|always|all] [reason]`. Two independent axes, one word each:
 *
 *    HOW LONG   `once` (the bare form) settles this call. `conv` · `conn` · `always` make
 *               it STANDING — remembered for the conversation, the connection, or the tool
 *               everywhere.
 *    HOW MANY   `all` answers every open card at once, each settled `once` — the pile a
 *               phone cannot comfortably quote through, cleared in one line.
 *
 *  `always` is the widest SCOPE precisely so `all` can mean all of them: a bare `/y` reads
 *  as `/y once`, which makes `/y always` the natural opposite and leaves `all` free for
 *  what it plainly says. */
const VERDICT = /^\/(y|n)\b(?:\s+(all|once|conv|conn|always)(?=\s|$))?\s*(.*)$/s;

const SCOPES = {
  once: "once",
  conv: "conversation",
  conn: "connection",
  always: "always",
} as const;

/** A principal's line as a verdict, or nothing if it isn't one. */
export function parseVerdict(text: string): PermissionVerdict | undefined {
  const said = VERDICT.exec(text.trim());
  if (!said) return undefined;
  const reason = said[3].trim();
  const every = said[2] === "all";
  return {
    behavior: said[1] === "y" ? "allow" : "deny",
    scope: every || !said[2] ? "once" : SCOPES[said[2] as keyof typeof SCOPES],
    ...(reason ? { reason } : {}),
    ...(every ? { every: true } : {}),
  };
}

/** The verdict a REACTION spells: a thumb or a heart on the card is `/y`, a thumb down or
 *  a gasp is `/n` — WhatsApp's quick-reaction bar — and a robot is `/y conv`, the agent
 *  let loose in that conversation; Slack's names for the same glyphs alike. A reaction has
 *  no words for a reason. */
const REACTIONS: Record<string, PermissionVerdict> = {
  "👍": { behavior: "allow", scope: "once" },
  "❤": { behavior: "allow", scope: "once" },
  "+1": { behavior: "allow", scope: "once" },
  "thumbsup": { behavior: "allow", scope: "once" },
  "heart": { behavior: "allow", scope: "once" },
  "🤖": { behavior: "allow", scope: "conversation" },
  "robot_face": { behavior: "allow", scope: "conversation" },
  "👎": { behavior: "deny", scope: "once" },
  "😮": { behavior: "deny", scope: "once" },
  "-1": { behavior: "deny", scope: "once" },
  "thumbsdown": { behavior: "deny", scope: "once" },
  "open_mouth": { behavior: "deny", scope: "once" },
};

/** A glyph as the table keys it: no variation selector (`❤️` is `❤` + VS16), no skin tone
 *  (`👍🏻` is `👍` + a modifier) — the phone's spelling of the same reaction. */
export function reactionVerdict(glyph: string): PermissionVerdict | undefined {
  const bare = glyph.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
  const verdict = REACTIONS[bare];
  return verdict ? { ...verdict } : undefined;
}

/* ── which cards ──────────────────────────────────────────────────────── */

/** What the principal gave: a line, or a reaction on a card. */
export type Said = { line: string } | { glyph: string };

/** The cards an answer settles, by the use each asks about, and the verdict on them. */
export interface Answered {
  refs: EventId[];
  verdict: PermissionVerdict;
}

/** A card's handle as a line names it: `shortId`'s six hex digits. */
const HANDLE = /^[0-9a-f]{6}$/;

const ANSWERED: Refusal = { refusal: "answered", waiting: 0 };

/** A refusal as a sentence, in a surface's tongue — English for the model and a terminal. */
export function refusalText(r: Refusal, w: Words = words()): string {
  switch (r.refusal) {
    case "not_verdict":
      return w.refusal.notVerdict;
    case "no_card":
      return w.refusal.noCard(r.handle);
    case "answered":
      return w.refusal.answered(r.waiting);
    case "none_waiting":
      return w.refusal.noneWaiting;
  }
}

/** Is this what an answer was refused with? */
export function isRefusal(x: unknown): x is Refusal {
  return typeof x === "object" && x !== null && "refusal" in x;
}

/** What `said` answers among the `open` cards (oldest first), or why it settles none.
 *  `quoted` is the card a surface's reply or reaction points at, open or not. A handle in
 *  the line is lifted out before the verdict is read, so it is not taken for a reason. */
export function answer(
  said: Said,
  open: PermissionRequestEvent[],
  quoted?: PermissionRequestEvent,
): Answered | Refusal {
  const words = "line" in said ? said.line.trim().split(/\s+/) : [];
  const named = open.find((c) => words.includes(shortId(c.payload.ref_id)));
  const verdict = "glyph" in said
    ? reactionVerdict(said.glyph)
    : parseVerdict(words.filter((w) => !named || w !== shortId(named.payload.ref_id)).join(" "));
  if (!verdict) return { refusal: "not_verdict" };
  const stale = named ? undefined : words.find((w) => HANDLE.test(w));
  if (stale) return { refusal: "no_card", handle: stale };
  const live = (c: PermissionRequestEvent) => open.some((o) => o.id === c.id);
  if (!named && quoted && !live(quoted)) return { refusal: "answered", waiting: open.length };
  if (open.length === 0) return { refusal: "none_waiting" };
  if (verdict.every) return { refs: open.map((c) => c.payload.ref_id), verdict };
  return { refs: [(named ?? quoted ?? open.at(-1)!).payload.ref_id], verdict };
}

/* ── the rows ─────────────────────────────────────────────────────────── */

/** An answer as the log holds it: one settlement per card, in the order they were asked;
 *  the first carries the line that gave them — what the room draws as the principal's, a
 *  `/y all` included, once. `from` is who and where: their signature, the session's stamp,
 *  a surface's provenance. */
export function answerRows(
  a: Answered,
  line: string,
  from: Pick<Draft<PermissionResponseEvent>, "agent" | "envelope" | "extra">,
): Draft<PermissionResponseEvent>[] {
  const ts = new Date().toISOString();
  return a.refs.map((ref, i): Draft<PermissionResponseEvent> => ({
    ts,
    type: "permission_response",
    payload: { ref_id: ref },
    ...from,
    parts: [
      { type: "data", kind: "permission_response", data: a.verdict },
      ...(i === 0 ? [{ type: "text" as const, kind: "text" as const, text: line }] : []),
    ],
  }));
}

/** The answer logged, as the store kept it: the settlements of the cards no other ruling
 *  reached first — a card is settled once (§9), and a race between two surfaces, or with
 *  the lapse, is the store's to break — or, when every card went to someone else, the
 *  refusal. The cards go one at a time, so the line rides the
 *  first one the store keeps: a card lost to a race does not take the line with it. */
export async function settle(
  publish: (rows: Draft<PermissionResponseEvent>[]) => Promise<Event[]>,
  a: Answered,
  line: string,
  from: Pick<Draft<PermissionResponseEvent>, "agent" | "envelope" | "extra">,
): Promise<PermissionResponseEvent[] | Refusal> {
  const stored: PermissionResponseEvent[] = [];
  for (const row of answerRows(a, line, from)) {
    const [data] = row.parts;
    const carrying: Draft<PermissionResponseEvent> = {
      ...row,
      parts: stored.length === 0 ? [data, { type: "text", kind: "text", text: line }] : [data],
    };
    stored.push(...await publish([carrying]) as PermissionResponseEvent[]);
  }
  return stored.length > 0 ? stored : ANSWERED;
}

/** The line a settlement carries — the principal's `/y`, `/n <reason>`, `👍` — when it is
 *  the row that gave it. A lapse, a withdrawal, the rest of a `/y all` carry none. */
export function answerLine(e: PermissionResponseEvent): string | undefined {
  const p = e.parts.find((p) => p.type === "text");
  return p?.type === "text" ? p.text : undefined;
}
