/**
 * line.ts — the input line of an attached surface (DESIGN §9): what the principal is
 * typing, and the lines they typed before.
 *
 * A terminal hands a program whole lines only while the kernel does the editing, and the
 * kernel's editor has no memory and no arrows — an arrow key reaches the program as the
 * three bytes it is, and lands in the message. Raw mode moves the job here: keys arrive as
 * bytes, this file holds the buffer, the cursor and the ring, and it owns the bottom of
 * the screen. Owning it is what lets the transcript stream while you type — every write
 * erases the line, prints above it, and draws it back where your cursor was.
 *
 * Where there is no terminal — a pipe, a test — there is no cursor to place: the same
 * interface reads whole lines and writes them straight through, so the surface above it
 * has one loop either way.
 *
 * The keys and the buffer are separated on purpose: `keys()` turns bytes into intents and
 * `edit()` applies one to a buffer, both pure, so the editor is tested without a tty.
 */

import { TextLineStream } from "@std/streams";

/** Columns to assume when the terminal will not say. */
const FALLBACK_COLS = 80;

/** One intent, decoded from what the terminal sent. */
export type Key =
  | { k: "insert"; text: string }
  | { k: "left" }
  | { k: "right" }
  | { k: "word-left" }
  | { k: "word-right" }
  | { k: "home" }
  | { k: "end" }
  | { k: "back" }
  | { k: "delete" }
  | { k: "kill-word" }
  | { k: "kill-start" }
  | { k: "kill-end" }
  | { k: "prev" }
  | { k: "next" }
  | { k: "enter" }
  | { k: "clear" }
  | { k: "eof" };

/** The line being typed: its text, and where the cursor sits in it (in code points). */
export interface Edit {
  text: string;
  at: number;
}

/** The lines already sent, walked by the up and down arrows. The line in progress is the
 *  ring's last stop, so walking up and back down returns what you were writing. */
export interface Ring {
  /** The previous line, `undefined` at the oldest; `now` is the line being left behind. */
  prev(now: string): string | undefined;
  /** The next line, back toward the one in progress; `undefined` when already there. */
  next(): string | undefined;
  /** Remember a sent line and return to the end. */
  add(line: string): void;
}

export function createRing(seed: readonly string[] = []): Ring {
  const past = seed.filter((l) => l !== "");
  let at = past.length; // === past.length ⇒ standing on the line in progress
  let draft = "";
  return {
    prev(now) {
      if (at === past.length) draft = now;
      if (at === 0) return undefined;
      return past[--at];
    },
    next() {
      if (at >= past.length) return undefined;
      at++;
      return at === past.length ? draft : past[at];
    },
    add(line) {
      // a line repeated back to back is one entry: the ring is for reaching, not counting
      if (line !== "" && past[past.length - 1] !== line) past.push(line);
      at = past.length;
      draft = "";
    },
  };
}

/** Decode a chunk of terminal input into intents. Printable runs coalesce, so a paste
 *  arrives as one insert; an escape sequence nobody here speaks is dropped whole, never
 *  typed into the line. */
export function keys(chunk: string): Key[] {
  const out: Key[] = [];
  const chars = [...chunk];
  let text = "";
  const flush = () => {
    if (text !== "") out.push({ k: "insert", text });
    text = "";
  };
  const push = (k: Key) => {
    flush();
    out.push(k);
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\x1b") {
      const seq = escape(chars, i);
      i += seq.used - 1;
      flush();
      if (seq.key) out.push(seq.key);
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && chars[i + 1] === "\n") i++; // one newline, however the terminal spells it
      push({ k: "enter" });
      continue;
    }
    if (c === "\x7f" || c === "\b") push({ k: "back" });
    else if (c === "\x01") push({ k: "home" });
    else if (c === "\x02") push({ k: "left" });
    else if (c === "\x03") push({ k: "clear" });
    else if (c === "\x04") push({ k: "eof" });
    else if (c === "\x05") push({ k: "end" });
    else if (c === "\x06") push({ k: "right" });
    else if (c === "\x0b") push({ k: "kill-end" });
    else if (c === "\x0e") push({ k: "next" });
    else if (c === "\x10") push({ k: "prev" });
    else if (c === "\x15") push({ k: "kill-start" });
    else if (c === "\x17") push({ k: "kill-word" });
    else if (c >= " ") text += c;
    // every other control byte is not a key this line speaks
  }
  flush();
  return out;
}

/** One escape sequence from `at`: the intent it carries (none, for a sequence this line
 *  does not speak) and how many characters it spent. */
