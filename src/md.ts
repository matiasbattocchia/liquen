/**
 * md.ts — markdown on a terminal, as it streams.
 *
 * The model writes markdown and a terminal shows text; the gap is closed here with the
 * few marks a chat answer actually uses — headings, code fences, bold, italic, inline
 * code — and nothing that needs the whole document first (tables, reference links). The
 * formatter is a stream: text goes in as it arrives, and what comes out is what can
 * already be shown. A span can only be styled once it closes, so the text from an
 * unclosed opener is held back until its closer arrives or the line ends — one delta of
 * latency, the same bargain the painter makes for `<|SILENCE|>`. A plain sentence, which
 * is most of them, streams untouched.
 */

export const BOLD = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";
export const ITALIC = "\x1b[3m";
export const ITALIC_OFF = "\x1b[23m";
export const CODE = "\x1b[36m";
export const CODE_OFF = "\x1b[39m";

export interface Markdown {
  /** Text as it arrives; returns what can be shown now. */
  feed(chunk: string): string;
  /** The end of the text: whatever was held comes out, styled as far as it got. */
  end(): string;
}

const HEADING = /^\s*#{1,6} /;
const FENCE = /^\s*```/;
/** A line whose start is not yet decided: it could still turn into a heading, or it is
 *  a fence, which is never shown and only resolves at its newline. */
const UNDECIDED = /^\s*(#{0,6}|```.*)$/;

export function markdown(): Markdown {
  let line = ""; // the current line, raw, as far as it has arrived
  let shown = 0; // how much of `line` is already out
  let opened = false; // the line's start has been decided
  let heading = false;
  let inCode = false; // inside a fence: nothing is styled

  const open = (): string => {
    opened = true;
    if (inCode) return "";
    const h = HEADING.exec(line);
    if (!h) return "";
    heading = true;
    shown = h[0].length;
    return BOLD;
  };

  const flow = (): string => {
    if (!opened) {
      if (UNDECIDED.test(line)) return "";
      const head = open();
      return head + flow();
    }
    const safe = inCode ? line.length : safeLength(line, shown);
    const piece = line.slice(shown, safe);
    shown = safe;
    return inCode ? piece : inline(piece, heading);
  };

  const close = (nl: boolean): string => {
    let out = "";
    if (!opened && FENCE.test(line)) {
      inCode = !inCode;
    } else {
      if (!opened) out += open();
      const rest = line.slice(shown);
      out += inCode ? rest : inline(rest, heading);
      if (heading) out += BOLD_OFF;
      if (nl) out += "\n";
    }
    line = "";
    shown = 0;
    opened = false;
    heading = false;
    return out;
  };

  return {
    feed(chunk) {
      let out = "";
      let rest = chunk;
      while (rest !== "") {
        const nl = rest.indexOf("\n");
        if (nl === -1) {
          line += rest;
          rest = "";
          out += flow();
        } else {
          line += rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          out += close(true);
        }
      }
      return out;
    },
    end() {
      const out = line === "" && !opened ? "" : close(false);
      inCode = false;
      return out;
    },
  };
}

/** The whole of a text, styled: a message that is already complete. */
export function renderMarkdown(text: string): string {
  const m = markdown();
  return m.feed(text) + m.end();
}

/** Can a marker at `i` open a span? At the start of the text or after a space or an
 *  opening bracket, and followed by something that is not a space. */
const opens = (s: string, i: number, len: number): boolean =>
  (i === 0 || /[\s(\[]/.test(s[i - 1])) && i + len < s.length && !/\s/.test(s[i + len]);
/** Can a marker at `i` close a span? Preceded by something that is not a space, and
 *  followed by the end, a space, or punctuation. */
const closes = (s: string, i: number, len: number): boolean =>
  i > 0 && !/\s/.test(s[i - 1]) && (i + len >= s.length || /[\s.,;:!?)\]]/.test(s[i + len]));

/** How far into `line`, from `from`, every span is closed: the index of the earliest
 *  opener still waiting for its closer, or the end when none is. Backtick runs pair with
 *  a run of the same length and nothing inside them counts. */
export function safeLength(line: string, from = 0): number {
  let code = 0; // the length of the backtick run that opened a code span, 0 outside one
  let codeAt = -1;
  let bold = -1; // where the unclosed `**` stands, -1 when closed
  let italic = -1;
  let mark = ""; // the italic marker in force
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (code === 0) {
        code = run;
        codeAt = i;
      } else if (run === code) code = 0;
      i += run - 1;
      continue;
    }
    if (code > 0) continue;
    if (c === "*" && line[i + 1] === "*") {
      if (bold === -1 && opens(line, i, 2)) bold = i;
      else if (bold !== -1 && closes(line, i, 2)) bold = -1;
      i++;
      continue;
    }
    if (c === "*" || c === "_") {
      if (italic === -1 && opens(line, i, 1)) {
        italic = i;
        mark = c;
      } else if (italic !== -1 && c === mark && closes(line, i, 1)) italic = -1;
    }
  }
  const open = [code > 0 ? codeAt : -1, bold, italic].filter((i) => i !== -1);
  return open.length === 0 ? line.length : Math.min(...open);
}

/** Style the spans of a piece whose spans all close inside it. Code spans are lifted out
 *  first, so a `**` inside one stays a `**`. Inside a heading the bold is the line's,
 *  so a bold span there wears no codes of its own — `BOLD_OFF` would end the heading. */
export function inline(piece: string, heading = false): string {
  return piece.split(/(`+.+?`+)/).map((part, i) => {
    if (i % 2 === 1) {
      const run = /^`+/.exec(part)![0].length;
      return `${CODE}${part.slice(run, -run)}${CODE_OFF}`;
    }
    return part
      .replace(
        /(^|[\s(\[])\*\*(\S(?:.*?\S)?)\*\*(?=$|[\s.,;:!?)\]])/g,
        (_, pre, t) => heading ? `${pre}${t}` : `${pre}${BOLD}${t}${BOLD_OFF}`,
      )
      .replace(
        /(^|[\s(\[])([*_])(\S(?:.*?\S)?)\2(?=$|[\s.,;:!?)\]])/g,
        (_, pre, __, t) => `${pre}${ITALIC}${t}${ITALIC_OFF}`,
      );
  }).join("");
}
