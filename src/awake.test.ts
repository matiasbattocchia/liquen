import { assertEquals } from "@std/assert";
import { awake, SLEPT_MS } from "./awake.ts";

Deno.test("awake: a wall clock that ran ahead of the monotonic one is a wake; a busy loop is not", () => {
  let wall = 1_000_000;
  let mono = 0;
  const watch = awake(() => wall, () => mono);
  assertEquals(watch.since(), 1_000_000);

  // a minute held busy: both clocks move together
  wall += 60_000;
  mono += 60_000;
  assertEquals(watch.since(), 1_000_000);

  // half an hour asleep, then five seconds awake: the read finds the wake at once
  wall += 30 * 60_000 + 5_000;
  mono += 5_000;
  assertEquals(watch.since(), wall);
  const woke = wall;

  // a drift under the bound is a clock's, not a sleep
  wall += 60_000 + SLEPT_MS - 1;
  mono += 60_000;
  assertEquals(watch.since(), woke);
});

Deno.test("awake: a look stamps a wake that no read has asked about yet", () => {
  let wall = 0;
  let mono = 0;
  const watch = awake(() => wall, () => mono);
  wall += 600_000;
  watch.look();
  const woke = wall;
  wall += 30_000;
  mono += 30_000;
  assertEquals(watch.since(), woke);
});
