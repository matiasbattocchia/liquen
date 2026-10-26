/**
 * exec/truncate.ts — the output truncation discipline (DESIGN §9, from pi).
 *
 * Two independent limits, whichever hits first: lines and bytes. Never partial lines
 * (one exception: a line that alone outgrows what is left of the window keeps its edges).
 * `bash` cuts the MIDDLE (what an output is shows at its start, how it ended at its end);
 * `aread` truncates from the HEAD; an output whose head was never read keeps its TAIL.
 */

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export interface Truncation {
  text: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  /** 1-indexed line number of the first shown line (tail truncation moves it up). */
  startLine: number;
  /** Set when the one shown line is only its own tail: that line's whole size, in bytes. */
  clippedLineBytes?: number;
}

export interface Limits {
  maxLines?: number;
  maxBytes?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (s: string) => encoder.encode(s).length;

/** The longest start of `s` within `n` bytes, never ending inside a character. */
function firstBytes(s: string, n: number): string {
  const b = encoder.encode(s);
  if (b.length <= n) return s;
  let end = Math.max(0, n);
  while (end > 0 && (b[end] & 0xC0) === 0x80) end--;
  return decoder.decode(b.subarray(0, end));
}

/** The longest end of `s` within `n` bytes, never starting inside a character. */
function lastBytes(s: string, n: number): string {
  const b = encoder.encode(s);
  if (b.length <= n) return s;
  let start = b.length - Math.max(0, n);
  while (start < b.length && (b[start] & 0xC0) === 0x80) start++;
  return decoder.decode(b.subarray(start));
}

/** `s.slice(0, n)` that never ends between the two halves of a surrogate pair. */
export function clipEnd(s: string, n: number): string {
  if (n >= s.length) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n);
}

/** `s.slice(i)` that never starts between the two halves of a surrogate pair. */
export function clipStart(s: string, i: number): string {
  const c = s.charCodeAt(i);
  return s.slice(c >= 0xDC00 && c <= 0xDFFF ? i + 1 : i);
}

/** Split for counting: a trailing newline does not create an extra empty line. */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Keep the FIRST lines that fit — for reads (the beginning matters). */
export function truncateHead(content: string, limits: Limits = {}): Truncation {
  const maxLines = limits.maxLines ?? MAX_LINES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const lines = splitLines(content);
  if (lines.length <= maxLines && bytes(content) <= maxBytes) {
    return {
      text: content,
      truncated: false,
      totalLines: lines.length,
      shownLines: lines.length,
      startLine: 1,
    };
  }
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    const cost = bytes(line) + (out.length > 0 ? 1 : 0);
    if (size + cost > maxBytes) break;
    out.push(line);
    size += cost;
  }
  return {
    text: out.join("\n"),
    truncated: true,
    totalLines: lines.length,
    shownLines: out.length,
    startLine: 1,
  };
}

/** Keep the LAST lines that fit — for command output (the end matters). */
export function truncateTail(content: string, limits: Limits = {}): Truncation {
  const maxLines = limits.maxLines ?? MAX_LINES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const lines = splitLines(content);
  if (lines.length <= maxLines && bytes(content) <= maxBytes) {
    return {
      text: content,
      truncated: false,
      totalLines: lines.length,
      shownLines: lines.length,
      startLine: 1,
    };
  }
  const out: string[] = [];
  let size = 0;
  let clippedLineBytes: number | undefined;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const cost = bytes(lines[i]) + (out.length > 0 ? 1 : 0);
    if (size + cost > maxBytes) {
      if (out.length === 0) {
        // even the last line alone exceeds the limit — keep its tail (char-safe)
        let tail = lines[i];
        while (bytes(tail) > maxBytes) tail = clipStart(tail, Math.ceil(tail.length / 8));
        out.unshift(tail);
        clippedLineBytes = cost;
      }
      break;
    }
    out.unshift(lines[i]);
    size += cost;
  }
  return {
    text: out.join("\n"),
    truncated: true,
    totalLines: lines.length,
    shownLines: out.length,
    startLine: lines.length - out.length + 1,
    ...(clippedLineBytes !== undefined ? { clippedLineBytes } : {}),
  };
}

/** What `truncateMiddle` kept: the start and the end, and what lies between them. */
export interface MiddleCut {
  /** The first lines that fit; where the gap opens inside a line, that line's start after. */
  head: string;
  /** Where the gap closes inside a line, that line's end; the last lines that fit after. */
  tail: string;
  truncated: boolean;
  totalLines: number;
  /** What was left out: lines `from`-`to` (1-indexed), whole unless `edges` — then the gap's
   *  outer lines keep their start or end in the head or the tail. `bytes` is what is gone,
   *  `lineBytes` those lines' whole size. */
  gap?: { from: number; to: number; bytes: number; lineBytes: number; edges: boolean };
}

/** The head's share of the window. An output says what it is at its start (the first
 *  answer, a response's opening keys, the first error of a cascade) and how it went at its
 *  end (the last error, the summary): the end is the verdict more often, so it keeps the
 *  larger part, and whatever the head leaves goes to it. */
const HEAD_SHARE = 0.4;

/** Keep the FIRST and the LAST lines that fit — for command output. A line the window
 *  cannot hold whole keeps its edges where the gap meets it: a response printed on one line
 *  shows how it opens and how it closes. */
export function truncateMiddle(content: string, limits: Limits = {}): MiddleCut {
  const maxLines = limits.maxLines ?? MAX_LINES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const lines = splitLines(content);
  const total = lines.length;
  if (total <= maxLines && bytes(content) <= maxBytes) {
    return { head: content, tail: "", truncated: false, totalLines: total };
  }
  const size = lines.map(bytes);
  // whole lines from the top, within the head's share; one line at least stays in the gap
  let h = 0;
  let used = 0;
  while (h < total - 1 && h < Math.floor(maxLines * HEAD_SHARE)) {
    const cost = size[h] + (h > 0 ? 1 : 0);
    if (used + cost > Math.floor(maxBytes * HEAD_SHARE)) break;
    used += cost;
    h++;
  }
  // whole lines from the bottom, within what the head left
  let t = 0;
  while (h + t < total - 1 && h + t < maxLines) {
    const cost = size[total - 1 - t] + 1;
    if (used + cost > maxBytes) break;
    used += cost;
    t++;
  }
  const from = h;
  const to = total - 1 - t;
  let lineBytes = to - from;
  for (let i = from; i <= to; i++) lineBytes += size[i];
  // what the window has left lends the gap's outer lines their edges, where no whole line
  // stands beside them: both sides when the gap is one line, else the side left bare
  const left = maxBytes - used;
  const lendStart = left > 0 && (from === to || h === 0);
  const lendEnd = left > 0 && (from === to || t === 0);
  const start = lendStart
    ? firstBytes(lines[from], lendEnd ? Math.floor(left * HEAD_SHARE) : left)
    : "";
  const end = lendEnd ? lastBytes(lines[to], left - bytes(start)) : "";
  const head = [...lines.slice(0, h), ...(start ? [start] : [])].join("\n");
  const tail = [...(end ? [end] : []), ...lines.slice(total - t)].join("\n");
  return {
    head,
    tail,
    truncated: true,
    totalLines: total,
    gap: {
      from: from + 1,
      to: to + 1,
      bytes: lineBytes - bytes(start) - bytes(end),
      lineBytes,
      edges: start !== "" || end !== "",
    },
  };
}
