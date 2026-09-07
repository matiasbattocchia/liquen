import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { seedDocs } from "./seed.ts";
import { openFileDocs } from "./docs.ts";

Deno.test("seed installs the cascade; list inlines the always-layers and indexes the memory", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedDocs(root, "alter");
    const docs = await openFileDocs(root).list({ agent: "alter" });
    const refs = docs.map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`).sort();
    assertEquals(refs, [
      "agent/instruction/instructions/agent",
      "agent/memory/memories/example",
      "org/instruction/instructions/organization",
      "system/instruction/instructions/compaction",
      "system/instruction/instructions/system",
      "system/skill/skills/transcribe-audio",
      "system/skill/skills/workflows",
    ]);
    const byName = new Map(docs.map((d) => [d.header.name, d]));
    assert(byName.get("instructions/system")!.body); // always ⇒ inlined, whatever it says
    assertEquals(byName.get("memories/example")!.body, undefined); // lazy → pointer
    assertEquals(byName.get("instructions/compaction")!.body, undefined); // lazy → pointer
    // the agent doc is the role alone: who and where is the env line (§5)
    assertStringIncludes(byName.get("instructions/agent")!.body!, "The role");
    assert(
      byName.get("memories/example")!.header.path.endsWith("/agents/alter/memories/example.md"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("seeding never overwrites an edited doc", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedDocs(root, "alter");
    const path = `${root}/org/instructions/organization.md`;
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nEDITED");
    await seedDocs(root, "alter"); // idempotent boot
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
