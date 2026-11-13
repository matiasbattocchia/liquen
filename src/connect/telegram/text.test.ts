import { assertEquals } from "@std/assert";
import { fromTelegram, mentionSpans, toTelegram } from "./text.ts";

Deno.test("telegram text: entities come in as common markdown, blanks outside the markers", () => {
  assertEquals(
    fromTelegram("hola mundo cruel", [
      { type: "bold", offset: 5, length: 6 }, // "mundo " with its trailing blank
      { type: "italic", offset: 11, length: 5 },
    ]),
    "hola **mundo** *cruel*",
  );
  assertEquals(
    fromTelegram("ver la doc", [{ type: "link", offset: 7, length: 3, url: "https://x.test/d" }]),
    "ver la [doc](https://x.test/d)",
  );
});

Deno.test("telegram text: nested spans close inside out, and code keeps its markers as content", () => {
  assertEquals(
    fromTelegram("muy importante", [
      { type: "bold", offset: 0, length: 14 },
      { type: "italic", offset: 4, length: 10 },
    ]),
    "**muy *importante***",
  );
  assertEquals(
    fromTelegram("corré git status ya", [
      { type: "code", offset: 6, length: 10 },
      { type: "bold", offset: 6, length: 3 },
    ]),
    "corré `git status` ya",
  );
  assertEquals(
    fromTelegram("x = 1", [{ type: "pre", offset: 0, length: 5, language: "py" }]),
    "```py\nx = 1\n```",
  );
});

Deno.test("telegram text: a span with no marker of its own leaves its words as they are", () => {
  assertEquals(
    fromTelegram("hola @solruiz", [
      { type: "mention", offset: 5, length: 8 },
      { type: "underline", offset: 0, length: 4 },
    ]),
    "hola @solruiz",
  );
});

Deno.test("telegram text: common markdown goes out as bare text and its spans", () => {
  assertEquals(toTelegram("hola **mundo** y *chau* ~~no~~"), {
    text: "hola mundo y chau no",
    entities: [
      { type: "bold", offset: 5, length: 5 },
      { type: "italic", offset: 13, length: 4 },
      { type: "strike", offset: 18, length: 2 },
    ],
  });
  assertEquals(toTelegram("mirá [la doc](https://x.test/d)."), {
    text: "mirá la doc.",
    entities: [{ type: "link", offset: 5, length: 6, url: "https://x.test/d" }],
  });
});

Deno.test("telegram text: nesting survives, a heading is a bold line, code is lifted whole", () => {
  assertEquals(toTelegram("**muy *importante***"), {
    text: "muy importante",
    entities: [
      { type: "bold", offset: 0, length: 14 },
      { type: "italic", offset: 4, length: 10 },
    ],
  });
  assertEquals(toTelegram("# Plan\nlisto"), {
    text: "Plan\nlisto",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });
  assertEquals(toTelegram("corré `a **b**` y\n```sh\nls *\n```\nfin"), {
    text: "corré a **b** y\nls *\nfin",
    entities: [
      { type: "code", offset: 6, length: 7 },
      { type: "pre", offset: 16, length: 4, language: "sh" },
    ],
  });
});

Deno.test("telegram text: a marker that is spelling stays text", () => {
  assertEquals(toTelegram("2 * 3 * 4 y snake_case_name").entities, []);
  assertEquals(toTelegram("2 * 3 * 4 y snake_case_name").text, "2 * 3 * 4 y snake_case_name");
});

Deno.test("telegram text: a round trip gives the markdown back", () => {
  const md = "hola **mundo**, mirá [esto](https://x.test/a) y `eso`";
  const { text, entities } = toTelegram(md);
  assertEquals(fromTelegram(text, entities), md);
});

Deno.test("telegram text: an @Name the directory claims is a mention of that id; offsets count UTF-16", () => {
  const dir = [{ address: "700200", name: "Sol Ruiz" }, { address: "-4100", name: "Equipo" }];
  assertEquals(mentionSpans("😀 gracias @Sol Ruiz!", dir), [
    { type: "mention_name", offset: 11, length: 9, user: "700200" },
  ]);
  // a room is nobody to mention, and an unclaimed name stays words
  assertEquals(mentionSpans("hola @Equipo y @Nadie", dir), []);
});
