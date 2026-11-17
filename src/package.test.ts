import { assertEquals, assertMatch } from "@std/assert";
import { checkoutCommit, running } from "./package.ts";

Deno.test("what runs: a checkout names its commit, and the registry's module none", async () => {
  assertMatch((await checkoutCommit(import.meta.url))!, /^[0-9a-f]{7,}$/);
  assertEquals(await checkoutCommit("https://jsr.io/@liquen/liquen/0.1.0/src/start.ts"), undefined);
  assertMatch(await running(), /^liquen \S+ at [0-9a-f]{7,}$/);
});
