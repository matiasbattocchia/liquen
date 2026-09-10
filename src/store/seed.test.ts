import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { seedAgent, seedOrg } from "./seed.ts";
import { openFileDocs } from "./docs.ts";

Deno.test("seed installs the cascade; list inlines the always-layers and indexes the memory", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(root);
    await seedAgent(root, "alter");
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
    await seedOrg(root);
    const path = `${root}/org/instructions/organization.md`;
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nEDITED");
    await seedOrg(root); // idempotent boot
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a deleted doc stays deleted — the folder is what says the org has this scope", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(root);
    await seedAgent(root, "alter");
    // an org that wants no org-wide instruction, and an agent that keeps no memories
    await Deno.remove(`${root}/org/instructions/organization.md`);
    await Deno.remove(`${root}/agents/alter/memories/example.md`);
    // and one that wants the scope gone altogether
    await Deno.remove(`${root}/system/skills`, { recursive: true });
    await seedOrg(root); // every later boot
    await seedAgent(root, "alter");
    assertEquals(
      await Deno.stat(`${root}/org/instructions/organization.md`).catch(() => null),
      null,
    );
    assertEquals(
      await Deno.stat(`${root}/agents/alter/memories/example.md`).catch(() => null),
      null,
    );
    // the emptied folder is the org's too — but removing it asks for the set again
    assert((await Deno.stat(`${root}/system/skills/workflows.md`)).isFile);
    // the two docs that share system/instructions/ both land, on the same first pass
    assert((await Deno.stat(`${root}/system/instructions/compaction.md`)).isFile);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the halves are the doors': org alone leaves no agent, and a home is a folder first", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(root); // `liquen init`: nobody declared yet
    assertEquals(await Deno.stat(`${root}/agents`).catch(() => null), null);
    await seedAgent(root, "alter"); // `liquen agent alter`
    assert((await Deno.stat(`${root}/agents/alter`)).isDirectory); // the workspace itself
    assertStringIncludes(
      await Deno.readTextFile(`${root}/agents/alter/instructions/agent.md`),
      "The role",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
