/**
 * store/seed.ts — install the default doc cascade, once per folder (§8).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module only copies them into the org's data
 * root (§9 layout: `system/` · `organization/` · `agents/<name>/`). Placeholders are meant
 * to be EDITED per deployment — seeding never overwrites, and never returns to a folder
 * that exists. Memory hygiene lives in the template text, not in code.
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

const TEMPLATES = new URL("../seed/", import.meta.url);

// fetched, not read: the templates are where the package is — a checkout's files or the
// registry's URLs — and fetch answers for both
const read = (rel: string) => fetch(new URL(rel, TEMPLATES)).then((r) => r.text());

/** Copy templates into the data root — a template only where its FOLDER does not exist.
 *
 *  The folder, not the file, because an absent doc is an answer: a deployment that deleted
 *  `organization/instructions/organization.md`, or emptied `system/skills/`, said it wants
 *  none, and the next boot must not argue. What that costs is a template added to a folder
 *  an org already has: it reaches new orgs and no existing one. Deleting the folder is how
 *  an org asks for the set again. */
async function install(root: string, files: [string, string][]): Promise<void> {
  // asked once per folder, before any of them is written: a folder two templates share is
  // absent for both or for neither, whichever this call found
  const empty = new Map<string, boolean>();
  for (const [rel, template] of files) {
    const path = `${root}/${rel}`;
    const folder = path.slice(0, path.lastIndexOf("/"));
    if (!empty.has(folder)) {
      // the org has this scope ⇒ its contents, edits and deletions alike, are its own
      empty.set(folder, await Deno.lstat(folder).then(() => false, () => true));
    }
    if (!empty.get(folder)) continue;
    await Deno.mkdir(folder, { recursive: true });
    await Deno.writeTextFile(path, await read(template));
  }
}

/** The kind folders a scope keeps beside its instructions, laid empty. */
async function kinds(scope: string): Promise<void> {
  for (const kind of ["skills", "memories"]) {
    await Deno.mkdir(`${scope}/${kind}`, { recursive: true });
  }
}

/** The org's half: what every agent in this deployment reads. */
export async function seedOrg(root: string): Promise<void> {
  await install(root, [
    ["system/instructions/system.md", "system/instructions/system.md"],
    ["system/instructions/compaction.md", "system/instructions/compaction.md"],
    ["system/skills/workflows.md", "system/skills/workflows.md"],
    ["system/skills/transcribe-audio.md", "system/skills/transcribe-audio.md"],
    ["organization/instructions/organization.md", "organization.md"],
  ]);
  await kinds(`${root}/organization`);
}

/** A connector's skill, laid by the connector's own door (`liquen connect <service>`), so
 *  it reaches exactly the orgs that connect the service. The rule is the file, not the
 *  folder: `system/skills/` exists in every org that has booted, and the door is a
 *  deliberate act. An edited skill is kept. Answers whether it wrote. */
export async function seedSkill(root: string, name: string): Promise<boolean> {
  const path = `${root}/system/skills/${name}.md`;
  if (await Deno.lstat(path).then(() => true, () => false)) return false;
  await Deno.mkdir(`${root}/system/skills`, { recursive: true });
  await Deno.writeTextFile(path, await read(`system/skills/${name}.md`));
  return true;
}

/** One agent's half: the home itself — its workspace, so it exists empty — the persona to
 *  write, and the folders its skills and memories go in. A person alone (§4) has no home
 *  and gets none of this. */
export async function seedAgent(root: string, agentId: string): Promise<void> {
  const home = `${root}/agents/${agentId}`;
  await Deno.mkdir(home, { recursive: true });
  await install(root, [[`agents/${agentId}/instructions/agent.md`, "agent.md"]]);
  await kinds(home);
}