function escape(chars: string[], at: number): { key?: Key; used: number } {
  const next = chars[at + 1];
  if (next === undefined) return { used: 1 }; // a lone ESC ends the chunk — nothing to place
  if (next === "b") return { key: { k: "word-left" }, used: 2 };
  if (next === "f") return { key: { k: "word-right" }, used: 2 };
  if (next !== "[" && next !== "O") return { used: 2 };
  // CSI: parameters, then one final byte in @‥~ that names the key
  let i = at + 2;
  while (i < chars.length && chars[i] >= "0" && chars[i] <= "?") i++;
  const final = chars[i];
  if (final === undefined) return { used: chars.length - at };
  const params = chars.slice(at + 2, i).join("");
  const used = i - at + 1;
  const ctrl = params.endsWith(";5") || params.endsWith(";3"); // control or alt held
  switch (final) {
    case "A":
      return { key: { k: "prev" }, used };
    case "B":
      return { key: { k: "next" }, used };
    case "C":
      return { key: { k: ctrl ? "word-right" : "right" }, used };
    case "D":
      return { key: { k: ctrl ? "word-left" : "left" }, used };
    case "H":
      return { key: { k: "home" }, used };
    case "F":
      return { key: { k: "end" }, used };
    case "~":
      if (params === "1" || params === "7") return { key: { k: "home" }, used };
      if (params === "4" || params === "8") return { key: { k: "end" }, used };
      if (params === "3") return { key: { k: "delete" }, used };
      return { used };
    default:
      return { used };
  }
}

/** Apply one intent to the line. The keys that are not the line's own — enter, the ring,
 *  the hang-ups — pass through untouched: the caller answers those. */
export function edit(e: Edit, k: Key): Edit {
  const chars = [...e.text];
  const join = (c: string[], at: number): Edit => ({ text: c.join(""), at });
  switch (k.k) {
    case "insert": {
      const add = [...k.text];
      chars.splice(e.at, 0, ...add);
      return join(chars, e.at + add.length);
    }
    case "left":
      return { text: e.text, at: Math.max(0, e.at - 1) };
    case "right":
      return { text: e.text, at: Math.min(chars.length, e.at + 1) };
    case "word-left":
      return { text: e.text, at: wordStart(chars, e.at) };
    case "word-right":
      return { text: e.text, at: wordEnd(chars, e.at) };
    case "home":
      return { text: e.text, at: 0 };
    case "end":
      return { text: e.text, at: chars.length };
    case "back": {
      if (e.at === 0) return e;
      chars.splice(e.at - 1, 1);
      return join(chars, e.at - 1);
    }
    case "delete": {
      if (e.at >= chars.length) return e;
      chars.splice(e.at, 1);
      return join(chars, e.at);
    }
    case "kill-word": {
      const from = wordStart(chars, e.at);
      chars.splice(from, e.at - from);
      return join(chars, from);
    }
    case "kill-start":
      return join(chars.slice(e.at), 0);
    case "kill-end":
      return join(chars.slice(0, e.at), e.at);
    case "clear":
      return { text: "", at: 0 };
    default:
      return e;
  }
}

const WORD = /[\p{L}\p{N}_]/u;

/** The start of the word left of the cursor: the spaces first, then the run. */
function wordStart(chars: string[], at: number): number {
  let i = at;
  while (i > 0 && !WORD.test(chars[i - 1])) i--;
  while (i > 0 && WORD.test(chars[i - 1])) i--;
  return i;
}

function wordEnd(chars: string[], at: number): number {
  let i = at;
  while (i < chars.length && !WORD.test(chars[i])) i++;
  while (i < chars.length && WORD.test(chars[i])) i++;
  return i;
}

/** The surface's terminal: the transcript prints through it, the line lives at the bottom
 *  of it, and the principal's lines come out of it. */
export interface Screen {
  /** Every line the principal sends, until the input ends (Ctrl-D, or a closed pipe). */
  lines(): AsyncIterableIterator<string>;
  /** Transcript text — printed above the line being typed, which stays where it was. */
  write(s: string): void;
  /** Close the row the transcript stands on. Nothing to close, nothing written. */
  prompt(): void;
  /** Open a block: leave exactly one blank row under what was said, however much of it
   *  already stands. Asking twice is asking once — which is what keeps a transcript from
   *  drifting downward as the parts that print take turns each assuming the worst. */
  gap(): void;
  /** Hand the terminal back the way it was found. */
  close(): void;
}

