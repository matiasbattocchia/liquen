/**
 * store/docs.ts — the Docs port (read side): substrate access to the doc cascade.
 *
 * The durable, human/agent-authored side of the substrate (DESIGN §8): instructions, skills,
 * memory, and tool (MCP) config, across four scopes:
 *
 *   system → org → agent → conversation
 *
 * **One discovery rule, every scope**: walk the scope directory recursively; a file is a doc
 * iff it is `.md` AND opens with YAML frontmatter — *a doc declares itself*. `kind` comes
 * from the frontmatter (`kind: instruction|skill|memory|tool`, default `memory`); folder
 * structure is pure convention (plural by custom: `instructions/`, `skills/`, `memories/`,
 * `tools/`) and invisible to the code. This is what lets the agent scope BE the agent's
 * workspace (`agents/<name>/`): a cloned repo's READMEs have no frontmatter and are ignored,
 * while the agent's own frontmattered notes anywhere in its home are its docs.
 *
 * The **privileged** read path nu/render use in-process (the agent's own read/write goes via
 * the substrate primitive — `aread`/`sql`, §9). It stays close to dumb: it lists docs and,
 * per each doc's `load`, hands render the header alone or the whole document. render owns the
 * rest of the policy — build the skill/memory index from the headers, order (by kind, cascade
 * within kind), lay them out.
 *
 *   • `load: always` → `list` returns `{ header, body }` (render inlines it: persona, core
 *     instructions).
 *   • otherwise      → `{ header }` only, a pointer; the body is pulled on demand — by the
 *     agent via the substrate read, or by render via `read()`.
 *
 * The **system** scope alone has two layers, because those words are the harness's and an
 * upgrade must be able to change them (§8): the package's own set never reaches the data
 * root — it is read where the package lives (`systemDocs`, store/seed.ts) — and anything the
 * org writes under `system/` answers for that name instead: a real doc replaces it, a file
 * with no frontmatter says the org wants none. So an org that writes nothing tracks the
 * package, and one that writes is never argued with. Such a doc's `path` is the package's
 * address, which is a plain path in a checkout and a URL in an installed org; `aread` takes
 * either (bin/afs.ts).
 *
 * Files adapter, rooted at the DATA ROOT (the §9 layout):
 *   <root>/system/**  ·  <root>/organizations/**  ·  <root>/agents/<agentId>/**
 *   <root>/conversations/<convId>/**
 * A doc's `name` is its path relative to the scope dir, minus `.md` (so the conventional
 * `instructions/compaction`). Reads are fresh from disk (multi-process, like the log). On db
 * this same port is SELECTs over `docs`.
 */

import { parse as parseYaml } from "@std/yaml";
import type { AgentId } from "../types.ts";
import { systemDocs } from "./seed.ts";

export type DocScope = "system" | "organization" | "agent" | "conversation";
export type DocKind = "instruction" | "skill" | "memory" | "tool";

const KINDS: readonly string[] = ["instruction", "skill", "memory", "tool"];

/** Workspace noise never scanned for docs (the agent scope is a working directory). */
const SKIP_DIRS = new Set([".git", "node_modules", ".out"]);

/** Locates one doc within a cascade. `name` is the scope-relative path without `.md`. */
export interface DocRef {
  scope: DocScope;
  kind: DocKind;
  name: string;
}

/** A doc's identity + its parsed YAML frontmatter + where it physically lives. */
export interface DocHeader extends DocRef {
  frontmatter: Record<string, unknown>;
  /** Substrate address (files: absolute path) — what the agent's own `aread` takes.
   *  The ref alone can't be pulled: agent/conversation scopes add an id segment on disk. */
  path: string;
}

/** What `list` hands render: the header always, the body when `load: always` (or after read). */
export interface DocEntry {
  header: DocHeader;
  body?: string;
}

/** The agent + conversation a cascade is resolved for. */
export interface DocContext {
  agent: AgentId;
  conversation?: string;
}

export interface Docs {
  /** Every doc in the cascade — header always, body inlined for `load: always` docs. */
  list(ctx: DocContext): Promise<DocEntry[]>;
  /** Pull one doc's body on demand (for a pointer), or null if it's gone. */
  read(ctx: DocContext, ref: DocRef): Promise<string | null>;
}

