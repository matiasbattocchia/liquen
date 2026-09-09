/**
 * connect/mentions.ts — OUTBOUND mention resolution (§3, §5): the inverse of the
 * ingest decode. Display form lives in the log; encoding happens at the frontier.
 *
 * The agent writes mentions as a human would — `@Name`, `#channel`, or the address
 * itself when it wants precision — and the DISPATCHER resolves them. The directory is
 * the log itself: every prior message taught us a `sender.name → sender.address` pair
 * (conversation-scoped — recency disambiguates namesakes), and every decoded channel
 * ref taught us a `#name → id` pair (workspace facts, lifted service-wide). The wire's
 * own display facts — pushnames, users.info, delivery labels — nothing of ours. An
 * unresolved token stays literal text: the same graceful nothing a human gets typing
 * a name the autocomplete didn't take.
 *
 * Per wire: Slack's encoding is liquen's job (`@Name` → `<@U…>`, `#chan` → `<#C…>`,
 * specials → `<!here>`); WhatsApp's is the bridge's (`content.mentions`
 * [{address, name}] drives its `@Name` → `@digits` rewrite + ContextInfo.MentionedJID
 * on texts and captions alike) — liquen only claims the tokens.
 */

import type { ReadQuery } from "../store/log.ts";
import type { Event, MessageEvent } from "../types.ts";

export interface NameEntry {
  address: string;
  name?: string;
  /** The sigil the token wears: `@` a person (the default when absent), `#` a
   *  conversation — the same shape `payload.mentions` stores (§3). */
  type?: "@" | "#";
}

/** What this conversation can name: people and channels, freshest fact first. */
export type Directory = (service: string, conversation: string) => Promise<NameEntry[]>;

/** The log-backed directory. People come from the CONVERSATION's recent senders —
 *  duplicate addresses keep their freshest name; duplicate names keep their freshest
 *  address (the older namesake stays reachable by `@<address>`). Channels come from
 *  the SERVICE's recent decoded refs (`payload.mentions` entries with `type: "#"`) —
 *  a channel's name is a workspace fact, not a conversation one. */
export function logDirectory(
  read: (q: ReadQuery) => Promise<Event[]>,
  limit = 400,
): Directory {
  return async (service, conversation) => {
    const [local, wide] = await Promise.all([
      read({ service, conversation, types: ["message"], limit }),
      read({ service, types: ["message"], limit }),
    ]);
    const people = new Map<string, NameEntry>();
    for (let i = local.length - 1; i >= 0; i--) { // append order → walk newest-first
      const s = local[i].envelope.sender;
      if (!s?.address || people.has(s.address)) continue;
      people.set(s.address, { address: s.address, ...(s.name ? { name: s.name } : {}) });
    }
    const channels = new Map<string, NameEntry>();
    for (let i = wide.length - 1; i >= 0; i--) {
      for (const m of (wide[i] as MessageEvent).payload?.mentions ?? []) {
        if (m.type !== "#" || !m.name || channels.has(m.address)) continue;
        channels.set(m.address, { address: m.address, name: m.name, type: "#" });
      }
    }
    return [...people.values(), ...channels.values()];
  };
}

/** A claimed token: which directory entry a sigiled span in the text names. */
export interface Claim extends NameEntry {
  index: number; // where the sigil sits — claims return in order of appearance
  length: number; // the whole claimed token, sigil included
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a token ends where a name/address character can't continue it
const boundary = /[\p{L}\p{N}_.-]/u;
// a sigil is a mention only at a word start: inside a word (`foo@here.com`) it is
// spelling, not addressing
const word = /[\p{L}\p{N}_]/u;

/** Find the tokens the directory can claim: `@Name`/`#name` (case-insensitive) and
 *  the always-precise sigiled address. Longest key first, so "@Ana María" is never
 *  half-claimed by "@Ana"; overlapping claims lose to the earlier, longer one. */
export function claimMentions(text: string, dir: NameEntry[]): Claim[] {
  const keys: { key: string; entry: NameEntry }[] = [];
  for (const e of dir) {
    const sigil = e.type ?? "@";
    keys.push({ key: sigil + e.address, entry: e });
    if (e.name) keys.push({ key: sigil + e.name, entry: e });
  }
  keys.sort((a, b) => b.key.length - a.key.length);

  const claims: Claim[] = [];
  const taken: [number, number][] = []; // claimed [start, end) spans
  for (const { key, entry } of keys) {
    const re = new RegExp(esc(key), "gi");
    for (const m of text.matchAll(re)) {
      const start = m.index, end = start + m[0].length;
      if (start > 0 && word.test(text[start - 1])) continue; // the sigil is inside a word
      if (text[end] !== undefined && boundary.test(text[end])) continue; // mid-word
      if (taken.some(([s, e2]) => start < e2 && end > s)) continue;
      taken.push([start, end]);
      claims.push({ ...entry, index: start, length: m[0].length });
    }
  }
  return claims.sort((a, b) => a.index - b.index);
}

/** Slack's special mentions — the tokens a human types → the wire's control words. Only
 *  at a word start: `foo@here.com` is an address, not a summons. */
const SPECIAL = /(?<![\p{L}\p{N}_])@(here|channel|everyone)\b/gu;
/** A bare Slack user/channel id typed directly — always resolvable, directory or not.
 *  Slack mints every object id as a type letter followed by a DIGIT (`U0…`, `W1…`, `C0…`),
 *  which is what tells an id from an uppercase word (`@UPDATES123` is a name; the
 *  directory claims it when it knows the address). The lookbehind skips ids the claim
 *  pass already wrapped (`<@U…>`, `<#C…>`) and sigils inside a word. */
const BARE_ID = /(?<![<\p{L}\p{N}_])@([UW][0-9][A-Z0-9]{7,})\b/gu;
const BARE_CHANNEL = /(?<![<\p{L}\p{N}_])#(C[0-9][A-Z0-9]{7,})\b/gu;

/** Encode outbound Slack text: claimed names → `<@U…>`/`<#C…>`, bare ids likewise,
 *  specials → `<!here>` etc. Everything unclaimed stays as written. */
export function encodeSlackText(text: string, dir: NameEntry[]): string {
  let out = "";
  let at = 0;
  for (const c of claimMentions(text, dir)) {
    out += text.slice(at, c.index) + (c.type === "#" ? `<#${c.address}>` : `<@${c.address}>`);
    at = c.index + c.length;
  }
  out += text.slice(at);
  return out
    .replace(BARE_ID, "<@$1>")
    .replace(BARE_CHANNEL, "<#$1>")
    .replace(SPECIAL, "<!$1>");
}

/** Claim outbound WhatsApp mentions for the bridge's encoder: [{address, name?}] —
 *  the bridge rewrites `@Name` → `@digits` and fills MentionedJID (texts and captions);
 *  a nameless claim (the text already says `@<address>`) passes through as the JID
 *  alone. Channel entries never claim — WhatsApp has no channel mention. */
export function whatsappMentions(text: string, dir: NameEntry[]): NameEntry[] {
  const seen = new Set<string>();
  const out: NameEntry[] = [];
  for (const c of claimMentions(text, dir.filter((e) => e.type !== "#"))) {
    if (seen.has(c.address)) continue;
    seen.add(c.address);
    out.push({ address: c.address, ...(c.name ? { name: c.name } : {}) });
  }
  return out;
}
