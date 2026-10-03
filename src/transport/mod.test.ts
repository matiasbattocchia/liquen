import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { checkProvider, GOOGLE, type ModelTransport, providerOf, silenced } from "./mod.ts";
import { retryable } from "../nu.ts";
import type { Delta } from "../types.ts";

const REQUEST = {
  model: "m",
  max_tokens: 100,
  messages: [{ role: "user" as const, content: "hi" }],
};
const DONE = { stop_reason: "end_turn" } as Anthropic.Message;

/** A transport that emits `deltas` text deltas `everyMs` apart, then answers — or, aborted,
 *  rejects the way an SDK does when its fetch is cut. */
const working = (deltas: number, everyMs: number): ModelTransport => (_p, emit, _m, signal) =>
  new Promise((resolve, reject) => {
    let i = 0;
    const tick = setInterval(() => {
      if (i++ < deltas) return emit?.({ kind: "text", text: `${i}` });
      clearInterval(tick);
      resolve(DONE);
    }, everyMs);
    signal?.addEventListener("abort", () => {
      clearInterval(tick);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

Deno.test("silenced: a call gone silent is cut, and fails as a dropped connection nu retries", async () => {
  const began = Date.now();
  const err = await assertRejects(
    () => silenced(working(1, 5_000), { silenceMs: 200 })(REQUEST),
    Error,
    "no word from the model in 0.2s",
  );
  assert(Date.now() - began < 2_000, "the deadline cut the wait");
  const status = (err as { status?: number }).status;
  assertEquals(status, undefined);
  assert(retryable(status, (err as Error).message));
});

Deno.test("silenced: deltas inside the deadline keep a long call alive, and reach the Stream", async () => {
  // 900ms of work, a delta every 100ms, under a 300ms deadline
  const seen: Delta[] = [];
  const message = await silenced(working(8, 100), { silenceMs: 300 })(REQUEST, (d) => seen.push(d));
  assertEquals(message, DONE);
  assertEquals(seen.length, 8);
});

Deno.test("silenced: the turn's interrupt is not taken for silence", async () => {
  const turn = new AbortController();
  setTimeout(() => turn.abort(), 50);
  const err = await assertRejects(
    () => silenced(working(1, 5_000), { silenceMs: 5_000 })(REQUEST, undefined, {}, turn.signal),
  );
  assertEquals((err as Error).name, "AbortError");
});

/** A transport that emits a delta at each of `at` (ms from the call), then answers `doneAt`
 *  — or, aborted, rejects as `working` does. */
const scripted = (at: number[], doneAt: number): ModelTransport => (_p, emit, _m, signal) =>
  new Promise((resolve, reject) => {
    const timers = at.map((ms) => setTimeout(() => emit?.({ kind: "text", text: `${ms}` }), ms));
    timers.push(setTimeout(() => resolve(DONE), doneAt));
    signal?.addEventListener("abort", () => {
      timers.forEach(clearTimeout);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

/** A wall clock that jumps `by` ms at `atMs` from now: what a sleep looks like from awake. */
const sleeping = (by: number, atMs: number) => {
  let ahead = 0;
  const jump = setTimeout(() => ahead = by, atMs);
  return { now: () => Date.now() + ahead, done: () => clearTimeout(jump) };
};

Deno.test("silenced: a wake gives a dead connection the wake's deadline, not the full one", async () => {
  const sleep = sleeping(60_000, 50);
  const began = Date.now();
  try {
    await assertRejects(
      () =>
        silenced(scripted([], 60_000), {
          silenceMs: 30_000,
          wakeMs: 200,
          tickMs: 20,
          now: sleep.now,
        })(REQUEST),
      Error,
      "no word from the model in 0.2s after the machine woke",
    );
  } finally {
    sleep.done();
  }
  assert(Date.now() - began < 2_000, "the wake cut the wait");
});

Deno.test("silenced: a stream the sleep left standing goes on, its deadline whole again", async () => {
  // wake at 50ms; a delta at 150ms; then 500ms of quiet, past the wake's 200ms
  const sleep = sleeping(60_000, 50);
  try {
    const message = await silenced(scripted([150], 650), {
      silenceMs: 30_000,
      wakeMs: 200,
      tickMs: 20,
      now: sleep.now,
    })(REQUEST);
    assertEquals(message, DONE);
  } finally {
    sleep.done();
  }
});

Deno.test("silenced: a clock a few seconds ahead is no sleep", async () => {
  const sleep = sleeping(5_000, 50);
  try {
    const message = await silenced(scripted([], 400), {
      silenceMs: 30_000,
      wakeMs: 100,
      tickMs: 20,
      now: sleep.now,
    })(REQUEST);
    assertEquals(message, DONE);
  } finally {
    sleep.done();
  }
});

Deno.test("providerOf: null is Anthropic; an unknown name is refused", () => {
  assertEquals(providerOf(null).name, "anthropic");
  assertEquals(providerOf(undefined).name, "anthropic");
  assertEquals(providerOf("google"), GOOGLE);
  assertThrows(() => providerOf("nope"), Error, 'unknown provider "nope"');
});

Deno.test("checkProvider: a google agent must name a gemini model at a depth the wire has", () => {
  checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: "high" });
  checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: null });
  assertThrows(
    () => checkProvider({ agentId: "a", provider: "google", model: "claude-sonnet-5" }),
    Error,
    'model "claude-sonnet-5" is not a google model',
  );
  assertThrows(
    () =>
      checkProvider({ agentId: "a", provider: "google", model: "gemini-3.5-flash", effort: "max" }),
    Error,
    'effort "max" is not one google can express',
  );
  // Anthropic's model names are the API's to judge, and every catalog depth is its own
  checkProvider({ agentId: "a", provider: null, model: "claude-x", effort: "max" });
  checkProvider({ agentId: "a", model: "anything", effort: "xhigh" });
});
