/**
 * exec/edit.ts — the text-anchored multi-edit engine (DESIGN §9, from pi's edit tool).
 *
 * A spec is one or more conflict-marker blocks (a format models already know):
 *
 *   <<<<<<<
 *   old text
 *   =======
 *   new text
 *   >>>>>>>
 *
 * Every block is matched against the ORIGINAL file — not incrementally — and must be
 * unique and non-overlapping. Matching is exact first, then trailing-whitespace-
 * insensitive (the fallback rewrites the file in normalized space, as pi does). BOM and
 * CRLF are stripped for matching and restored on write.
 */

export interface Edit {
  old: string;
  new: string;
}

/** Parse a conflict-marker spec. Throws on malformed input. */
export function parseEdits(spec: string): Edit[] {
  const lines = spec.split("\n");
  const edits: Edit[] = [];
  let mode: "outside" | "old" | "new" = "outside";
  let oldLines: string[] = [];
  let newLines: string[] = [];
  for (const line of lines) {
    if (line === "<<<<<<<") {
      if (mode !== "outside") throw new Error("malformed spec: unexpected <<<<<<<");
      mode = "old";
      oldLines = [];
      newLines = [];
    } else if (line === "=======") {
      if (mode !== "old") throw new Error("malformed spec: ======= outside a block");
      mode = "new";
    } else if (line === ">>>>>>>") {
      if (mode !== "new") throw new Error("malformed spec: >>>>>>> outside a block");
      edits.push({ old: oldLines.join("\n"), new: newLines.join("\n") });
      mode = "outside";
    } else if (mode === "old") oldLines.push(line);
    else if (mode === "new") newLines.push(line);
    else if (line.trim() !== "") {
      throw new Error(`malformed spec: text outside a block: ${line.slice(0, 40)}`);
    }
  }
  if (mode !== "outside") throw new Error("malformed spec: unterminated block");
  if (edits.length === 0) throw new Error("empty spec: no edit blocks found");
  return edits;
}

const stripTrailing = (s: string) => s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");

function indexOfUnique(haystack: string, needle: string, label: string): number {
  if (needle.length === 0) throw new Error(`edit ${label}: old text is empty`);
  const first = haystack.indexOf(needle);
  if (first === -1) return -1;
  if (haystack.indexOf(needle, first + 1) !== -1) {
    throw new Error(`edit ${label}: old text matches more than once — make it unique`);
  }
  return first;
}

/** Apply edits to content (LF-normalized, BOM-free). Returns the new content. */
function applyToNormalized(content: string, edits: Edit[]): string {
  // exact match first; if ANY edit misses, retry every edit in trailing-ws-normalized space
  let base = content;
  let use = edits;
  const misses = edits.filter((e) => base.indexOf(e.old) === -1);
  if (misses.length > 0) {
    base = stripTrailing(content);
    use = edits.map((e) => ({ old: stripTrailing(e.old), new: e.new }));
  }
  // locate all (unique) matches against the ORIGINAL, validate non-overlap
  const spans = use.map((e, i) => {
    const start = indexOfUnique(base, e.old, `#${i + 1}`);
    if (start === -1) {
      throw new Error(
        `edit #${i + 1}: old text not found${
          misses.length > 0 ? " (even ignoring trailing whitespace)" : ""
        }`,
      );
    }
    return { start, end: start + e.old.length, text: e.new };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      throw new Error("edits overlap — merge nearby changes into one block");
    }
  }
  // splice back-to-front so earlier spans keep their offsets
  let out = base;
  for (const s of [...spans].reverse()) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/** Apply a parsed spec to raw file content, preserving BOM and line endings. */
export function applyEdits(raw: string, edits: Edit[]): string {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes("\r\n");
  const normalized = crlf ? text.replaceAll("\r\n", "\n") : text;
  const lfEdits = edits.map((e) => ({
    old: e.old.replaceAll("\r\n", "\n"),
    new: e.new.replaceAll("\r\n", "\n"),
  }));
  const result = applyToNormalized(normalized, lfEdits);
  return bom + (crlf ? result.replaceAll("\n", "\r\n") : result);
}
