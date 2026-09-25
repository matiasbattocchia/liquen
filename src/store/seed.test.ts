import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { onFiles, seedAgent, seedOrg, seedSkill } from "./seed.ts";
import { openFileDocs } from "./docs.ts";

Deno.test("seed installs the cascade; list inlines the always-layers and indexes the skills", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    await seedAgent(onFiles(root), "alter");
    const docs = await openFileDocs(root).list({ agent: "alter" });
    const refs = docs.map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`).sort();
    assertEquals(refs, [
      "agent/instruction/instructions/agent",
      "organization/instruction/instructions/organization",
      "system/instruction/instructions/system",
      "system/skill/skills/transcribe-audio",
      "system/skill/skills/workflows",
    ]);
    const byName = new Map(docs.map((d) => [d.header.name, d]));
    assert(byName.get("instructions/system")!.body); // always ⇒ inlined, whatever it says
    assertEquals(byName.get("skills/workflows")!.body, undefined); // lazy → pointer
    // the compaction prompt has no frontmatter: never in the index, still read by name
    assertEquals(byName.has("instructions/compaction"), false);
    assertStringIncludes(
      (await openFileDocs(root).read({ agent: "alter" }, {
        scope: "system",
        kind: "instruction",
        name: "instructions/compaction",
      }))!,
      "archived",
    );
    // the agent doc is the role alone: who and where is the env line (§5)
    assertStringIncludes(byName.get("instructions/agent")!.body!, "What this agent is for");
    assertEquals(byName.get("instructions/agent")!.header.handle, "instructions/agent.md");
    // the kind folders that carry no template stand empty, where a skill or a memory goes
    for (
      const dir of [
        "organization/skills",
        "organization/memories",
        "agents/alter/skills",
        "agents/alter/memories",
      ]
    ) {
      assert((await Deno.stat(`${root}/${dir}`)).isDirectory);
      assertEquals((await Array.fromAsync(Deno.readDir(`${root}/${dir}`))).length, 0);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("seeding never overwrites an edited doc", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    const path = `${root}/organization/instructions/organization.md`;
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nEDITED");
    await seedOrg(onFiles(root)); // idempotent boot
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a deleted doc stays deleted — the folder is what says the org has this scope", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    await seedAgent(onFiles(root), "alter");
    // an org that wants no org-wide instruction
    await Deno.remove(`${root}/organization/instructions/organization.md`);
    // and one that wants the scope gone altogether
    await Deno.remove(`${root}/system/skills`, { recursive: true });
    await seedOrg(onFiles(root)); // every later boot
    await seedAgent(onFiles(root), "alter");
    assertEquals(
      await Deno.stat(`${root}/organization/instructions/organization.md`).catch(() => null),
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
    await seedOrg(onFiles(root)); // `liquen init`: nobody declared yet
    assertEquals(await Deno.stat(`${root}/agents`).catch(() => null), null);
    await seedAgent(onFiles(root), "alter"); // `liquen agent alter`
    assert((await Deno.stat(`${root}/agents/alter`)).isDirectory); // the workspace itself
    assertStringIncludes(
      await Deno.readTextFile(`${root}/agents/alter/instructions/agent.md`),
      "What this agent is for",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a connector's skill is laid by its door, by file — the skills folder already exists", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root)); // system/skills/ is here now, with the harness's own skills
    assertEquals(await seedSkill(onFiles(root), "microsoft-graph"), true);
    const path = `${root}/system/skills/microsoft-graph.md`;
    assertStringIncludes(await Deno.readTextFile(path), "MICROSOFT_GRAPH_TOKEN");
    const docs = await openFileDocs(root).list({ agent: "alter" });
    assert(docs.some((d) => d.header.name === "skills/microsoft-graph"));
    // a second door run keeps the org's edit
    await Deno.writeTextFile(path, "---\nkind: skill\ndescription: x\n---\nEDITED");
    assertEquals(await seedSkill(onFiles(root), "microsoft-graph"), false);
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
