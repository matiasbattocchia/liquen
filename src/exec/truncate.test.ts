import { assert, assertEquals } from "@std/assert";
import { truncateHead, truncateTail } from "./truncate.ts";

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
});

Deno.test("trailing newline does not count as an extra line", () => {
  const t = truncateHead("a\nb\n", { maxLines: 10, maxBytes: 1000 });
  assertEquals(t.totalLines, 2);
});
