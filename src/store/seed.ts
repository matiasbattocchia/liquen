/**
 * store/seed.ts — install the default doc cascade, once per folder (§8).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module only copies them into the org's docs,
 * wherever those live (§9 layout: `system/` · `shared/` · `agents/<name>/` on files,
 * the same scopes as rows of the docs table). Placeholders are meant to be EDITED per
 * deployment — seeding never overwrites, and never returns to a folder that exists.
 * Memory hygiene lives in the template text, not in code.
 *
 * The cascade comes in the two halves the setup doors are cut along: `seedOrg` is what
 * `liquen init` lays with the catalog, `seedAgent` what `liquen agent` lays with the
 * declaration — so every file a deployment is meant to write exists before the first boot,
 * on disk, in an editor. Boot lays them too, for a roster entry typed into `config.jsonc`
 * by hand; `install`'s rule is what makes all three the same call.
 *
 * The system templates sit in the tree they install into — `system/compaction.md`,
 * `system/<kind>/<name>.md` — so an org may symlink each file, or
 * `system/instructions/`, `system/tools/` and `system/skills/`, at the checkout's and read
 * the harness's words live, a folder's new files included. The instructions are one file
 * per skill the harness teaches, so a skill comes and goes as a file. A skill that teaches one connector's service sits
 * there too, and is laid by that connector's door (`seedSkill`), not by boot: an org has it
 * iff it connected the service. The org and agent templates are flat (`organization.md`,
 * `agent.md`, `memories.md`): their home has an id segment no template can name. The
 * tables below are the whole mapping, one line per doc. Folders are convention only in the
 * data root — discovery is recursive there and kind rides in frontmatter (§8).
 *
 * `deno compile` note: embed the templates with `--include src/seed`.
 */

import type { DocScope } from "./docs.ts";

const TEMPLATES = new URL("../seed/", import.meta.url);

// fetched, not read: the templates are where the package is — a checkout's files or the
// registry's URLs — and fetch answers for both
const read = (rel: string) => fetch(new URL(rel, TEMPLATES)).then((r) => r.text());

/** Where a cascade is laid: files under a data root, or rows of the docs table. A doc is
 *  named as the table keys it — the scope, the owner (an agent's id, empty for the org's
 *  two scopes), the scope-relative name. */
export interface Seedbed {
  /** Whether the scope has this folder — the unit of if-absent. On files, the folder
   *  exists; on the table, a row lies under it. */
  laid(scope: DocScope, owner: string, folder: string): Promise<boolean>;
  /** Lay one doc where none is. Answers whether it wrote. */
  lay(scope: DocScope, owner: string, name: string, text: string): Promise<boolean>;
}

/** A bed a release's words are brought into (`bringToolDocs`): one doc read as laid, and
 *  replaced only while it still reads that way. */
export interface Relaybed extends Seedbed {
  /** One doc's whole text, frontmatter included, or null where none is. */
  text(scope: DocScope, owner: string, name: string): Promise<string | null>;
  /** Replace one doc's text with `to` while it is still `from`. Answers whether it wrote. */
  swap(scope: DocScope, owner: string, name: string, from: string, to: string): Promise<boolean>;
  /** Whether the folder is a link to words read live elsewhere. Absent where docs are rows. */
  linked?(scope: DocScope, owner: string, folder: string): Promise<boolean>;
}

/** A doc's path under the data root. */
const pathOf = (root: string, scope: DocScope, owner: string, name: string) =>
  `${root}/${scopeDir(scope, owner)}/${name}.md`;
const scopeDir = (scope: DocScope, owner: string) => scope === "agent" ? `agents/${owner}` : scope;

/** The files under a data root. */
export function onFiles(root: string): Relaybed {
  const text = (scope: DocScope, owner: string, name: string) =>
    Deno.readTextFile(pathOf(root, scope, owner, name)).catch((err) => {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    });
  return {
    laid: (scope, owner, folder) =>
      Deno.lstat(`${root}/${scopeDir(scope, owner)}/${folder}`).then(() => true, () => false),
    linked: (scope, owner, folder) =>
      Deno.lstat(`${root}/${scopeDir(scope, owner)}/${folder}`).then(
        (s) => s.isSymlink,
        () => false,
      ),
    text,
    async swap(scope, owner, name, from, to) {
      if (await text(scope, owner, name) !== from) return false;
      await Deno.writeTextFile(pathOf(root, scope, owner, name), to);
      return true;
    },
    async lay(scope, owner, name, text) {
      const path = pathOf(root, scope, owner, name);
      if (await Deno.lstat(path).then(() => true, () => false)) return false;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, text);
      return true;
    },
  };
}

/** One doc to lay: scope, owner, name, template. */
type Template = [DocScope, string, string, string];

/** The builtin tools whose words are docs (tooldoc.ts), one `kind: tool` file each under
 *  `system/tools/`. */
const TOOL_DOCS = [
  "send",
  "search",
  "schedule",
  "cancel",
  "conversation",
  "contact",
  "bash",
  "read",
  "write",
  "edit",
];

