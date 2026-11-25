/**
 * worn.ts: the names a doc's party goes by on the wire (§8). A profile names a person the
 * principal's way, in its keywords; the wire names them its own way, as a saved contact, a
 * pushname, a group's new subject. The two meet only at the address, so the names every
 * address a doc's `conversations` hold has worn in the log, as the chat's name or as a
 * sender's, stand beside the doc as `also: …` (render.ts), each once, minus what the doc
 * already says.
 *
 * Only a doc about one party wears them: at most one address per service, as a person's
 * profile has (their chat on each service) or a group's. A doc naming several addresses on
 * one service is about a matter, and its names are its members', no one's aliases.
 *
 * The names are read once per address and then only from the rows after the last read: a
 * step asks again every time, and an address's whole history is a scan the prefix cannot
 * pay for on every step. The order is the order the names were first worn, so a new
 * row never reshuffles them and the prefix stays what its cache holds.
 */

import type { DocEntry, Where } from "./store/docs.ts";
import type { Reader } from "./store/log.ts";
import { nameWords } from "./store/names.ts";

/** How many names a doc shows, the first worn first. */
export const WORN_SHOWN = 5;

interface Worn {
  name: string;
  first: string;
}

/** One reader's names between steps: each address's names by their comparable form, and
 *  the newest row read through. */
interface Cache {
  by: Map<string, Map<string, Worn>>;
  through?: string;
}

const caches = new WeakMap<object, Cache>();

const keyOf = (w: Where): string => `${w.service}:${w.address}`;

/** A name's comparable form: its words, folded. An emoji, a `:::` or a case is no word, so
 *  `🇦🇷 Lautaro Motta` and `LAUTARO MOTTA` are one name. */
export function nameKey(name: string): string {
  return nameWords(name).join(" ");
}

/** Is the doc about one party: at most one address per service? */
export function oneParty(conversations: readonly Where[] | undefined): boolean {
  if (!conversations?.length) return false;
  const services = conversations.map((w) => w.service);
  return new Set(services).size === services.length;
}

/** The docs, each about one party carrying the names its addresses wore that it does not
 *  say itself. A reader with no `names` leaves them as they are. */
export async function withWorn(
  docs: DocEntry[],
  log: Pick<Reader, "read" | "names">,
): Promise<DocEntry[]> {
  if (!log.names) return docs;
  const parties = docs.filter((d) => d.header.kind !== "tool" && oneParty(d.header.conversations));
  if (parties.length === 0) return docs;
  const worn = await wornOf(log, parties.flatMap((d) => d.header.conversations ?? []));
  return docs.map((d) => {
    if (!parties.includes(d)) return d;
    const all = (d.header.conversations ?? []).flatMap((w) => [
      ...(worn.get(keyOf(w))?.values() ?? []),
    ]);
    const names = unsaid(d.header, all);
    return names.length > 0 ? { ...d, names } : d;
  });
}

/** Of the names a doc's addresses wore, the ones it should show: each once, in the order
 *  first worn, none its keywords or its description already say and none with no letter in
 *  it (a bare number is its address), at most `WORN_SHOWN`. */
function unsaid(header: DocEntry["header"], worn: Worn[]): string[] {
  const said = new Set((header.keywords ?? []).map(nameKey));
  const described = ` ${nameKey(header.description ?? "")} `;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...worn].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))) {
    const key = nameKey(w.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/\p{L}/u.test(key) || said.has(key) || described.includes(` ${key} `)) continue;
    out.push(w.name);
    if (out.length === WORN_SHOWN) break;
  }
  return out;
}

/** Each address's names, by its `service:address`: read whole the first time it is asked
 *  for, and from then on only off the rows after the last read. */
async function wornOf(
  log: Pick<Reader, "read" | "names">,
  wheres: Where[],
): Promise<Map<string, Map<string, Worn>>> {
  let cache = caches.get(log);
  if (!cache) caches.set(log, cache = { by: new Map() });
  // the newest row before either read: the next step starts after it, and whatever lands in
  // between is read twice, which the names, kept by their first row, never mind
  const [top] = await log.read({ limit: 1 });
  const fresh = unique(wheres.filter((w) => !cache.by.has(keyOf(w))));
  for (const w of fresh) cache.by.set(keyOf(w), new Map());
  const reads: Promise<void>[] = [];
  if (fresh.length > 0) reads.push(readWhole(log, cache, fresh));
  if (cache.through !== undefined && cache.by.size > fresh.length) {
    reads.push(readAfter(log, cache, cache.through));
  }
  await Promise.all(reads);
  if (top) cache.through = top.id;
  return cache.by;
}

/** Every name the addresses wore: as the conversation a row stands in, and as its sender. */
async function readWhole(
  log: Pick<Reader, "names">,
  cache: Cache,
  wheres: Where[],
): Promise<void> {
  const addresses = [...new Set(wheres.map((w) => w.address))];
  const [rooms, senders] = await Promise.all([
    log.names!({ conversations: addresses }),
    log.names!({ senders: addresses }),
  ]);
  for (const r of rooms) keep(cache, r.service, r.conversation, r.conversationName, r.first);
  for (const r of senders) keep(cache, r.service, r.sender, r.senderName, r.first);
}

/** The names the rows after `through` wore, kept for whichever cached address they name. */
async function readAfter(log: Pick<Reader, "names">, cache: Cache, through: string): Promise<void> {
  for (const r of await log.names!({ afterId: through })) {
    keep(cache, r.service, r.conversation, r.conversationName, r.first);
    keep(cache, r.service, r.sender, r.senderName, r.first);
  }
}

/** One name an address wore, kept by its comparable form with the first row that wore it. */
function keep(
  cache: Cache,
  service: string | undefined,
  address: string | undefined,
  name: string | undefined,
  first: string,
): void {
  if (service === undefined || address === undefined || !name) return;
  const names = cache.by.get(`${service}:${address}`);
  const key = nameKey(name);
  if (!names || key === "") return;
  const had = names.get(key);
  if (!had || first < had.first) names.set(key, { name, first });
}

function unique(wheres: Where[]): Where[] {
  return [...new Map(wheres.map((w) => [keyOf(w), w])).values()];
}
