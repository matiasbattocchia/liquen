/**
 * connect/mentions.ts — a line's mentions in the wire's own form (§3, §5). The send resolved
 * them and the row carries them (`payload.mentions`, `src/mentions.ts`); here they are
 * encoded at the frontier.
 *
 * Per wire: Slack's encoding is liquen's job (`@Name` → `<@U…>`, `#chan` → `<#C…>`,
 * specials → `<!here>`); WhatsApp's is the bridge's (`content.mentions` [{address, name}]
 * drives its `@<name>` → `@digits` rewrite and ContextInfo.MentionedJID on texts and
 * captions alike), so liquen hands it the mentions the text carries.
 */

import { claimMentions, type NameEntry } from "../mentions.ts";

/** Slack's special mentions — the tokens a human types → the wire's control words. Only
 *  at a word start: `foo@here.com` is an address, not a summons. */
const SPECIAL = /(?<![\p{L}\p{N}_])@(here|channel|everyone)\b/gu;
/** A bare Slack user/channel id typed directly — always resolvable. Slack mints every
 *  object id as a type letter followed by a DIGIT (`U0…`, `W1…`, `C0…`), which is what tells
 *  an id from an uppercase word (`@UPDATES123` is a name). The lookbehind skips ids already
 *  wrapped (`<@U…>`, `<#C…>`) and sigils inside a word. */
const BARE_ID = /(?<![<\p{L}\p{N}_])@([UW][0-9][A-Z0-9]{7,})\b/gu;
const BARE_CHANNEL = /(?<![<\p{L}\p{N}_])#(C[0-9][A-Z0-9]{7,})\b/gu;

/** The handles Slack mentions by itself: the specials and a bare id. */
export const SLACK_NATIVE = /^(?:here|channel|everyone|[UW][0-9][A-Z0-9]{7,})$/;

/** Encode outbound Slack text: the line's mentions → `<@U…>`/`<#C…>`, bare ids likewise,
 *  specials → `<!here>` etc. Everything else stays as written. */
export function encodeSlackText(text: string, mentions: NameEntry[]): string {
  let out = "";
  let at = 0;
  for (const c of claimMentions(text, mentions)) {
    out += text.slice(at, c.index) + (c.type === "#" ? `<#${c.address}>` : `<@${c.address}>`);
    at = c.index + c.length;
  }
  out += text.slice(at);
  return out
    .replace(BARE_ID, "<@$1>")
    .replace(BARE_CHANNEL, "<#$1>")
    .replace(SPECIAL, "<!$1>");
}

/** The line's people a WhatsApp text or caption writes, for the bridge's encoder, each
 *  once. WhatsApp has no channel mention. */
export function whatsappMentions(text: string, mentions: NameEntry[]): NameEntry[] {
  const out: NameEntry[] = [];
  for (const c of claimMentions(text, mentions.filter((e) => e.type !== "#"))) {
    if (out.some((m) => m.address === c.address && m.name === c.name)) continue;
    out.push({ address: c.address, ...(c.name ? { name: c.name } : {}) });
  }
  return out;
}
