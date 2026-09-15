/**
 * paint.ts — the attach transcript: how a principal surface renders what the tail pushes.
 * One painter for every attach client (the REPL, the CLI), so the agent reads the same
 * everywhere; what differs per surface — where a line ends, where failures go, whether
 * thinking streams — arrives as the surface's hooks, never as a second renderer.
 *
 * `<|SILENCE|>` has to LOOK like silence on every surface — but text arrives as deltas,
 * before anyone knows which word it is. So the painter holds back whatever could still
 * turn out to be the sentinel and releases it the moment it can't: an ordinary answer
 * pays one delta of latency, and a turn that says nothing prints nothing.
 *
 * Who is speaking is a mark, never a name: `❯` opens the principal's lines (the screen's
 * own head, and the recap's), `•` opens the agent's — each block of its text, so a reply
 * that pauses for a tool starts again with its mark. A blank line stands between blocks.
 * Every message line says when, dim, in the org's clock: a recalled row by the clock that
 * wrote it, a live block by the surface's clock as it opens — the deltas inside it need
 * no time of their own. The agent's text is markdown, and it is shown as styles as it
 * streams (`md.ts`). A turn that says nothing paints nothing — not even a line's end.
 */

import { hhmm, isCancelled, outcomeLine, ownVoice, SILENCE, silent, textOf } from "./render.ts";
import { describeCall } from "./describe.ts";
import { markdown, renderMarkdown } from "./md.ts";
import type { Delta, Event, SessionRef } from "./types.ts";

export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const RESET = "\x1b[0m";

/** The marks: the principal's line and the agent's. */
export const YOU = "❯";
export const AGENT = "•";

/** The surface's half: sinks and reactions. `error` is where failures land (the REPL's
 *  screen, the CLI's stderr); the gate hooks let a surface keep an approval pile — the
 *  painter only reports what the tail disclosed.
 *
 *  `prompt` and `gap` are the painter asking for a shape rather than printing one: close
 *  the row, and stand one blank row under what was said. Only the surface knows where its
 *  cursor is — a painter that wrote its own newlines would have to guess, and two parts
 *  guessing the same blank line is how a transcript grows an empty column. */
export interface Surface {
  session: SessionRef; // the ownVoice discriminator (§3) — the pair, never the bare name
  home: string; // the session conversation this surface fronts
  write(s: string): void;
  error(s: string): void;
  prompt(): void;
  gap(): void;
  thinking: boolean; // stream thinking deltas (dim) or drop them
  zone?: string; // the org's clock, the one every stamp is read in (§5)
  clock?: () => Date; // now, for the stamp a live block opens with; tests hand a fixed one
  gateHint?: string; // the answer vocabulary printed under an approval card
  onGate?(ref: string): void;
  onGateSettled?(ref: string): void;
}

export interface Painter {
  delta(d: Delta): void;
  event(e: Event): void;
  /** What the room already holds, oldest first — the door's `recall` (§9). */
  recap(events: Event[]): void;
}

