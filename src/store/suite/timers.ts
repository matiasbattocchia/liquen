/**
 * timers: the scheduler's rows (§10) — the one non-log fact about the future. Armed by the
 * `schedule` tool, scanned by the clock, consumed on firing: one-shot rows vanish, cron rows
 * advance PAST NOW so an outage costs one late fire, never a burst of catch-up ones.
 */

import { assert, assertEquals } from "@std/assert";
import { CLAIM_LEASE_MS, type TimerRow } from "../timers.ts";
import type { Substrate } from "./mod.ts";

export function timersSuite(s: Substrate): void {
  const wake = (over: Partial<TimerRow> = {}): Omit<TimerRow, "id" | "armedAt"> => ({
    agentId: "ana",
    sessionId: "mind", // the row is the SESSION's — keyed by the (agent, session) pair (§4)
    fireAt: "2026-09-01T17:00:00.000Z",
    note: "call the clinic",
    conversation: "mind@ana",
    ...over,
  });

  Deno.test("timers: a one-shot fires once and is gone", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const t = await log.arm(wake());
      assert(t.id.length > 0, "the row is armed with an id — cancel's handle");
      assertEquals(await log.due("2026-09-01T16:59:00.000Z"), []); // not yet
      assertEquals((await log.due("2026-09-01T17:00:00.000Z")).map((r) => r.id), [t.id]); // due AT the moment
      await log.settle(t.id, "2026-09-01T17:00:00.000Z");
      assertEquals(await log.due("2026-09-02T00:00:00.000Z"), []); // consumed
      assertEquals(await log.timers("ana", "mind"), []);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("timers: a cron advances past NOW — a week down fires once, not 168 times", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const t = await log.arm(wake({ cron: "0 9 * * *", fireAt: "2026-09-01T09:00:00.000Z" }));
      // the org was down for a week; the clock's first pass fires it ONCE
      const now = "2026-09-08T11:30:00.000Z";
      assertEquals((await log.due(now)).map((r) => r.id), [t.id]);
      await log.settle(t.id, now);
      const [after] = await log.timers("ana", "mind");
      assertEquals(after.fireAt, "2026-09-09T09:00:00.000Z"); // the next 09:00 after now
      assertEquals(after.cron, "0 9 * * *"); // still armed — a cron is forever
      assertEquals(await log.due(now), []); // and not due again in the same pass
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("timers: a cron advances on the clock it was armed against, not UTC", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      // "0 9" said in Madrid means 9 on Madrid's wall EVERY fire — an advance that fell back
      // to UTC would silently shift the second fire to 10:00 or 11:00 local
      const t = await log.arm(wake({ cron: "0 9 * * *", fireAt: "2026-09-08T07:00:00.000Z" }));
      await log.settle(t.id, "2026-09-08T11:30:00.000Z", "Europe/Madrid");
      const [after] = await log.timers("ana", "mind");
      assertEquals(after.fireAt, "2026-09-09T07:00:00.000Z"); // 09:00 CEST, not 09:00Z
    } finally {
      await log.close();
      await store.drop();
    }
  });

  /** Two clocks on one table — two processes' handles on the same store, so the claim is
   *  decided by the engine and not by JS ordering. */
  async function twoClocks() {
    const store = await s.fresh();
    const a = await store.open(), b = await store.open();
    const down = async () => {
      await a.close();
      await b.close();
      await store.drop();
    };
    return { a, b, down };
  }

  Deno.test("timers: a due row is claimed by exactly one of two clocks", async () => {
    const { a, b, down } = await twoClocks();
    try {
      const now = "2026-09-01T17:00:00.000Z";
      const t = await a.arm(wake());
      // both scans see it due — the scan is a read, never a claim
      assertEquals((await a.due(now)).map((r) => r.id), [t.id]);
      assertEquals((await b.due(now)).map((r) => r.id), [t.id]);
      const won = await a.claim(t.id, now);
      assertEquals(won?.id, t.id);
      assertEquals(won?.note, "call the clinic"); // the winner gets the row to fire
      assertEquals(await b.claim(t.id, now), null); // the loser gets nothing to publish
      assertEquals(await b.due(now), []); // and a re-scan no longer lists it
      await a.settle(t.id, now);
      assertEquals(await a.timers("ana", "mind"), []); // one-shot: consumed once, by the winner
    } finally {
      await down();
    }
  });

  Deno.test("timers: a cron claimed by one clock advances once, not once per clock", async () => {
    const { a, b, down } = await twoClocks();
    try {
      const now = "2026-09-08T11:30:00.000Z";
      const t = await a.arm(wake({ cron: "0 9 * * *", fireAt: "2026-09-08T09:00:00.000Z" }));
      assert(await a.claim(t.id, now));
      assertEquals(await b.claim(t.id, now), null);
      await a.settle(t.id, now);
      const [after] = await b.timers("ana", "mind");
      assertEquals(after.fireAt, "2026-09-09T09:00:00.000Z"); // the next 09:00 after now
      assertEquals(after.cron, "0 9 * * *");
      assertEquals(await b.claim(t.id, now), null); // settled past now — nothing to win
    } finally {
      await down();
    }
  });

  Deno.test("timers: a claim never settled comes due again at the lease horizon", async () => {
    const { a, down } = await twoClocks();
    try {
      const now = "2026-09-01T17:00:00.000Z";
      const t = await a.arm(wake());
      assert(await a.claim(t.id, now)); // the claimer dies before it publishes
      const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
      assertEquals(await a.due(at(CLAIM_LEASE_MS - 1)), []); // parked for the lease
      assertEquals((await a.due(at(CLAIM_LEASE_MS))).map((r) => r.id), [t.id]); // then due again
      assert(await a.claim(t.id, at(CLAIM_LEASE_MS))); // and claimable by whoever is alive
    } finally {
      await down();
    }
  });

  Deno.test("timers: rows outlive the process — recovery is just reading them", async () => {
    const store = await s.fresh();
    const log = await store.open();
    const t = await log.arm(wake({ refId: "use-1", cron: "*/5 * * * *" }));
    await log.close();
    const reopened = await store.open();
    try {
      const [row] = await reopened.timers("ana", "mind");
      assertEquals(row, {
        id: t.id,
        agentId: "ana",
        sessionId: "mind",
        fireAt: "2026-09-01T17:00:00.000Z",
        cron: "*/5 * * * *",
        note: "call the clinic",
        conversation: "mind@ana",
        refId: "use-1",
        armedAt: t.armedAt, // stamped at arm — the other half of an alarm's provenance
      });
    } finally {
      await reopened.close();
      await store.drop();
    }
  });

  Deno.test("timers: a wake is the session's — disarm is theirs alone, and the list is next-first", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const late = await log.arm(wake({ fireAt: "2026-09-03T10:00:00.000Z", note: "later" }));
      const soon = await log.arm(wake({ fireAt: "2026-09-02T10:00:00.000Z", note: "sooner" }));
      // bo's session shares ana's bare name — the PAIR is what keeps them apart (§4)
      const theirs = await log.arm(wake({ agentId: "bo", note: "bo's" }));
      assertEquals((await log.timers("ana", "mind")).map((r) => r.note), ["sooner", "later"]);
      assertEquals(await log.disarm(theirs.id, "ana", "mind"), false); // not ana's to unset (§6)
      assertEquals((await log.timers("bo", "mind")).length, 1);
      assertEquals(await log.disarm(soon.id, "ana", "mind"), true);
      assertEquals((await log.timers("ana", "mind")).map((r) => r.id), [late.id]);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("timers: a named wake is the operator's handle — arming it again replaces the row", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const first = await log.arm(wake({ name: "sonar-digest", cron: "*/15 8-21 * * 1-5" }));
      const second = await log.arm(
        wake({ name: "sonar-digest", note: "pull the digest", fireAt: "2026-09-02T11:00:00.000Z" }),
      );
      const held = await log.timers("ana", "mind");
      assertEquals(held.map((t) => t.id), [second.id]); // one row, not two
      assertEquals(held[0].name, "sonar-digest");
      assertEquals(held[0].note, "pull the digest");
      assertEquals(held[0].cron, undefined); // the new row IS the wake, not a patch of the old
      assert(first.id !== second.id);
      // the name is per (agent, session): another agent's handle of the same name is its own
      const bo = await log.arm(
        wake({ agentId: "bo", conversation: "mind@bo", name: "sonar-digest" }),
      );
      assertEquals((await log.timers("bo", "mind")).map((t) => t.id), [bo.id]);
      assertEquals((await log.timers("ana", "mind")).map((t) => t.id), [second.id]);
      // an unnamed wake collides with nothing, however many are armed
      await log.arm(wake());
      await log.arm(wake());
      assertEquals((await log.timers("ana", "mind")).length, 3);
    } finally {
      await log.close();
      await store.drop();
    }
  });

  Deno.test("armed(): every session's wakes, next first", async () => {
    const store = await s.fresh();
    const log = await store.open();
    try {
      const late = await log.arm(wake({ fireAt: "2026-09-02T09:00:00.000Z" }));
      const soon = await log.arm(
        wake({ agentId: "bo", conversation: "mind@bo", fireAt: "2026-09-01T09:00:00.000Z" }),
      );
      const mid = await log.arm(wake({ sessionId: "ops", conversation: "ops@ana" }));
      assertEquals((await log.armed()).map((t) => t.id), [soon.id, mid.id, late.id]);
    } finally {
      await log.close();
      await store.drop();
    }
  });
}
