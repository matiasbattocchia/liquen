/**
 * connect/telegram/text.ts — markdown at Telegram's wire (§4), both ways.
 *
 * The log speaks common markdown. Telegram carries plain text beside a list of ENTITIES,
 * each a span and what it is, so nothing in the text itself is markup: `fromTelegram`
 * writes the spans back as markers, `toTelegram` reads the markers out and answers the
 * bare text with its spans. Offsets count UTF-16 units on both sides, a JavaScript
 * string's own index.
 *
 * A marker inside code is content: a `code` or `pre` span takes no markers within it, and
 * outbound a backtick span or a fence is lifted out before anything else is read.
 */

import { type Claim, claimMentions, type NameEntry } from "../mentions.ts";
import type { TgEntity } from "./wire.ts";

/** The marker pair a span is written with. A span with none (an underline, a spoiler, a
 *  mention) leaves its text as it is. */
function markers(e: TgEntity): [string, string] | null {
  switch (e.type) {
    case "bold":
      return ["**", "**"];
    case "italic":
      return ["*", "*"];
    case "strike":
      return ["~~", "~~"];
    case "code":
      return ["`", "`"];
    case "pre":
      return [`\`\`\`${e.language ?? ""}\n`, "\n```"];
    case "link":
      return e.url ? ["[", `](${e.url})`] : null;
    default:
      return null;
  }
}

/** Telegram's text and entities as common markdown. A span is drawn around its words:
 *  the blanks at its edges stay outside the markers, where CommonMark wants them. */
export function fromTelegram(text: string, entities: TgEntity[]): string {
  const code = entities.filter((e) => e.type === "code" || e.type === "pre");
  const within = (e: TgEntity) =>
    code.some((c) => c !== e && c.offset <= e.offset && e.offset + e.length <= c.offset + c.length);
  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();
  const spans = entities
    .filter((e) => !within(e))
    .map((e) => {
      let start = e.offset;
      let end = Math.min(text.length, e.offset + e.length);
      if (e.type !== "pre" && e.type !== "code") {
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
      }
      return { start, end, marks: markers(e) };
    })
    .filter((s): s is { start: number; end: number; marks: [string, string] } =>
      s.marks !== null && s.end > s.start
    )
    // the outer span opens first and closes last
    .sort((a, b) => a.start - b.start || b.end - a.end);
  for (const s of spans) {
    opens.set(s.start, [...(opens.get(s.start) ?? []), s.marks[0]]);
    closes.set(s.end, [s.marks[1], ...(closes.get(s.end) ?? [])]);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    out += (closes.get(i) ?? []).join("") + (opens.get(i) ?? []).join("");
    if (i < text.length) out += text[i];
  }
  return out;
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)\n?```/;
const TICK = /`([^`\n]+)`/;
// bold, strike, a web link, then italic by either marker, each at a word's edge
const INLINE =
  /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*(?!\*)|~~(?=\S)([\s\S]+?)(?<=\S)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/;

interface Flat {
  text: string;
  entities: TgEntity[];
}

function shifted(entities: TgEntity[], by: number): TgEntity[] {
  return entities.map((e) => ({ ...e, offset: e.offset + by }));
}

/** Prose with no code in it: each marked span read out, the spans within it too. */
function inline(s: string): Flat {
  const out: Flat = { text: "", entities: [] };
  let rest = s;
  for (let m = INLINE.exec(rest); m; m = INLINE.exec(rest)) {
    out.text += rest.slice(0, m.index);
    const [whole, bold, strike, label, url, star, under] = m;
    const inner = inline(bold ?? strike ?? label ?? star ?? under);
    const type = bold !== undefined
      ? "bold"
      : strike !== undefined
      ? "strike"
      : label !== undefined
      ? "link"
      : "italic";
    const at = out.text.length;
    out.entities.push(
      { type, offset: at, length: inner.text.length, ...(type === "link" ? { url } : {}) },
      ...shifted(inner.entities, at),
    );
    out.text += inner.text;
    rest = rest.slice(m.index + whole.length);
  }
  out.text += rest;
  return out;
}

/** A heading is a line in bold: Telegram has no heading of its own. */
function headings(s: string): string {
  return s.replace(
    /^#{1,6}[ \t]+(.+?)[ \t]*$/gm,
    (_, line: string) => `**${line.replaceAll("**", "")}**`,
  );
}

/** Common markdown as Telegram's text and entities. */
export function toTelegram(markdown: string): Flat {
  const out: Flat = { text: "", entities: [] };
  const prose = (s: string) => {
    const read = inline(headings(s));
    out.entities.push(...shifted(read.entities, out.text.length));
    out.text += read.text;
  };
  const code = (s: string, type: "code" | "pre", language?: string) => {
    out.entities.push({
      type,
      offset: out.text.length,
      length: s.length,
      ...(language ? { language } : {}),
    });
    out.text += s;
  };
  let rest = markdown;
  while (rest !== "") {
    const fence = FENCE.exec(rest);
    const tick = TICK.exec(rest);
    const first = fence && (!tick || fence.index <= tick.index) ? fence : tick;
    if (!first) break;
    prose(rest.slice(0, first.index));
    if (first === fence) code(first[2], "pre", first[1].trim());
    else code(first[1], "code");
    rest = rest.slice(first.index + first[0].length);
  }
  prose(rest);
  return out;
}

/** The people an outbound text names, as spans over it: an `@Name` the room's directory
 *  claims becomes a mention of that person by id, and the words stay as typed. A handle
 *  Telegram resolves by itself (`@username`) needs no span, so only a person's id claims. */
export function mentionSpans(text: string, dir: NameEntry[]): TgEntity[] {
  const people = dir.filter((e) => e.type !== "#" && /^\d+$/.test(e.address));
  return claimMentions(text, people).map((c: Claim) => ({
    type: "mention_name" as const,
    offset: c.index,
    length: c.length,
    user: c.address,
  }));
}