/** What the tail of a transcript stands as, kept by whoever does the writing. Escapes
 *  paint, they do not move: only the newlines count, and two is the ceiling — nothing on
 *  screen is ever owed more than one blank row. */
export function tailOf() {
  let gap = 2; // an empty screen already stands as though a blank row were under it
  return {
    /** Take account of what was just written. */
    note(s: string) {
      const plain = s.replace(ESCAPES, "");
      if (plain === "") return;
      const body = plain.replace(/\n+$/, "");
      const ends = plain.length - body.length;
      gap = ends === 0 ? 0 : Math.min(2, (body === "" ? gap : 0) + ends);
    },
    /** The newlines still owed to stand `want` deep: 1 = a closed row, 2 = a blank one. */
    owed(want: 1 | 2): string {
      return "\n".repeat(Math.max(0, want - gap));
    },
  };
}

export interface ScreenOptions {
  /** What stands at the head of the line — asked for at every draw, so a surface can
   *  show there what is true only now (what is waiting to be answered). Columns only:
   *  the head is measured to place the cursor, and an escape would be counted. */
  head?: string | (() => string);
  /** How a sent line stands in the transcript once entered — the surface's chance to
   *  date and mark it. Default: the head and the line, as they were typed. */
  sent?: (line: string) => string;
  /** The lines already sent, oldest first — the ring opens standing after them. Asked for
   *  when the first line is read, so a surface may still be learning its past while it
   *  builds the screen it will print on. */
  recalled?: () => readonly string[];
}

/** A screen over stdin and stdout: the editor when a terminal is there to edit on, whole
 *  lines when it is not. */
