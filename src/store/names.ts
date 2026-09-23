/**
 * store/names.ts — how a NAME is looked up, everywhere one is (§6, §9).
 *
 * A person is named loosely: the calendar says `REVECO EDGARDO`, the phone saved
 * `Edgardo Reveco`, the model types `edgardo reveco`, and a pushname carries `Álvaro` where
 * the address book has `Alvaro`. They are one person, so one rule matches them all: fold
 * case and accents, and every word of the query has to appear somewhere in the name, in
 * any order. `Reveco` still finds Edgardo (one word, substring — the way a person searches
 * their own phone), and `REVECO EDGARDO` finds him too, because the order of two names was
 * never information.
 *
 * The rule lives here as words and is applied in two places that never meet: the log's
 * name columns (as a bound SQL function, `fold`, so the filter runs inside the engine) and
 * the whatsmeow bridge's address book, which is the wire's and answers in Go — the same
 * three lines, so a name resolves the same whichever side holds it.
 *
 * A book also says who people are to each other: `Isabel (Mamá De Yañez Marcos)` is saved
 * next to `Marcos Alberto Yañez`, and both answer to `YAÑEZ MARCOS`. The parenthesis
 * names somebody else, so where one person has to be picked (`send`, `contact`) the
 * hits whose name PROPER carries the query stand, and the ones that only carry it in a
 * parenthesis step aside — unless nobody's proper name has it, when the parenthesis is
 * all there is (`preferProper`). Search keeps every hit: an ambiguity is its answer.
 */

/** Case and accents gone, whitespace collapsed: the comparable form of a name. */
export function foldName(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The words of a query, folded: what each has to be found in the name. */
export function nameWords(query: string): string[] {
  return foldName(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** Does `name` answer to `query`? Every word of the query, in any order, as a substring
 *  of the folded name. An empty query names nobody. */
export function namesMatch(query: string, name: string | undefined): boolean {
  if (!name) return false;
  const words = nameWords(query);
  if (words.length === 0) return false;
  const folded = foldName(name);
  return words.every((w) => folded.includes(w));
}

/** The name proper: what is left once every parenthesis — a relation, a note — is gone. */
export function properName(name: string): string {
  return name.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Of several people a query reached, the ones it names PROPERLY — all of them when it
 *  names none that way, so a person only ever saved as somebody's relation is still found. */
export function preferProper<T extends { name?: string }>(query: string, hits: T[]): T[] {
  if (hits.length < 2) return hits;
  const proper = hits.filter((h) => h.name !== undefined && namesMatch(query, properName(h.name)));
  return proper.length > 0 ? proper : hits;
}