/** Open a filesystem-backed Docs read port rooted at the org data root. */
export function openFileDocs(root: string): Docs {
  return {
    async list(ctx: DocContext): Promise<DocEntry[]> {
      const out: DocEntry[] = [];
      for (const [scope, dir] of scopeDirs(root, ctx)) {
        const own = await markdownUnder(dir); // whatever this org stands in the scope
        for (const name of own) {
          const path = `${dir}/${name}.md`;
          const frontmatter = await readFrontmatter(path);
          if (frontmatter === null) continue; // no frontmatter ⇒ not a doc (workspace file)
          const entry = entryOf(scope, name, path, frontmatter);
          if (frontmatter.load === "always") {
            entry.body = stripFrontmatter(await Deno.readTextFile(path));
          }
          out.push(entry);
        }
        if (scope !== "system") continue;
        // and the package's own, for every name the org did not answer itself — a NAME, not
        // a doc: a file with no frontmatter is how an org says it wants none
        const answered = new Set(own);
        for (const doc of await systemDocs()) {
          if (answered.has(doc.name)) continue;
          const frontmatter = frontmatterOf(doc.text);
          if (frontmatter === null) continue; // the harness's to send, not the agent's to read
          const entry = entryOf(scope, doc.name, doc.path, frontmatter);
          if (frontmatter.load === "always") entry.body = stripFrontmatter(doc.text);
          out.push(entry);
        }
      }
      return out;
    },

    async read(ctx: DocContext, ref: DocRef): Promise<string | null> {
      const dir = scopeDir(root, ref.scope, ctx);
      if (dir === null) return null;
      try {
        return stripFrontmatter(await Deno.readTextFile(`${dir}/${ref.name}.md`));
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      if (ref.scope !== "system") return null;
      // same order as `list`: the org's file if it stands there, else the package's own
      const doc = (await systemDocs()).find((d) => d.name === ref.name);
      return doc ? stripFrontmatter(doc.text) : null;
    },
  };
}

/** A doc's header, wherever it was found — the org's tree or the package's own. */
function entryOf(
  scope: DocScope,
  name: string,
  path: string,
  frontmatter: Record<string, unknown>,
): DocEntry {
  return { header: { scope, kind: kindOf(frontmatter), name, frontmatter, path } };
}

/** `kind` is frontmatter metadata, never path: unknown/absent falls back to `memory`. */
function kindOf(frontmatter: Record<string, unknown>): DocKind {
  const k = frontmatter.kind;
  return typeof k === "string" && KINDS.includes(k) ? k as DocKind : "memory";
}

/** The scope directories to walk, in cascade order — skipping any that don't apply. */
function scopeDirs(root: string, ctx: DocContext): [DocScope, string][] {
  const out: [DocScope, string][] = [];
  for (const scope of ["system", "organization", "agent", "conversation"] as DocScope[]) {
    const dir = scopeDir(root, scope, ctx);
    if (dir !== null) out.push([scope, dir]);
  }
  return out;
}

function scopeDir(root: string, scope: DocScope, ctx: DocContext): string | null {
  switch (scope) {
    case "system":
      return `${root}/system`;
    case "organization":
      return `${root}/organizations`;
    case "agent":
      return `${root}/agents/${ctx.agent}`;
    case "conversation":
      return ctx.conversation ? `${root}/conversations/${ctx.conversation}` : null;
  }
}

/** Sorted scope-relative `.md` names (no extension), walked recursively; [] if `dir` is
 *  absent. Skips workspace noise dirs. A symlinked doc or folder is a doc or folder: a
 *  cascade is a place, and what stands in that place is what counts — a linked seed doc
 *  the same as a copied one. */
async function markdownUnder(dir: string, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      // readDir describes the LINK, which is neither file nor directory; the target is
      // what it stands for, and a dangling one stands for nothing
      const what = entry.isSymlink ? await targetOf(`${dir}/${entry.name}`) : entry;
      if (what.isFile && entry.name.endsWith(".md")) {
        names.push(`${prefix}${entry.name.slice(0, -3)}`);
      } else if (what.isDirectory && !SKIP_DIRS.has(entry.name)) {
        names.push(...await markdownUnder(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  return names.sort();
}

/** What a link points at — nothing, when it points nowhere. */
async function targetOf(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
  try {
    return await Deno.stat(path); // follows the link
  } catch {
    return { isFile: false, isDirectory: false };
  }
}

/** Parse a doc's YAML frontmatter, reading only up to the closing `---`.
 *  `null` when the file has NO frontmatter block (⇒ not a doc); `{}` when malformed. */
async function readFrontmatter(path: string): Promise<Record<string, unknown> | null> {
  return parseBlock(await readHead(path));
}

/** The same, for a doc already in hand (the package's own — store/seed.ts). */
function frontmatterOf(text: string): Record<string, unknown> | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const end = text.indexOf("\n---", 3);
  return parseBlock(end === -1 ? null : text.slice(4, end));
}

function parseBlock(block: string | null): Record<string, unknown> | null {
  if (block === null) return null;
  try {
    const doc = parseYaml(block);
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? doc as Record<string, unknown>
      : {};
  } catch {
    return {}; // malformed frontmatter never breaks context-building
  }
}

/** Read a file's leading `--- … ---` block (content only), stopping at the closing delimiter. */
async function readHead(path: string): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  try {
    const decoder = new TextDecoder();
    const chunk = new Uint8Array(4096);
    let text = "";
    let n: number | null;
    while ((n = await file.read(chunk)) !== null) {
      text += decoder.decode(chunk.subarray(0, n), { stream: true });
      if (text.length >= 4 && !text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
      const end = text.indexOf("\n---", 3);
      if (end !== -1) return text.slice(4, end);
      if (text.length > 65536) return null; // opened but never closed — give up
    }
    return null;
  } finally {
    file.close();
  }
}

/** Drop a leading `--- … ---` frontmatter block, returning the body. */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\r?\n/, "");
}