export function createScreen(opts: ScreenOptions = {}): Screen {
  const given = opts.head ?? "> ";
  const head = typeof given === "function" ? given : () => given;
  const recalled = opts.recalled ?? (() => []);
  const sent = opts.sent ?? ((line: string) => head() + line);
  return Deno.stdin.isTerminal() ? editor(head, recalled, sent) : plain(head);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const encoder = new TextEncoder();
const out = (s: string) => {
  if (s !== "") Deno.stdout.writeSync(encoder.encode(s));
};

/** No terminal: the kernel's lines are the principal's lines, and the transcript is
 *  whatever we print. */
function plain(head: () => string): Screen {
  const tail = tailOf();
  const say = (s: string) => {
    tail.note(s);
    out(s);
  };
  return {
    async *lines() {
      const stream = Deno.stdin.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      say(head());
      for await (const line of stream) {
        yield line;
        say(head());
      }
    },
    write: say,
    prompt: () => say(tail.owed(1) + head()),
    gap: () => say(tail.owed(2)),
    close: () => {},
  };
}

/** The editor: raw keys in, one owned block of screen at the bottom.
 *
 * The block is a rule across the screen — the transcript ends above it, the line lives
 * below, so the last `❯` of the transcript and the empty one of the line are never taken
 * for each other — then `head` plus the line, wrapped over as many rows as it takes.
 * `erase` walks back up over all of it and leaves the cursor where the transcript last
 * stopped — mid-row if the transcript stopped mid-row, so a streamed sentence continues
 * where it left off. */
function editor(
  head: () => string,
  recalled: () => readonly string[],
  sent: (line: string) => string,
): Screen {
  let e: Edit = { text: "", at: 0 };
  let drawn = false;
  let rows = 1; // rows the drawn line spans, the rule's not counted
  let row = 0; // the row within it the cursor sits on
  let broke = false; // the block opened with a newline of its own
  let col = 0; // the SCREEN column the transcript stands at, wraps counted
  let raw = false;
  let closed = false; // the terminal is the caller's again: print, draw nothing

  const tail = tailOf();
  const transcript = (s: string) => {
    out(s);
    tail.note(s);
    col = columnAfter(col, s, cols());
  };

  const cols = () => {
    try {
      return Deno.consoleSize().columns || FALLBACK_COLS;
    } catch {
      return FALLBACK_COLS;
    }
  };

  const paint = () => {
    broke = col > 0; // the block never shares a row with the transcript
    if (broke) out("\n");
    const width = cols();
    out(`${DIM}${"─".repeat(width)}${RESET}\n`);
    const line = head() + e.text;
    const len = [...line].length;
    out(line);
    rows = Math.floor(Math.max(0, len - 1) / width) + 1;
    if (len > 0 && len % width === 0) {
      out("\n\r"); // the text filled the last row exactly: open the one the cursor needs
      rows++;
    }
    const pos = [...head()].length + e.at;
    row = Math.floor(pos / width);
    const up = rows - 1 - row;
    if (up > 0) out(`\x1b[${up}A`);
    out("\r");
    const right = pos % width;
    if (right > 0) out(`\x1b[${right}C`);
    drawn = true;
  };

  const erase = () => {
    if (!drawn) return;
    const down = rows - 1 - row;
    if (down > 0) out(`\x1b[${down}B`);
    for (let i = rows; i > 0; i--) out("\r\x1b[0K\x1b[1A"); // the line's rows, up onto the rule
    out("\r\x1b[0K"); // the rule
    if (broke) {
      out("\x1b[1A"); // back onto the transcript's own row, where it stopped
      if (col > 0) out(`\x1b[${col}C`);
    }
    drawn = false;
  };

  const redraw = () => {
    erase();
    paint();
  };

  /** Leave the transcript standing `want` deep — a closed row, or a blank one under it —
   *  writing only what it does not already stand as. Nothing owed, nothing touched: the
   *  block below stays exactly as it was drawn. */
  const stand = (want: 1 | 2) => {
    const owed = tail.owed(want);
    if (owed === "") return;
    erase();
    transcript(owed);
    if (!closed) paint();
  };

  const setRaw = (on: boolean) => {
    if (raw === on) return;
    try {
      Deno.stdin.setRaw(on);
      raw = on;
    } catch { /* not a terminal any more — the reads will say so */ }
  };

  return {
    async *lines() {
      setRaw(true);
      const ring = createRing(recalled());
      const decoder = new TextDecoder();
      const buf = new Uint8Array(4096);
      try {
        redraw();
        for (;;) {
          let n: number | null;
          try {
            n = await Deno.stdin.read(buf);
          } catch {
            return; // stdin closed under the read
          }
          if (n === null) return;
          for (const k of keys(decoder.decode(buf.subarray(0, n), { stream: true }))) {
            if (k.k === "enter") {
              // the sent line joins the transcript — dated and marked as the surface
              // says — and the block is drawn fresh below it; an empty one joins nothing
              const line = e.text;
              erase();
              // the sent line is the principal's block: it stands clear of the last one,
              // by however much the transcript does not already stand clear
              if (line !== "") transcript(`${tail.owed(2)}${sent(line)}\n`);
              ring.add(line);
              e = { text: "", at: 0 };
              // the caller works between lines: what it writes lands above a line drawn
              // fresh and empty, and the next read finds the cursor already on it
              yield line;
              setRaw(true); // a caller that ran a child may have taken the terminal back
              redraw();
              continue;
            }
            if (k.k === "eof") {
              if (e.text === "") {
                erase();
                return;
              }
              e = edit(e, { k: "delete" });
            } else if (k.k === "prev" || k.k === "next") {
              const line = k.k === "prev" ? ring.prev(e.text) : ring.next();
              if (line === undefined) continue;
              e = { text: line, at: [...line].length };
            } else {
              e = edit(e, k);
            }
            redraw();
          }
        }
      } finally {
        setRaw(false);
      }
    },
    write(s) {
      erase();
      transcript(s);
      if (!closed) paint();
    },
    prompt() {
      stand(1);
    },
    gap() {
      stand(2);
    },
    close() {
      erase();
      closed = true;
      setRaw(false);
    },
  };
}

// CSI sequences move the cursor and colour it; they occupy no column — ESC is the byte
// that opens one, so the control character is the point of the pattern
// deno-lint-ignore no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[@-~]/g;

/**
 * Where the cursor stands after printing `s` from column `col` — a SCREEN column, so it
 * counts what the terminal shows and not what was written. A line longer than the screen
 * is already on a later row by the time it ends, and a count that kept climbing sent the
 * repaint's `\x1b[{col}C` past the right margin, where it clamps: every streamed chunk
 * after the first wrap printed hard against the edge.
 *
 * A width the text fills exactly answers `width`, never 0: the terminal holds that cursor
 * at the last column with the wrap still pending, and `width` is both the column it is at
 * and the "a newline is owed here" the repaint needs.
 */
export function columnAfter(col: number, s: string, width = FALLBACK_COLS): number {
  const plain = s.replace(ESCAPES, "");
  const nl = plain.lastIndexOf("\n");
  const tail = nl === -1 ? plain : plain.slice(nl + 1);
  const cr = tail.lastIndexOf("\r");
  const from = nl === -1 && cr === -1 ? col : 0;
  const at = from + [...(cr === -1 ? tail : tail.slice(cr + 1))].length;
  const on = at % width;
  return on === 0 && at > 0 ? width : on;
}
