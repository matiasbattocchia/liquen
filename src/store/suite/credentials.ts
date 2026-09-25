import { assertEquals } from "@std/assert";
import type { Substrate } from "./mod.ts";

export function credentialsSuite(s: Substrate): void {
  /** An OAuth state is one-shot and short-lived: consumed once, and only within its TTL.
   *  The TTL is compared against the store's clock (§9), so the test ages it by moving the
   *  clock — never by waiting the ten minutes out. */
  Deno.test("an OAuth state is consumed once, and not at all past its TTL", async () => {
    const store = await s.fresh();
    let skew = 0;
    const creds = await store.vault({ now: () => Date.now() + skew });
    try {
      const fresh = await creds.mintState("slack", { agentId: "ana" });
      assertEquals(await creds.consumeState("google", fresh), null); // another service's door
      assertEquals(await creds.consumeState("slack", fresh), { agentId: "ana" });
      assertEquals(await creds.consumeState("slack", fresh), null); // spent

      const aged = await creds.mintState("slack");
      skew = 10 * 60_000 + 1; // a TTL and a millisecond later…
      assertEquals(await creds.consumeState("slack", aged), null); // …the door is closed
    } finally {
      await creds.close();
      await store.drop();
    }
  });

  /** The merge is FIELD-WISE: a top-level field lands whole, replacing what was under it —
   *  a door that rewrites a map (the calendar's cursors) drops a key by leaving it out. */
  Deno.test("put merges by top-level field: a nested object is replaced whole, not merged", async () => {
    const store = await s.fresh();
    const creds = await store.vault();
    try {
      await creds.put({
        key: "google:ana",
        value: { refresh_token: "r1" },
        extra: { expiry: "t1", calendar_sync: { primary: "tok1", team: "tok2" } },
      });
      await creds.put({ key: "google:ana", value: {}, extra: { calendar_sync: { team: "tok3" } } });
      await creds.put({
        key: "google:ana",
        value: { access_token: "a1" },
        extra: { expiry: "t2" },
      });
      assertEquals(await creds.get("google:ana"), {
        key: "google:ana",
        value: { refresh_token: "r1", access_token: "a1" },
        extra: { expiry: "t2", calendar_sync: { team: "tok3" } },
      });
    } finally {
      await creds.close();
      await store.drop();
    }
  });
}
