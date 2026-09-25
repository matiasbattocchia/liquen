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
