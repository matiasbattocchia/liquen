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
