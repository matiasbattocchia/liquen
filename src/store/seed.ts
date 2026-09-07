/**
 * store/seed.ts — install the default doc cascade, write-if-absent at boot (§8).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module only copies them into the org's data
 * root (§9 layout: `system/` · `org/` · `agents/<name>/`). Placeholders are meant to be
 * EDITED per deployment — seeding never overwrites. Memory hygiene lives in the template text, not in code (the
 * Claude-Code lesson).
 *
 * The templates are FLAT — `<scope>-<name>.md` — and the tree they install into is not:
 * the table below is the whole mapping, one line per doc, which is the point of the flat
 * side. Plural kind folders (`instructions/`, `memories/`) are convention only in the data
 * root — discovery is recursive there and kind rides in frontmatter (§8).
 *
 * `deno compile` note: embed the templates with `--include src/seed`.
 */

const TEMPLATES = new URL("../seed/", import.meta.url);

const read = (rel: string) => Deno.readTextFile(new URL(rel, TEMPLATES));

/** Install the default cascade under the data `root` for one agent. Never overwrites. */
export async function seedDocs(root: string, agentId: string): Promise<void> {
  const files: [string, string][] = [
    ["system/instructions/system.md", await read("system.md")],
    ["system/instructions/compaction.md", await read("system-compaction.md")],
    ["system/skills/workflows.md", await read("system-skills-workflows.md")],
    ["system/skills/transcribe-audio.md", await read("system-skills-transcribe-audio.md")],
    ["org/instructions/organization.md", await read("organization.md")],
    [`agents/${agentId}/instructions/agent.md`, await read("agent.md")],
    [`agents/${agentId}/memories/example.md`, await read("agent-memory-example.md")],
  ];
  for (const [rel, content] of files) {
    const path = `${root}/${rel}`;
    try {
      await Deno.lstat(path);
      continue; // exists (possibly edited) — never overwrite
    } catch { /* absent — seed it */ }
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}
