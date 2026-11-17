/**
 * judge.ts — the decision model (§2): one cheap call per room whose news the mind has not
 * read, answering green, yellow or red before the ladder weighs it. Green wakes the mind
 * now; yellow waits for the next look; red is never what makes a digest due.
 *
 * The call reads one room, never the window: the room's last lines with the news marked,
 * who holds the floor there, the day's calendar, and the principal's standing word, which
 * is the agent's own notes about people and rooms (`standingOf`, `aboutOf`). Its words are
 * `system/decision.md`, an org's own copy like every instruction. Its answer is structured
 * (a reason, then a color), and a call that fails or answers out of shape judges nothing:
 * the room falls back to the ladder as if no model were configured.
 *
 * What it writes is a `light` row (types.ts), in the mind's room: `xi` sets lights aside
 * from the window before any rule reads it, so a light is never news and never input.
 */

import type { ModelTransport } from "./mu.ts";
import type { Color, Draft, Effort, Event, LightEvent, MessageEvent } from "./types.ts";
import type { DocEntry, Where } from "./store/docs.ts";
import { hhmm, ownComplex, ownVoice, textOf } from "./render.ts";
import { roomOnly } from "./room.ts";
import { LOCAL_CONNECTION } from "./session.ts";

/** How many of a room's last lines the judge reads: enough to see a thread's turn, few
 *  enough that the call stays a fraction of a think. */
export const SLICE_LINES = 20;

/** The answer's cap: a line of reason and a color. */
const JUDGE_MAX_TOKENS = 1024;

const COLORS: readonly Color[] = ["green", "yellow", "red"];

/** The shape the judge answers in: the reason first, so the color is said after it. */
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    color: { type: "string", enum: COLORS },
  },
  required: ["reason", "color"],
  additionalProperties: false,
};

export interface Judgment {
  color: Color;
  reason: string;
}

/** Who the room's lines are told from. */
export interface Seat {
  agentId: string;
  /** The session the judge works for: the mind. */
  id: string;
  /** The mind's own room, where a light is written. */
  conversation: string;
}

/**
 * The principal's standing word, the same for every room: the agent's own instructions,
 * its one-line memories, and the profiles that load always, the principal's among them
 * (`instructions/80-people.md` keeps profiles under `profiles/`). The agent's other docs
 * (what it learned about a beach, a procedure) say nothing about who can wait. Empty when
 * the agent keeps none of these.
 */
export function standingOf(docs: DocEntry[]): string {
  const kept = docs.filter(({ header: h, body }) =>
    h.scope === "agent" && h.load === "always" && body &&
    (h.name === "instructions" || h.name === "memories" || h.name.startsWith("profiles/"))
  );
  if (kept.length === 0) return "";
  return [
    "What the assistant keeps about the principal and the people in their life, from the " +
    "principal's own word:",
    ...kept.map(({ header: h, body }) => `\n[${h.name}]\n${body!.trim()}`),
  ].join("\n");
}

/** The docs about one room: a profile or note that loads while the room is in view, the
 *  person's or the group's, whoever keeps it. */
export function aboutOf(docs: DocEntry[], where: Where): DocEntry[] {
  return docs.filter(({ header: h, body }) =>
    h.load === "conditional" && body &&
    (h.conversations ?? []).some((c) => c.service === where.service && c.address === where.address)
  );
}

/** What one room shows the judge, as text: its name and kind, who holds the floor, the
 *  day, what the agent keeps about the room, and its last lines with the news set off
 *  below a rule. */
export function sliceOf(
  events: Event[],
  room: string,
  news: Set<string>,
  seat: Seat,
  today: string[],
  zone?: string,
  now = Date.now(),
  about: DocEntry[] = [],
): string {
  const lines = events.filter((e): e is MessageEvent =>
    e.type === "message" && e.envelope.conversation.address === room && !roomOnly(e)
  ).slice(-SLICE_LINES);
  const last = lines.at(-1);
  const where = last?.envelope.conversation;
  const head = [
    `Room: ${where?.name ?? room} (${where?.kind ?? "conversation"}, ${
      last?.envelope.service ?? "unknown"
    })`,
    floorOf(lines, seat, now),
    today.length > 0 ? `Today:\n${today.join("\n")}` : "Today: nothing on the calendar.",
    ...about.map(({ header: h, body }) => `\nAbout this room [${h.name}]:\n${body!.trim()}`),
  ];
  const body: string[] = [];
  let ruled = false;
  for (const e of lines) {
    if (!ruled && news.has(e.id)) {
      body.push("— new, to judge —");
      ruled = true;
    }
    // a transcript is its note's words: it speaks as the note's author, read off the note
    // the window holds, which a transcript carrying no author of its own needs
    const note = noteOf(e, events);
    const who = speakerOf(note ?? e, seat) + (note ? " (voice note, transcribed)" : "");
    body.push(`${hhmm(e.ts, zone)} ${who}: ${textOf(e) || wordless(e)}`);
  }
  return [...head, "", "Lines, oldest first:", ...body].join("\n");
}

