import { assertEquals, assertThrows } from "@std/assert";
import { applyEdits, parseEdits } from "./edit.ts";

const spec = (...blocks: [string, string][]) =>
  blocks.map(([o, n]) => `<<<<<<<\n${o}\n=======\n${n}\n>>>>>>>`).join("\n");

Deno.test("parse: one block", () => {
  assertEquals(parseEdits(spec(["old", "new"])), [{ old: "old", new: "new" }]);
});

Deno.test("parse: multiple blocks, multi-line bodies", () => {
  const edits = parseEdits(spec(["a\nb", "c"], ["x", "y\nz"]));
  assertEquals(edits, [{ old: "a\nb", new: "c" }, { old: "x", new: "y\nz" }]);
});

Deno.test("parse: malformed specs throw", () => {
  assertThrows(() => parseEdits("no markers"), Error, "outside a block");
  assertThrows(() => parseEdits("<<<<<<<\nold"), Error, "unterminated");
  assertThrows(() => parseEdits(""), Error, "empty spec");
});

Deno.test("apply: exact replacement", () => {
  assertEquals(applyEdits("hello world", [{ old: "world", new: "mundo" }]), "hello mundo");
});

Deno.test("apply: multiple edits match the ORIGINAL, applied non-incrementally", () => {
  const out = applyEdits("aaa bbb ccc", [
    { old: "aaa", new: "bbb" }, // creates a second "bbb" — must not confuse edit 2
    { old: "ccc", new: "ddd" },
  ]);
  assertEquals(out, "bbb bbb ddd");
});

Deno.test("apply: ambiguous old text throws", () => {
  assertThrows(
    () => applyEdits("dup dup", [{ old: "dup", new: "x" }]),
    Error,
    "more than once",
  );
});

Deno.test("apply: missing old text throws", () => {
  assertThrows(() => applyEdits("abc", [{ old: "zzz", new: "x" }]), Error, "not found");
});

Deno.test("apply: overlapping edits throw", () => {
  assertThrows(
    () => applyEdits("abcdef", [{ old: "abcd", new: "x" }, { old: "cdef", new: "y" }]),
    Error,
    "overlap",
  );
});

Deno.test("apply: trailing-whitespace-insensitive fallback", () => {
  const content = "line one   \nline two";
  const out = applyEdits(content, [{ old: "line one\nline two", new: "merged" }]);
  assertEquals(out, "merged");
});

Deno.test("apply: CRLF preserved end-to-end", () => {
  const out = applyEdits("a\r\nb\r\nc", [{ old: "b", new: "B" }]);
  assertEquals(out, "a\r\nB\r\nc");
});

Deno.test("apply: BOM preserved", () => {
  const out = applyEdits("﻿hello", [{ old: "hello", new: "hola" }]);
  assertEquals(out, "﻿hola");
});

Deno.test("apply: the whitespace-insensitive fallback rewrites only the matched span", () => {
  const content = "a  \nb\nc  \n";
  const out = applyEdits(content, [{ old: "a\nb", new: "A\nB" }]);
  assertEquals(out, "A\nB\nc  \n"); // c's trailing spaces are not the edit's to take
});

Deno.test("parse: a CRLF spec parses like an LF one", () => {
  const edits = parseEdits("<<<<<<<\r\nold\r\n=======\r\nnew\r\n>>>>>>>\r\n");
  assertEquals(edits, [{ old: "old", new: "new" }]);
});
