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
 * own words (§8 `system/` — the harness's docs), so they never reach the data root. They are
 * READ where the package is — `systemDocs()` — and an upgrade's wording therefore reaches a
 * live org the way a code change does, with the version. An org that wants other words
 * writes its own file into `system/`, which answers for that name instead (docs.ts); a file
 * with no frontmatter there is how it says it wants none.
 *
 * The templates are FLAT — `<scope>-<name>.md` — and the tree they install into is not:
 * the tables below are the whole mapping, one line per doc, which is the point of the flat
 * side. Plural kind folders (`instructions/`, `memories/`) are convention only in the data
 * root — discovery is recursive there and kind rides in frontmatter (§8).
 *
 * `deno compile` note: embed the templates with `--include src/seed`.
 */

import { fileURLToPath } from "node:url";

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

/** The org's half: the words this deployment writes. The system scope is not here — it is
 *  the harness's, and it stays with the package (`systemDocs`). */
export function seedOrg(root: string): Promise<void> {
  return install(root, [
    ["organizations/instructions/organization.md", "organization.md"],
  ]);
}

/** One of the harness's own docs, as the cascade meets it: `name` is what an org overrides
 *  by, `path` its address — a plain file path in a checkout, the registry's URL in an
 *  installed org — which is also the handle render hands the model. */
export interface SystemDoc {
  name: string;
  path: string;
  text: string;
}

/** Cascade name ← template, for the docs the harness speaks with. */
const SYSTEM: [string, string][] = [
  ["instructions/system", "system.md"],
  ["instructions/compaction", "system-compaction.md"],
  ["skills/workflows", "system-skills-workflows.md"],
  ["skills/transcribe-audio", "system-skills-transcribe-audio.md"],
];

let loaded: Promise<SystemDoc[]> | undefined;

/** The system scope, read from the package. Once per process and then held: the package
 *  cannot change under a running org, and docs that render every turn must not be a request
 *  every turn — nor a thing an outage can take away mid-run. */
export function systemDocs(): Promise<SystemDoc[]> {
  return loaded ??= Promise.all(SYSTEM.map(async ([name, template]) => {
    const url = new URL(template, TEMPLATES);
    return {
      name,
      // the agent reads it at this address too, so a checkout's is a path, not a file: URL
      path: url.protocol === "file:" ? fileURLToPath(url) : url.href,
      text: await read(template),
    };
  }));
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
