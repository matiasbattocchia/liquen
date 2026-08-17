/**
 * connect/mentions.ts — OUTBOUND mention resolution (§3, §5): the inverse of the
 * ingest decode. Display form lives in the log; encoding happens at the frontier.
 *
 * The agent writes mentions as a human would — `@Name`, or `@<address>` when it wants
 * precision — and the DISPATCHER resolves them. The directory is the log itself: every
 * prior message in the conversation taught us a `sender.name → sender.address` pair
 * (the wire's own display facts — pushnames, users.info — nothing of ours). An
 * unresolved token stays literal text: the same graceful nothing a human gets typing
 * a name the autocomplete didn't take.
 *
 * Per wire: Slack's encoding is mu's job (`@Name` → `<@U…>`, specials → `<!here>`);
 * WhatsApp's is the bridge's (`content.mentions` [{address, name}] drives its
 * `@Name` → `@digits` rewrite + ContextInfo.MentionedJID) — mu only claims the tokens.
 */

import type { ReadQuery } from "../store/log.ts";
import type { Event } from "../types.ts";

export interface NameEntry {
  address: string;
  name?: string;
}

/** Who this conversation knows: name/address pairs, newest fact first. */
export type Directory = (service: string, conversation: string) => Promise<NameEntry[]>;

/** The log-backed directory: the conversation's recent senders, newest first —
 *  duplicate addresses keep their freshest name; duplicate names keep their freshest
 *  address (the older namesake stays reachable by `@<address>`). */
export function logDirectory(
  read: (q: ReadQuery) => Promise<Event[]>,
  limit = 400,
): Directory {
  return async (service, conversation) => {
    const events = await read({ service, conversation, types: ["message"], limit });
    const byAddress = new Map<string, NameEntry>();
    for (let i = events.length - 1; i >= 0; i--) { // append order → walk newest-first
      const s = events[i].envelope.sender;
      if (!s?.address || byAddress.has(s.address)) continue;
      byAddress.set(s.address, { address: s.address, ...(s.name ? { name: s.name } : {}) });
    }
    return [...byAddress.values()];
  };
}

/** A claimed token: which directory entry an `@…` span in the text names. */
export interface Claim extends NameEntry {
  index: number; // where the `@` sits — claims return in order of appearance
  length: number; // the whole claimed token, `@` included
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a token ends where a name/address character can't continue it
const boundary = /[\p{L}\p{N}_.-]/u;

/** Find the `@…` tokens the directory can claim: `@Name` (case-insensitive) and the
 *  always-precise `@<address>`. Longest key first, so "@Ana María" is never
 *  half-claimed by "@Ana"; overlapping claims lose to the earlier, longer one. */
export function claimMentions(text: string, dir: NameEntry[]): Claim[] {
  const keys: { key: string; entry: NameEntry }[] = [];
  for (const e of dir) {
    keys.push({ key: e.address, entry: e });
    if (e.name) keys.push({ key: e.name, entry: e });
  }
  keys.sort((a, b) => b.key.length - a.key.length);

  const claims: Claim[] = [];
  const taken: [number, number][] = []; // claimed [start, end) spans
  for (const { key, entry } of keys) {
    const re = new RegExp(`@${esc(key)}`, "gi");
    for (const m of text.matchAll(re)) {
      const start = m.index, end = start + m[0].length;
      if (text[end] !== undefined && boundary.test(text[end])) continue; // mid-word
      if (taken.some(([s, e2]) => start < e2 && end > s)) continue;
      taken.push([start, end]);
      claims.push({ ...entry, index: start, length: m[0].length });
    }
  }
  return claims.sort((a, b) => a.index - b.index);
}

/** Slack's special mentions — the tokens a human types → the wire's control words. */
const SPECIAL = /@(here|channel|everyone)\b/g;
/** A bare Slack user id typed directly — always resolvable, directory or not. The
 *  lookbehind skips ids the claim pass already wrapped (`<@U…>`). */
const BARE_ID = /(?<!<)@([UW][A-Z0-9]{8,})\b/g;

/** Encode outbound Slack text: claimed names and bare/directory ids → `<@U…>`,
 *  specials → `<!here>` etc. Everything unclaimed stays as written. */
export function encodeSlackText(text: string, dir: NameEntry[]): string {
  let out = "";
  let at = 0;
  for (const c of claimMentions(text, dir)) {
    out += text.slice(at, c.index) + `<@${c.address}>`;
    at = c.index + c.length;
  }
  out += text.slice(at);
  return out.replace(BARE_ID, "<@$1>").replace(SPECIAL, "<!$1>");
}

/** Claim outbound WhatsApp mentions for the bridge's encoder: [{address, name?}] —
 *  the bridge rewrites `@Name` → `@digits` and fills MentionedJID; a nameless claim
 *  (the text already says `@<address>`) passes through as the JID alone. */
export function whatsappMentions(text: string, dir: NameEntry[]): NameEntry[] {
  const seen = new Set<string>();
  const out: NameEntry[] = [];
  for (const c of claimMentions(text, dir)) {
    if (seen.has(c.address)) continue;
    seen.add(c.address);
    out.push({ address: c.address, ...(c.name ? { name: c.name } : {}) });
  }
  return out;
}
