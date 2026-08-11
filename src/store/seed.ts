/**
 * store/seed.ts — install the default doc cascade, write-if-absent at boot (§8).
 *
 * The templates are REAL files under `seed/docs/` (repo root) — readable and editable by
 * the developer before any deployment, shadcn-style; this module only copies them into the
 * org's data root (§9 layout: `system/` · `org/` · `agents/<name>/`), interpolating
 * `{{HOME_DIR}}` / `{{AGENT_ID}}` in agent-scope docs. Placeholders are meant to be EDITED
 * per deployment — seeding never overwrites. Memory hygiene lives in the template text,
 * not in code (the Claude-Code lesson). Plural kind folders (`instructions/`, `memories/`)
 * are convention only — discovery is recursive and kind rides in frontmatter (§8).
 *
 * `deno compile` note: embed the templates with `--include seed/docs`.
 */

const TEMPLATES = new URL("../../seed/docs/", import.meta.url);

const read = (rel: string) => Deno.readTextFile(new URL(rel, TEMPLATES));

/** Install the default cascade under the data `root` for one agent. Never overwrites. */
export async function seedDocs(root: string, agentId: string): Promise<void> {
  const home = `${root}/agents/${agentId}`;
  const files: [string, string][] = [
    ["system/instructions/principal.md", await read("system/instructions/principal.md")],
    ["system/instructions/compaction.md", await read("system/instructions/compaction.md")],
    ["org/instructions/org.md", await read("org/instructions/org.md")],
    [
      `agents/${agentId}/instructions/identity.md`,
      (await read("agent/instructions/identity.md"))
        .replaceAll("{{HOME_DIR}}", home)
        .replaceAll("{{AGENT_ID}}", agentId),
    ],
    [`agents/${agentId}/memories/example.md`, await read("agent/memories/example.md")],
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
