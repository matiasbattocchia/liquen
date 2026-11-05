import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bringToolDocs, onFiles, seedAgent, seedOrg, seedSkill } from "./seed.ts";
import { openFileDocs } from "./docs.ts";

Deno.test("seed installs the cascade; list inlines the always-layers and indexes the skills", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
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
      ]
        .map((s) => `system/instruction/instructions/${s}`),
      "system/skill/skills/profile",
      "system/skill/skills/transcribe-audio",
      "system/skill/skills/workflows",
      ...[
        "bash",
        "cancel",
        "contact",
        "conversation",
        "edit",
        "read",
        "schedule",
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

Deno.test("seeding never overwrites an edited doc", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    const path = `${root}/shared/instructions.md`;
    await Deno.writeTextFile(path, "---\nkind: instruction\nload: always\n---\nEDITED");
    await seedOrg(onFiles(root)); // idempotent boot
    assertStringIncludes(await Deno.readTextFile(path), "EDITED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a deleted doc stays deleted in a folder the org has; a root doc answers for itself", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    await seedAgent(onFiles(root), "alter");
    // an org that wants one skill fewer
    await Deno.remove(`${root}/system/skills/workflows.md`);
    // one that wants no org-wide instruction empties it: a file with no header is no doc
    await Deno.writeTextFile(`${root}/shared/instructions.md`, "");
    // and a root doc deleted outright
    await Deno.remove(`${root}/agents/alter/memories.md`);
    await seedOrg(onFiles(root)); // every later boot
    await seedAgent(onFiles(root), "alter");
    assertEquals(await Deno.stat(`${root}/system/skills/workflows.md`).catch(() => null), null);
    assertEquals(await Deno.readTextFile(`${root}/shared/instructions.md`), "");
    assert((await Deno.stat(`${root}/agents/alter/memories.md`)).isFile);
    // removing a folder asks for its set again
    await Deno.remove(`${root}/system/skills`, { recursive: true });
    await seedOrg(onFiles(root));
    assert((await Deno.stat(`${root}/system/skills/workflows.md`)).isFile);
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
      await Deno.readTextFile(`${root}/agents/alter/instructions.md`),
      "What this agent is for",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a release's tool docs reach an org that has its own: laid, brought, or kept", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    const bed = onFiles(root);
    const path = (tool: string) => `${root}/system/tools/${tool}.md`;
    const template = (tool: string) =>
      fetch(new URL(`../seed/system/tools/${tool}.md`, import.meta.url)).then((r) => r.text());
    // the org as an older release left it: bash and send in that release's words, cancel
    // edited by the org, and contact a tool that release had no doc for
    const older = "---\nkind: tool\n---\nolder words";
    await Deno.writeTextFile(path("bash"), older);
    await Deno.writeTextFile(path("send"), older);
    await Deno.writeTextFile(path("cancel"), "---\nkind: tool\n---\nthe org's own");
    await Deno.remove(path("contact"));
    // what the older release published; search it worded as this one does
    const was = (t: string) =>
      t.endsWith("/contact.md")
        ? Promise.resolve(null)
        : t.endsWith("/search.md")
        ? template("search")
        : Promise.resolve(older);
    assertEquals(await bringToolDocs(bed, was), {
      laid: ["contact"],
      updated: ["send", "bash"],
      kept: ["cancel"],
    });
    assertEquals(await Deno.readTextFile(path("bash")), await template("bash"));
    assertEquals(await Deno.readTextFile(path("contact")), await template("contact"));
    assertStringIncludes(await Deno.readTextFile(path("cancel")), "the org's own");
    // an edit the release did not reword is the org's, and goes unsaid
    await Deno.writeTextFile(path("search"), "---\nkind: tool\n---\nthe org's search");
    assertEquals(await bringToolDocs(bed, was), { laid: [], updated: [], kept: ["cancel"] });
    assertStringIncludes(await Deno.readTextFile(path("search")), "the org's search");
    // a folder linked at a checkout reads the checkout's words live: nothing to bring
    const linked = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${linked}/system`);
      await Deno.symlink(`${root}/system/tools`, `${linked}/system/tools`);
      assertEquals(await bringToolDocs(onFiles(linked), was), null);
    } finally {
      await Deno.remove(linked, { recursive: true });
    }
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
