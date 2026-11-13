import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bringSystemDocs, hashOf, onFiles, seedAgent, seedOrg, seedSkill } from "./seed.ts";
import { openFileDocs } from "./docs.ts";

/** A manifest kept in memory, its rows in view. */
function memory(rows: Record<string, string> = {}) {
  return {
    rows,
    manifest: () => Promise.resolve({ ...rows }),
    setManifest(entries: Record<string, string | null>) {
      for (const [key, value] of Object.entries(entries)) {
        if (value === null) delete rows[key];
        else rows[key] = value;
      }
      return Promise.resolve();
    },
  };
}

Deno.test("seed installs the cascade; list inlines the always-layers and indexes the skills", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    await bringSystemDocs(onFiles(root));
    await seedAgent(onFiles(root), "alter");
    const docs = await openFileDocs(root).list({ agent: "alter" });
    const refs = docs.map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`).sort();
    assertEquals(refs, [
      "agent/instruction/instructions",
      "agent/memory/memories",
      "shared/instruction/instructions",
      "shared/memory/memories",
      ...[
        "10-core",
        "20-continuity",
        "30-permissions",
        "40-async",
        "50-peers",
        "60-knowledge",
        "70-memory",
        "80-people",
        "90-agenda",
      ]
        .map((s) => `system/instruction/instructions/${s}`),
      "system/skill/skills/transcribe-audio",
      "system/skill/skills/workflows",
      ...[
        "bash",
        "cancel",
        "contact",
        "conversation",
        "edit",
        "read",
        "search",
        "send",
        "write",
      ].map((t) => `system/tool/tools/${t}`),
    ]);
    const byRef = new Map(docs.map((d) => [`${d.header.scope}/${d.header.name}`, d]));
    assert(byRef.get("system/instructions/10-core")!.body); // always ⇒ inlined, whatever it says
    assertEquals(byRef.get("system/skills/workflows")!.body, undefined); // lazy → pointer
    // the memories load always, and hold nothing yet
    assertEquals(byRef.get("shared/memories")!.body, "");
    assertEquals(byRef.get("agent/memories")!.body, "");
    // the compaction prompt has no frontmatter: never in the index, still read by name
    assertEquals(byRef.has("system/compaction"), false);
    assertStringIncludes(
      (await openFileDocs(root).read({ agent: "alter" }, {
        scope: "system",
        kind: "instruction",
        name: "compaction",
      }))!,
      "archived",
    );
    // the agent doc is the role alone: who and where is the env line (§5)
    assertStringIncludes(byRef.get("agent/instructions")!.body!, "What this agent is for");
    assertEquals(
      byRef.get("agent/instructions")!.header.handle,
      `${root}/agents/alter/instructions.md`,
    );
    // no kind folders: a scope holds its two files, and folders are the org's to make
    assertEquals(
      (await Array.fromAsync(Deno.readDir(`${root}/agents/alter`))).map((e) => e.name).sort(),
      ["instructions.md", "memories.md"],
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(`${root}/shared`))).map((e) => e.name).sort(),
      ["instructions.md", "memories.md"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a scaffold is the org's once laid: an edit is kept, an emptied one stays empty", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    await seedAgent(onFiles(root), "alter");
    const path = `${root}/shared/instructions.md`;
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nEDITED");
    // one that wants no memories doc empties it: a file with no header is no doc
    await Deno.writeTextFile(`${root}/agents/alter/memories.md`, "");
    await seedOrg(onFiles(root)); // every later boot
    await seedAgent(onFiles(root), "alter");
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
    assertEquals(await Deno.readTextFile(`${root}/agents/alter/memories.md`), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the halves are the doors': org alone leaves no agent, and a home is a folder first", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root)); // `liquen init`: nobody made yet
    assertEquals(await Deno.stat(`${root}/agents`).catch(() => null), null);
    await seedAgent(onFiles(root), "alter"); // `liquen agent alter`
    assert((await Deno.stat(`${root}/agents/alter`)).isDirectory); // the workspace itself
    assertStringIncludes(
      await Deno.readTextFile(`${root}/agents/alter/instructions.md`),
      "What this agent is for",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a release's system docs reach an org's files: new ones laid, unedited ones replaced, the org's own left for a decision", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bed = onFiles(root);
    const manifest = memory();
    await bringSystemDocs(bed, manifest); // the first boot: every doc laid and recorded
    const path = (doc: string) => `${root}/system/${doc}.md`;
    const template = (doc: string) =>
      fetch(new URL(`../seed/system/${doc}.md`, import.meta.url)).then((r) => r.text());
    // the org as an older release left it: bash in that release's words, cancel edited
    // since, workflows deleted, and contact a doc that release did not have
    const older = "---\nkind: tool\n---\nolder words";
    for (const doc of ["tools/bash", "tools/cancel", "skills/workflows"]) {
      manifest.rows[`doc:system/${doc}`] = await hashOf(older);
    }
    await Deno.writeTextFile(path("tools/bash"), older);
    await Deno.writeTextFile(path("tools/cancel"), "---\nkind: tool\n---\nthe org's own");
    await Deno.remove(path("skills/workflows"));
    await Deno.remove(path("tools/contact"));
    delete manifest.rows["doc:system/tools/contact"];
    // an edit to a doc the release did not reword is the org's, and goes unsaid
    await Deno.writeTextFile(path("tools/search"), "---\nkind: tool\n---\nthe org's search");

    const boot = await bringSystemDocs(bed, manifest);
    assertEquals([boot.laid, boot.replaced], [["tools/contact"], ["tools/bash"]]);
    assertEquals(boot.pending, [
      { doc: "tools/cancel", state: "edited" },
      { doc: "skills/workflows", state: "deleted" },
    ]);
    assertEquals(await Deno.readTextFile(path("tools/bash")), await template("tools/bash"));
    assertEquals(await Deno.readTextFile(path("tools/contact")), await template("tools/contact"));
    assertStringIncludes(await Deno.readTextFile(path("tools/cancel")), "the org's own");
    assertStringIncludes(await Deno.readTextFile(path("tools/search")), "the org's search");

    // the release's words beside the org's: a file nothing loads, and the doc still waits
    const beside = await bringSystemDocs(
      bed,
      manifest,
      (p) => Promise.resolve(p.state === "edited" ? "beside" : undefined),
    );
    assertEquals(beside.beside, ["tools/cancel"]);
    assertEquals(
      await Deno.readTextFile(`${path("tools/cancel")}.new`),
      await template("tools/cancel"),
    );
    const listed = await openFileDocs(root).list({ agent: "alter" });
    assertEquals(listed.filter((d) => d.header.name.startsWith("tools/cancel")).length, 1);
    // settled: the org's kept, the deleted one kept deleted — and both quiet from here on
    const kept = await bringSystemDocs(bed, manifest, () => Promise.resolve("keep"));
    assertEquals(kept.kept.sort(), ["skills/workflows", "tools/cancel"]);
    assertEquals(await Deno.stat(path("skills/workflows")).catch(() => null), null);
    assertEquals((await bringSystemDocs(bed, manifest)).pending, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a connector's skill is laid by its door, once, and recorded as taken", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = memory();
    await bringSystemDocs(onFiles(root), manifest);
    const path = `${root}/system/skills/microsoft-graph.md`;
    assertEquals(await Deno.stat(path).catch(() => null), null); // no boot lays it
    assertEquals(await seedSkill(onFiles(root), manifest, "microsoft-graph"), true);
    assertStringIncludes(await Deno.readTextFile(path), "MICROSOFT_GRAPH_TOKEN");
    assert("doc:system/skills/microsoft-graph" in manifest.rows);
    const docs = await openFileDocs(root).list({ agent: "alter" });
    assert(docs.some((d) => d.header.name === "skills/microsoft-graph"));
    // a second door run keeps the org's edit
    await Deno.writeTextFile(path, "---\nkind: skill\ndescription: x\n---\nEDITED");
    assertEquals(await seedSkill(onFiles(root), manifest, "microsoft-graph"), false);
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
