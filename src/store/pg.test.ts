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
import { digits } from "./roster.ts";
import { routedSession } from "../session.ts";
import { connect } from "./pg/sql.ts";
import { AGENT_ROLE, VERSION } from "./pg/schema.ts";
import { openPgDocs } from "./pg/docs.ts";

import { agentsSuite } from "./suite/agents.ts";
import { connectionsSuite } from "./suite/connections.ts";
import { credentialsSuite } from "./suite/credentials.ts";
import { docsSuite } from "./suite/docs.ts";
import { gatesSuite } from "./suite/gates.ts";
import { lockSuite } from "./suite/lock.ts";
import { logSuite } from "./suite/log.ts";
import { rosterSuite } from "./suite/roster.ts";
import { rulesSuite } from "./suite/rules.ts";
import { sweepSuite } from "./suite/sweep.ts";
import { timersSuite } from "./suite/timers.ts";
import { postgres, postgresDocs } from "./suite/mod.ts";

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

  Deno.test("digits is the roster's handle rule", async () => {
    await withSchema(async (sql) => {
      for (const a of ["+54 9 11 555-0001", "549115550001", "ana@acme.co", "+", "", "(011) 4555"]) {
        assertEquals(await one(sql, "SELECT digits($1::text) AS v", [a]), digits(a), a);
      }
    });
  });

  Deno.test("routed is the routing function: the session a connection's traffic belongs to", async () => {
    await withSchema(async (sql) => {
      for (
        const [service, connection] of [["whatsapp", "549"], ["slack", "T1:U7"], [
          "local",
          "default",
        ]]
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
      const log = await store.open();
      // mail rows as a store before v4 filed them: by the other party, the subject in
      // `conversation_thread` (added below, once the rows are in)
      await log.upsertConnections([{ service: "google", address: "me@org.com" }]);
      await log.publish([
        {
          ts: "2026-09-25T00:00:00Z",
          type: "message",
          envelope: {
            service: "google",
            connection_address: "me@org.com",
            conversation: { address: "ana@x.com", kind: "direct" },
            external_id: "mail:m0@org.com",
          },
          parts: [{ type: "text", kind: "text", text: "please pay" }],
          extra: { google: { thread: "t1" } },
        },
        {
          ts: "2026-09-25T00:01:00Z",
          type: "message",
          payload: { action: "reply", ref_external_id: "mail:m0@org.com" },
          envelope: {
            service: "google",
            connection_address: "me@org.com",
            conversation: { address: "ana@x.com,bob@y.com", kind: "direct" },
            external_id: "mail:m1@x.com",
          },
          parts: [{ type: "text", kind: "text", text: "paid" }],
        },
      ]);
      await log.close();
      assertEquals(await version(), VERSION);
      await sql.unsafe("ALTER TABLE events ADD COLUMN conversation_thread text");
      await sql.unsafe("UPDATE events SET conversation_thread = 'Invoice 42'");
      await sql.unsafe("UPDATE schema_version SET version = 0");
      await (await store.vault()).close(); // either opener raises the store
      assertEquals(await version(), VERSION);
      // the raise to v4 filed the thread at its root, the raise to v5 at the Gmail thread its
      // rows kept — a row that kept none follows its thread — keyed per mailbox, the raise
      // to v6 made the thread a `group`, and the raise to v7 took the subject's old column off
      assertEquals(
        await one<number>(
          sql,
          "SELECT count(*)::integer AS v FROM information_schema.columns " +
            "WHERE table_schema = $1::text AND table_name = 'events' " +
            "AND column_name = 'conversation_thread'",
          [store.schema],
        ),
        0,
      );
      const raised = await store.open();
      const rows = await raised.read({ types: ["message"] });
      assertEquals(rows.map((e) => e.envelope.conversation), [
        { address: "t1", kind: "group", name: "Invoice 42" },
        { address: "t1", kind: "group", name: "Invoice 42" },
      ]);
      assertEquals(rows.map((e) => e.envelope.external_id), [
        "mail:me@org.com:m0@org.com",
        "mail:me@org.com:m1@x.com",
      ]);
      assertEquals(rows[1].payload?.ref_external_id, "mail:me@org.com:m0@org.com");
      await raised.close();
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

  docsSuite(postgresDocs(url));

  /** The policy under the functions: the agent role, writing past `docs_write`'s own
   *  refusal, still lands nowhere it may not. */
  Deno.test("docs: the row-level policy holds a statement the functions never make", async () => {
    const store = await pg.fresh();
    const docs = await openPgDocs(url, { schema: store.schema });
    const sql = connect(url, store.schema);
    try {
      const as = (statement: string) =>
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${AGENT_ROLE}`);
          await tx.unsafe("SELECT set_config('liquen.agent', 'a1', true)");
          await tx.unsafe(statement);
        });
      await assertRejects(
        () =>
          as(`INSERT INTO docs (scope, owner, name, text, updated_at)
              VALUES ('system', '', 'x', 'x', 't')`),
        Error,
        "row-level security",
      );
      await assertRejects(
        () =>
          as(`INSERT INTO docs (scope, owner, name, text, updated_at)
              VALUES ('agent', 'a2', 'x', 'x', 't')`),
        Error,
        "row-level security",
      );
    } finally {
      await sql.end();
      await docs.close();
      await store.drop();
    }
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
