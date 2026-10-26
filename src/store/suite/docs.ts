/**
 * The docs table's contract: the cascade it lists, the rule an agent's calls keep, the
 * seeds it takes, and `read · edit` answering what `aread · aedit` answer. Both engines
 * run it, so an agent's docs behave the same on SQLite and on Postgres.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DocScope } from "../docs.ts";
import { applyEdits, parseEdits } from "../../exec/edit.ts";
import { bringToolDocs, seedAgent, seedOrg, seedSkill } from "../seed.ts";
import type { DocsBench, DocsSubstrate } from "./mod.ts";

/** A doc's text: frontmatter (with `kind`) + body. */
const doc = (kind: string, body: string, extra = "") => `---\nkind: ${kind}\n${extra}---\n${body}`;

const refs = (docs: { header: { scope: string; kind: string; name: string } }[]) =>
  docs.map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`);

export function docsSuite(s: DocsSubstrate): void {
  /** A table seeded with `rows` (scope, owner, name, text), opened, for `fn`. */
  const withDocs = async (
    seed: [DocScope, string, string, string][],
    fn: (bench: DocsBench) => Promise<void>,
  ) => {
    const bench = await s.fresh();
    try {
      for (const [scope, owner, name, text] of seed) await bench.set(scope, owner, name, text);
      await fn(bench);
    } finally {
      await bench.close();
    }
  };

  Deno.test("docs: list is the cascade the context names, in its order, the handle the row's key", async () => {
    await withDocs([
      ["agent", "a1", "instructions/persona", doc("instruction", "be helpful")],
      ["agent", "a2", "instructions/persona", doc("instruction", "someone else's")],
      ["shared", "", "skills/refunds", doc("skill", "how to refund")],
      ["shared", "", "instructions/policy", doc("instruction", "org policy", "load: always\n")],
      ["system", "", "instructions/base", doc("instruction", "world model")],
      ["conversation", "c9", "state", doc("memory", "working state")],
    ], async ({ docs }) => {
      const listed = await docs.list({ agent: "a1" });
      assertEquals(refs(listed), [
        "system/instruction/instructions/base",
        "shared/instruction/instructions/policy",
        "shared/skill/skills/refunds",
        "agent/instruction/instructions/persona",
      ]);
      assertEquals(listed.map((d) => d.header.handle), [
        "system/instructions/base",
        "shared/instructions/policy",
        "shared/skills/refunds",
        "agent/instructions/persona",
      ]);
      // load: always ⇒ the body rides along, stripped; otherwise a pointer
      assertEquals(listed[1].body, "org policy");
      assertEquals(listed[2].body, undefined);
      // the conversation scope is listed only when the context names one
      assertEquals(
        refs(await docs.list({ agent: "a1", conversation: "c9" })).at(-1),
        "conversation/memory/state",
      );
      // read pulls a pointer's body, stripped; a missing doc is null
      assertEquals(
        await docs.read({ agent: "a1" }, {
          scope: "shared",
          kind: "skill",
          name: "skills/refunds",
        }),
        "how to refund",
      );
      assertEquals(
        await docs.read({ agent: "a1" }, { scope: "agent", kind: "instruction", name: "ghost" }),
        null,
      );
      assertEquals(
        await docs.read({ agent: "a1" }, { scope: "conversation", kind: "memory", name: "state" }),
        null,
      );
    });
  });

  Deno.test("docs: a row declares itself — kind, load and description ride in its frontmatter", async () => {
    await withDocs([
      ["agent", "a1", "anywhere/deep/note", doc("skill", "s")],
      ["agent", "a1", "loose", "---\ndescription: d\n---\nno kind ⇒ memory"],
      ["agent", "a1", "weird", doc("quantum", "unknown kind ⇒ memory")],
      ["agent", "a1", "bare", "no frontmatter at all"],
      ["agent", "a1", "quoted", '---\nkind: skill\ndescription: "ratio a:b, quoted"\n---\nbody'],
    ], async ({ docs }) => {
      const by = new Map((await docs.list({ agent: "a1" })).map((d) => [d.header.name, d.header]));
      assertEquals(by.get("anywhere/deep/note")!.kind, "skill");
      assertEquals(by.get("loose")!.kind, "memory");
      assertEquals(by.get("loose")!.description, "d");
      assertEquals(by.get("weird")!.kind, "memory");
      assertEquals(by.has("bare"), false); // no frontmatter ⇒ not a doc, as a file is not
      assertEquals(by.get("quoted")!.description, "ratio a:b, quoted");
    });
  });

  Deno.test("docs: an agent reads the scopes above it and its own, writes its own and its conversation's, and nothing else", async () => {
    await withDocs([
      ["system", "", "instructions/base", doc("instruction", "world model")],
      ["shared", "", "skills/refunds", doc("skill", "how to refund")],
      ["agent", "a1", "instructions/persona", doc("instruction", "mine")],
      ["agent", "a2", "instructions/persona", doc("instruction", "theirs")],
      ["conversation", "c9", "state", doc("memory", "ours")],
      ["conversation", "c8", "state", doc("memory", "not ours")],
    ], async ({ docs, rows }) => {
      const me = docs.as({ agent: "a1", conversation: "c9" });
      // reads: the cascade, as the read port lists it
      assertEquals(await me.read("system/instructions/base"), doc("instruction", "world model"));
      assertEquals(await me.read("shared/skills/refunds"), doc("skill", "how to refund"));
      assertEquals(await me.read("agent/instructions/persona"), doc("instruction", "mine"));
      assertEquals(await me.read("conversation/state"), doc("memory", "ours"));
      // another agent's row is not a doc I can name: the handle resolves to MINE
      await assertRejects(() => me.read("agent/nothing"), Error, "no such doc");
      // writes: my scope and the conversation's
      assertEquals(
        await me.write("agent/memories/x", "---\nkind: memory\n---\nnew"),
        "wrote 24 bytes to agent/memories/x",
      );
      assertEquals(
        await me.write("conversation/state", "changed"),
        "wrote 7 bytes to conversation/state",
      );
      assertEquals(
        await me.edit("agent/instructions/persona", "<<<<<<<\nmine\n=======\nMINE\n>>>>>>>"),
        "applied 1 edit(s) to agent/instructions/persona",
      );
      assertEquals(await me.read("agent/instructions/persona"), doc("instruction", "MINE"));
      // not the scopes above me
      await assertRejects(
        () => me.write("system/instructions/base", "x"),
        Error,
        "system/instructions/base: not yours to write",
      );
      await assertRejects(
        () => me.write("shared/skills/new", "x"),
        Error,
        "shared/skills/new: not yours to write",
      );
      await assertRejects(
        () => me.edit("system/instructions/base", "<<<<<<<\nworld\n=======\nx\n>>>>>>>"),
        Error,
        "not yours to edit",
      );
      // what landed, as the org sees it: a2's and c8's rows untouched, mine where I put them
      const all = await rows();
      assertEquals(all.map((r) => r.key), [
        "agent/a1/instructions/persona",
        "agent/a1/memories/x",
        "agent/a2/instructions/persona",
        "conversation/c8/state",
        "conversation/c9/state",
        "shared//skills/refunds",
        "system//instructions/base",
      ]);
      assertEquals(
        all.find((r) => r.key === "agent/a2/instructions/persona")!.text,
        doc("instruction", "theirs"),
      );
      assertEquals(all.find((r) => r.key === "conversation/c9/state")!.text, "changed");
      // a handle is scope/name
      await assertRejects(() => me.read("persona"), Error, "a handle is scope/name");
      await assertRejects(() => me.read("agent/"), Error, "a handle is scope/name");
      // no conversation ⇒ no conversation doc is anyone's
      const alone = docs.as({ agent: "a1" });
      await assertRejects(() => alone.read("conversation/state"), Error, "no such doc");
      await assertRejects(
        () => alone.write("conversation/state", "x"),
        Error,
        "not yours to write",
      );
      await assertRejects(
        () => alone.edit("conversation/state", "<<<<<<<\nours\n=======\nx\n>>>>>>>"),
        Error,
        "no such doc",
      );
    });
  });

  Deno.test("docs: the cascade seeds into the table by folder — never twice, and a deleted doc stays deleted", async () => {
    await withDocs([], async ({ docs, set, store }) => {
      const bed = { laid: docs.laid, lay: docs.lay };
      await seedOrg(bed);
      await seedAgent(bed, "alter");
      const listed = await docs.list({ agent: "alter" });
      assertEquals(refs(listed).sort(), [
        "agent/instruction/instructions/agent",
        "shared/instruction/instructions/organization",
        "system/instruction/instructions/system",
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
      assertEquals(
        listed.find((d) => d.header.name === "instructions/agent")!.header.handle,
        "agent/instructions/agent",
      );
      // the compaction prompt has no frontmatter: never in the index, still read by name
      assertStringIncludes(
        (await docs.read({ agent: "alter" }, {
          scope: "system",
          kind: "instruction",
          name: "instructions/compaction",
        }))!,
        "archived",
      );
      // an edit is kept, a deletion is kept: the folder's rows are the org's own
      await set("shared", "", "instructions/organization", "EDITED");
      await set("system", "", "skills/workflows", null);
      await seedOrg(bed);
      await seedAgent(bed, "alter");
      const again = await docs.list({ agent: "alter" });
      assertEquals(again.some((d) => d.header.name === "skills/workflows"), false);
      assertEquals(await docs.text("shared", "", "instructions/organization"), "EDITED");
      // a connector's skill is laid by the file's rule, once
      assertEquals(await seedSkill(bed, "microsoft-graph"), true);
      assertEquals(await seedSkill(bed, "microsoft-graph"), false);
      // and the store hands the same bed out where the catalog puts the docs in the table
      const opened = await store();
      try {
        assertEquals(opened.on, "table");
        assertEquals(typeof opened.as, "function");
        assertEquals(await opened.bed.laid("system", "", "skills"), true);
        // a folder is a whole segment: `skill` is not `skills`
        assertEquals(await opened.bed.laid("system", "", "skill"), false);
        // a release's tool docs reach the rows as they reach files: an older release's words
        // are brought, an edit is kept
        await set("system", "", "tools/bash", "older");
        await set("system", "", "tools/send", "the org's own");
        assertEquals(
          await bringToolDocs(opened.bed, () => Promise.resolve("older")),
          { laid: [], updated: ["bash"], kept: ["send"] },
        );
        assertStringIncludes((await opened.bed.text("system", "", "tools/bash"))!, "kind: tool");
        assertEquals(await opened.bed.text("system", "", "tools/send"), "the org's own");
      } finally {
        await opened.close();
      }
    });
  });

  Deno.test("docs: read is aread — head-truncated, 1-indexed, a footer naming the line to continue from", async () => {
    const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
    await withDocs([
      ["agent", "a1", "short", "a\nb\nc"],
      ["agent", "a1", "long", numbered(10)],
      ["agent", "a1", "trailing", "a\nb\n"],
      ["agent", "a1", "empty", ""],
      ["agent", "a1", "wide", "x".repeat(100) + "\nshort"],
    ], async ({ docs }) => {
      const me = docs.as({ agent: "a1" });
      assertEquals(await me.read("agent/short"), "a\nb\nc");
      assertEquals(await me.read("agent/trailing"), "a\nb");
      assertEquals(await me.read("agent/empty"), "");
      assertEquals(
        await me.read("agent/long", undefined, 3),
        "line 1\nline 2\nline 3\n\n[showing lines 1-3 of 10 — continue from line 4]",
      );
      assertEquals(
        await me.read("agent/long", 4, 3),
        "line 4\nline 5\nline 6\n\n[showing lines 4-6 of 10 — continue from line 7]",
      );
      assertEquals(await me.read("agent/long", 9), "line 9\nline 10");
      await assertRejects(
        () => me.read("agent/long", 11),
        Error,
        "offset 11 is beyond end of file (10 lines)",
      );
      // the byte cap wins when it hits first, never a partial line ("line 1\nline 2\nline 3" = 20 bytes)
      assertEquals(
        await me.read("agent/long", undefined, undefined, 20),
        "line 1\nline 2\nline 3\n\n[showing lines 1-3 of 10 — continue from line 4]",
      );
      assertEquals(
        await me.read("agent/wide", undefined, undefined, 50),
        "[line 1 alone exceeds the byte cap (50 bytes) — raise maxBytes]",
      );
      assertEquals(await me.read("agent/wide", 2, undefined, 50), "short");
    });
  });

  Deno.test("docs: edit is aedit — the edit engine's cases answer the same", async () => {
    const spec = (...blocks: [string, string][]) =>
      blocks.map(([o, n]) => `<<<<<<<\n${o}\n=======\n${n}\n>>>>>>>`).join("\n");
    // [the text, the spec]: each answers what applyEdits answers, or throws what it throws
    const cases: [string, string][] = [
      ["hello world", spec(["world", "mundo"])],
      ["aaa bbb ccc", spec(["aaa", "bbb"], ["ccc", "ddd"])], // matched against the ORIGINAL
      ["dup dup", spec(["dup", "x"])], // ambiguous
      ["abc", spec(["zzz", "x"])], // missing
      ["abcdef", spec(["abcd", "x"], ["cdef", "y"])], // overlapping
      ["line one   \nline two", spec(["line one\nline two", "merged"])], // trailing-ws fallback
      ["a\r\nb\r\nc", spec(["b", "B"])], // CRLF preserved
      ["﻿hello", spec(["hello", "hola"])], // BOM preserved
      ["a  \nb\nc  \n", spec(["a\nb", "A\nB"])], // the fallback rewrites only the matched span
      ["a  \nb\nc  \n", spec(["a", "A"], ["c", "C"])], // mixed: the span's end takes the line's whitespace
      ["x\ny", "<<<<<<<\r\nx\r\n=======\r\nX\r\n>>>>>>>\r\n"], // a CRLF spec
      ["abc", "no markers"],
      ["abc", "<<<<<<< old\nb\n=======\nB\n>>>>>>> new"], // git's labelled markers
      ["<<<<<<< HEAD\nx", "<<<<<<<\n<<<<<<< HEAD\n=======\nkept\n>>>>>>>"], // a label as text
      ["abc", "<<<<<<<\nold"],
      ["abc", ""],
      ["abc", spec(["", "x"])], // an empty old text
      ["ünïcödé — ñ 😀 end", spec(["ñ 😀", "n :)"])], // offsets past the BMP
      ["ab  \ncd 😀  \nef", spec(["cd 😀\nef", "X"])], // the fallback past the BMP
    ];
    await withDocs(
      cases.map(([text], i) => ["agent", "a1", `case${i}`, text]),
      async ({ docs }) => {
        const me = docs.as({ agent: "a1" });
        // the row's text, whole — the read's view pops a trailing newline, as aread does
        const stored = (i: number) => docs.text("agent", "a1", `case${i}`);
        for (const [i, [text, s]] of cases.entries()) {
          let want: string;
          try {
            want = applyEdits(text, parseEdits(s));
          } catch (err) {
            const message = (err as Error).message;
            await assertRejects(() => me.edit(`agent/case${i}`, s), Error, message.slice(0, 30));
            assertEquals(await stored(i), text, `case ${i}: untouched after the error`);
            continue;
          }
          await me.edit(`agent/case${i}`, s);
          assertEquals(
            await stored(i),
            want,
            `case ${i}: ${JSON.stringify(text)} ⊕ ${JSON.stringify(s)}`,
          );
        }
      },
    );
  });
}
