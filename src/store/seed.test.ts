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
      "organization/instruction/instructions/organization",
      "system/instruction/instructions/system",
      "system/skill/skills/transcribe-audio",
      "system/skill/skills/workflows",
    ]);
    const byName = new Map(docs.map((d) => [d.header.name, d]));
    assert(byName.get("instructions/system")!.body); // always ⇒ inlined, whatever it says
    assertEquals(byName.get("memories/example")!.body, undefined); // lazy → pointer
    // the checkpoint prompt is the harness's own business: it carries no frontmatter, so it
    // is no doc — never indexed, never offered — and is still read by name when one is due
    assert(
      (await Deno.stat(`${root}/system/seed/instructions/compaction.md`)).isFile,
    );
    assertStringIncludes(
      (await openFileDocs(root).read({ agent: "alter" }, {
        scope: "system",
        kind: "instruction",
        name: "instructions/compaction",
      }))!,
      "The conversation above is being archived.",
    );
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
    const path = `${root}/organizations/instructions/organization.md`;
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
    await Deno.remove(`${root}/organizations/instructions/organization.md`);
    await Deno.remove(`${root}/agents/alter/memories/example.md`);
    await seedOrg(root); // every later boot
    await seedAgent(root, "alter");
    assertEquals(
      await Deno.stat(`${root}/organizations/instructions/organization.md`).catch(() => null),
      null,
    );
    assertEquals(
      await Deno.stat(`${root}/agents/alter/memories/example.md`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the system scope is laid, not seeded: an upgrade's words reach a live org", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(root);
    const path = `${root}/system/seed/instructions/system.md`;
    const shipped = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nSTALE");
    await seedOrg(root); // the next boot, on a newer version
    assertEquals(await Deno.readTextFile(path), shipped);
    // and nothing of the harness's lands in the tree the org edits
    assertEquals(await Deno.stat(`${root}/system/instructions`).catch(() => null), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the org answers a system name by writing one — a doc replaces it, a bare file refuses it", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(root);
    await Deno.mkdir(`${root}/system/instructions`, { recursive: true });
    await Deno.mkdir(`${root}/system/skills`, { recursive: true });
    // this org's own legend, and no workflows skill at all
    await Deno.writeTextFile(
      `${root}/system/instructions/system.md`,
      "---\nkind: instruction\nload: always\n---\nOURS",
    );
    await Deno.writeTextFile(`${root}/system/skills/workflows.md`, "");
    await seedOrg(root); // a later boot never argues with either
    const docs = await openFileDocs(root).list({ agent: "alter" });
    const byName = new Map(docs.map((d) => [d.header.name, d]));
    assertEquals(byName.get("instructions/system")!.body, "OURS");
    assertEquals(
      byName.get("instructions/system")!.header.path,
      `${root}/system/instructions/system.md`,
    );
    assertEquals(byName.has("skills/workflows"), false);
    assert(byName.has("skills/transcribe-audio")); // the rest of the harness's set stands
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
