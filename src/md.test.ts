/**
 * md.test.ts — markdown on a terminal (§9): the marks a chat answer uses become styles,
 * and they become them as the text streams — a span the moment it closes, a plain
 * sentence at once.
 */

import { assertEquals } from "@std/assert";
import {
  BOLD,
  BOLD_OFF,
  CODE,
  CODE_OFF,
  ITALIC,
  ITALIC_OFF,
  markdown,
  renderMarkdown,
  safeLength,
} from "./md.ts";

Deno.test("inline: bold, italic and code become styles; the rest is untouched", () => {
  assertEquals(renderMarkdown("hola **mundo**!"), `hola ${BOLD}mundo${BOLD_OFF}!`);
  assertEquals(
    renderMarkdown("es *importante* y _también_"),
    `es ${ITALIC}importante${ITALIC_OFF} y ${ITALIC}también${ITALIC_OFF}`,
  );
  assertEquals(
    renderMarkdown("corré `deno task test` ahora"),
    `corré ${CODE}deno task test${CODE_OFF} ahora`,
  );
  assertEquals(renderMarkdown("sin marcas, tal cual"), "sin marcas, tal cual");
});

Deno.test("inline: a marker that is not a span is left alone", () => {
  assertEquals(renderMarkdown("snake_case_name y 2 * 3 * 4"), "snake_case_name y 2 * 3 * 4");
  assertEquals(renderMarkdown("`**` dentro de código"), `${CODE}**${CODE_OFF} dentro de código`);
});

Deno.test("headings: the line is bold, the hashes are not shown", () => {
  assertEquals(renderMarkdown("## Plan\ntexto"), `${BOLD}Plan${BOLD_OFF}\ntexto`);
  // a bold span inside a heading wears no codes of its own — the line is already bold
  assertEquals(renderMarkdown("# uno **dos**"), `${BOLD}uno dos${BOLD_OFF}`);
  assertEquals(renderMarkdown("#hashtag no es título"), "#hashtag no es título");
});

Deno.test("fences: the fence lines vanish and nothing inside is styled", () => {
  assertEquals(
    renderMarkdown("antes\n```ts\nconst a = **b**;\n# no título\n```\n**después**"),
    `antes\nconst a = **b**;\n# no título\n${BOLD}después${BOLD_OFF}`,
  );
});

Deno.test("stream: a plain sentence shows as it arrives, delta by delta", () => {
  const m = markdown();
  assertEquals(m.feed("hola "), "hola ");
  assertEquals(m.feed("mundo"), "mundo");
  assertEquals(m.feed("\nsegunda"), "\nsegunda");
  assertEquals(m.end(), "");
});

Deno.test("stream: a span is held from its opener and shown whole when it closes", () => {
  const m = markdown();
  assertEquals(m.feed("es **muy"), "es ");
  assertEquals(m.feed(" impor"), "");
  assertEquals(m.feed("tante** sí"), `${BOLD}muy importante${BOLD_OFF} sí`);
  assertEquals(m.end(), "");
});

Deno.test("stream: a span the line ends on is let go unstyled — the text is never lost", () => {
  const m = markdown();
  assertEquals(m.feed("a **b"), "a ");
  assertEquals(m.feed("\nc"), "**b\nc");
  const n = markdown();
  assertEquals(n.feed("`sin cerrar"), "");
  assertEquals(n.end(), "`sin cerrar");
});

Deno.test("stream: a heading arriving in pieces opens bold as soon as it can", () => {
  const m = markdown();
  assertEquals(m.feed("#"), ""); // could still be a heading
  assertEquals(m.feed("# Pl"), `${BOLD}Pl`);
  assertEquals(m.feed("an\n"), `an${BOLD_OFF}\n`);
  assertEquals(m.feed("cuerpo"), "cuerpo");
});

Deno.test("stream: a fence is never shown, and the code after it streams raw", () => {
  const m = markdown();
  assertEquals(m.feed("```"), "");
  assertEquals(m.feed("ts\n"), "");
  assertEquals(m.feed("x = **y**"), "x = **y**");
  assertEquals(m.feed("\n```\n**z**"), "\n" + `${BOLD}z${BOLD_OFF}`);
  assertEquals(m.end(), "");
});

Deno.test("safeLength: where the unclosed span starts", () => {
  assertEquals(safeLength("hola **mundo"), 5);
  assertEquals(safeLength("hola **mundo**"), 14);
  assertEquals(safeLength("`a ** b"), 0); // inside code, the ** is not an opener
  assertEquals(safeLength("x *y"), 2);
  assertEquals(safeLength("2 * 3"), 5); // a star between spaces opens nothing
  assertEquals(safeLength("abc", 1), 3);
});
