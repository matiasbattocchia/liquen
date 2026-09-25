/**
 * store/seed.ts — install the default doc cascade, once per folder (§8).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module only copies them into the org's docs,
 * wherever those live (§9 layout: `system/` · `organization/` · `agents/<name>/` on files,
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
 * The system templates sit in the tree they install into — `system/<kind>/<name>.md` — so
 * an org may symlink `system/instructions/` or `system/skills/` at the checkout's folder and
 * read the harness's words live, new files included. A skill that teaches one connector's
 * service sits there too, and is laid by that connector's door (`seedSkill`), not by boot:
 * an org has it iff it connected the service. The org and agent templates are flat,
 * `<scope>-<name>.md`: their home has an id segment no template can name. The tables below
 * are the whole mapping, one line per doc. Plural kind folders (`instructions/`, `skills/`,
 * `memories/`) are convention only in the data root — discovery is recursive there and kind
 * rides in frontmatter (§8). The kind folders that carry no template are laid empty, every
 * boot: an empty folder holds no doc, so it says nothing about the org's wishes, and it
 * shows the operator where a skill or a memory goes.
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
  /** The folders a substrate has to lay beside its docs: a home, the empty kind folders.
   *  Absent where docs are rows. */
  folders?(scope: DocScope, owner: string): Promise<void>;
}

/** A doc's path under the data root. */
const pathOf = (root: string, scope: DocScope, owner: string, name: string) =>
  `${root}/${scopeDir(scope, owner)}/${name}.md`;
const scopeDir = (scope: DocScope, owner: string) =>
  scope === "agent"
    ? `agents/${owner}`
    : scope === "conversation"
    ? `conversations/${owner}`
    : scope;

/** The files under a data root. */
export function onFiles(root: string): Seedbed {
  return {
    laid: (scope, owner, folder) =>
      Deno.lstat(`${root}/${scopeDir(scope, owner)}/${folder}`).then(() => true, () => false),
    async lay(scope, owner, name, text) {
      const path = pathOf(root, scope, owner, name);
      if (await Deno.lstat(path).then(() => true, () => false)) return false;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, text);
      return true;
    },
    // the home itself — the agent's workspace, so it exists empty — and the kind folders
    async folders(scope, owner) {
      for (const kind of ["skills", "memories"]) {
        await Deno.mkdir(`${root}/${scopeDir(scope, owner)}/${kind}`, { recursive: true });
      }
    },
  };
}

/** Copy templates into the bed — a template only where its FOLDER does not exist.
 *
 *  The folder, not the file, because an absent doc is an answer: a deployment that deleted
 *  `organization/instructions/organization.md`, or emptied `system/skills/`, said it wants
 *  none, and the next boot must not argue. What that costs is a template added to a folder
 *  an org already has: it reaches new orgs and no existing one. Deleting the folder is how
 *  an org asks for the set again. */
async function install(
  bed: Seedbed,
  docs: [DocScope, string, string, string][], // scope, owner, name, template
): Promise<void> {
  // asked once per folder, before any of them is written: a folder two templates share is
  // absent for both or for neither, whichever this call found
  const laid = new Map<string, boolean>();
  for (const [scope, owner, name, template] of docs) {
    const folder = name.slice(0, name.lastIndexOf("/"));
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
    ["system", "", "instructions/system", "system/instructions/system.md"],
    ["system", "", "instructions/compaction", "system/instructions/compaction.md"],
    ["system", "", "skills/workflows", "system/skills/workflows.md"],
    ["system", "", "skills/transcribe-audio", "system/skills/transcribe-audio.md"],
    ["organization", "", "instructions/organization", "organization.md"],
  ]);
  await bed.folders?.("organization", "");
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

/** One agent's half: the home itself — its workspace, so it exists empty — the persona to
 *  write, and the folders its skills and memories go in. A person alone (§4) has no home
 *  and gets none of this. */
export async function seedAgent(bed: Seedbed, agentId: string): Promise<void> {
  await bed.folders?.("agent", agentId);
  await install(bed, [["agent", agentId, "instructions/agent", "agent.md"]]);
}
