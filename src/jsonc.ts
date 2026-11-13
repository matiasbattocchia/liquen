/**
 * jsonc.ts — a member added to or taken out of a JSONC file's top-level section, as a
 * text edit: the file is its owner's, comments and layout included, so the edit is the
 * member's own lines and the comma beside them, every other byte as it was found.
 */

/** Brace depth at `at` within `text`, counted from its start. */
function depthAt(text: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return depth;
}

/** The offsets of the braces that open and close a top-level section's block. */
function block(raw: string, section: string, path: string): [number, number] {
  const at = topLevel(raw, section);
  const open = at < 0 ? -1 : raw.indexOf("{", at);
  if (open < 0) throw new Error(`${path}: no "${section}" section`);
  let depth = 0, close = open;
  for (; close < raw.length; close++) {
    if (raw[close] === "{") depth++;
    else if (raw[close] === "}" && --depth === 0) break;
  }
  if (close === raw.length) throw new Error(`${path}: "${section}" is never closed`);
  return [open, close];
}

/** Where `"section":` opens at the file's TOP level — depth one in braces — or -1. The
 *  first match in the file is not it: `"agents":` also names the defaults every agent
 *  inherits, one level down under `shared`. */
function topLevel(raw: string, section: string): number {
  for (const m of raw.matchAll(new RegExp(`"${section}"\\s*:`, "g"))) {
    if (depthAt(raw, m.index) === 1) return m.index;
  }
  return -1;
}

/** `raw` with one rendered member at the tail of its top-level `section`'s block, so the
 *  block reads in the order things were declared and its leading comment stays on top. A
 *  surgical text edit, not a re-render: the file is the operator's, comments and layout
 *  included, so the insertion is the member's own lines inside the existing block, a comma
 *  on the member before it when there is one, and every other byte is left as it was
 *  found. `path` only names the file in a complaint. */
export function withMember(raw: string, section: string, member: string, path: string): string {
  const [open, close] = block(raw, section, path);
  // the comma goes on the last MEMBER line — never on a blank or a comment that trails it
  const lines = raw.slice(open + 1, close).trimEnd().split("\n");
  const last = lines.findLastIndex((l) => l.trim() !== "" && !l.trim().startsWith("//"));
  if (last >= 0) {
    const line = lines[last];
    const code = line.slice(0, codeEnd(line)).trimEnd();
    lines[last] = `${code},${line.slice(code.length)}`;
  }
  const body = `${lines.join("\n")}\n    ${member}\n  `;
  return raw.slice(0, open + 1) + body + raw.slice(close);
}

/** `raw` without the member `name` of its top-level `section`: the member's own lines go,
 *  and the comma that separated it, every other byte as it was found — `withMember`'s
 *  inverse. `raw` as given when the section has no such member. */
export function withoutMember(raw: string, section: string, name: string, path: string): string {
  const [open, close] = block(raw, section, path);
  const key = [...raw.slice(open, close).matchAll(new RegExp(`"${name}"\\s*:`, "g"))]
    .map((m) => open + m.index)
    .find((at) => depthAt(raw, at) === 2);
  if (key === undefined) return raw;
  let end = raw.indexOf(":", key) + 1;
  while (/\s/.test(raw[end])) end++;
  end = valueEnd(raw, end);
  const lineStart = raw.lastIndexOf("\n", key) + 1;
  const from = raw.slice(lineStart, key).trim() === "" ? lineStart : key;
  let to = end;
  while (raw[to] === " " || raw[to] === "\t") to++;
  if (raw[to] === ",") {
    to++;
    const rest = raw.indexOf("\n", to);
    if (rest >= 0 && raw.slice(to, rest).trim() === "") to = rest + 1;
    return raw.slice(0, from) + raw.slice(to);
  }
  // the block's last member: the comma on the member before it goes instead — the last
  // code on an earlier line, ahead of any comment that trails it
  let cut = -1;
  for (let end = from - 1; end > open && cut < 0;) {
    const start = raw.lastIndexOf("\n", end - 1) + 1;
    const line = raw.slice(start, end);
    const code = line.slice(0, codeEnd(line)).trimEnd();
    if (code.endsWith(",")) cut = start + code.length - 1;
    else if (code.trim() !== "") break;
    end = start - 1;
  }
  const kept = cut >= 0 ? raw.slice(0, cut) + raw.slice(cut + 1, from) : raw.slice(0, from);
  const rest = raw.indexOf("\n", to);
  return kept + raw.slice(rest >= 0 && raw.slice(to, rest).trim() === "" ? rest + 1 : to);
}

/** Where the JSON value starting at `at` ends: past its closing quote or bracket. */
function valueEnd(raw: string, at: number): number {
  if (raw[at] === '"') {
    for (let i = at + 1; i < raw.length; i++) {
      if (raw[i] === "\\") i++;
      else if (raw[i] === '"') return i + 1;
    }
    return raw.length;
  }
  if (raw[at] !== "{" && raw[at] !== "[") {
    let i = at;
    while (i < raw.length && !/[,}\]\n]/.test(raw[i])) i++;
    return i;
  }
  let depth = 0;
  let quoted = false;
  for (let i = at; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return raw.length;
}

/** Where a line's code ends: at a `//` that opens a comment — outside any string — or at
 *  the line's end. */
function codeEnd(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (quoted) {
      if (line[i] === "\\") i++;
      else if (line[i] === '"') quoted = false;
    } else if (line[i] === '"') quoted = true;
    else if (line[i] === "/" && line[i + 1] === "/") return i;
  }
  return line.length;
}
