import { assert, assertEquals, assertMatch } from "@std/assert";
import { createIdGen, newId, timeOf } from "./id.ts";

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("ids are canonical UUIDv7 (version 7, variant 10)", () => {
  for (let i = 0; i < 100; i++) assertMatch(newId(), UUIDV7);
});

Deno.test("ids are strictly increasing under a normal clock", () => {
  let t = 1_000_000;
  const gen = createIdGen(() => (t += 1));
  let prev = "";
  for (let i = 0; i < 1000; i++) {
    const id = gen();
    assert(id > prev, `expected ${id} > ${prev}`);
    prev = id;
  }
});

Deno.test("monotonic within a single millisecond (frozen clock → counter advances)", () => {
  const gen = createIdGen(() => 1_700_000_000_000); // never changes
  let prev = "";
  for (let i = 0; i < 3000; i++) {
    const id = gen();
    assert(id > prev, `frozen-clock id ${i} not increasing: ${id} <= ${prev}`);
    prev = id;
  }
});

Deno.test("a backwards clock cannot regress ids (high-water timestamp)", () => {
  let t = 5_000_000;
  const gen = createIdGen(() => (t -= 1)); // clock runs backwards every call
  let prev = "";
  for (let i = 0; i < 1000; i++) {
    const id = gen();
    assert(id > prev, `backwards-clock id ${i} regressed: ${id} <= ${prev}`);
    prev = id;
  }
});

Deno.test("lexical sort order equals generation order", () => {
  let t = 2_000_000;
  const gen = createIdGen(() => (t += 7));
  const ids = Array.from({ length: 500 }, () => gen());
  const sorted = [...ids].sort();
  assertEquals(sorted, ids);
});

Deno.test("timeOf recovers the millisecond the id encodes", () => {
  const ms = 1_700_123_456_789;
  const gen = createIdGen(() => ms);
  assertEquals(timeOf(gen()), ms);
});

Deno.test("ids are unique across a large batch", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) seen.add(newId());
  assertEquals(seen.size, 10_000);
});
