import { assert, assertEquals } from "@std/assert";
import { type DocEntry, openFileDocs } from "./docs.ts";

/** Write `<root>/<rel>.md` with `content` (parent dirs created). */
async function put(root: string, rel: string, content: string) {
  const path = `${root}/${rel}.md`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
}

/** A doc file: frontmatter (with `kind`) + body. */
const doc = (kind: string, body: string, extra = "") => `---\nkind: ${kind}\n${extra}---\n${body}`;

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** What this ROOT holds. The package's own system docs stand in every cascade (§8) and are
 *  nobody's temp dir, so the path is what tells them apart; the two-layer test below is
 *  where they are asserted on purpose. */
const ref = (docs: DocEntry[], root: string) =>
  docs.filter((d) => d.header.path.startsWith(root))
    .map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`);

Deno.test("list returns every doc's header across the cascade (§8 layout)", async () => {
  await withRoot(async (root) => {
    await put(root, "agents/a1/instructions/persona", doc("instruction", "be helpful"));
    await put(root, "organizations/instructions/policy", doc("instruction", "org policy"));
    await put(root, "system/instructions/base", doc("instruction", "world model"));
    await put(root, "organizations/skills/refunds", doc("skill", "how to refund"));

    const docs = await openFileDocs(root).list({ agent: "a1" });
    assertEquals(ref(docs, root).sort(), [
      "agent/instruction/instructions/persona",
      "organization/instruction/instructions/policy",
      "organization/skill/skills/refunds",
      "system/instruction/instructions/base",
    ]);
  });
});

Deno.test("a doc declares itself: no frontmatter ⇒ not a doc (workspace files stay files)", async () => {
  await withRoot(async (root) => {
    await put(root, "agents/a1/memories/real", doc("memory", "a fact"));
    await put(root, "agents/a1/README", "# just a readme, no frontmatter");
    await put(root, "agents/a1/repo/docs/guide", "plain markdown from a cloned repo");

    const docs = await openFileDocs(root).list({ agent: "a1" });
    assertEquals(ref(docs, root), ["agent/memory/memories/real"]);
  });
});

Deno.test("kind rides in frontmatter — folders are convention; unknown/absent ⇒ memory", async () => {
  await withRoot(async (root) => {
    await put(root, "agents/a1/anywhere/deep/note", doc("skill", "s"));
    await put(root, "agents/a1/loose", "---\ndescription: d\n---\nno kind ⇒ memory");
    await put(root, "agents/a1/weird", doc("quantum", "unknown kind ⇒ memory"));

    const kinds = new Map(
      (await openFileDocs(root).list({ agent: "a1" })).map((d) => [d.header.name, d.header.kind]),
    );
    assertEquals(kinds.get("anywhere/deep/note"), "skill");
    assertEquals(kinds.get("loose"), "memory");
    assertEquals(kinds.get("weird"), "memory");
  });
});

Deno.test("workspace noise dirs are never scanned (.git · node_modules · .out)", async () => {
  await withRoot(async (root) => {
    await put(root, "agents/a1/.git/fake", doc("memory", "x"));
    await put(root, "agents/a1/node_modules/pkg/README", doc("memory", "x"));
    await put(root, "agents/a1/.out/dump", doc("memory", "x"));
    await put(root, "agents/a1/ok", doc("memory", "x"));

    const docs = await openFileDocs(root).list({ agent: "a1" });
    assertEquals(ref(docs, root), ["agent/memory/ok"]);
  });
});

Deno.test("load: always ⇒ body is inlined; otherwise header-only pointer", async () => {
  await withRoot(async (root) => {
    await put(
      root,
      "organizations/instructions/policy",
      doc("instruction", "follow the rules", "load: always\n"),
    );
    await put(root, "organizations/skills/refunds", doc("skill", "Step 1. ...", "load: lazy\n"));

    const byName = new Map(
      (await openFileDocs(root).list({ agent: "a1" })).map((d) => [d.header.name, d]),
    );
    assertEquals(byName.get("instructions/policy")!.body, "follow the rules"); // always → inlined
    assertEquals(byName.get("skills/refunds")!.body, undefined); // lazy → pointer
  });
});

Deno.test("header carries parsed YAML frontmatter (quotes and colons handled)", async () => {
  await withRoot(async (root) => {
    await put(
      root,
      "organizations/skills/x",
      '---\nkind: skill\ndescription: "ratio a:b, quoted"\n---\nbody',
    );
    const docs = await openFileDocs(root).list({ agent: "a1" });
    const d = docs.find((e) => e.header.name === "skills/x")!;
    assertEquals(d.header.frontmatter, { kind: "skill", description: "ratio a:b, quoted" });
  });
});

Deno.test("read pulls a pointer's body on demand and strips frontmatter", async () => {
  await withRoot(async (root) => {
    await put(root, "organizations/skills/refunds", doc("skill", "Step 1. ...", "load: lazy\n"));
    const body = await openFileDocs(root).read({ agent: "a1" }, {
      scope: "organization",
      kind: "skill",
      name: "skills/refunds", // name IS the scope-relative path — kind is metadata (§8)
    });
    assertEquals(body, "Step 1. ...");
  });
});

Deno.test("conversation scope is listed only when requested", async () => {
  await withRoot(async (root) => {
    await put(root, "agents/a1/persona", doc("instruction", "p"));
    await put(root, "conversations/c9/state", doc("memory", "working state"));
    const docs = openFileDocs(root);

    assertEquals(ref(await docs.list({ agent: "a1" }), root), ["agent/instruction/persona"]);
    assertEquals(
      ref(await docs.list({ agent: "a1", conversation: "c9" }), root).sort(),
      ["agent/instruction/persona", "conversation/memory/state"],
    );
  });
});

Deno.test("non-.md files are ignored; a missing scope lists empty; missing read ⇒ null", async () => {
  await withRoot(async (root) => {
    await put(root, "organizations/instructions/x", doc("instruction", "body"));
    await Deno.writeTextFile(
      `${root}/organizations/instructions/notes.txt`,
      "---\nkind: skill\n---\nignore",
    );

    const docs = openFileDocs(root);
    assertEquals(ref(await docs.list({ agent: "a1" }), root), [
      "organization/instruction/instructions/x",
    ]);
    // an agent with no folder still sees the cascade above it — just nothing of its own
    assertEquals(ref(await docs.list({ agent: "nobody" }), root), [
      "organization/instruction/instructions/x",
    ]);
    assertEquals(
      await docs.read({ agent: "a1" }, { scope: "organization", kind: "skill", name: "ghost" }),
      null,
    );
    assert(
      (await docs.list({ agent: "a1" })).find((d) => d.header.name === "instructions/x")!
        .header.path.endsWith("/organizations/instructions/x.md"),
    );
  });
});

// a doc kept under version control and linked into the cascade is the doc that stands
// there: the seed's system.md, edited in the repo, read by the org
Deno.test("a linked doc is a doc, a linked folder is a folder, a dangling link is nothing", async () => {
  await withRoot(async (root) => {
    const outside = await Deno.makeTempDir();
    try {
      await put(outside, "system", doc("instruction", "the legend", "load: always\n"));
      await put(outside, "shared/playbook", doc("skill", "how we work"));
      await Deno.mkdir(`${root}/system/instructions`, { recursive: true });
      await Deno.mkdir(`${root}/organizations`, { recursive: true });
      await Deno.symlink(`${outside}/system.md`, `${root}/system/instructions/system.md`);
      await Deno.symlink(`${outside}/shared`, `${root}/organizations/skills`);
      await Deno.symlink(`${outside}/gone.md`, `${root}/system/instructions/gone.md`);

      const docs = await openFileDocs(root).list({ agent: "a1" });
      assertEquals(ref(docs, root).sort(), [
        "organization/skill/skills/playbook",
        "system/instruction/instructions/system",
      ]);
      // and it is read through the link, body and all
      assertEquals(docs.find((d) => d.header.name === "instructions/system")?.body, "the legend");
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

// §8: the system scope is the only one with two layers — the package's own set, read where
// the package lives and never copied here, and whatever this org put in its place
Deno.test("system: an empty root already has the package's docs, at the package's address", async () => {
  await withRoot(async (root) => {
    const docs = openFileDocs(root);
    const byName = new Map((await docs.list({ agent: "a1" })).map((d) => [d.header.name, d]));
    assertEquals([...byName.keys()].sort(), [
      "instructions/system",
      "skills/transcribe-audio",
      "skills/workflows",
    ]);
    // a checkout's package is files, so the address is one; an installed org's is its URL
    const at = byName.get("skills/workflows")!.header.path;
    assert(at.endsWith("/src/seed/system-skills-workflows.md"), at);
    assertEquals(at.startsWith(root), false); // never the data root, on any run
    assert(byName.get("instructions/system")!.body); // always ⇒ inlined
    assertEquals(byName.get("skills/workflows")!.body, undefined); // lazy → a pointer to `at`
    // the checkpoint prompt is no doc (no frontmatter) and still reads by name
    assertEquals(byName.has("instructions/compaction"), false);
    const ref = { scope: "system", kind: "instruction" } as const;
    assert(
      (await docs.read({ agent: "a1" }, { ...ref, name: "instructions/compaction" }))!
        .startsWith("The conversation above is being archived."),
    );
    assertEquals(await docs.read({ agent: "a1" }, { ...ref, name: "instructions/ghost" }), null);
  });
});

Deno.test("system: what the org writes answers for that name — a doc replaces, a bare file refuses", async () => {
  await withRoot(async (root) => {
    await put(root, "system/instructions/system", doc("instruction", "ours", "load: always\n"));
    await put(root, "system/skills/workflows", ""); // this org wants none

    const docs = openFileDocs(root);
    const byName = new Map((await docs.list({ agent: "a1" })).map((d) => [d.header.name, d]));
    assertEquals([...byName.keys()].sort(), ["instructions/system", "skills/transcribe-audio"]);
    assertEquals(byName.get("instructions/system")!.body, "ours");
    assertEquals(
      byName.get("instructions/system")!.header.path,
      `${root}/system/instructions/system.md`,
    );
    // read follows the same order, and reaches a file that is no doc at all
    const at = (name: string) =>
      docs.read({ agent: "a1" }, { scope: "system", kind: "instruction", name });
    assertEquals(await at("instructions/system"), "ours");
    assertEquals(await at("skills/workflows"), "");
  });
});
