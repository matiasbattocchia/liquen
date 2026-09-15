/**
 * line.test.ts — the input line (§9): bytes become intents, intents move a buffer, and the
 * ring reaches back through what was sent. All three are pure, so the editor is proved
 * without a terminal — which is also why they are separate in the first place.
 */

import { assertEquals } from "@std/assert";
import { columnAfter, createRing, type Edit, edit, keys, tailOf } from "./line.ts";

/** Type a chunk into a line, the way the editor's loop does. */
function type(start: Edit, chunk: string): Edit {
  let e = start;
  for (const k of keys(chunk)) e = edit(e, k);
  return e;
}

const empty: Edit = { text: "", at: 0 };

Deno.test("keys: printable runs coalesce into one insert", () => {
  assertEquals(keys("hola"), [{ k: "insert", text: "hola" }]);
  assertEquals(keys("¿qué tal?"), [{ k: "insert", text: "¿qué tal?" }]);
});

Deno.test("keys: an arrow is one intent, never three characters of message", () => {
  assertEquals(keys("\x1b[D"), [{ k: "left" }]);
  assertEquals(keys("\x1b[C"), [{ k: "right" }]);
  assertEquals(keys("\x1b[A"), [{ k: "prev" }]);
  assertEquals(keys("\x1b[B"), [{ k: "next" }]);
  assertEquals(keys("\x1b[1;5D"), [{ k: "word-left" }]);
  assertEquals(keys("\x1b[1;5C"), [{ k: "word-right" }]);
  assertEquals(keys("\x1b[H"), [{ k: "home" }]);
  assertEquals(keys("\x1b[4~"), [{ k: "end" }]);
  assertEquals(keys("\x1b[3~"), [{ k: "delete" }]);
  // an escape sequence this line does not speak is dropped whole
  assertEquals(keys("\x1b[200~hola"), [{ k: "insert", text: "hola" }]);
});

Deno.test("keys: the control bytes a line answers to", () => {
  assertEquals(keys("\x01\x05\x7f\x17\x15\x0b\x03\x04"), [
    { k: "home" },
    { k: "end" },
    { k: "back" },
    { k: "kill-word" },
    { k: "kill-start" },
    { k: "kill-end" },
    { k: "clear" },
    { k: "eof" },
  ]);
});

Deno.test("keys: a newline is one enter however the terminal spells it", () => {
  assertEquals(keys("a\r\nb\n"), [
    { k: "insert", text: "a" },
    { k: "enter" },
    { k: "insert", text: "b" },
    { k: "enter" },
  ]);
});

Deno.test("edit: the cursor places, and text lands where it stands", () => {
  const typed = type(empty, "hola mundo");
  assertEquals(typed, { text: "hola mundo", at: 10 });
  const back = type(typed, "\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D");
  assertEquals(back.at, 5);
  assertEquals(type(back, "el "), { text: "hola el mundo", at: 8 });
});

Deno.test("edit: the cursor stops at both ends", () => {
  assertEquals(type(empty, "\x1b[D\x1b[D"), empty);
  assertEquals(type(type(empty, "ab"), "\x1b[C\x1b[C"), { text: "ab", at: 2 });
});

Deno.test("edit: home, end and the word jumps", () => {
  const e = type(empty, "uno dos tres");
  assertEquals(type(e, "\x01").at, 0);
  assertEquals(type(type(e, "\x01"), "\x05").at, 12);
  assertEquals(type(e, "\x1b[1;5D").at, 8); // the start of "tres"
  assertEquals(type(type(e, "\x01"), "\x1b[1;5C").at, 3); // the end of "uno"
});

Deno.test("edit: backspace and delete take the character on their own side", () => {
  assertEquals(type(empty, "hola\x7f"), { text: "hol", at: 3 });
  assertEquals(type(type(empty, "hola"), "\x01\x1b[3~"), { text: "ola", at: 0 });
  // nothing to take: the line stands as it was
  assertEquals(type(empty, "\x7f"), empty);
  assertEquals(type(type(empty, "ab"), "\x1b[3~"), { text: "ab", at: 2 });
});

