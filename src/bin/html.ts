/**
 * bin/html.ts — a page as `fetch` shows it: the text a reader sees, as light markdown, then
 * the data the page carries for its own scripts.
 *
 * Nothing here runs the page's JavaScript, so what the server sent is the whole of what
 * there is to read. A page's content lives in one of two places: the markup a reader
 * without scripts sees (`<noscript>` included), or a data script — `<script
 * type="application/json">`, `application/ld+json` — whose JSON the page's code renders
 * from, and which is often the only copy of a client-rendered page's content. The markup
 * becomes text; each data script follows the text under its own opening tag, its JSON
 * pretty when it parses, wherever it stood in the page (hidden or not). Executable scripts,
 * styles, svg, form controls and anything the page hides from view are dropped.
 *
 * The parser is a forgiving tokenizer and a tree with HTML's common implied closes (a
 * `<li>`, `<td>` or `<p>` ended by what follows it), not a spec parser: it needs only the
 * reading order and the block boundaries right.
 */

interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: Node[];
}
type Node = El | string;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Elements whose content is text up to their own closing tag, never markup. */
const RAW = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);
/** Dropped with everything inside: nothing in them reads as the page's text. */
const DROP = new Set([
  "head",
  "script",
  "style",
  "title",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "object",
  "audio",
  "video",
  "select",
  "datalist",
  "textarea",
  "input",
  "xmp",
  "noembed",
  "noframes",
]);
/** Elements that flow inside a line; every other element is a block of its own. */
const INLINE = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "ins",
  "kbd",
  "label",
  "mark",
  "meter",
  "nobr",
  "output",
  "picture",
  "progress",
  "q",
  "s",
  "samp",
  "slot",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);
/** An opening tag that ends an open sibling: a new `<li>` ends the one before it, within
 *  its own list and never past it. */
const ENDS: Record<string, { ends: string[]; scope: string[] }> = {
  li: { ends: ["li"], scope: ["ul", "ol", "menu"] },
  dt: { ends: ["dt", "dd"], scope: ["dl"] },
  dd: { ends: ["dt", "dd"], scope: ["dl"] },
  tr: { ends: ["tr", "td", "th"], scope: ["table", "thead", "tbody", "tfoot"] },
  td: { ends: ["td", "th"], scope: ["tr", "table"] },
  th: { ends: ["td", "th"], scope: ["tr", "table"] },
  thead: { ends: ["thead", "tbody", "tfoot", "tr", "td", "th"], scope: ["table"] },
  tbody: { ends: ["thead", "tbody", "tfoot", "tr", "td", "th"], scope: ["table"] },
  tfoot: { ends: ["thead", "tbody", "tfoot", "tr", "td", "th"], scope: ["table"] },
  option: { ends: ["option"], scope: ["select", "datalist", "optgroup"] },
};
/** The elements whose opening tag ends an open `<p>`. */
const ENDS_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
/** What `<head>` holds; any other element opens the body and ends an unclosed head. */
const HEAD = new Set(["title", "meta", "link", "style", "script", "base", "noscript", "template"]);
/** Nesting past this is flattened into the deepest element, so unclosed tags repeated
 *  thousands of times cannot exhaust the renderer's stack. */
const MAX_DEPTH = 512;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "",
  zwnj: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  iexcl: "¡",
  iquest: "¿",
};

/** Character references: numeric ones always, named ones from the common set; an unknown
 *  name stays as written (`?a=1&b=2` in a URL is not a reference). */