export function painter(s: Surface): Painter {
  let held = "";
  let checkpointing = false; // a checkpoint is under way: its first delta announced it
  let md = markdown();
  let block: "none" | "text" | "thinking" = "none"; // what the transcript last streamed
  const clock = s.clock ?? (() => new Date());
  const stamp = (ts: string) => `${DIM}${hhmm(ts, s.zone)}${RESET} `;
  // the agent's text, released: the first of a block opens it — a blank line, the time
  // and the mark — and the rest flows through the markdown stream
  const show = (raw: string) => {
    if (block !== "text") {
      s.gap(); // a block of its own, standing clear of the last one
      s.write(`${stamp(clock().toISOString())}${AGENT} `);
      block = "text";
    }
    s.write(md.feed(raw));
  };
  const say = (text: string) => {
    held += text;
    if (SILENCE.startsWith(held.trimStart())) return;
    show(held);
    held = "";
  };
  // the block closes: what the stream still holds comes out, and the next text starts
  // a block of its own — after a tool line, after the turn
  const settle = (): void => {
    if (block === "text") s.write(md.end());
    md = markdown();
    block = "none";
  };

  const delta = (d: Delta): void => {
    if (d.kind === "text") say(d.text ?? "");
    else if (d.kind === "thinking" && s.thinking) {
      if (block === "text") settle();
      if (block === "none") s.gap(); // thinking is a block too, and opens like one
      block = "thinking";
      s.write(`${DIM}${d.text ?? ""}${RESET}`);
    } else if (d.kind === "checkpoint" && s.thinking) {
      // the record being written, behind a head that says what the dim text is — a surface
      // that keeps the machine's inner text folded still gets the closing line below
      if (!checkpointing) {
        s.gap();
        s.write(`${DIM}≡ checkpoint${RESET}\n`);
      }
      checkpointing = true;
      s.write(`${DIM}${d.text ?? ""}${RESET}`);
    } else if (d.kind === "error") s.error(d.text ?? "");
  };

  const event = (e: Event): void => {
    const self = ownVoice(e, s.session); // the model's output (§3) — the principal's own
    // stamped lines stay non-self: locally they're already on screen
    switch (e.type) {
      case "message": {
        const via = (e.extra?.via ?? undefined) as { service?: string } | undefined;
        const text = e.parts.filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text).join(" ");
        if (!self) {
          // the principal spoke — locally it's already on screen; through a mind-alias
          // surface (§4) the mirror's copy is the only sighting, so paint it, tagged
          if (via && e.envelope.conversation.address === s.home) {
            s.gap();
            s.write(`${stamp(e.ts)}${YOU} ${CYAN}[via ${via.service}]${RESET} ${text}`);
            s.prompt();
          }
          return;
        }
        if (via) return; // an alias CC is plumbing — its mind original already painted
        if (e.envelope.conversation.address === s.home) {
          // the message is published: whatever `say` is still holding is the sentinel —
          // which is never a word, even after words — or the tail of a reply that ended
          // mid-word. Either way this turn is over; one that said nothing leaves the
          // screen as it found it, or an idle hour would be a column of blank lines.
          if (!silent(e) && held !== "" && held.trim() !== SILENCE) show(held);
          held = "";
          const spoke = block !== "none";
          settle();
          if (spoke) s.gap(); // the body itself already streamed; this closes it off
        } else {
          settle();
          s.gap();
          s.write(`${stamp(e.ts)}${CYAN}→ ${e.envelope.conversation.address}:${RESET} ${text}`);
          s.prompt();
        }
        return;
      }
      case "tool_use": {
        // a call the agent made mid-sentence belongs to that block, on the row under its
        // words; one that opens a turn is a block of its own and stands clear
        const inBlock = block !== "none";
        settle();
        if (inBlock) s.prompt();
        else s.gap();
        s.write(`${DIM}⚙ ${describeCall(e.parts[0].data)}${RESET}\n`);
        return;
      }
      case "tool_result": {
        // a deferred outcome is the harness reporting on a call the principal approved —
        // it reads as a sentence, not a checkmark, because nothing on screen expects it
        if (e.payload.deferred) {
          settle();
          s.gap();
          s.write(`${YELLOW}${outcomeLine(e, 160)}${RESET}`);
          s.prompt();
          return;
        }
        const { is_error } = e.parts[0].data;
        s.write(is_error ? `${RED}✗ tool failed${RESET}\n` : `${DIM}✓${RESET}\n`);
        return;
      }
      case "permission_request": {
        const { detail } = e.parts[0].data;
        const ref = e.payload?.ref_id;
        if (typeof ref === "string") s.onGate?.(ref);
        s.gap();
        s.write(`${YELLOW}? approve ${detail}${RESET}${s.gateHint ? `\n${s.gateHint}` : ""}`);
        s.prompt();
        return;
      }
      case "permission_response": {
        // settled elsewhere (the agent withdrew it, a surface answered it) — it is no
        // longer this surface's to answer
        if (typeof e.payload?.ref_id === "string") s.onGateSettled?.(e.payload.ref_id);
        return;
      }
      case "summary": {
        // the one line every surface gets: the window was folded, and this turn was that
        checkpointing = false;
        s.gap();
        s.write(`${DIM}≡ checkpoint written${RESET}\n`);
        return;
      }
      case "error": {
        s.error(JSON.stringify(e.parts[0]?.data ?? {}));
        return;
      }
      case "control": {
        // the harness closing the turn the principal cut; their own word is already on screen
        if (!isCancelled(e)) return;
        held = "";
        settle();
        s.gap();
        s.write(`${DIM}${textOf(e)}${RESET}`);
        s.prompt();
        return;
      }
      default:
        return; // thinking is streamed as deltas; the rest is substrate
    }
  };

  /**
   * The room as it already stands, painted before the tail opens on the present: the
   * same lines the live transcript would have shown — when, by the clock that wrote each
   * row (the org's, the same one the model reads (§5), because a mind and its principal
   * must agree on what "yesterday" was), who, by the same marks, and through which wire
   * when a line came in through one.
   */
  const recap = (events: Event[]): void => {
    let page = "";
    for (const e of events) {
      if (e.type !== "message") continue;
      const text = textOf(e);
      if (text === "" || silent(e)) continue;
      if (ownVoice(e, s.session)) {
        page += `${stamp(e.ts)}${AGENT} ${renderMarkdown(text)}\n\n`;
      } else {
        const via = (e.extra?.via ?? undefined) as { service?: string } | undefined;
        const wire = via?.service ? `${CYAN}[via ${via.service}]${RESET} ` : "";
        page += `${stamp(e.ts)}${YOU} ${wire}${text}\n\n`;
      }
    }
    // one write: the past arrives as a page, not as a line the surface redraws around
    if (page !== "") s.write(page);
  };

  return { delta, event, recap };
}
