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
 * `~strike~`, `<url|text>`, no headings.
 *
 * Every transform skips code — a marker inside backticks or a fence is content, not
 * formatting, on every dialect involved.
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

/** Common markdown → Slack mrkdwn: `**b**` → `*b*`, `~~s~~` → `~s~`, `[t](u)` → `<u|t>`,
 *  a heading line → a bold line (mrkdwn has no headings). */
export function toSlack(text: string): string {
  return outsideCode(text, (s) =>
    s
      .replace(LINK, "<$2|$1>")
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/~~([^~\n]+)~~/g, "~$1~")
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*"));
}

/** Slack mrkdwn → common markdown, the inbound leg: `<url|t>` → `[t](url)`, bare `<url>`
 *  unwrapped, `*b*` → `**b**`, `~s~` → `~~s~~`. Meaning-preserving: a Slack single star
 *  IS bold, so it must not survive as common-markdown italic. */
export function fromSlack(text: string): string {
  return outsideCode(text, (s) =>
    s
      .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1**$2**")
      .replace(/(^|[^~])~([^~\n]+)~(?!~)/g, "$1~~$2~~"));
}
