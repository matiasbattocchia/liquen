import { assertEquals, assertRejects } from "@std/assert";
import { type Log, openLog } from "./log.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";

function msg(id: string, conversation: string, text: string, sender?: string): MessageEvent {
  return {
    id,
    ts: `2026-07-16T00:00:${id.padStart(2, "0")}Z`,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "org",
      conversation: { address: conversation },
      ...(sender ? { sender: { address: sender } } : {}),
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

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

/** Resolve once `n` events are delivered to a subscription, else reject. */
function take(log: Log, n: number, from?: string, ms = 2000): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const got: Event[] = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout: got ${got.length}/${n}`));
    }, ms);
    const off = log.subscribe((e) => {
      got.push(e);
      if (got.length >= n) {
        clearTimeout(timer);
        off();
        resolve(got);
      }
    }, from === undefined ? {} : { from });
  });
}

/* ── publish + read ─────────────────────────────────────────────────── */

Deno.test("publish returns the event; read replays it in append order", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "c1", "hello"));
    const returned = (await log.publish(msg("02", "c1", "world")))!;
    assertEquals(returned.id, "02");
    assertEquals((await log.read()).map((e) => e.id), ["01", "02"]);
  });
});

Deno.test("published events persist across reopen (recovery = replay)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const a = await openLog(dir);
    await a.publish(msg("01", "c1", "a"));
    await a.publish(msg("02", "c2", "b"));
    await a.close();

    const b = await openLog(dir);
    assertEquals((await b.read()).map((e) => e.id), ["01", "02"]);
    await b.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("read filters by conversation, sender, and case-insensitive text (§6)", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "c1", "Refund please", "cust"));
    await log.publish(msg("02", "c2", "unrelated", "cust"));
    await log.publish(msg("03", "c1", "another REFUND", "other"));

    assertEquals((await log.read({ conversation: "c1" })).map((e) => e.id), ["01", "03"]);
    assertEquals((await log.read({ from: "cust" })).map((e) => e.id), ["01", "02"]);
    assertEquals((await log.read({ text: "refund" })).map((e) => e.id), ["01", "03"]);
  });
});

Deno.test("the search column is every part's words: text, a file's name+caption, a data part's leaves+text (§6)", async () => {
  await withLog(async (log) => {
    const parted = (id: string, parts: MessageEvent["parts"]): MessageEvent => ({
      ...msg(id, "c1", ""),
      parts,
    });
    await log.publish(parted("01", [{
      type: "file",
      kind: "document",
      file: { mime_type: "application/pdf", uri: "file:///m/x.pdf", name: "contrato.pdf" },
      text: "acá está",
    }]));
    await log.publish(parted("02", [{
      type: "data",
      kind: "calendar",
      // keys are dropped, VALUES indexed — and the prose rides `text`, not a data field
      data: { gid: "ev1", title: "Natación", loc: "Club Náutico" },
      text: "traer antiparras",
    }]));
    // machinery is not search text: a thinking block's signature never enters the column
    await log.publish({
      ts: "2026-07-16T00:00:03Z",
      type: "thinking",
      envelope: { service: "local", connection_address: "org", conversation: { address: "c1" } },
      parts: [{ type: "data", kind: "thinking", data: { thinking: "hmm", signature: "AbCd" } }],
    } as unknown as Draft<Event>);

    const found = async (text: string) => (await log.read({ text })).map((e) => e.id);
    assertEquals(await found("contrato"), ["01"]); // the filename
    assertEquals(await found("acá está"), ["01"]); // the caption
    assertEquals(await found("Natación"), ["02"]); // a data VALUE
    assertEquals(await found("Náutico"), ["02"]);
    assertEquals(await found("antiparras"), ["02"]); // the data part's own text
    assertEquals(await found("gid"), []); // never a KEY
    assertEquals(await found("AbCd"), []); // never machinery
  });
});

Deno.test("read `conversations` scopes to a set — the readable filter at source (§6)", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "c1", "a"));
    await log.publish(msg("02", "c2", "b"));
    await log.publish(msg("03", "c3", "c"));
    // a principal permitted only c1+c3 never loads c2 out of the store (WHERE IN, not post-filter)
    assertEquals((await log.read({ conversations: ["c1", "c3"] })).map((e) => e.id), ["01", "03"]);
  });
});

Deno.test("after/before bound the id range; limit keeps the most recent N", async () => {
  await withLog(async (log) => {
    for (const id of ["01", "02", "03", "04", "05"]) await log.publish(msg(id, "c1", id));
    // after/before are EVENT-TIME bounds (§6) — ISO timestamps against the timestamp column,
    // never ids (an ISO string vs a uuid compares lexically into nonsense)
    assertEquals(
      (await log.read({ after: "2026-07-16T00:00:02Z", before: "2026-07-16T00:00:05Z" }))
        .map((e) => e.id),
      ["03", "04"],
    );
    assertEquals((await log.read({ limit: 2 })).map((e) => e.id), ["04", "05"]);
  });
});

Deno.test("concurrent cross-process publishes serialize (SQLite WAL + busy_timeout)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // two independent Log handles = two connections contending for the same db
    const w1 = await openLog(dir);
    const w2 = await openLog(dir);
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const id = String(i).padStart(2, "0");
      writes.push((i % 2 === 0 ? w1 : w2).publish(msg(id, "c1", id)));
    }
    await Promise.all(writes);

    const reader = await openLog(dir);
    const all = await reader.read();
    assertEquals(all.length, 20); // every row committed, none lost to contention
    assertEquals(new Set(all.map((e) => e.id)).size, 20);
    await Promise.all([w1.close(), w2.close(), reader.close()]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const keyed = (id: string, key: string, text = id): MessageEvent => {
  const e = msg(id, "c1", text);
  return { ...e, envelope: { ...e.envelope, external_id: key } };
};

Deno.test("subscribe's cursor is seeded synchronously: no publish falls in the arming gap", async () => {
  await withLog(async (log) => {
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e));
    // no await between subscribe and publish — the guarantee is that `subscribe()` RETURNING
    // is the cut, not whenever the watcher happens to arm (a lazy seed loses this one)
    await log.publish(msg("01", "c1", "immediately after"));
    try {
      const t0 = Date.now();
      while (got.length === 0 && Date.now() - t0 < 2000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assertEquals(got.map((e) => e.id), ["01"]);
    } finally {
      off();
    }
  });
});

Deno.test("publishAndRelease: the batch and the lease release commit together (§2)", async () => {
  await withLog(async (log) => {
    const lock = log.lock("turn-a1");
    assertEquals(await lock.acquire(), "acquired");
    const draft = (text: string) => {
      const { id: _, ...rest } = msg("00", "c1", text);
      return rest;
    };
    const stored = await log.publishAndRelease([draft("one"), draft("two")], lock.lease());
    assertEquals(stored.length, 2);
    assertEquals((await log.read()).map((e) => e.id), stored.map((e) => e.id)); // in order
    // the lease is gone in the SAME transaction: a wake fired by those inserts can never
    // find it still held — that was the stalled-cycle bug (§2)
    assertEquals(await lock.held(), false);
    await lock.release(); // the row is gone; this stops the holder's heartbeat
    const next = log.lock("turn-a1");
    assertEquals(await next.acquire(), "acquired"); // clean, not a steal
    await next.release();
  });
});

Deno.test("publishAndRelease is atomic: a bad draft leaves neither events nor a freed lease", async () => {
  await withLog(async (log) => {
    const lock = log.lock("turn-a1");
    await lock.acquire();
    const ok = { ...msg("01", "c1", "fine") } as Record<string, unknown>;
    delete ok.id;
    const bad = { ...ok, type: undefined }; // NOT NULL violation on `type`
    let threw = false;
    try {
      await log.publishAndRelease([ok, bad] as never, lock.lease());
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals((await log.read()).length, 0); // the first insert rolled back with it
    assertEquals(await lock.held(), true); // and the lease is still ours to release
    await lock.release();
  });
});

Deno.test("the store owns the id: a draft gets a UUIDv7, minted in append order (§3)", async () => {
  await withLog(async (log) => {
    const draft = (text: string) => {
      const { id: _, ...rest } = msg("00", "c1", text);
      return rest;
    };
    const a = (await log.publish(draft("first")))!;
    const b = (await log.publish(draft("second")))!;
    // v7: version nibble 7, variant 8‥b — the same shape Postgres's `DEFAULT uuidv7()` mints
    for (const e of [a, b]) {
      assertEquals(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.id),
        true,
      );
    }
    assertEquals(a.id < b.id, true); // lexical order = mint order = append order
    assertEquals((await log.read()).map((e) => e.id), [a.id, b.id]);
  });
});

Deno.test("a MERGE returns the surviving row's id, not the caller's", async () => {
  await withLog(async (log) => {
    const first = (await log.publish(keyed("01", "x1", "original")))!;
    const merged = (await log.publish(keyed("02", "x1", "edited")))!;
    assertEquals(merged.id, first.id); // "02" never became a row — the caller learns that
    assertEquals((await log.read()).length, 1);
  });
});

Deno.test("publish upserts on external_id: a known key MERGES (retry/edit), a new one inserts", async () => {
  await withLog(async (log) => {
    await log.publish(keyed("01", "x1", "original"));
    await log.publish(keyed("02", "x1", "edited")); // same key → merge into 01, no new row
    await log.publish(keyed("03", "x2")); // new key → kept
    await log.publish(msg("04", "c1", "no key")); // no key → always kept
    const all = await log.read();
    assertEquals(all.map((e) => e.id), ["01", "03", "04"]);
    // the merge applied: 01 now carries the edited parts (json_patch, open-bsp merge trigger)
    const first = all[0] as MessageEvent;
    assertEquals((first.parts[0] as { text: string }).text, "edited");
  });
});

Deno.test("echo-reconciliation: setDelivery backfills external_id; the loopback merges, no wake", async () => {
  await withLog(async (log) => {
    // 1. the agent's outbound send — no external_id yet
    await log.publish(msg("01", "gh:a/w#1", "on it"));
    // 2. dispatch posted it; backfill the platform id + dispatched_at
    await log.setDelivery("01", {
      external_id: "gh:555",
      status: { dispatched_at: "2026-07-24T00:00:00Z" },
    });
    // a subscriber armed BEFORE the echo — the loopback must not wake it
    const woken: Event[] = [];
    const off = log.subscribe((e) => woken.push(e));
    await new Promise((r) => setTimeout(r, 50));
    // 3. the webhook echoes our own comment back, carrying the same external_id
    await log.publish(keyed("02", "gh:555", "on it"));
    await new Promise((r) => setTimeout(r, 400));
    off();
    assertEquals(woken.length, 0); // merged into 01 — an UPDATE, not an insert
    const all = await log.read();
    assertEquals(all.map((e) => e.id), ["01"]); // still one row
    assertEquals(all[0].envelope.external_id, "gh:555");
  });
});

Deno.test("setDelivery sender: fills when empty, never overwrites — the echo's fact wins first (§4)", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "wa:x", "hola"));
    // the send response names our side — sender lands WITH dispatched_at
    await log.setDelivery("01", { sender: { address: "5491" } });
    assertEquals((await log.read())[0].envelope.sender, { address: "5491" });
    // a later stamp (the echo already merged a fuller fact) cannot overwrite the address —
    // but the name FILLS, first non-empty wins per field
    await log.setDelivery("01", { sender: { address: "other", name: "matias" } });
    assertEquals((await log.read())[0].envelope.sender, { address: "5491", name: "matias" });
  });
});

Deno.test("echo race: the echo arrives BEFORE the backfill — setDelivery absorbs it into one row", async () => {
  await withLog(async (log) => {
    // 1. the agent's outbound send — dispatch is posting, no external_id yet
    await log.publish(msg("01", "gh:a/w#1", "on it"));
    // 2. the webhook wins the race: our own comment echoes in FIRST (a new row — it wakes)
    await log.publish(keyed("02", "gh:555", "on it"));
    assertEquals((await log.read()).length, 2); // the race really happened
    // 3. the late backfill reconciles: absorb the echo row into ours, converge to ONE row
    await log.setDelivery("01", {
      external_id: "gh:555",
      status: { dispatched_at: "2026-07-24T00:00:00Z" },
    });
    const all = await log.read();
    assertEquals(all.map((e) => e.id), ["01"]); // the echo row is gone
    assertEquals(all[0].envelope.external_id, "gh:555");
    // the already-fired wake now finds a quiescent window — nothing owed, no self-reply (§2)
  });
});

/* ── subscribe ──────────────────────────────────────────────────────── */

Deno.test("subscribe delivers events published after subscribe (live)", async () => {
  await withLog(async (log) => {
    const pending = take(log, 2);
    await new Promise((r) => setTimeout(r, 50)); // let the watcher arm
    await log.publish(msg("01", "c1", "a"));
    await log.publish(msg("02", "c1", "b"));
    assertEquals((await pending).map((e) => e.id), ["01", "02"]);
  });
});

Deno.test("subscribe reads the db, not writer memory (cross-process path)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const writer = await openLog(dir);
    const consumer = await openLog(dir); // a *different* handle, as another process would
    const pending = take(consumer, 1);
    await new Promise((r) => setTimeout(r, 50));
    await writer.publish(msg("01", "c1", "x"));
    assertEquals((await pending).map((e) => e.id), ["01"]);
    await Promise.all([writer.close(), consumer.close()]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("subscribe filter narrows the stream", async () => {
  await withLog(async (log) => {
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e), {
      filter: (e) => e.envelope.conversation.address === "c2",
    });
    await new Promise((r) => setTimeout(r, 50));
    await log.publish(msg("01", "c1", "a"));
    await log.publish(msg("02", "c2", "b"));
    await new Promise((r) => setTimeout(r, 300));
    off();
    assertEquals(got.map((e) => e.id), ["02"]);
  });
});

Deno.test("subscribe `from` replays the backlog after a known id (id is the cursor)", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "c1", "a"));
    await log.publish(msg("02", "c1", "b"));
    await log.publish(msg("03", "c1", "c"));
    const got = await take(log, 2, "01"); // exclusive: expect 02, 03
    assertEquals(got.map((e) => e.id), ["02", "03"]);
  });
});

Deno.test("unsubscribe stops delivery and leaks no watcher", async () => {
  await withLog(async (log) => {
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 50));
    off();
    await log.publish(msg("01", "c1", "a"));
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(got.length, 0);
  });
});

Deno.test("conversation.kind round-trips (direct | group | channel — ingest-stamped, §3)", async () => {
  await withLog(async (log) => {
    const e = msg("01", "C123", "in a channel");
    e.envelope.conversation.kind = "channel";
    await log.publish(e);
    const [back] = await log.read();
    assertEquals(back.envelope.conversation.kind, "channel");
    const plain = (await log.publish(msg("02", "c2", "no kind")))!;
    assertEquals(plain.envelope.conversation.kind, undefined);
    const [, p] = await log.read();
    assertEquals(p.envelope.conversation.kind, undefined);
  });
});

Deno.test("the publish gate: only a registered, live connection may log (§4); local is exempt", async () => {
  await withLog(async (log) => {
    const slack = msg("01", "C1", "hola");
    slack.envelope.service = "slack";
    slack.envelope.connection_address = "T1:U7";

    // unregistered ⇒ refused before anything lands
    await assertRejects(() => log.publish(slack), Error, "connection not registered");
    assertEquals((await log.read()).length, 0);

    log.upsertConnections([{ service: "slack", address: "T1:U7", agentId: "matias" }]);
    await log.publish(slack); // the grant opens the log

    // a soft-deleted grant closes it again — and a re-grant reopens
    log.deleteConnections([{ service: "slack", address: "T1:U7" }]);
    const more = msg("02", "C1", "sigo acá");
    more.envelope.service = "slack";
    more.envelope.connection_address = "T1:U7";
    await assertRejects(() => log.publish(more), Error, "connection not registered");
    log.upsertConnections([{ service: "slack", address: "T1:U7" }]);
    await log.publish(more);

    await log.publish(msg("03", "mind@m", "local needs no grant")); // the exempt service
    assertEquals((await log.read()).length, 3);
  });
});

Deno.test("events.extra: wire sidecar round-trips and MERGES on the external-id upsert (§3)", async () => {
  await withLog(async (log) => {
    const e = msg("01", "C1", "hola");
    e.envelope.external_id = "x:1";
    e.extra = { slack: { subtype: "me_message" }, raw: "hola" };
    await log.publish(e);

    const edit = msg("01b", "C1", "hola (edited)");
    edit.envelope.external_id = "x:1";
    edit.extra = { slack: { authorizations: ["U7"] }, edited: true };
    await log.publish(edit); // same merge key ⇒ same row, extra json_patched

    const [back] = await log.read();
    assertEquals(back.extra, {
      slack: { subtype: "me_message", authorizations: ["U7"] },
      raw: "hola",
      edited: true,
    });
  });
});

Deno.test("read({silenced:false}) drops silenced rows — and spends the LIMIT on news", async () => {
  await withLog(async (log) => {
    // an import, a muted chat's message, an archived chat's — then the one live message
    for (let i = 0; i < 5; i++) {
      const e = msg(`h${i}`, "C1", `history ${i}`);
      e.extra = { backfill: true, whatsapp: { re: "x" } }; // beside the sidecar, not in it
      await log.publish(e);
    }
    const mutedRow = msg("m1", "C2", "muted noise");
    mutedRow.extra = { muted: true };
    await log.publish(mutedRow);
    const archivedRow = msg("a1", "C3", "archived noise");
    archivedRow.extra = { archived: true };
    await log.publish(archivedRow);
    await log.publish(msg("live", "C1", "the news"));

    const all = await log.read();
    assertEquals(all.length, 8); // search still sees everything — silenced rows are its point

    const news = await log.read({ silenced: false });
    assertEquals(news.map((e) => (e as MessageEvent).parts[0]), [{
      type: "text",
      kind: "text",
      text: "the news",
    }]);

    // the point of doing it in SQL: a window of 3 fills with 3 LIVE rows, not 3 dropped ones
    for (let i = 0; i < 3; i++) await log.publish(msg(`n${i}`, "C1", `news ${i}`));
    const window = await log.read({ silenced: false, limit: 3 });
    assertEquals(window.length, 3);
    assertEquals(
      window.every((e) => e.extra === undefined || e.extra.backfill === undefined),
      true,
    );
  });
});

Deno.test("identity FILLS, never overwrites (§3): first non-empty writer wins", async () => {
  await withLog(async (log) => {
    // the agent's send: authored, senderless (the account speaks through us)
    const sent = keyed("01", "x1", "hola");
    sent.agent = { id: "a1", session_id: "s1" };
    await log.publish(sent);
    // the platform echo: peer-shaped (sender = the account), same external id
    const echo = keyed("02", "x1", "hola");
    echo.envelope.sender = { address: "5491", name: "matias" };
    await log.publish(echo);
    const [row] = await log.read();
    assertEquals(row.agent?.id, "a1"); // authorship survives the echo — the Instagram lesson
    assertEquals(row.envelope.sender?.address, "5491"); // …and the blank got filled
  });
});

Deno.test("a PARTLESS draft is merge-only: no referent ⇒ NOTHING stored (§3)", async () => {
  await withLog(async (log) => {
    const stamp = (key: string): Draft => ({
      ts: "2026-08-17T00:00:00Z",
      type: "message",
      envelope: {
        service: "local",
        connection_address: "org",
        conversation: { address: "" },
        external_id: key,
      },
      status: { deleted_at: "2026-08-17T00:00:00Z" },
    } as unknown as Draft);
    // the referent doesn't exist: nothing lands — no message-shaped ghost
    assertEquals(await log.publish(stamp("x9")), null);
    assertEquals((await log.read()).length, 0);
    // the referent exists: the stamp merges into it
    await log.publish(keyed("01", "x9", "original"));
    const merged = await log.publish(stamp("x9"));
    assertEquals(merged !== null, true);
    const [row] = await log.read();
    assertEquals((await log.read()).length, 1);
    assertEquals(row.status?.deleted_at, "2026-08-17T00:00:00Z");
    assertEquals((row as MessageEvent).parts.length, 1); // the content survived the stamp
  });
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
      connection_address: "agent",
      conversation: { address: "mind@ana" },
    },
    parts: [{ type: "text", kind: "text", text: "dale" }],
  } as Draft<MessageEvent>);
  await first.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(`${dir}/log.db`);
  db.exec(
    `UPDATE events SET session_id = 'ana', conversation_address = 'mind:ana';
     UPDATE memberships SET conversation_address = 'mind:ana';
     PRAGMA user_version = 5;`,
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

/* ── the read path's cost ───────────────────────────────────────────────── */

Deno.test("read: a filter with a limit stops at the limit — the table is not walked", async () => {
  await withLog(async (log) => {
    for (let i = 1; i <= 40; i++) {
      await log.publish(msg(String(i).padStart(2, "0"), "c1", `m${i}`));
    }
    let seen = 0;
    const out = await log.read({
      limit: 5,
      filter: () => {
        seen++;
        return true;
      },
    });
    assertEquals(out.length, 5);
    assertEquals(seen, 5);
    // and the window is the most recent five, in append order
    assertEquals(out.map((e) => e.parts[0].type === "text" && e.parts[0].text), [
      "m36",
      "m37",
      "m38",
      "m39",
      "m40",
    ]);
  });
});

Deno.test("events are indexed by timestamp — a time-bounded read does not scan", async () => {
  await withLog(async (_log, dir) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(`${dir}/log.db`, { readOnly: true });
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
    ).all() as { name: string }[]).map((r) => r.name);
    db.close();
    assertEquals(names.includes("events_timestamp"), true);
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

Deno.test("read: externalId is an exact match on the wire id", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  try {
    log.upsertConnections([{ service: "slack", address: "T1" }]);
    const draft = (ext: string) => ({
      ts: new Date().toISOString(),
      type: "message" as const,
      envelope: {
        service: "slack" as const,
        connection_address: "T1",
        conversation: { address: "C1" },
        external_id: ext,
      },
      parts: [{ type: "text" as const, kind: "text" as const, text: ext }],
    });
    await log.publish(draft("slack:T1:C1:1.0"));
    await log.publish(draft("slack:T1:C1:1.01"));
    const rows = await log.read({ externalId: "slack:T1:C1:1.0" });
    assertEquals(rows.map((r) => r.envelope.external_id), ["slack:T1:C1:1.0"]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

/* ── the update stream ──────────────────────────────────────────────── */

Deno.test("subscribe({updates}) delivers a row as its lifecycle moves; the plain stream never sees a move", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "mind@m", "on it"));
    const moves: Event[] = [];
    const appends: Event[] = [];
    const offMoves = log.subscribe((e) => moves.push(e), { updates: true });
    const offAppends = log.subscribe((e) => appends.push(e));
    await new Promise((r) => setTimeout(r, 50));
    await log.setDelivery("01", {
      status: { state: "dispatched", dispatched_at: "2026-07-24T00:00:00Z" },
    });
    await new Promise((r) => setTimeout(r, 400));
    offMoves();
    offAppends();
    assertEquals(moves.map((e) => [e.id, e.envelope.status]), [["01", "dispatched"]]);
    assertEquals(moves[0].status?.dispatched_at, "2026-07-24T00:00:00Z");
    assertEquals(appends.length, 0);
  });
});

Deno.test("an append reaches an updates subscriber ONCE — a fresh row is the append stream's alone", async () => {
  await withLog(async (log) => {
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e), { updates: true });
    await log.publish(msg("01", "mind@m", "hola"));
    await new Promise((r) => setTimeout(r, 400));
    off();
    assertEquals(got.map((e) => e.id), ["01"]);
  });
});

Deno.test("the update stream starts live whatever `from` says: a move before subscribing is not replayed", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "mind@m", "hola"));
    await log.setDelivery("01", { status: { state: "dispatched", dispatched_at: "x" } });
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e), { updates: true, from: "" });
    await new Promise((r) => setTimeout(r, 400));
    off();
    assertEquals(got.map((e) => e.id), ["01"]); // the backlog replay — the move itself, not again
  });
});

Deno.test("the filter sees the row as it stands after the move", async () => {
  await withLog(async (log) => {
    await log.publish(msg("01", "mind@m", "hola"));
    const got: Event[] = [];
    const off = log.subscribe((e) => got.push(e), {
      updates: true,
      filter: (e) => e.envelope.status === "queued",
    });
    await new Promise((r) => setTimeout(r, 50));
    await log.setDelivery("01", { status: { state: "dispatched", dispatched_at: "x" } });
    await new Promise((r) => setTimeout(r, 10)); // two moves, two moments
    await log.setDelivery("01", { status: { state: "queued", queued_at: "y" } });
    await new Promise((r) => setTimeout(r, 400));
    off();
    assertEquals(got.map((e) => e.envelope.status), ["queued"]);
  });
});

Deno.test("an agent's message bound for a wire is born queued; the mind's local traffic and the world's rows are not", async () => {
  await withLog(async (log) => {
    log.upsertConnections([{ service: "slack", address: "T1", agentId: "ana" }]);
    const wire = (over: Partial<MessageEvent>): Draft<MessageEvent> => ({
      ts: "2026-07-16T00:00:00Z",
      type: "message",
      envelope: { service: "slack", connection_address: "T1", conversation: { address: "C1" } },
      parts: [{ type: "text", kind: "text", text: "hola" }],
      ...over,
    });
    const ours = (await log.publish(wire({ agent: { id: "ana", session_id: "mind" } })))!;
    assertEquals(ours.envelope.status, "queued"); // the caller's copy says so too
    assertEquals(typeof ours.status?.queued_at, "string");
    const theirs = (await log.publish(
      wire({ envelope: { ...wire({}).envelope, external_id: "slack:T1:C1:1.0" } }),
    ))!;
    const local = (await log.publish({
      ...msg("07", "conv", "thinking aloud"),
      agent: { id: "ana", session_id: "mind" },
    }))!;
    const rows = await log.read();
    const state = (id: string) => rows.find((e) => e.id === id)!.envelope.status;
    assertEquals(state(ours.id), "queued");
    assertEquals(state(theirs.id), undefined);
    assertEquals(state(local.id), undefined);
    // the opening read a dispatcher makes: its service's standing offers, nothing else
    const standing = await log.read({ service: "slack", types: ["message"], state: "queued" });
    assertEquals(standing.map((e) => e.id), [ours.id]);
  });
});
