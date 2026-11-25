/**
 * mentions.ts — the people an outbound line names (§3, §5): resolved once, at the send, and
 * carried on the row as `payload.mentions`, which every dispatcher encodes in its wire's form.
 *
 * The agent mentions as a person types one: `@` and the name, or the address when it wants
 * precision. The send resolves each token among the people of the conversation it lands in,
 * the way `conversation` and `contact` resolve a name: every word typed is a whole word of
 * the name (case and accents folded, any order), and the token takes as many of the words
 * after the sigil as still name somebody, so `@Ana María, hola` is Ana María and not Ana. A
 * token that names one person is a mention; one that names several, or nobody, is the send's
 * refusal, carrying whom it could mean. A handle the wire links by itself (Slack's `@here`,
 * Telegram's `@username`) goes as written when nobody there goes by it.
 *
 * A stored mention's `name` is the token as written, sigil dropped: the text holds
 * `@<name>`, so an encoder finds it by that spelling (WhatsApp's bridge rewrites `@<name>`
 * to the wire's `@digits`, Slack wraps it as `<@U…>`, Telegram and Teams span it).
 *
 * A sigil opens a token only where a person's would: at the start, after a space, an opening
 * bracket or quote, a list's comma, or a markdown marker. Inside a word (`foo@bar.com`) or a
 * path (`/@user`) it is spelling. A token ends where a name's word can end: a letter or digit
 * after it, or a `.` `_` `@` `-` running into one, makes it a handle (`@liquen.dev`) rather
 * than a name. Code spans are content and name nobody.
 */

import { foldName, nameWords, properName } from "./store/names.ts";

/** A person or a channel a line names: the wire's address and the name the text writes. */
export interface NameEntry {
  address: string;
  name?: string;
  /** The sigil the token wears: `@` a person (the default when absent), `#` a
   *  conversation — the same shape `payload.mentions` stores (§3). */
  type?: "@" | "#";
}

/** A claimed token: which entry a sigiled span in the text names. */
export interface Claim extends NameEntry {
  index: number; // where the sigil sits — claims return in order of appearance
  length: number; // the whole claimed token, sigil included
}

/** A token the send could not settle: the people it names (`many`), or nobody, when
 *  `candidates` are the ones there it might have meant. One entry per address. */
export interface Unresolved {
  token: string; // as written, sigil included
  many: boolean;
  candidates: NameEntry[];
}

