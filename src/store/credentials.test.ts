import { assertEquals } from "@std/assert";
import { openCredentials } from "./credentials.ts";

/** An OAuth state is one-shot and short-lived: consumed once, and only within its TTL.
 *  The TTL is compared against the store's clock (§9), so the test ages it by moving the
 *  clock — never by waiting the ten minutes out. */
Deno.test("an OAuth state is consumed once, and not at all past its TTL", async () => {
  const dir = await Deno.makeTempDir();
  let skew = 0;
  const creds = await openCredentials(dir, { now: () => Date.now() + skew });
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
    await Deno.remove(dir, { recursive: true });
  }
});