/** The skills the system instructions teach, one `instructions/<NN>-<skill>.md` each. The
 *  number is the load order, `core` first with the voices the others lean on, and its gaps
 *  leave room for a skill between two. */
const SKILL_INSTRUCTIONS = [
  "10-core",
  "20-continuity",
  "30-permissions",
  "40-async",
  "50-peers",
  "60-knowledge",
  "70-memory",
];

/** Copy templates into the bed — a foldered template only where its FOLDER does not exist,
 *  one at the scope's root wherever the file itself does not.
 *
 *  The folder, not the file, because an absent doc is an answer: a deployment that emptied
 *  `system/skills/` said it wants none, and the next boot must not argue. What that costs is
 *  a template added to a folder an org already has: it reaches new orgs and no existing
 *  one. Deleting the folder is how an org asks for the set again. A scope's root always
 *  stands, so its files answer for themselves: an org that wants no `instructions.md` empties
 *  it, and a file with no header is no doc. The tool docs are the exception, brought by
 *  `liquen update` (`bringToolDocs`): a tool's words are its schema's, and no tool goes
 *  without. */
async function install(bed: Seedbed, docs: Template[]): Promise<void> {
  // asked once per folder, before any of them is written: a folder two templates share is
  // absent for both or for neither, whichever this call found
  const laid = new Map<string, boolean>();
  for (const [scope, owner, name, template] of docs) {
    const folder = name.slice(0, Math.max(name.lastIndexOf("/"), 0));
    if (folder === "") {
      await bed.lay(scope, owner, name, await read(template));
      continue;
    }
    const key = `${scope}/${owner}/${folder}`;
    if (!laid.has(key)) {
      // the org has this scope ⇒ its contents, edits and deletions alike, are its own
      laid.set(key, await bed.laid(scope, owner, folder));
    }
    if (laid.get(key)) continue;
    await bed.lay(scope, owner, name, await read(template));
  }
}

/** The org's half: what every agent in this deployment reads. */
export async function seedOrg(bed: Seedbed): Promise<void> {
  await install(bed, [
    ...SKILL_INSTRUCTIONS.map((skill): Template => [
      "system",
      "",
      `instructions/${skill}`,
      `system/instructions/${skill}.md`,
    ]),
    ["system", "", "compaction", "system/compaction.md"],
    ...TOOL_DOCS.map((tool): Template => [
      "system",
      "",
      `tools/${tool}`,
      `system/tools/${tool}.md`,
    ]),
    ["system", "", "skills/workflows", "system/skills/workflows.md"],
    ["system", "", "skills/transcribe-audio", "system/skills/transcribe-audio.md"],
    ["shared", "", "instructions", "organization.md"],
    ["shared", "", "memories", "memories.md"],
  ]);
}

/** A connector's skill, laid by the connector's own door (`liquen connect <service>`), so
 *  it reaches exactly the orgs that connect the service. The rule is the file, not the
 *  folder: `system/skills/` exists in every org that has booted, and the door is a
 *  deliberate act. An edited skill is kept. Answers whether it wrote. */
export function seedSkill(bed: Seedbed, name: string): Promise<boolean> {
  return read(`system/skills/${name}.md`).then((text) =>
    bed.lay("system", "", `skills/${name}`, text)
  );
}

/** What bringing a release's tool docs did: the tools whose doc was laid where none was,
 *  the ones that took the release's words, and the ones kept as the org wrote them. */
export interface Brought {
  laid: string[];
  updated: string[];
  kept: string[];
}

/** This release's tool docs into an org that has its own `system/tools/`, which seeding
 *  never returns to. A tool doc is the schema's words, so one missing is laid; one still
 *  word for word the release the org ran before (`was`, by template path, null where that
 *  release had none) takes this release's; one the org edited is kept, and named, since a
 *  parameter this release added has no item in it. A folder linked at a checkout reads the
 *  checkout's words live and is left alone: null. */
export async function bringToolDocs(
  bed: Relaybed,
  was: (template: string) => Promise<string | null>,
): Promise<Brought | null> {
  if (await bed.linked?.("system", "", "tools")) return null;
  const out: Brought = { laid: [], updated: [], kept: [] };
  for (const tool of TOOL_DOCS) {
    const name = `tools/${tool}`;
    const template = `system/tools/${tool}.md`;
    const now = await read(template);
    const held = await bed.text("system", "", name);
    if (held === now) continue;
    if (held === null) {
      if (await bed.lay("system", "", name, now)) out.laid.push(tool);
      continue;
    }
    const before = await was(template);
    if (before === now) continue; // the release left these words alone: an edit is the org's
    if (held === before && await bed.swap("system", "", name, held, now)) {
      out.updated.push(tool);
    } else out.kept.push(tool);
  }
  return out;
}

/** One agent's half: the persona to write and the memories to keep, which lay the home —
 *  its workspace — on files. A person alone (§4) has no home and gets none of this. */
export async function seedAgent(bed: Seedbed, agentId: string): Promise<void> {
  await install(bed, [
    ["agent", agentId, "instructions", "agent.md"],
    ["agent", agentId, "memories", "memories.md"],
  ]);
}
