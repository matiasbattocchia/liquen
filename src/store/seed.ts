/**
 * store/seed.ts — install the default doc cascade, once per folder (§8).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module only copies them into the org's data
 * root (§9 layout: `system/` · `org/` · `agents/<name>/`). Placeholders are meant to be
 * EDITED per deployment — seeding never overwrites, and never returns to a folder that
 * exists. Memory hygiene lives in the template text, not in code (the Claude-Code lesson).
 *
 * The cascade comes in the two halves the setup doors are cut along: `seedOrg` is what
 * `liquen init` lays with the catalog, `seedAgent` what `liquen agent` lays with the
 * declaration — so every file a deployment is meant to write exists before the first boot,
 * on disk, in an editor. Boot lays them too, for a roster entry typed into `config.jsonc`
 * by hand; `install`'s rule is what makes all three the same call.
 *
 * The templates are FLAT — `<scope>-<name>.md` — and the tree they install into is not:
 * the tables below are the whole mapping, one line per doc, which is the point of the flat
 * side. Plural kind folders (`instructions/`, `memories/`) are convention only in the data
 * root — discovery is recursive there and kind rides in frontmatter (§8).
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
 *  `organizations/instructions/organization.md`, or emptied `system/skills/`, said it wants none, and
 *  the next boot must not argue. What that costs is a template added to a folder an org
 *  already has: it reaches new orgs and no existing one. Deleting the folder is how an org
 *  asks for the set again. */
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

/** The org's half: what every agent in this deployment reads. */
export function seedOrg(root: string): Promise<void> {
  return install(root, [
    ["system/instructions/system.md", "system.md"],
    ["system/instructions/compaction.md", "system-compaction.md"],
    ["system/skills/workflows.md", "system-skills-workflows.md"],
    ["system/skills/transcribe-audio.md", "system-skills-transcribe-audio.md"],
    ["organizations/instructions/organization.md", "organization.md"],
  ]);
}

/** One agent's half: the home itself — its workspace, so it exists empty — the persona to
 *  write, and one memory to write the next by. A person alone (§4) has no home and gets
 *  none of this. */
export async function seedAgent(root: string, agentId: string): Promise<void> {
  await Deno.mkdir(`${root}/agents/${agentId}`, { recursive: true });
  await install(root, [
    [`agents/${agentId}/instructions/agent.md`, "agent.md"],
    [`agents/${agentId}/memories/example.md`, "agent-memory-example.md"],
  ]);
}
