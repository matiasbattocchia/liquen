import { assertEquals } from "@std/assert";
import { createBios, floodSeconds, FRESH_MS, QUEUE } from "./bio.ts";
import { DispatchError } from "../errors.ts";

/** A clock the test moves, and a sleep that moves it. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

Deno.test("telegram bio: a person is read once and remembered, an empty about included", async () => {
  const c = clock();
  const asked: string[] = [];
  const bios = createBios({
    about: (u) => {
      asked.push(u);
      return Promise.resolve(u === "1" ? "  Arquitecta  " : "");
    },
    now: c.now,
    sleep: c.sleep,
  });
  assertEquals(await bios.of("1", 5_000), "Arquitecta");
  assertEquals(await bios.of("1"), "Arquitecta");
  assertEquals(await bios.of("2", 5_000), "");
  assertEquals(await bios.of("2"), "");
  assertEquals(asked, ["1", "2"]);
});

Deno.test("telegram bio: reads go out one at a time, the gap apart, and a week ends the memory", async () => {
  const c = clock();
  const asked: string[] = [];
  const bios = createBios({
    about: (u) => {
      asked.push(u);
      return Promise.resolve("x");
    },
    now: c.now,
    sleep: c.sleep,
    gapMs: 3_000,
  });
  await Promise.all([bios.of("1", 60_000), bios.of("2", 60_000), bios.of("3", 60_000)]);
  assertEquals(asked, ["1", "2", "3"]);
  assertEquals(c.slept, [3_000, 3_000]);
  c.advance(FRESH_MS + 1);
  await bios.of("1", 60_000);
  assertEquals(asked, ["1", "2", "3", "1"]);
});

Deno.test("telegram bio: nobody waits longer than they said, and the read goes on", async () => {
  let release: (about: string) => void = () => {};
  const bios = createBios({
    about: () => new Promise<string>((r) => (release = r)),
    gapMs: 0,
  });
  assertEquals(await bios.of("1"), undefined); // asked, not waited for
  assertEquals(await bios.of("1", 10), undefined); // waited ten ms, still unread
  release("al fin");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(await bios.of("1"), "al fin");
});

Deno.test("telegram bio: a flood wait holds every read until it is out", async () => {
  const c = clock();
  let calls = 0;
  const failed: string[] = [];
  const bios = createBios({
    about: () => {
      if (++calls === 1) return Promise.reject(new DispatchError("FLOOD_WAIT_17", 429));
      return Promise.resolve("ok");
    },
    now: c.now,
    sleep: c.sleep,
    gapMs: 0,
    onError: (u) => failed.push(u),
  });
  assertEquals(await bios.of("1", 60_000), undefined);
  assertEquals(c.slept, [17_000]);
  assertEquals(failed, ["1"]);
  // not remembered: asked again, and read
  assertEquals(await bios.of("1", 60_000), "ok");
  assertEquals(floodSeconds(new Error("FLOOD_PREMIUM_WAIT_5")), 5);
  assertEquals(floodSeconds(new Error("PEER_ID_INVALID")), undefined);
});

Deno.test("telegram bio: a full queue turns the next one away, and a stop reads no more", async () => {
  const asked: string[] = [];
  const bios = createBios({
    about: (u) => {
      asked.push(u);
      return new Promise<string>(() => {});
    },
    gapMs: 0,
  });
  for (let i = 0; i < QUEUE; i++) void bios.of(String(i));
  assertEquals(await bios.of("late", 5), undefined);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(asked, ["0"]); // the first read holds the line; "late" never joined it

  const quiet = createBios({ about: () => Promise.resolve("x"), gapMs: 0 });
  quiet.stop();
  assertEquals(await quiet.of("1", 20), undefined);
});
