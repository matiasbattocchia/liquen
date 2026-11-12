import { assertEquals, assertThrows } from "@std/assert";
import { bounded, boundsSaid, isBounded } from "./bounds.ts";

const SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string" },
    limit: { type: "integer", default: 5, minimum: 1, maximum: 20 },
    wait: { type: "number", default: 120, minimum: 0, maximum: 600 },
    offset: { type: "integer", default: 1, minimum: 1 },
    text: { type: "array", items: { type: "string" }, maxItems: 3 },
    cards: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: { phones: { type: "array", items: { type: "string" }, maxItems: 1 } },
        required: ["phones"],
      },
    },
    lat: { type: "number" },
  },
};

Deno.test("bounded: an absent parameter takes its default, a given one stands", () => {
  assertEquals(bounded(SCHEMA, { q: "x" }), { q: "x", limit: 5, wait: 120, offset: 1 });
  assertEquals(bounded(SCHEMA, { limit: 20, wait: 0.5 }).limit, 20);
  assertEquals(bounded(undefined, { a: 1 }), { a: 1 }); // a tool with no schema holds nothing
});

Deno.test("bounded: a count out of its range, or not of its kind, is refused with the range", () => {
  assertThrows(() => bounded(SCHEMA, { limit: 40 }), Error, "limit is an integer, 1–20: got 40");
  assertThrows(() => bounded(SCHEMA, { limit: 2.5 }), Error, "got 2.5");
  assertThrows(() => bounded(SCHEMA, { limit: "10" }), Error, 'got "10"');
  assertThrows(() => bounded(SCHEMA, { wait: 601 }), Error, "wait is a number, 0–600");
  assertThrows(() => bounded(SCHEMA, { offset: 0 }), Error, "offset is an integer, 1 or more");
  // a number its schema bounds nowhere is the handler's to read
  assertEquals(bounded(SCHEMA, { lat: "-34.6" }).lat, "-34.6");
});

Deno.test("bounded: a list past its length is refused, its items held the same way", () => {
  assertThrows(
    () => bounded(SCHEMA, { text: ["a", "b", "c", "d"] }),
    Error,
    "text holds up to 3: got 4",
  );
  assertThrows(
    () => bounded(SCHEMA, { cards: [{ phones: ["1"] }, { phones: ["1", "2"] }] }),
    Error,
    "cards[1].phones holds up to 1: got 2",
  );
  assertEquals(bounded(SCHEMA, { text: ["a"] }).text, ["a"]);
});

Deno.test("boundsSaid: optional unless required, then the default, then the range", () => {
  const p = SCHEMA.properties;
  assertEquals(boundsSaid(p.limit, false), "optional; default 5; 1–20");
  assertEquals(boundsSaid(p.offset, false), "optional; default 1; 1 or more");
  assertEquals(boundsSaid(p.text, false), "optional; up to 3");
  assertEquals(boundsSaid(p.cards.items.properties.phones, true), "up to 1");
  assertEquals(isBounded(p.q), false);
  assertEquals(isBounded(p.lat), false);
});
