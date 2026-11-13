/**
 * The SQLite adapter runs the log suite, and answers for what is the engine's own: the
 * migrations a live file takes on open, the index a bounded read walks, and the write
 * lock's patience.
 */

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { type Log, openLog } from "./log.ts";
import type { Draft, MessageEvent } from "../types.ts";
import { logSuite } from "./suite/log.ts";
import { sqlite } from "./suite/mod.ts";

logSuite(sqlite);

async function withLog(fn: (log: Log, dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    await fn(log, dir);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const msg = (id: string, conversation: string, text: string): MessageEvent => ({
  id,
  ts: `2026-07-16T00:00:${id}Z`,
  type: "message",
  envelope: {
    service: "local",
    connection_address: "org",
    conversation: { address: conversation },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("migrate v6: a pre-sessions log settles on the pair vocabulary (§4, §7)", async () => {
  const dir = await Deno.makeTempDir();
  // an old-shaped database: agent-id session stamps, `mind:` rooms, version 5
  const first = await openLog(dir);
  await first.publish({
    ts: "2026-08-30T10:00:00.000Z",
    type: "message",
    agent: { id: "ana", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "default",
      conversation: { address: "mind@ana" },
    },
    parts: [{ type: "text", kind: "text", text: "dale" }],
  } as Draft<MessageEvent>);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `UPDATE events SET session_id = 'ana', conversation_address = 'mind:ana';
   UPDATE memberships SET conversation_address = 'mind:ana';
   UPDATE manifest SET value = '5' WHERE key = 'schema';`,
  );
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    const [e] = await log.read();
    assertEquals(e.agent, { id: "ana", session_id: "mind" });
    assertEquals(e.envelope.conversation.address, "mind@ana");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v13: mail rows are filed by thread — the reply chain walked to its root, the subject the name (then v14: keyed per mailbox; v16: the subject's old column gone)", async () => {
  const dir = await Deno.makeTempDir();
  const first = await openLog(dir);
  // a store at v12 kept a mail's subject in `conversation_thread`
  const subjects: Record<string, string> = {};
  const mail = (
    id: string,
    address: string,
    subject: string | undefined,
    ref?: string,
  ): Draft<MessageEvent> => {
    if (subject) subjects[`mail:${id}`] = subject;
    return {
      ts: "2026-08-30T10:00:00.000Z",
      type: "message",
      ...(ref ? { payload: { action: "reply", ref_external_id: `mail:${ref}` } } : {}),
      envelope: {
        service: "google",
        connection_address: "me@org.com",
        conversation: { address, kind: "direct", name: "Ana" },
        external_id: `mail:${id}`,
      },
      parts: [{ type: "text", kind: "text", text: id }],
    };
  };
  await first.upsertConnections([
    { service: "google", address: "me@org.com" },
    { service: "whatsapp", address: "549" },
  ]);
  await first.publish([
    mail("m0@org.com", "ana@x.com", "Invoice 42"),
    mail("m1@x.com", "ana@x.com", "Invoice 42", "m0@org.com"),
    // a Cc joined: the same thread under another address, two replies deep
    mail("m2@y.com", "ana@x.com,bob@y.com", "Invoice 42", "m1@x.com"),
    // a reply to a message the log never saw: that message is the root
    mail("m3@z.com", "carl@z.com", "Quote", "old@z.com"),
    // another thread with the same person, and one with no subject
    mail("m4@x.com", "ana@x.com", "Lunch"),
    mail("m5@x.com", "ana@x.com", undefined),
    {
      ts: "2026-08-30T10:00:00.000Z",
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "549",
        conversation: { address: "ana@x.com", kind: "direct" },
        external_id: "whatsapp:w1",
      },
      parts: [{ type: "text", kind: "text", text: "hola" }],
    },
  ]);
  subjects["whatsapp:w1"] = "not mail";
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec("ALTER TABLE events ADD COLUMN conversation_thread TEXT");
  const keep = db.prepare("UPDATE events SET conversation_thread = ? WHERE external_id = ?");
  for (const [key, subject] of Object.entries(subjects)) keep.run(subject, key);
  db.exec("UPDATE manifest SET value = '12' WHERE key = 'schema'");
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    const rows = await log.read({ types: ["message"] });
    const filed = Object.fromEntries(
      rows.map((e) => [e.envelope.external_id, e.envelope.conversation]),
    );
    const me = "mail:me@org.com:";
    assertEquals(filed, {
      [`${me}m0@org.com`]: { address: "m0@org.com", kind: "group", name: "Invoice 42" },
      [`${me}m1@x.com`]: { address: "m0@org.com", kind: "group", name: "Invoice 42" },
      [`${me}m2@y.com`]: { address: "m0@org.com", kind: "group", name: "Invoice 42" },
      [`${me}m3@z.com`]: { address: "old@z.com", kind: "group", name: "Quote" },
      [`${me}m4@x.com`]: { address: "m4@x.com", kind: "group", name: "Lunch" },
      [`${me}m5@x.com`]: { address: "m5@x.com", kind: "group" },
      "whatsapp:w1": { address: "ana@x.com", kind: "direct" },
    });
    // v16 took the column off
    const after = new DatabaseSync(`${dir}/log.db`);
    const cols = after.prepare("SELECT name FROM pragma_table_info('events')").all()
      .map((c) => (c as { name: string }).name);
    after.close();
    assert(!cols.includes("conversation_thread"));
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v14: mail is keyed per mailbox and filed at the Gmail thread its rows kept", async () => {
  const dir = await Deno.makeTempDir();
  const first = await openLog(dir);
  const row = (
    service: "google" | "microsoft",
    account: string,
    external: string | undefined,
    address: string,
    over: Partial<Draft<MessageEvent>> = {},
  ): Draft<MessageEvent> => ({
    ts: "2026-09-29T10:00:00.000Z",
    type: "message",
    envelope: {
      service,
      connection_address: account,
      conversation: { address, kind: "group", name: "Invoice 42" },
      ...(external ? { external_id: external } : {}),
    },
    parts: [{ type: "text", kind: "text", text: "x" }],
    ...over,
  });
  await first.upsertConnections([
    { service: "google", address: "me@org.com" },
    { service: "microsoft", address: "me@corp.com" },
  ]);
  await first.publish([
    // a Gmail thread at its root: the inbound row kept its threadId, our reply's echo did
    // not come back
    row("google", "me@org.com", "mail:m0@x.com", "m0@x.com", {
      extra: { google: { thread: "t1" } },
    }),
    row("google", "me@org.com", "mail:u1@org.com", "m0@x.com", {
      agent: { id: "a1", session_id: "mind" },
      payload: { action: "reply", ref_external_id: "mail:m0@x.com" },
    }),
    // an Outlook thread: no conversationId was ever kept
    row("microsoft", "me@corp.com", "mail:m5@y.com", "m5@y.com"),
    // not mail: a Teams group chat on the same service, a calendar
    row("microsoft", "me@corp.com", "teams:c1", "19:abc@thread.v2"),
    row("google", "me@org.com", "gcal:e1", "me@org.com", {
      envelope: {
        service: "google",
        connection_address: "me@org.com",
        conversation: { address: "me@org.com", kind: "broadcast" },
        external_id: "gcal:e1",
      },
    }),
  ]);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec("UPDATE manifest SET value = '13' WHERE key = 'schema'");
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    const rows = await log.read({ types: ["message"] });
    const filed = Object.fromEntries(
      rows.map((e) => [e.envelope.external_id, e.envelope.conversation]),
    );
    assertEquals(filed, {
      "mail:me@org.com:m0@x.com": { address: "t1", kind: "group", name: "Invoice 42" },
      "mail:me@org.com:u1@org.com": { address: "t1", kind: "group", name: "Invoice 42" },
      "mail:me@corp.com:m5@y.com": { address: "m5@y.com", kind: "group", name: "Invoice 42" },
      "teams:c1": { address: "19:abc@thread.v2", kind: "group", name: "Invoice 42" },
      "gcal:e1": { address: "me@org.com", kind: "broadcast" },
    });
    const reply = rows.find((e) => e.envelope.external_id === "mail:me@org.com:u1@org.com");
    assertEquals(reply?.payload?.ref_external_id, "mail:me@org.com:m0@x.com");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v15: every mail thread is a group, a send not yet confirmed in it too; a direct chat stays direct", async () => {
  const dir = await Deno.makeTempDir();
  const first = await openLog(dir);
  const row = (
    service: "google" | "microsoft" | "whatsapp",
    account: string,
    external: string | undefined,
    address: string,
    text: string,
  ): Draft<MessageEvent> => ({
    ts: "2026-09-30T10:00:00.000Z",
    type: "message",
    envelope: {
      service,
      connection_address: account,
      conversation: { address, kind: "direct", name: "Invoice 42" },
      ...(external ? { external_id: external } : {}),
    },
    parts: [{ type: "text", kind: "text", text }],
  });
  await first.upsertConnections([
    { service: "google", address: "me@org.com" },
    { service: "microsoft", address: "me@corp.com" },
    { service: "whatsapp", address: "549" },
  ]);
  await first.publish([
    row("google", "me@org.com", "mail:me@org.com:m0@x.com", "t1", "inbound"),
    {
      ...row("google", "me@org.com", undefined, "t1", "queued"),
      agent: { id: "a1", session_id: "mind" },
    },
    row("microsoft", "me@corp.com", "mail:me@corp.com:m5@y.com", "AAQk5", "outlook"),
    row("microsoft", "me@corp.com", "teams:c1", "19:a_b@unq.gbl.spaces", "teams"),
    row("whatsapp", "549", "whatsapp:w1", "5491100000000", "whatsapp"),
  ]);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec("UPDATE manifest SET value = '14' WHERE key = 'schema'");
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    const rows = await log.read({ types: ["message"] });
    const kinds = Object.fromEntries(
      rows.map((e) => [(e.parts[0] as { text: string }).text, e.envelope.conversation.kind]),
    );
    assertEquals(kinds, {
      inbound: "group",
      queued: "group",
      outlook: "group",
      teams: "direct",
      whatsapp: "direct",
    });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v17: a log that armed wakes in a table opens without it", async () => {
  const dir = await Deno.makeTempDir();
  const first = await openLog(dir);
  await first.close();
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `CREATE TABLE timers (id TEXT PRIMARY KEY, fire_at TEXT NOT NULL);
   INSERT INTO timers VALUES ('t1', '2026-11-06T13:00:00.000Z');
   UPDATE manifest SET value = '16' WHERE key = 'schema';`,
  );
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  await log.close();
  const again = new DatabaseSync(`${dir}/log.db`);
  try {
    assertEquals(
      again.prepare("SELECT 1 FROM sqlite_master WHERE name = 'timers'").get(),
      undefined,
    );
    assertEquals(
      again.prepare("SELECT value FROM manifest WHERE key = 'schema'").get(),
      { value: "18" },
    );
  } finally {
    again.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate v18: a store whose version the engine kept takes the manifest; the roster keeps who and its floor, and what names a gone agent goes", async () => {
  const dir = await Deno.makeTempDir();
  // a store as v17 left it: settings on the row, no key from any table to the roster, the
  // version in the engine's own counter
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `CREATE TABLE events (id TEXT PRIMARY KEY, external_id TEXT, type TEXT NOT NULL, service TEXT,
       connection_address TEXT, conversation_address TEXT, conversation_name TEXT,
       conversation_kind TEXT, session_id TEXT, sender_address TEXT, sender_name TEXT,
       agent_id TEXT, timestamp TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       text TEXT, parts TEXT, payload TEXT NOT NULL, extra TEXT, status TEXT);
     CREATE TABLE agents (agent_id TEXT PRIMARY KEY, mind TEXT NOT NULL, provider TEXT, model TEXT,
       effort TEXT, name TEXT, email TEXT, phone TEXT, principals TEXT,
       runs INTEGER NOT NULL DEFAULT 1, settings TEXT, created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL);
     CREATE TABLE connections (service TEXT NOT NULL, address TEXT NOT NULL, agent_id TEXT,
       credential_key TEXT, extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       deleted_at TEXT, PRIMARY KEY (service, address));
     CREATE TABLE memberships (service TEXT NOT NULL, connection_address TEXT NOT NULL,
       conversation_address TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
       created_at TEXT NOT NULL, deleted_at TEXT,
       PRIMARY KEY (service, connection_address, conversation_address, agent_id, session_id));
     CREATE TABLE rules (agent_id TEXT NOT NULL, tool TEXT NOT NULL,
       connection TEXT NOT NULL DEFAULT '', conversation TEXT NOT NULL DEFAULT '',
       action TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (agent_id, tool, connection, conversation));
     CREATE TABLE credentials (key TEXT PRIMARY KEY, value TEXT NOT NULL, agent_id TEXT,
       extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     INSERT INTO agents VALUES ('ana', 'mind@ana', 'anthropic', 'claude-x', 'low', 'Ana',
       'ana@org.example', NULL, '["ana"]', 1,
       '{"maxTokens":1024,"since":"2026-11-01T00:00:00.000Z"}', 't', 't');
     INSERT INTO connections VALUES ('slack', 'T1', NULL, 'slack:T1:org', NULL, 't', 't', NULL),
       ('slack', 'T1:U1', 'ana', NULL, '{"mirrors":{"self":"D1"}}', 't', 't', NULL),
       ('slack', 'T1:U9', 'gone', NULL, NULL, 't', 't', NULL);
     INSERT INTO memberships VALUES ('local', 'default', 'mind@ana', 'ana', 'mind', 't', NULL),
       ('local', 'default', 'mind@gone', 'gone', 'mind', 't', NULL);
     INSERT INTO rules VALUES ('ana', 'send', '', '', 'allow', 't'),
       ('gone', 'send', '', '', 'allow', 't');
     INSERT INTO credentials VALUES ('ai:anthropic:ana', '{"token":"a"}', 'ana', NULL, 't', 't'),
       ('ai:anthropic:gone', '{"token":"g"}', 'gone', NULL, 't', 't'),
       ('slack:T1:org', '{"token":"o"}', NULL, NULL, 't', 't');
     PRAGMA user_version = 17;`,
  );
  db.close();

  const log = await openLog(dir); // reopening IS the migration
  try {
    assertEquals(await log.agents(), [{
      agentId: "ana",
      mind: "mind@ana",
      name: "Ana",
      email: "ana@org.example",
      principals: ["ana"],
      since: "2026-11-01T00:00:00.000Z", // the floor its settings held: the prompt's history stays put
    }]);
    assertEquals((await log.manifest()).schema, "18");
    assertEquals(await log.config(), []); // the settings are the file's to set again at this boot
    assertEquals((await log.connections()).map((c) => c.address), ["T1", "T1:U1"]);
    assertEquals((await log.memberships()).map((m) => m.agentId), ["ana"]);
    assertEquals((await log.remembered("gone")).length, 0);
    assertEquals((await log.remembered("ana")).length, 1);
    // the keys are enforced from here on: what names an agent goes with it
    await log.dropAgent("ana");
    assertEquals((await log.connections()).map((c) => c.address), ["T1"]);
  } finally {
    await log.close();
  }
  const again = new DatabaseSync(`${dir}/log.db`);
  try {
    assertEquals(
      again.prepare("SELECT key FROM credentials ORDER BY key").all(),
      [{ key: "slack:T1:org" }],
    );
  } finally {
    again.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("events are indexed by timestamp — a time-bounded read does not scan", async () => {
  await withLog((_log, dir) => {
    const db = new DatabaseSync(`${dir}/log.db`, { readOnly: true });
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
    ).all() as { name: string }[]).map((r) => r.name);
    db.close();
    assertEquals(names.includes("events_timestamp"), true);
    return Promise.resolve();
  });
});

Deno.test("publish outlasts a writer holding the lock past the busy timeout (slow)", async () => {
  await withLog(async (log, dir) => {
    // another PROCESS holds the write lock for longer than busy_timeout
    const holder = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync("${dir}/log.db");
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       await new Promise((r) => setTimeout(r, 5_600));
       db.exec("COMMIT");
       db.close();`,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const reader = holder.stdout.getReader();
    await reader.read(); // "held"
    reader.releaseLock();
    await holder.stdout.cancel();
    const e = (await log.publish(msg("01", "c1", "hola")))!;
    assertEquals(e.type, "message");
    await holder.status;
  });
});

Deno.test("the health check waits out a lock another process holds on the file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // an EXCLUSIVE lock on a rollback-journal file shuts out readers too, as a sibling
    // replaying a WAL does at boot
    const holder = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync("${dir}/log.db");
       db.exec("BEGIN EXCLUSIVE; CREATE TABLE held (x)");
       console.log("held");
       await new Promise((r) => setTimeout(r, 1_000));
       db.exec("COMMIT");
       db.close();`,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const reader = holder.stdout.getReader();
    await reader.read(); // "held"
    reader.releaseLock();
    await holder.stdout.cancel();
    const log = await openLog(dir);
    await log.close();
    await holder.status;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a file that is not a database is refused as corrupt, naming the engine's reason", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/log.db`, "not a database, just words ".repeat(200));
    const err = await openLog(dir).then(() => undefined, (e: Error) => e);
    assert(err instanceof Error && !(err instanceof Deno.errors.Busy));
    assert(err.message.includes("is corrupt (file is not a database)"), err.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