/** Who said a line: the agent, its principal, or the sender as the wire names them. */
function speakerOf(e: MessageEvent, seat: Seat): string {
  if (ownVoice(e, seat)) return "agent";
  if (ownComplex(e, seat)) return "principal";
  const s = e.envelope.sender;
  return s?.name ?? s?.address ?? "someone";
}

/** A line with no words: the kind of what it carried (`[audio]`, `[image]`), or that it
 *  carried nothing readable. */
function wordless(e: MessageEvent): string {
  const file = e.parts.find((p) => p.type === "file");
  return file ? `[${file.kind}]` : "[no text]";
}

/** The note a transcript gives words to: the message its `ref_external_id` names on the
 *  wire, or its `ref_id` names in the log. Nothing for any other row, or for a transcript
 *  whose note the window no longer holds. */
export function noteOf(e: Event, events: Event[]): MessageEvent | undefined {
  if (e.type !== "message" || e.payload?.action !== "add") return undefined;
  if (!e.parts.some((p) => p.type === "text" && p.kind === "transcript")) return undefined;
  const ref = e.payload.ref_external_id;
  const id = e.payload.ref_id;
  return events.find((n): n is MessageEvent =>
    n.type === "message" &&
    ((typeof ref === "string" && ref !== "" && n.envelope.external_id === ref) ||
      (id !== undefined && n.id === id))
  );
}

/** Who holds the floor: the last line our side said there, the agent's or the principal's. */
function floorOf(lines: MessageEvent[], seat: Seat, now: number): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (!ownComplex(e, seat)) continue;
    const ago = Math.max(0, Math.round((now - Date.parse(e.ts)) / 60_000));
    return ownVoice(e, seat)
      ? `The agent spoke last on your side here, ${ago} min ago: it holds the floor.`
      : `The principal spoke last on your side here, ${ago} min ago.`;
  }
  return "Nobody on your side has spoken here in these lines.";
}

/** Ask the model for one room's light; nothing when the call fails or answers out of shape.
 *  The instruction and the standing word are the same for every room an agent judges, so
 *  the system closes on a cache mark and a burst of rooms reads it back. */
export async function judge(
  transport: ModelTransport,
  { model, effort }: { model: string; effort: Effort | null },
  instruction: string,
  slice: string,
  signal?: AbortSignal,
  standing = "",
): Promise<Judgment | undefined> {
  const system = [instruction, standing].filter((t) => t.trim() !== "")
    .map((text) => ({ type: "text" as const, text }));
  (system.at(-1) as { cache_control?: object }).cache_control = { type: "ephemeral" };
  try {
    const message = await transport(
      {
        model,
        max_tokens: JUDGE_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: slice }],
        output_config: {
          ...(effort ? { effort } : {}),
          format: { type: "json_schema", schema: ANSWER_SCHEMA },
        },
      } as Parameters<ModelTransport>[0],
      undefined,
      { kind: "decision" },
      signal,
    );
    const text = message.content.find((b) => b.type === "text")?.text;
    return text === undefined ? undefined : answerOf(text);
  } catch (err) {
    if (!signal?.aborted) console.error(`[decision] the judge failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** The answer read back, or nothing when it is not the shape asked for. */
export function answerOf(text: string): Judgment | undefined {
  try {
    const a = JSON.parse(text) as { color?: unknown; reason?: unknown };
    if (!COLORS.includes(a.color as Color) || typeof a.reason !== "string") return undefined;
    return { color: a.color as Color, reason: a.reason };
  } catch {
    return undefined;
  }
}

/** The light a judgment writes: in the mind's room, covering the room's news up to
 *  `consumed`, the last of its lines the judge read. */
export function lightOf(
  seat: Seat,
  room: string,
  consumed: string,
  j: Judgment,
  model: string,
): Draft<LightEvent> {
  return {
    ts: new Date().toISOString(),
    type: "light",
    envelope: {
      service: "local",
      connection_address: LOCAL_CONNECTION,
      conversation: { address: seat.conversation },
    },
    agent: { id: seat.agentId, session_id: seat.id },
    parts: [{ type: "data", kind: "light", data: { ...j, model, room } }],
    extra: { consumed },
  } as Draft<LightEvent>;
}
