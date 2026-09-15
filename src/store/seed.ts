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
 * The SYSTEM scope is the exception, and it is not seeded at all: those are the harness's
 * own words (§8 `system/` — the harness's docs), so they are LAID, fresh, under
 * `system/seed/` on every pass, and the org's editable tree starts empty of them. An
 * upgrade's wording then reaches a live org the way a code change does, and an org that
 * wants other words writes its own file one level up — `system/instructions/system.md`
 * shadows `system/seed/instructions/system.md` by name (docs.ts), and a file with no
 * frontmatter there is how an org says it wants none.
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
 *  `organizations/instructions/organization.md`, or emptied `agents/<name>/memories/`, said
 *  it wants none, and the next boot must not argue. What that costs is a template added to a folder an org
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

/** Where under the system scope a boot lays the package's own docs — harness-owned, never
 *  edited in place: what an org writes goes one level up and shadows it by name. */
export const SEED_DIR = "seed";

/** The harness's own words, laid (not seeded) under `system/${SEED_DIR}/`. */
const SYSTEM: [string, string][] = [
  ["instructions/system.md", "system.md"],
  ["instructions/compaction.md", "system-compaction.md"],
  ["skills/workflows.md", "system-skills-workflows.md"],
  ["skills/transcribe-audio.md", "system-skills-transcribe-audio.md"],
];

/** The org's half: the words this deployment writes, plus a fresh copy of the harness's. */
export async function seedOrg(root: string): Promise<void> {
  for (const [rel, template] of SYSTEM) {
    const path = `${root}/system/${SEED_DIR}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, await read(template)); // overwritten every pass, on purpose
  }
  await install(root, [
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
