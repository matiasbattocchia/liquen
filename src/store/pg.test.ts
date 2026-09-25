/**
 * The Postgres adapter runs every store suite, against the database `LIQUEN_TEST_PG` names
 * (a connection URL: its password is a secret, so it rides the environment). Each store
 * is a schema of its own, dropped when its test ends. Without the variable the suites are
 * not registered, and one ignored test says so.
 *
 * Beside the suites, what is the engine's own: the functions the schema defines are the
 * code's rules restated in SQL, held here to the code's answers, and a store's schema is
 * set up once when two processes open it at the same moment.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { foldName } from "./names.ts";
import { digits, sameHandle } from "./roster.ts";
import { routedSession } from "../session.ts";
import { connect } from "./pg/sql.ts";
import { VERSION } from "./pg/schema.ts";
import { openPgDocs, type PgDocs } from "./pg/docs.ts";
import { applyEdits, parseEdits } from "../exec/edit.ts";

import { agentsSuite } from "./suite/agents.ts";
import { connectionsSuite } from "./suite/connections.ts";
import { credentialsSuite } from "./suite/credentials.ts";
import { gatesSuite } from "./suite/gates.ts";
import { lockSuite } from "./suite/lock.ts";
import { logSuite } from "./suite/log.ts";
import { rosterSuite } from "./suite/roster.ts";
import { rulesSuite } from "./suite/rules.ts";
import { sweepSuite } from "./suite/sweep.ts";
import { timersSuite } from "./suite/timers.ts";
import { postgres } from "./suite/mod.ts";

const url = Deno.env.get("LIQUEN_TEST_PG");

if (url === undefined) {
  Deno.test({
    name: "postgres: the store suites run when LIQUEN_TEST_PG names a database",
    ignore: true,
    fn() {},
  });
} else {
  const pg = postgres(url);
  logSuite(pg);
  lockSuite(pg);
  agentsSuite(pg);
  connectionsSuite(pg);
  rulesSuite(pg);
  timersSuite(pg);
  gatesSuite(pg);
  sweepSuite(pg);
  rosterSuite(pg);
  credentialsSuite(pg);

  /** A store, opened, and a plain connection on its schema for `fn` to query. */
  const withSchema = async (fn: (sql: ReturnType<typeof connect>) => Promise<void>) => {
    const store = await pg.fresh();
    const log = await store.open();
    const sql = connect(url, store.schema);
    try {
      await fn(sql);
    } finally {
      await sql.end();
      await log.close();
      await store.drop();
    }
  };
  const one = async <T>(sql: ReturnType<typeof connect>, text: string, params: unknown[]) =>
    (await sql.unsafe(text, params as never[]))[0].v as T;

  Deno.test("fold is the name rule: case, accents and spacing folded as foldName folds them", async () => {
    await withSchema(async (sql) => {
      for (
        const s of [
          "Álvaro",
          "VERÓNICA  Sesto",
          " Yañez\tMarcos ",
          "Ünal Çelik",
          "Nguyễn Đức",
          "ÅSA",
          "مُحَمَّد", // Arabic harakat: marks outside the Latin combining blocks
          "हिन्दी", // Devanagari vowel signs, spacing marks
          "שָׁלוֹם", // Hebrew points
          "Ǆ ǅ ǆ", // no marks at all
        ]
      ) {
        assertEquals(await one(sql, "SELECT fold($1::text) AS v", [s]), foldName(s), s);
      }
    });
  });

  Deno.test("same_handle and digits are the roster's handle rules", async () => {
    await withSchema(async (sql) => {
      const pairs: [string, string][] = [
        ["+54 9 11 555-0001", "549115550001"],
        ["549115550001", "549115550002"],
        ["Ana@Acme.co", " ana@acme.co "],
        ["ana@acme.co", "549115550001"],
        ["+", "-"],
        ["", "549"],
        ["(011) 4555", "0114555"],
      ];
      for (const [a, b] of pairs) {
        assertEquals(
          await one(sql, "SELECT same_handle($1::text, $2::text) AS v", [a, b]),
          sameHandle(a, b),
          `${a} ~ ${b}`,
        );
        assertEquals(await one(sql, "SELECT digits($1::text) AS v", [a]), digits(a));
      }
    });
  });

  Deno.test("routed is the routing function: the session a connection's traffic belongs to", async () => {
    await withSchema(async (sql) => {
      for (
        const [service, connection] of [["whatsapp", "549"], ["slack", "T1:U7"], ["local", "agent"]]
      ) {
        assertEquals(
          await one(sql, "SELECT routed($1::text, $2::text) AS v", [service, connection]),
          routedSession({ service, connection_address: connection }),
        );
      }
    });
  });

  Deno.test("json_patch merges as SQLite's does (RFC 7396)", async () => {
    const lite = new DatabaseSync(":memory:");
    try {
      await withSchema(async (sql) => {
        const cases: [string, string][] = [
          ['{"a":1}', '{"b":2}'],
          ['{"a":{"x":1,"y":2}}', '{"a":{"y":null,"z":3}}'],
          ['{"a":1}', '{"a":null}'],
          ['{"a":[1,2]}', '{"a":[3]}'],
          ['{"a":1}', '{"a":{"b":{"c":null,"d":1}}}'],
          ['{"state":"failed","attempts":1}', '{"state":"queued","queued_at":"t"}'],
          ["[1]", '{"a":1}'],
          ['{"a":1}', '"x"'],
        ];
        for (const [target, patch] of cases) {
          const want = (lite.prepare("SELECT json_patch(?, ?) AS v").get(target, patch) as {
            v: string;
          }).v;
          const got = await one<string>(sql, "SELECT json_patch($1::jsonb, $2::jsonb) AS v", [
            target,
            patch,
          ]);
          assertEquals(JSON.parse(got), JSON.parse(want), `${target} ⊕ ${patch}`);
        }
      });
    } finally {
      lite.close();
    }
  });

  Deno.test("two processes opening one store at once set it up once, and both run", async () => {
    const store = await pg.fresh();
    const [a, b] = await Promise.all([store.open(), store.open()]);
    try {
      await a.publish({
        ts: "2026-09-25T00:00:00Z",
        type: "message",
        envelope: { service: "local", connection_address: "org", conversation: { address: "c1" } },
        parts: [{ type: "text", kind: "text", text: "hola" }],
      });
      assertEquals((await b.read()).length, 1);
    } finally {
      await a.close();
      await b.close();
      await store.drop();
    }
  });

  Deno.test("the schema carries its version: a fresh store is stamped, a behind one raised, an ahead one refused", async () => {
    const store = await pg.fresh();
    const sql = connect(url, store.schema);
    const version = async () =>
      await one<number>(sql, "SELECT version AS v FROM schema_version", []);
    try {
      await (await store.open()).close();
      assertEquals(await version(), VERSION);
      await sql.unsafe("UPDATE schema_version SET version = 0");
      await (await store.vault()).close(); // either opener raises the store
      assertEquals(await version(), VERSION);
      await sql.unsafe("UPDATE schema_version SET version = $1::integer", [VERSION + 1]);
      await assertRejects(() => store.open(), Error, `schema version ${VERSION + 1}`);
    } finally {
      await sql.end();
      await store.drop();
    }
  });

  Deno.test("a NUL in a draft lands as U+FFFD, in the text and in the parts alike", async () => {
    const store = await pg.fresh();
    const log = await store.open();
    try {
      const e = await log.publish({
        ts: "2026-09-25T00:00:00Z",
        type: "message",
        envelope: {
          service: "local",
          connection_address: "org",
          conversation: { address: "c1", name: "room\0one" },
        },
        parts: [{ type: "text", kind: "text", text: "a\0b" }],
      });
      await log.setDelivery(e!.id, { status: { state: "failed", error: "x\0y" } });
      const [found] = await log.read();
      assertEquals(found.parts, [{ type: "text", kind: "text", text: "a�b" }]);
      assertEquals(found.envelope.conversation.name, "room�one");
      assertEquals(found.status?.error, "x�y");
    } finally {
      await log.close();
      await store.drop();
    }
  });

  /* ── the docs table ─────────────────────────────────────────────────── */

  /** A doc's text: frontmatter (with `kind`) + body. */
  const doc = (kind: string, body: string, extra = "") =>
    `---\nkind: ${kind}\n${extra}---\n${body}`;

  /** A docs table seeded with `rows` (scope, owner, name, text), opened, for `fn`. */
  const withDocs = async (
    seed: [string, string, string, string][],
    fn: (docs: PgDocs, sql: ReturnType<typeof connect>) => Promise<void>,
  ) => {
    const store = await pg.fresh();
    const docs = await openPgDocs(url, { schema: store.schema });
    const sql = connect(url, store.schema);
    try {
      for (const [scope, owner, name, text] of seed) {
        await sql.unsafe(
          `INSERT INTO docs (scope, owner, name, text, updated_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, 't')`,
          [scope, owner, name, text],
        );
      }
      await fn(docs, sql);
    } finally {
      await sql.end();
      await docs.close();
      await store.drop();
    }
  };
  const refs = (docs: { header: { scope: string; kind: string; name: string } }[]) =>
    docs.map((d) => `${d.header.scope}/${d.header.kind}/${d.header.name}`);

  Deno.test("docs: list is the cascade the context names, in its order, the handle the row's key", async () => {
    await withDocs([
      ["agent", "a1", "instructions/persona", doc("instruction", "be helpful")],
      ["agent", "a2", "instructions/persona", doc("instruction", "someone else's")],
      ["organization", "", "skills/refunds", doc("skill", "how to refund")],
      [
        "organization",
        "",
        "instructions/policy",
        doc("instruction", "org policy", "load: always\n"),
      ],
      ["system", "", "instructions/base", doc("instruction", "world model")],
      ["conversation", "c9", "state", doc("memory", "working state")],
    ], async (docs) => {
      const listed = await docs.list({ agent: "a1" });
      assertEquals(refs(listed), [
        "system/instruction/instructions/base",
        "organization/instruction/instructions/policy",
        "organization/skill/skills/refunds",
        "agent/instruction/instructions/persona",
      ]);
      assertEquals(listed.map((d) => d.header.handle), [
        "system/instructions/base",
        "organization/instructions/policy",
        "organization/skills/refunds",
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
          scope: "organization",
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
    ], async (docs) => {
      const by = new Map((await docs.list({ agent: "a1" })).map((d) => [d.header.name, d.header]));
      assertEquals(by.get("anywhere/deep/note")!.kind, "skill");
      assertEquals(by.get("loose")!.kind, "memory");
      assertEquals(by.get("loose")!.description, "d");
      assertEquals(by.get("weird")!.kind, "memory");
      assertEquals(by.get("bare")!.kind, "memory");
      assertEquals(by.get("bare")!.load, "lazy");
      assertEquals(by.get("quoted")!.description, "ratio a:b, quoted");
    });
  });

  Deno.test("docs: the policy — an agent reads the scopes above it and its own, writes its own and its conversation's, and nothing else", async () => {
    await withDocs([
      ["system", "", "instructions/base", doc("instruction", "world model")],
      ["organization", "", "skills/refunds", doc("skill", "how to refund")],
      ["agent", "a1", "instructions/persona", doc("instruction", "mine")],
      ["agent", "a2", "instructions/persona", doc("instruction", "theirs")],
      ["conversation", "c9", "state", doc("memory", "ours")],
      ["conversation", "c8", "state", doc("memory", "not ours")],
    ], async (docs, sql) => {
      const me = docs.as({ agent: "a1", conversation: "c9" });
      // reads: the cascade, as the read port lists it
      assertEquals(await me.read("system/instructions/base"), doc("instruction", "world model"));
      assertEquals(await me.read("organization/skills/refunds"), doc("skill", "how to refund"));
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
        "row-level security",
      );
      await assertRejects(
        () => me.write("organization/skills/new", "x"),
        Error,
        "row-level security",
      );
      await assertRejects(
        () => me.edit("system/instructions/base", "<<<<<<<\nworld\n=======\nx\n>>>>>>>"),
        Error,
        "not yours to edit",
      );
      // what landed, as the owner sees it: a2's and c8's rows untouched, mine where I put them
      const all = await sql.unsafe(
        "SELECT scope, owner, name, text FROM docs ORDER BY scope, owner, name",
      );
      assertEquals(all.map((r) => `${r.scope}/${r.owner}/${r.name}`), [
        "agent/a1/instructions/persona",
        "agent/a1/memories/x",
        "agent/a2/instructions/persona",
        "conversation/c8/state",
        "conversation/c9/state",
        "organization//skills/refunds",
        "system//instructions/base",
      ]);
      assertEquals(all.find((r) => r.owner === "a2")!.text, doc("instruction", "theirs"));
      assertEquals(all.find((r) => r.owner === "c9")!.text, "changed");
      // a handle is scope/name
      await assertRejects(() => me.read("persona"), Error, "a handle is scope/name");
      await assertRejects(() => me.read("agent/"), Error, "a handle is scope/name");
      // no conversation ⇒ no conversation doc is anyone's
      await assertRejects(
        () => docs.as({ agent: "a1" }).read("conversation/state"),
        Error,
        "no such doc",
      );
      await assertRejects(() => docs.as({ agent: "a1" }).write("conversation/state", "x"), Error);
    });
  });

  Deno.test("docs_read is aread: head-truncated, 1-indexed, a footer naming the line to continue from", async () => {
    const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
    await withDocs([
      ["agent", "a1", "short", "a\nb\nc"],
      ["agent", "a1", "long", numbered(10)],
      ["agent", "a1", "trailing", "a\nb\n"],
      ["agent", "a1", "empty", ""],
      ["agent", "a1", "wide", "x".repeat(100) + "\nshort"],
    ], async (docs) => {
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

  Deno.test("docs_edit is aedit: the edit engine's cases answer the same on both", async () => {
    const spec = (...blocks: [string, string][]) =>
      blocks.map(([o, n]) => `<<<<<<<\n${o}\n=======\n${n}\n>>>>>>>`).join("\n");
    // [the text, the spec, what applyEdits answers or the error it throws]
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
      ["abc", "<<<<<<<\nold"],
      ["abc", ""],
      ["abc", spec(["", "x"])], // an empty old text
      ["ünïcödé — ñ 😀 end", spec(["ñ 😀", "n :)"])], // offsets past the BMP
      ["ab  \ncd 😀  \nef", spec(["cd 😀\nef", "X"])], // the fallback past the BMP
    ];
    await withDocs(
      cases.map(([text], i) => ["agent", "a1", `case${i}`, text]),
      async (docs, sql) => {
        const me = docs.as({ agent: "a1" });
        // the row's text, whole — the read's view pops a trailing newline, as aread does
        const stored = async (i: number) =>
          (await sql.unsafe("SELECT text FROM docs WHERE name = $1::text", [`case${i}`]))[0].text;
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

  Deno.test("two processes merging different fields of one credential both survive", async () => {
    const store = await pg.fresh();
    const [a, b] = await Promise.all([store.vault(), store.vault()]);
    try {
      const n = 100;
      const writes = (vault: typeof a, field: string) =>
        (async () => {
          for (let i = 0; i < n; i++) {
            await vault.put({ key: "svc:org", value: { [field]: String(i) } });
          }
        })();
      await Promise.all([writes(a, "token"), writes(b, "app_token")]);
      assertEquals((await a.get("svc:org"))?.value, {
        token: String(n - 1),
        app_token: String(n - 1),
      });
    } finally {
      await a.close();
      await b.close();
      await store.drop();
    }
  });
}
