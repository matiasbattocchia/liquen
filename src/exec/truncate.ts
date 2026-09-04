/**
 * exec/truncate.ts — the output truncation discipline (DESIGN §9, from pi).
 *
 * Two independent limits, whichever hits first: lines and bytes. Never partial lines
 * (one exception: tail truncation when even the last line alone exceeds the byte limit).
 * `bash` truncates from the TAIL (errors live at the end); `aread` from the HEAD.
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
}

export interface Limits {
  maxLines?: number;
  maxBytes?: number;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

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
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const cost = bytes(lines[i]) + (out.length > 0 ? 1 : 0);
    if (size + cost > maxBytes) {
      if (out.length === 0) {
        // even the last line alone exceeds the limit — keep its tail (char-safe)
        let tail = lines[i];
        while (bytes(tail) > maxBytes) tail = clipStart(tail, Math.ceil(tail.length / 8));
        out.unshift(tail);
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
  };
}