Deno.test("edit: the kills — a word, the head, the tail", () => {
  assertEquals(type(empty, "uno dos\x17"), { text: "uno ", at: 4 });
  const mid = type(type(empty, "uno dos"), "\x1b[D\x1b[D\x1b[D"); // before "dos"
  assertEquals(type(mid, "\x15"), { text: "dos", at: 0 });
  assertEquals(type(mid, "\x0b"), { text: "uno ", at: 4 });
  assertEquals(type(type(empty, "uno"), "\x03"), empty);
});

Deno.test("edit: a code point is one character, however many bytes it is", () => {
  const e = type(empty, "añó");
  assertEquals(e, { text: "añó", at: 3 });
  assertEquals(type(e, "\x7f"), { text: "añ", at: 2 });
});

Deno.test("ring: up walks back through what was sent, down returns to the line in progress", () => {
  const r = createRing(["uno", "dos"]);
  assertEquals(r.prev("escribiendo"), "dos");
  assertEquals(r.prev("dos"), "uno");
  assertEquals(r.prev("uno"), undefined); // the oldest: there is nothing further back
  assertEquals(r.next(), "dos");
  assertEquals(r.next(), "escribiendo"); // what was being written, kept
  assertEquals(r.next(), undefined);
});

Deno.test("ring: a sent line joins the end, and a repeat is one entry", () => {
  const r = createRing([]);
  r.add("hola");
  r.add("hola");
  r.add("");
  assertEquals(r.prev(""), "hola");
  assertEquals(r.prev("hola"), undefined);
});

Deno.test("ring: what the door recalled is where the ring opens", () => {
  const r = createRing(["ayer", "hoy"]);
  r.add("ahora");
  assertEquals(r.prev(""), "ahora");
  assertEquals(r.prev("ahora"), "hoy");
  assertEquals(r.prev("hoy"), "ayer");
});

Deno.test("columnAfter: where the transcript stands, colour costing nothing", () => {
  assertEquals(columnAfter(0, "hola"), 4);
  assertEquals(columnAfter(4, " mundo"), 10);
  assertEquals(columnAfter(7, "hola\n"), 0);
  assertEquals(columnAfter(0, "una\nlinea"), 5);
  assertEquals(columnAfter(0, "\x1b[2mdim\x1b[0m"), 3);
  assertEquals(columnAfter(3, "\rotra"), 4);
});

// A streamed sentence outgrows the screen long before it ends its line, and the repaint
// walks back to where it stopped. Counting characters instead of columns sent that walk
// past the right margin, where the terminal clamps it: every chunk after the first wrap
// printed hard against the edge, one fragment per row.
Deno.test("columnAfter: the count is the SCREEN's, so a wrapped line does not run away", () => {
  assertEquals(columnAfter(0, "x".repeat(153), 100), 53);
  assertEquals(columnAfter(90, "x".repeat(20), 100), 10);
  assertEquals(columnAfter(0, "x".repeat(260), 100), 60);
  // a newline starts the count over, wherever the wrapping had reached
  assertEquals(columnAfter(90, "abc\nde", 100), 2);
  // filled to the edge exactly: the cursor waits at the last column, a wrap still owed
  assertEquals(columnAfter(0, "x".repeat(100), 100), 100);
  assertEquals(columnAfter(100, "x", 100), 1);
});

// What the tail stands as is the one fact a surface needs to print the right amount of
// nothing: asking for a blank row twice asks for it once.
Deno.test("tailOf: what is already standing is never written twice", () => {
  const t = tailOf();
  assertEquals(t.owed(1), ""); // an empty screen owes nothing
  assertEquals(t.owed(2), "");
  t.note("11 Sep 11:14 • listo");
  assertEquals(t.owed(1), "\n"); // mid-row: one to close it
  assertEquals(t.owed(2), "\n\n"); // and another to stand clear
  t.note("\n");
  assertEquals(t.owed(1), "");
  assertEquals(t.owed(2), "\n");
  t.note("\n");
  assertEquals(t.owed(2), ""); // the blank row stands: asking again writes nothing
  t.note("\x1b[2m\x1b[0m"); // escapes paint, they do not move
  assertEquals(t.owed(2), "");
  t.note("⚙ send(...)\n");
  assertEquals(t.owed(1), "");
  assertEquals(t.owed(2), "\n");
});
