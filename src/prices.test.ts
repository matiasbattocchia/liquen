import { assertEquals } from "@std/assert";
import { costOf, costOfAll, dollars, type Price, priceFor, PRICES } from "./prices.ts";
import type { UsageRow } from "./store/log.ts";

const call = (over: Partial<UsageRow> = {}): UsageRow => ({
  created_at: "2026-10-19T09:00:00Z",
  model: "m",
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  ...over,
});

const own: Price[] = [
  { model: "m", valid_since: "2026-01-01", input: 1, output: 2, cache_read: 0.1 },
  { model: "m", valid_since: "2026-10-19", input: 3, output: 4, cache_read: 0.3 },
];

Deno.test("a call is priced at the row in effect on its day", () => {
  assertEquals(priceFor("m", "2026-10-18T23:59:59Z", own)?.input, 1);
  assertEquals(priceFor("m", "2026-10-19T00:00:00Z", own)?.input, 3);
  assertEquals(priceFor("m", "2025-12-31T23:00:00Z", own), undefined);
  assertEquals(costOf(call({ created_at: "2026-06-01T00:00:00Z" }), own), 3);
  assertEquals(costOf(call(), own), 7);
});

Deno.test("an org row in effect wins over the package's; the package fills the rest", () => {
  const model = PRICES[0].model;
  const mine: Price = { model, valid_since: "2026-10-01", input: 0, output: 0, cache_read: 0 };
  assertEquals(priceFor(model, "2026-10-19T00:00:00Z", [mine]), mine);
  assertEquals(
    priceFor(model, "2026-09-30T00:00:00Z", [mine]),
    priceFor(model, "2026-09-30T00:00:00Z"),
  );
});

Deno.test("cache reads and writes are priced at their own rates, or leave the call unpriced", () => {
  assertEquals(
    costOf(call({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 }), own),
    0.3,
  );
  // a cache write the row gives no rate for: nobody can say what it cost
  assertEquals(costOf(call({ cache_write_tokens: 10 }), own), undefined);
  assertEquals(costOf(call({ model: "unknown" }), own), undefined);
});

Deno.test("a tier applies above its context, counting what the cache served", () => {
  const tiered: Price[] = [{
    model: "t",
    valid_since: "2026-01-01",
    input: 1,
    output: 1,
    cache_read: 1,
    tiers: [{ above_context: 100, input: 10, output: 10, cache_read: 10 }],
  }];
  const at = (input: number, cache: number) =>
    costOf(
      call({ model: "t", input_tokens: input, output_tokens: 0, cache_read_tokens: cache }),
      tiered,
    );
  assertEquals(at(100, 0), 100 / 1_000_000);
  assertEquals(at(50, 51), 1010 / 1_000_000);
});

Deno.test("a total says how many calls it could not price", () => {
  const rows = [call(), call({ model: "unknown" }), call({ created_at: "2026-02-01T00:00:00Z" })];
  const c = costOfAll(rows, own);
  assertEquals(c, { usd: 10, calls: 3, unpriced: 1 });
  assertEquals(dollars(c), "≥ $10.00 (1 unpriced)");
  assertEquals(dollars({ usd: 0, calls: 2, unpriced: 2 }), "$?");
  assertEquals(dollars({ usd: 0.004, calls: 1, unpriced: 0 }), "$0.0040");
});

Deno.test("the package's rows are themselves well-formed", async () => {
  const { checkPrices } = await import("./prices.ts");
  assertEquals(checkPrices(PRICES), null);
});