const MAX_WORDS = 5;
// what may stand before a sigil that opens a token
const OPENS = /[\s(\[{"'“‘«¿¡,;:*_~​]/u;
const ALNUM = /[\p{L}\p{N}]/u;
// a name's word as typed: letters and digits with the marks a decomposed accent keeps, and
// an apostrophe or hyphen inside it (O'Brien, Díaz-Araujo)
const NAME_WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/uy;
// a handle as typed, past the sigil: what a wire's native mention would read
const HANDLE = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/uy;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Does a sigil at `i` open a token? */
function opens(text: string, i: number): boolean {
  return (i === 0 || OPENS.test(text[i - 1])) && ALNUM.test(text[i + 1] ?? "");
}

/** Does the text run on at `end`, so that no token may end there? */
function runsOn(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return false;
  if (ALNUM.test(next) || next === "_") return true;
  return ".@-".includes(next) && ALNUM.test(text[end + 1] ?? "");
}

/** The [start, end) spans of code, which name nobody. */
function codeSpans(text: string): [number, number][] {
  return [...text.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
}

/** The entries of a message that the text writes, in order of appearance: `@<name>` or
 *  `@<address>` (`#` for a channel) at a token's start and end, case folded. Longest key
 *  first, so `@Ana María` is never half-claimed by `@Ana`. */
export function claimMentions(text: string, entries: NameEntry[]): Claim[] {
  const keys: { key: string; entry: NameEntry }[] = [];
  for (const e of entries) {
    const sigil = e.type ?? "@";
    keys.push({ key: sigil + e.address, entry: e });
    if (e.name) keys.push({ key: sigil + e.name, entry: e });
  }
  keys.sort((a, b) => b.key.length - a.key.length);
  const folded = text.toLowerCase();
  const claims: Claim[] = [];
  const taken: [number, number][] = [...codeSpans(text)];
  for (const { key, entry } of keys) {
    const k = key.toLowerCase();
    for (let at = folded.indexOf(k); at !== -1; at = folded.indexOf(k, at + 1)) {
      const end = at + k.length;
      if (!opens(text, at) || runsOn(text, end)) continue;
      if (taken.some(([s, e]) => at < e && end > s)) continue;
      taken.push([at, end]);
      claims.push({ ...entry, index: at, length: end - at });
    }
  }
  return claims.sort((a, b) => a.index - b.index);
}

/** What an outbound text's tokens name among `people` (their addresses, each with every
 *  name it goes by) and `channels`. `native` answers a handle the wire mentions by itself.
 *  A `#` nobody's channel is a hashtag and stays text. */
export function resolveMentions(
  text: string,
  people: NameEntry[],
  opts: { channels?: NameEntry[]; native?: (handle: string) => boolean } = {},
): { mentions: NameEntry[]; unresolved: Unresolved[] } {
  const code = codeSpans(text);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const named = people.filter((p) => p.name);
  const addresses = [...new Set(people.map((p) => p.address))]
    .sort((a, b) => b.length - a.length);
  const channels = [...(opts.channels ?? [])]
    .filter((c) => c.name)
    .sort((a, b) => b.name!.length - a.name!.length);
  const mentions: NameEntry[] = [];
  const unresolved: Unresolved[] = [];
  const claim = (entry: NameEntry) => {
    if (!mentions.some((m) => m.address === entry.address && m.name === entry.name)) {
      mentions.push(entry);
    }
  };
  for (const m of text.matchAll(/[@#]/g)) {
    const i = m.index;
    if (!opens(text, i) || inCode(i)) continue;
    const rest = text.slice(i + 1);
    const at = (s: string) =>
      rest.slice(0, s.length).toLowerCase() === s.toLowerCase() && !runsOn(text, i + 1 + s.length);
    if (m[0] === "#") {
      const c = channels.find((c) => at(c.name!));
      if (c) claim({ address: c.address, name: rest.slice(0, c.name!.length), type: "#" });
      continue;
    }
    const address = addresses.find(at);
    if (address) {
      claim({ address, name: rest.slice(0, address.length) });
      continue;
    }
    const ends = wordEnds(text, i + 1);
    let settled = false;
    for (let n = ends.length; n > 0 && !settled; n--) {
      const span = text.slice(i + 1, ends[n - 1]);
      const typed = nameWords(span);
      const hits = byAddress(named.filter((p) => typed.every((w) => wordsOf(p.name!).includes(w))));
      if (hits.length === 1) claim({ address: hits[0].address, name: span });
      else if (hits.length > 1) {
        unresolved.push({ token: `@${span}`, many: true, candidates: hits });
      }
      settled = hits.length > 0;
    }
    if (settled) continue;
    HANDLE.lastIndex = i + 1;
    const handle = HANDLE.exec(text)?.[0] ?? "";
    if (opts.native?.(handle)) continue;
    const stem = foldName(handle).slice(0, 3);
    const near = byAddress(named.filter((p) => wordsOf(p.name!).some((w) => w.startsWith(stem))));
    unresolved.push({
      token: `@${handle}`,
      many: false,
      candidates: near.length > 0 ? near : byAddress(named),
    });
  }
  return { mentions, unresolved };
}

/** Where each run of 1…MAX_WORDS name words after `start` could end a token. */
function wordEnds(text: string, start: number): number[] {
  const ends: number[] = [];
  let at = start;
  while (ends.length < MAX_WORDS) {
    NAME_WORD.lastIndex = at;
    const w = NAME_WORD.exec(text);
    if (!w) break;
    const end = at + w[0].length;
    if (runsOn(text, end)) break;
    ends.push(end);
    if (text[end] !== " ") break;
    at = end + 1;
  }
  return ends;
}

/** A name's words, its parenthesis left out: a relation a book notes names somebody else. */
function wordsOf(name: string): string[] {
  return nameWords(properName(name));
}

/** One entry per address, the first name it was listed under. */
function byAddress(entries: NameEntry[]): NameEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.address) && seen.add(e.address));
}
