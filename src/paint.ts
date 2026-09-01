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
 */

import { outcomeLine, ownVoice, SILENCE, silent } from "./render.ts";
import { describeCall } from "./describe.ts";
import type { Delta, Event } from "./types.ts";

export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const RESET = "\x1b[0m";

/** The surface's half: sinks and reactions. `prompt` is the transcript's line-end (the
 *  REPL redraws `"\n> "`, the CLI writes `"\n"`); `error` is where failures land (the
 *  REPL's screen, the CLI's stderr); the gate hooks let a surface keep an approval pile —
 *  the painter only reports what the tail disclosed. */
export interface Surface {
  session: string; // the ownVoice discriminator (§3)
  home: string; // the mind conversation this surface fronts
  write(s: string): void;
  error(s: string): void;
  prompt(): void;
  thinking: boolean; // stream thinking deltas (dim) or drop them
  gateHint?: string; // the answer vocabulary printed under an approval card
  onGate?(ref: string): void;
  onGateSettled?(ref: string): void;
}

export interface Painter {
  delta(d: Delta): void;
  event(e: Event): void;
}

export function painter(s: Surface): Painter {
  let held = "";
  const say = (text: string) => {
    held += text;
    if (SILENCE.startsWith(held.trimStart())) return;
    s.write(held);
    held = "";
  };

  const delta = (d: Delta): void => {
    if (d.kind === "text") say(d.text ?? "");
    else if (d.kind === "thinking" && s.thinking) s.write(`${DIM}${d.text ?? ""}${RESET}`);
    else if (d.kind === "error") s.error(d.text ?? "");
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
            s.write(`\n${CYAN}[via ${via.service}]${RESET} ${text}`);
            s.prompt();
          }
          return;
        }
        if (via) return; // an alias CC is plumbing — its mind original already painted
        if (e.envelope.conversation.address === s.home) {
          // the message is published: whatever `say` is still holding was the sentinel,
          // or the tail of a reply that ended mid-word. Either way this turn is over.
          if (!silent(e)) s.write(held);
          held = "";
          s.prompt(); // the body itself already streamed
        } else {
          s.write(`\n${CYAN}→ ${e.envelope.conversation.address}:${RESET} ${text}`);
          s.prompt();
        }
        return;
      }
      case "tool_use": {
        s.write(`\n${DIM}⚙ ${describeCall(e.parts[0].data)}${RESET}\n`);
        return;
      }
      case "tool_result": {
        // a deferred outcome is the harness reporting on a call the principal approved —
        // it reads as a sentence, not a checkmark, because nothing on screen expects it
        if (e.payload.deferred) {
          s.write(`\n${YELLOW}${outcomeLine(e, 160)}${RESET}`);
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
        s.write(`\n${YELLOW}? approve ${detail}${RESET}${s.gateHint ? `\n${s.gateHint}` : ""}`);
        s.prompt();
        return;
      }
      case "permission_response": {
        // settled elsewhere (the agent withdrew it, a surface answered it) — it is no
        // longer this surface's to answer
        if (typeof e.payload?.ref_id === "string") s.onGateSettled?.(e.payload.ref_id);
        return;
      }
      case "error": {
        s.error(JSON.stringify(e.parts[0]?.data ?? {}));
        return;
      }
      default:
        return; // thinking is streamed as deltas; the rest is substrate
    }
  };

  return { delta, event };
}
