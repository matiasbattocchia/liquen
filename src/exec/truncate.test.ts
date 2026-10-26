import { assert, assertEquals } from "@std/assert";
import { truncateHead, truncateMiddle, truncateTail } from "./truncate.ts";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

Deno.test("no truncation when under both limits", () => {
  const t = truncateHead("a\nb\nc", { maxLines: 10, maxBytes: 1000 });
  assertEquals(t.truncated, false);
  assertEquals(t.text, "a\nb\nc");
  assertEquals(t.totalLines, 3);
});

Deno.test("head: keeps the FIRST lines; line limit", () => {
  const t = truncateHead(numbered(10), { maxLines: 3, maxBytes: 1000 });
  assertEquals(t.text, "line 1\nline 2\nline 3");
  assertEquals(t.truncated, true);
  assertEquals(t.shownLines, 3);
  assertEquals(t.totalLines, 10);
  assertEquals(t.startLine, 1);
});

Deno.test("tail: keeps the LAST lines; startLine reports the window", () => {
  const t = truncateTail(numbered(10), { maxLines: 3, maxBytes: 1000 });
  assertEquals(t.text, "line 8\nline 9\nline 10");
  assertEquals(t.startLine, 8);
  assertEquals(t.totalLines, 10);
});

Deno.test("byte limit wins when hit first; never partial lines", () => {
  const t = truncateHead(numbered(100), { maxLines: 1000, maxBytes: 20 });
  assert(t.truncated);
  assert(!t.text.includes("line 4")); // "line 1\nline 2\nline 3" = 20 bytes
  assert(t.text.endsWith("line 3") || t.text.endsWith("line 2"));
});

Deno.test("tail: a single oversized line yields its tail, char-safe", () => {
  const t = truncateTail("x".repeat(200), { maxLines: 10, maxBytes: 50 });
  assert(t.truncated);
  assert(t.text.length <= 50);
  assert(t.text.length > 0);
  assertEquals(t.clippedLineBytes, 200);
});

Deno.test("tail: an oversized last line says it was clipped; whole lines say nothing", () => {
  const t = truncateTail(`first\n${"y".repeat(300)}`, { maxLines: 10, maxBytes: 100 });
  assertEquals([t.startLine, t.totalLines, t.clippedLineBytes], [2, 2, 300]);
  const whole = truncateTail(numbered(10), { maxLines: 3, maxBytes: 1000 });
  assertEquals(whole.clippedLineBytes, undefined);
});

Deno.test("trailing newline does not count as an extra line", () => {
  const t = truncateHead("a\nb\n", { maxLines: 10, maxBytes: 1000 });
  assertEquals(t.totalLines, 2);
});

Deno.test("tail: an oversized line of astral characters is cut between them, never inside one", () => {
  for (let n = 10; n <= 120; n += 7) {
    for (let m = 17; m <= 90; m += 9) {
      if (n * 4 <= m) continue; // fits whole
      const t = truncateTail("😀".repeat(n), { maxLines: 10, maxBytes: m });
      assert(t.truncated);
      assert(t.text.length > 0);
      assert(t.text.isWellFormed(), `${n} emoji under ${m} bytes: ${JSON.stringify(t.text)}`);
    }
  }
});

Deno.test("middle: keeps the first and the last lines, the gap between them named", () => {
  const t = truncateMiddle(numbered(100), { maxLines: 10, maxBytes: 10_000 });
  assertEquals(t.head, "line 1\nline 2\nline 3\nline 4"); // 40% of the lines
  assertEquals(t.tail, numbered(100).split("\n").slice(94).join("\n"));
  assertEquals(t.gap, {
    from: 5,
    to: 94,
    bytes: t.gap!.lineBytes,
    lineBytes: t.gap!.lineBytes,
    edges: false,
  });
  assertEquals(t.totalLines, 100);
});

Deno.test("middle: under both limits the text is whole, all head", () => {
  const t = truncateMiddle("a\nb", { maxLines: 10, maxBytes: 100 });
  assertEquals([t.head, t.tail, t.truncated, t.gap], ["a\nb", "", false, undefined]);
});

Deno.test("middle: a response on one line keeps how it opens and how it closes", () => {
  const line = `{status: 200, body: {events: [${"x".repeat(5000)}]}}`;
  const t = truncateMiddle(line, { maxLines: 10, maxBytes: 1000 });
  assert(t.head.startsWith("{status: 200, body: {events: ["));
  assert(t.tail.endsWith("]}}"));
  assert(new TextEncoder().encode(t.head + t.tail).length <= 1000);
  assertEquals([t.gap!.from, t.gap!.to, t.gap!.edges, t.gap!.lineBytes], [1, 1, true, line.length]);
  assertEquals(t.gap!.bytes, line.length - t.head.length - t.tail.length);
});

Deno.test("middle: a short first line stays whole beside a long second one's edges", () => {
  // two calls joined, the second's answer far past the window: both are seen
  const t = truncateMiddle(`{contacts: []}\n{events: [${"y".repeat(9000)}]}`, {
    maxLines: 10,
    maxBytes: 2000,
  });
  assert(t.head.startsWith("{contacts: []}\n{events: [y"));
  assert(t.tail.endsWith("y]}"));
  assertEquals([t.gap!.from, t.gap!.to, t.gap!.edges], [2, 2, true]);
});

Deno.test("middle: an oversized line's edges are cut between characters, never inside one", () => {
  for (let n = 10; n <= 120; n += 7) {
    for (let m = 17; m <= 90; m += 9) {
      if (n * 4 <= m) continue;
      const t = truncateMiddle("😀".repeat(n), { maxLines: 10, maxBytes: m });
      assert(!(t.head + t.tail).includes("�"));
      assert([...t.head, ...t.tail].every((c) => c === "😀"));
      assert(new TextEncoder().encode(t.head + t.tail).length <= m);
    }
  }
});
