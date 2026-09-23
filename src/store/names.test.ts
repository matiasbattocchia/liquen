import { assert, assertEquals } from "@std/assert";
import { foldName, namesMatch, nameWords, preferProper, properName } from "./names.ts";

Deno.test("foldName: case and accents go, whitespace collapses", () => {
  assertEquals(foldName("  Verónica   SESTO "), "veronica sesto");
  assertEquals(foldName("Álvaro Muñoz"), "alvaro munoz");
  assertEquals(foldName("Ñandú"), "nandu");
});

Deno.test("nameWords: the folded words, punctuation aside; nothing from nothing", () => {
  assertEquals(nameWords("REVECO, EDGARDO"), ["reveco", "edgardo"]);
  assertEquals(nameWords("  -- "), []);
});

Deno.test("namesMatch: every word of the query, any order, case and accents aside", () => {
  assert(namesMatch("REVECO EDGARDO", "Edgardo Reveco"));
  assert(namesMatch("reveco", "Edgardo Reveco")); // one word is a substring, as a phone searches
  assert(namesMatch("alvaro", "Álvaro Manzur"));
  assert(namesMatch("Vero", "Verónica Sesto"));
  assert(!namesMatch("Verónica Paz", "Verónica Sesto")); // one word missing is a miss
  assert(!namesMatch("", "anyone"));
  assert(!namesMatch("anyone", undefined));
});

Deno.test("properName: the parenthesis is somebody else; preferProper lets the name proper win", () => {
  assertEquals(properName("Isabel (Mamá De Yañez Marcos)"), "Isabel");
  assertEquals(properName("Gabriela [familiar] (De Manzur)"), "Gabriela");
  const isabel = { name: "Isabel (Mamá De Yañez Marcos)", address: "1" };
  const marcos = { name: "Marcos Alberto Yañez", address: "2" };
  assertEquals(preferProper("YAÑEZ MARCOS", [isabel, marcos]), [marcos]);
  assertEquals(preferProper("Isabel", [isabel, marcos]), [isabel]);
  // nobody's proper name has it all: every hit stands, and the caller says it is ambiguous
  assertEquals(preferProper("mamá de yañez", [isabel, marcos]), [isabel, marcos]);
  assertEquals(preferProper("Yañez", [isabel]), [isabel]); // one hit is never narrowed
});