export function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (all, e: string) => {
    if (e[0] !== "#") return NAMED[e] ?? all;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

const OPEN = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const CLOSE = /<\/([a-zA-Z][^\s/>]*)[^>]*>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** The tree: a root whose kids are the document's top-level nodes, text already decoded. */
export function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  const text = (s: string) => {
    if (s) top().kids.push(decode(s));
  };
  const close = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return;
      }
    }
  };
  const implied = (tag: string) => {
    if (!HEAD.has(tag)) {
      const head = stack.findIndex((e) => e.tag === "head");
      if (head > 0) stack.length = head;
    }
    const rule = ENDS[tag];
    if (rule) {
      let cut = 0;
      for (let i = stack.length - 1; i > 0; i--) {
        if (rule.scope.includes(stack[i].tag)) break;
        if (rule.ends.includes(stack[i].tag)) cut = i;
      }
      if (cut) stack.length = cut;
    }
    if (ENDS_P.has(tag) && top().tag === "p") stack.length--;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      top().kids.push(html.slice(i + 9, end < 0 ? html.length : end));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    CLOSE.lastIndex = i;
    const shut = CLOSE.exec(html);
    if (shut) {
      const tag = shut[1].toLowerCase();
      if (tag === "br") top().kids.push({ tag, attrs: {}, kids: [] });
      else close(tag);
      i = CLOSE.lastIndex;
      continue;
    }
    OPEN.lastIndex = i;
    const open = OPEN.exec(html);
    if (!open) {
      text("<");
      i++;
      continue;
    }
    i = OPEN.lastIndex;
    const tag = open[1].toLowerCase();
    implied(tag);
    const el: El = { tag, attrs: attributes(open[2]), kids: [] };
    top().kids.push(el);
    if (RAW.has(tag)) {
      const end = new RegExp(`</${tag}[\\s/>]`, "gi");
      end.lastIndex = i;
      const at = end.exec(html)?.index ?? html.length;
      const body = html.slice(i, at);
      if (body) el.kids.push(tag === "title" || tag === "textarea" ? decode(body) : body);
      const gt = html.indexOf(">", at);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    // `/>` closes only after a space, a quote or the bare name: `<a href=/docs/>` opens
    const selfClosing = /(?:^|[\s"'])\/\s*$/.test(open[2]);
    if (!VOID.has(tag) && !selfClosing && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

interface Page {
  base?: string;
  title?: string;
  description?: string;
  data: string[];
  /** Preformatted blocks, set aside while the text around them is reflowed. */
  pre: string[];
}

/** Marks the text keeps out of the reflow: an indent, and a preformatted block's slot.
 *  Private-use code points, removed from the page's own text so only these are marks. */
const INDENT = "";
const SLOT = "";

const isEl = (n: Node): n is El => typeof n !== "string";
const flat = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const block = (s: string) => `\n\n${s.trim()}\n\n`;

function resolve(href: string, base?: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function hidden(attrs: Record<string, string>): boolean {
  return ("hidden" in attrs && attrs.hidden !== "until-found") ||
    /display\s*:\s*none/i.test(attrs.style ?? "");
}

/** The text under a node as written: whitespace kept, `<br>` a newline. */
function textOf(n: Node): string {
  if (!isEl(n)) return n;
  if (n.tag === "br") return "\n";
  return n.kids.map(textOf).join("");
}

function dataBlock(script: El): string | undefined {
  const raw = (script.kids[0] as string | undefined)?.trim();
  if (!raw) return undefined;
  let body = raw;
  try {
    body = JSON.stringify(JSON.parse(raw), null, 2);
  } catch { /* shown as served */ }
  const id = script.attrs.id ? ` id="${script.attrs.id}"` : "";
  return `<script type="${script.attrs.type}"${id}>\n${body}\n</script>`;
}

/** What the page says about itself, wherever it says it: title, description, base, and
 *  every data script, in document order. */
function survey(nodes: Node[], page: Page, inSvg = false): void {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    const { tag, attrs } = n;
    if (tag === "script") {
      const data = /json/i.test(attrs.type ?? "") ? dataBlock(n) : undefined;
      if (data) page.data.push(data);
      continue;
    }
    if (tag === "title" && !inSvg) page.title ||= flat(textOf(n));
    if (tag === "meta" && /^(og:)?description$/i.test(attrs.name ?? attrs.property ?? "")) {
      page.description ||= attrs.content?.trim();
    }
    if (tag === "base" && attrs.href) page.base = resolve(attrs.href, page.base);
    survey(n.kids, page, inSvg || tag === "svg");
  }
}

function walk(nodes: Node[], page: Page): string {
  return nodes.map((n) => one(n, page)).join("");
}

function one(n: Node, page: Page): string {
  if (!isEl(n)) return n.replaceAll(INDENT, "").replaceAll(SLOT, "").replace(/\s+/g, " ");
  const { tag, attrs, kids } = n;
  if (DROP.has(tag) || hidden(attrs)) return "";
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return block("---");
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = flat(walk(kids, page));
      return text ? block(`${"#".repeat(Number(tag[1]))} ${text}`) : "";
    }
    case "pre":
      return pre(n, page);
    case "code":
    case "kbd":
    case "samp": {
      const text = flat(textOf(n).replace(/\s+/g, " "));
      return text ? `\`${text}\`` : "";
    }
    case "a": {
      const text = flat(walk(kids, page));
      const href = attrs.href?.trim();
      if (!text || !href || href.startsWith("#") || /^javascript:/i.test(href)) return text;
      return `[${text}](${resolve(href, page.base)})`;
    }
    case "img": {
      const alt = flat(attrs.alt ?? "");
      if (!alt) return "";
      const src = attrs.src?.trim();
      return !src || src.startsWith("data:")
        ? `![${alt}]`
        : `![${alt}](${resolve(src, page.base)})`;
    }
    case "ul":
    case "ol":
    case "menu":
      return list(n, page);
    case "li":
      return `\n${item(n, "- ", page)}\n`;
    case "table":
      return table(n, page);
    case "blockquote": {
      const text = walk(kids, page).trim().replace(/\n(?:[^\S\n]*\n)+/g, "\n\n");
      return text ? block(text.split("\n").map((l) => `> ${l}`).join("\n")) : "";
    }
  }
  const inner = walk(kids, page);
  return INLINE.has(tag) ? inner : block(inner);
}

function pre(n: El, page: Page): string {
  const code = textOf(n).replace(/^\n/, "").trimEnd();
  if (!code) return "";
  const classes = [n.attrs.class, ...n.kids.filter(isEl).map((k) => k.attrs.class)].join(" ");
  const lang = /(?:^|\s)lang(?:uage)?-(\S+)/.exec(classes)?.[1] ?? "";
  const fence = code.includes("```") ? "````" : "```";
  page.pre.push(`${fence}${lang}\n${code}\n${fence}`);
  return block(`${SLOT}${page.pre.length - 1}${SLOT}`);
}

function list(n: El, page: Page): string {
  let k = Number(n.attrs.start) || 1;
  const items = n.kids.map((kid) => {
    if (!isEl(kid) || kid.tag !== "li") return one(kid, page);
    return item(kid, n.tag === "ol" ? `${k++}. ` : "- ", page);
  });
  return block(`\n${items.join("")}`);
}

/** One list item: its marker, then its lines, continuation lines and nested lists indented
 *  under it. */
function item(li: El, marker: string, page: Page): string {
  const lines = walk(li.kids, page).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `${marker}${lines.join(`\n${INDENT}`)}\n`;
}

/** A data table is rows of cells, a header rule under a row of `<th>`. A table holding a
 *  table lays out a page rather than data, so its cells read as blocks. */
function table(t: El, page: Page): string {
  const rows: El[] = [];
  let layout = false;
  const find = (nodes: Node[]) => {
    for (const k of nodes.filter(isEl)) {
      if (k.tag === "table") layout = true;
      else if (k.tag === "tr") {
        rows.push(k);
        find(k.kids);
      } else find(k.kids);
    }
  };
  find(t.kids);
  if (layout) return block(walk(t.kids, page));
  const lines: string[] = [];
  for (const tr of rows) {
    const cells = tr.kids.filter(isEl).filter((c) => c.tag === "td" || c.tag === "th");
    if (!cells.length) continue;
    const text = cells.map((c) => flat(walk(c.kids, page)).replaceAll("|", "\\|"));
    lines.push(`| ${text.join(" | ")} |`);
    if (lines.length === 1 && cells.every((c) => c.tag === "th")) {
      lines.push(`|${" --- |".repeat(cells.length)}`);
    }
  }
  const caption = t.kids.filter(isEl).find((k) => k.tag === "caption");
  const title = caption ? flat(walk(caption.kids, page)) : "";
  return block([title, lines.join("\n")].filter(Boolean).join("\n\n"));
}

/** One space between words, no blank runs longer than one line, then the set-aside marks
 *  put back. */
function tidy(s: string, page: Page): string {
  return s.split("\n").map((l) => l.replace(/ {2,}/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim()
    .replaceAll(INDENT, "  ")
    .replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_, i: string) => page.pre[Number(i)]);
}

/** The page as text: `# title` and its description, the body as light markdown with links
 *  absolute against `base`, then each data script. */
export function htmlToText(html: string, base?: string): string {
  const root = parse(html);
  const page: Page = { base, data: [], pre: [] };
  survey(root.kids, page);
  const head = [page.title && `# ${page.title}`, page.description].filter(Boolean).join("\n\n");
  return [head, tidy(walk(root.kids, page), page), ...page.data].filter(Boolean).join("\n\n");
}
