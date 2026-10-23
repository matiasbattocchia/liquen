/**
 * connect/flavor.ts — markdown translation at the wire (§4). The log speaks COMMON
 * markdown — the models' native tongue, so harness lines and agent prose alike carry it
 * without thinking about where they will land. Each service reads and writes its own
 * dialect, and the translation lives at the boundary, both ways: dispatch translates OUT
 * (common → wire), ingest translates IN (wire → common). The REPL shows common markdown
 * raw until it renders it.
 *
 * What needs translating is MEASURED, not assumed. WhatsApp clients (probed live,
 * Android + Web) parse CommonMark natively — `**bold**`, `*italic*`,
 * `~~strike~~`, `` `code` ``, headings, bullets, quotes all render; only the link syntax
 * `[text](url)` shows raw. Slack parses mrkdwn, its own documented dialect: `*bold*`,
 * `~strike~`, `<url|text>`, no headings — and, measured off the blocks Slack parses a post
 * into, a marker reads as one only at a word's edge: `*bash*(git status)` stays literal.
 * A zero-width space gives a marker that touches a word the edge it needs.
 *
 * Slack's wire reserves `&`, `<` and `>` — the angle pair delimits its link, mention and
 * control forms, and the ampersand its entities — so every one of the three in prose
 * travels as `&amp;`, `&lt;`, `&gt;`, inside code spans as much as outside them. Outbound,
 * the escape runs FIRST, so the forms the transforms then emit are the only angle brackets
 * on the wire (an `&` inside a URL rides as `&amp;` between them, the wire's own spelling).
 * Inbound, the unescape runs LAST, after the wire forms are consumed, so an escaped
 * `&lt;foo&gt;` is the text `<foo>` and never reads as a form.
 *
 * Every markdown transform skips code — a marker inside backticks or a fence is content,
 * not formatting, on every dialect involved.
 */

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Run a transform on the prose between code spans/fences, leaving the code untouched. */
function outsideCode(text: string, fn: (s: string) => string): string {
  return text.split(CODE).map((chunk, i) => (i % 2 === 1 ? chunk : fn(chunk))).join("");
}

/** Common markdown → the WhatsApp wire. Links only — the one syntax WhatsApp shows raw:
 *  `[text](url)` → `text (url)`, the bare URL auto-linking on the client. */
export function toWhatsApp(text: string): string {
  return outsideCode(text, (s) => s.replace(LINK, "$1 ($2)"));
}

/** A link to anything but the web — `[Acme](org:5f3a)`, an id the agent's own app reads —
 *  points nowhere on a chat wire: its words stand alone. */
const NON_WEB_LINK = /\[([^\]]+)\]\([^\s)]+\)/g;

const ZWSP = "\u200b";

/** `**b**` → `*b*` (and `~~s~~` → `~s~`), a zero-width space against whatever word the
 *  marker would otherwise touch. */
function mark(s: string, common: RegExp, wire: string): string {
  return s.replace(common, (whole: string, inner: string, at: number, all: string) => {
    const before = at > 0 && !/\s/.test(all[at - 1]) ? ZWSP : "";
    const next = all[at + whole.length];
    const after = next !== undefined && !/\s/.test(next) ? ZWSP : "";
    return `${before}${wire}${inner}${wire}${after}`;
  });
}

/** Common markdown → Slack mrkdwn: the three wire characters escape over the whole text,
 *  then `**b**` → `*b*`, `~~s~~` → `~s~`, `[t](u)` → `<u|t>` and a link off the web → its
 *  words, a heading line → a bold line (mrkdwn has no headings). */
export function toSlack(text: string): string {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return outsideCode(escaped, (s) =>
    mark(
      mark(
        s.replace(LINK, "<$2|$1>").replace(NON_WEB_LINK, "$1").replace(
          /^#{1,6}\s+(.+)$/gm,
          "**$1**",
        ),
        /\*\*([^*\n]+)\*\*/g,
        "*",
      ),
      /~~([^~\n]+)~~/g,
      "~",
    ));
}

/** Slack mrkdwn → common markdown, the inbound leg: `<url|t>` → `[t](url)`, bare `<url>`
 *  unwrapped, `*b*` → `**b**`, `~s~` → `~~s~~`, and the three entities unescaped last, over
 *  the whole text. Meaning-preserving: a Slack single star IS bold, so it must not survive
 *  as common-markdown italic. */
export function fromSlack(text: string): string {
  return outsideCode(text, (s) =>
    s
      .replace(/\u200b(?=[*~])|(?<=[*~])\u200b/g, "")
      .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1**$2**")
      .replace(/(^|[^~])~([^~\n]+)~(?!~)/g, "$1~~$2~~"))
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
