import { assert, assertEquals } from "@std/assert";
import { LAPSED_SHOWN, lapsedIn, tidying } from "./unload.ts";
import { MEMORY_CHARS } from "./render.ts";

const NOV25 = { year: 2026, month: 11, day: 25 };

Deno.test("lapsedIn: a dated line whose day is over, a done item and a closed range are past their end", () => {
  const body = [
    "# Memories",
    "- @21 Nov Isidris Sunset: entrada pagada. (19 Nov, 8865fb)",
    "- [x] @1 Dec Mandar el recordatorio (20 Nov, eeccf5)",
    "- [x] Llamar a la gestora (20 Nov, 1a2b3c)",
    "- Lu in Córdoba. (2 Nov–15 Nov, 8be1d0 41c2aa)",
    "- Lu vuelve a Córdoba. (2 Nov-15 Nov, 8be1d0; 20 Nov–30 Nov, 9c0d1e)",
    "- [ ] @19 Nov remind 2 days before at 10:00 Pagar la tasa (10 Nov, 6acb30)",
  ].join("\n");
  assertEquals(lapsedIn(body, NOV25), [
    "@21 Nov Isidris Sunset: entrada pagada. (19 Nov, 8865fb)",
    "[x] @1 Dec Mandar el recordatorio (20 Nov, eeccf5)",
    "[x] Llamar a la gestora (20 Nov, 1a2b3c)",
    "Lu in Córdoba. (2 Nov–15 Nov, 8be1d0 41c2aa)",
    "[ ] @19 Nov remind 2 days before at 10:00 Pagar la tasa (10…",
  ]);
});

Deno.test("lapsedIn: today's line, a future one, a repeat and an open range are not over", () => {
  const body = [
    "- [ ] @25 Nov 11:30 Call con Juani (24 Nov, 3c2455)",
    "- @2 Dec 9:00 Consulta con Majo Caprio (25 Nov, 004bdd)",
    "- @10 Oct every year Cumple de Matías (1 Oct, aa11bb)",
    "- @3 Nov 2026 18:00 every Tue Clase de inglés (28 Oct, e52aa0)",
    "- @1 Nov every Mon until 30 Dec Natación (1 Nov, ab12cd)",
    "- Sol en Rosario. (20 Nov–13 Jan, abc629)",
    "- Sam: write in English. (27 Oct, 3f9a2c)",
    "- Hermenex: 19-20 Nov, cuotas (19-20 Nov, 8865fb)",
    "```",
    "- @1 Jan 2020 an example, never an entry",
    "```",
  ].join("\n");
  assertEquals(lapsedIn(body, NOV25), []);
});

Deno.test("lapsedIn: a repeat whose until is over is past its end", () => {
  assertEquals(
    lapsedIn("- @1 Nov every Mon until 20 Nov Natación (1 Nov, ab12cd)", NOV25),
    ["@1 Nov every Mon until 20 Nov Natación (1 Nov, ab12cd)"],
  );
});

Deno.test("tidying: names each memory over its size and each entry past its end, by handle", () => {
  const text = tidying([
    {
      handle: "/org/data/agents/a1/memories.md",
      chars: MEMORY_CHARS * 6,
      body: "- @21 Nov Isidris (19 Nov, 1)",
    },
    {
      handle: "/org/data/agents/a1/profiles/rubi.md",
      chars: MEMORY_CHARS / 2,
      body: "- @2 Dec Cierre (1 Nov, 2)",
    },
    { handle: "/org/data/shared/memories.md", chars: MEMORY_CHARS, body: "- [x] Hecho (1 Nov, 3)" },
  ], NOV25);
  assertEquals(
    text,
    [
      "memories over their size:",
      "- /org/data/agents/a1/memories.md 600% of 2,200 chars",
      "entries past their end:",
      "- /org/data/agents/a1/memories.md: @21 Nov Isidris (19 Nov, 1)",
      "- /org/data/shared/memories.md: [x] Hecho (1 Nov, 3)",
    ].join("\n"),
  );
});

Deno.test("tidying: nothing owed is no text, and past ten entries the rest are counted per doc", () => {
  assertEquals(
    tidying([{ handle: "/m.md", chars: 100, body: "- @2 Dec Cierre (1 Nov, 2)" }], NOV25),
    "",
  );
  const many = Array.from({ length: LAPSED_SHOWN + 3 }, (_, i) => `- @${i + 1} Nov Cosa ${i}`);
  const text = tidying([
    { handle: "/a.md", chars: 100, body: many.slice(0, LAPSED_SHOWN + 1).join("\n") },
    { handle: "/b.md", chars: 100, body: many.slice(LAPSED_SHOWN + 1).join("\n") },
  ], NOV25);
  const lines = text.split("\n");
  assertEquals(lines.filter((l) => l.startsWith("- /a.md: @")).length, LAPSED_SHOWN);
  assert(lines.includes("- /a.md: 1 more"));
  assert(lines.includes("- /b.md: 2 more"));
});
