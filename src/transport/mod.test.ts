import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC,
  CACHE_HOUR_MS,
  checkProvider,
  GOOGLE,
  leaveOwed,
  type ModelTransport,
  providerOf,
  silenced,
  takeOwed,
  transports,
  vaultKeys,
  warmth,
} from "./mod.ts";
import { openCredentials } from "../store/credentials.ts";
import { membersAt } from "../testing.ts";
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

/** A `make` that records the key each client was built with, and answers with it. */
function recorder() {
  const built: (string | undefined)[] = [];
  const make = (_p: unknown, key: string | undefined): ModelTransport => {
    built.push(key);
    return () => Promise.resolve({ ...DONE, id: key ?? "env" } as Anthropic.Message);
  };
  return { built, make };
}
const answer = async (t: ModelTransport) => (await t(REQUEST)).id;

Deno.test("transports: the vault's key, the agent's own before the org's, read at every call", async () => {
  const dir = await Deno.makeTempDir();
  await membersAt(dir, "a", "ana");
  const creds = await openCredentials(dir);
  try {
    const { built, make } = recorder();
    const of = transports({ keyOf: vaultKeys(creds) }, make);
    const ana = of(GOOGLE, "ana");
    const bo = of(GOOGLE, "bo");

    assertEquals(await answer(ana), "env"); // no row: the SDK's own chain
    await creds.put({ key: "ai:google", value: { api_key: "org-key" } });
    assertEquals(await answer(ana), "org-key"); // connected while running: the next call
    assertEquals(await answer(bo), "org-key");
    await creds.put({ key: "ai:google:ana", value: { api_key: "ana-key" }, agentId: "ana" });
    assertEquals(await answer(ana), "ana-key"); // her own wins
    assertEquals(await answer(bo), "org-key"); // and is hers alone
    await creds.put({ key: "ai:google", value: { api_key: "rotated" } });
    assertEquals(await answer(bo), "rotated");
    assertEquals(await answer(of(ANTHROPIC, "bo")), "env"); // a key is one provider's
    // one client per key, shared by every agent spending it
    assertEquals(built, [undefined, "org-key", "ana-key", "rotated", undefined]);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transports: an explicit anthropic key wins, and no vault is the SDK's chain", async () => {
  const { make } = recorder();
  const keyOf = () => Promise.resolve("vault-key");
  assertEquals(await answer(transports({ anthropic: "given", keyOf }, make)(ANTHROPIC)), "given");
  assertEquals(await answer(transports({ anthropic: "given", keyOf }, make)(GOOGLE)), "vault-key");
  assertEquals(await answer(transports({}, make)(GOOGLE, "ana")), "env");
});

/** A transport that answers at once and keeps every call: its max_tokens and kind. Each
 *  call in `failing` (by index) rejects instead. */
function calls(failing: number[] = []) {
  const seen: { max_tokens: number; kind?: string; model: string }[] = [];
  const t: ModelTransport = (params, _e, meta) => {
    seen.push({ max_tokens: params.max_tokens, kind: meta?.kind, model: params.model });
    return failing.includes(seen.length - 1)
      ? Promise.reject(new Error("overloaded"))
      : Promise.resolve(DONE);
  };
  return { seen, t };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("warmth: a turn's call is replayed at max_tokens 0, as keepalive, until the horizon past it", async () => {
  // the wall clock is the test's: each beat waits a few real ms and reads it again
  let clock = 0;
  const said: string[] = [];
  const w = warmth({
    everyMs: 100,
    beatMs: 5,
    horizonMs: () => 250,
    now: () => clock,
    say: (s) => said.push(s),
  });
  const { seen, t } = calls();
  try {
    await w.through(t)(REQUEST, undefined, { kind: "think", turn_id: "t1" });
    for (const at of [50, 100, 200, 300]) {
      clock = at;
      await wait(30);
    }
    // pings at 100 and 200; at 300 the session's last call is past the horizon
    assertEquals(seen, [
      { max_tokens: 100, kind: "think", model: "m" },
      { max_tokens: 0, kind: "keepalive", model: "m" },
      { max_tokens: 0, kind: "keepalive", model: "m" },
    ]);
    assertEquals(said, ["keep-alive run over, 0 h past the session's last call: the cache lapses"]);
    assertEquals(w.stop(), undefined);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a beat that lands late says the machine slept, and a ping still in its hour goes when due", async () => {
  let clock = 0;
  const said: string[] = [];
  const w = warmth({ beatMs: 5, now: () => clock, say: (s) => said.push(s) });
  const { seen, t } = calls();
  try {
    await w.through(t)(REQUEST, undefined, { kind: "think" });
    clock = 48 * 60_000; // the lid closed after the call and opened 48 min on
    await wait(30);
    assertEquals(seen.map((c) => c.kind), ["think"]); // 55 min: not due yet
    assertEquals(said, ["the machine slept 48 min"]);
    clock = 55 * 60_000; // another jump, another sleep: the wall clock is all a beat reads
    await wait(30);
    assertEquals(seen.map((c) => c.kind), ["think", "keepalive"]);
    assertEquals(said, ["the machine slept 48 min", "the machine slept 7 min"]);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a checkpoint arms nothing, and a later call takes the timer over", async () => {
  const w = warmth({ everyMs: 40 });
  const { seen, t } = calls();
  try {
    await w.through(t)(REQUEST, undefined, { kind: "think" });
    await w.through(t)(REQUEST, undefined, { kind: "checkpoint" });
    await wait(100);
    assertEquals(seen.map((c) => c.kind), ["think", "checkpoint"]);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a provider not kept arms nothing and stands the armed ping down", async () => {
  const w = warmth({ everyMs: 40 });
  const anthropic = calls();
  const google = calls();
  try {
    await w.through(anthropic.t)(REQUEST, undefined, { kind: "think" });
    await w.through(google.t, false)({ ...REQUEST, model: "g" }, undefined, { kind: "think" });
    await wait(100);
    assertEquals(anthropic.seen.map((c) => c.kind), ["think"]);
    assertEquals(google.seen.map((c) => c.kind), ["think"]);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a failed ping ends the run, and stop ends it for good", async () => {
  const failed = warmth({ everyMs: 20 });
  const flaky = calls([1]);
  const stopped = warmth({ everyMs: 20 });
  const quiet = calls();
  const error = console.error;
  const said: string[] = [];
  console.error = (s: string) => said.push(s);
  try {
    await failed.through(flaky.t)(REQUEST, undefined, { kind: "think" });
    await stopped.through(quiet.t)(REQUEST, undefined, { kind: "think" });
    stopped.stop();
    await wait(100);
    assertEquals(flaky.seen.map((c) => c.kind), ["think", "keepalive"]);
    assertEquals(said, ["keep-alive failed, the cache left to lapse: overloaded"]);
    assertEquals(quiet.seen.map((c) => c.kind), ["think"]);
  } finally {
    console.error = error;
    failed.stop();
  }
});

Deno.test("warmth: a call that fails leaves the ping armed before it", async () => {
  const w = warmth({ everyMs: 40, horizonMs: () => 60 }); // room for one ping
  const { seen, t } = calls([1]);
  try {
    const through = w.through(t);
    await through(REQUEST, undefined, { kind: "think" });
    await assertRejects(() => through(REQUEST, undefined, { kind: "think" }));
    await wait(100);
    assertEquals(seen.map((c) => c.kind), ["think", "think", "keepalive"]);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a ping whose hour ran out stands down, since it would write, and says so", async () => {
  let clock = 0;
  const said: string[] = [];
  const w = warmth({ everyMs: 20, now: () => clock, say: (s) => said.push(s) });
  const { seen, t } = calls();
  try {
    await w.through(t)(REQUEST, undefined, { kind: "think" });
    clock = CACHE_HOUR_MS + 42 * 60_000; // the machine slept through it
    await wait(60);
    assertEquals(seen.map((c) => c.kind), ["think"]);
    assertEquals(said, [
      "the machine slept 102 min",
      "keep-alive stood down 42 min past its hour: the cache lapsed",
    ]);
    assertEquals(w.stop(), undefined);
  } finally {
    w.stop();
  }
});

/** A transport that answers each call with an id of its own and the reply `answers` holds
 *  for it, and keeps the `diagnostics` each request carried. */
function diagnosed(answers: Partial<Anthropic.Message & { diagnostics: unknown }>[]) {
  const named: unknown[] = [];
  const t: ModelTransport = (params) => {
    named.push((params as { diagnostics?: unknown }).diagnostics);
    const n = named.length;
    return Promise.resolve({ ...DONE, id: `msg_${n}`, ...answers[n - 1] } as Anthropic.Message);
  };
  return { named, t };
}
const usage = (read: number, wrote: number) =>
  ({ cache_read_input_tokens: read, cache_creation_input_tokens: wrote }) as Anthropic.Usage;

Deno.test("warmth: each call names the one before it, and a miss is said with its reason", async () => {
  const said: string[] = [];
  const w = warmth({ everyMs: 60_000, say: (s) => said.push(s) });
  const { named, t } = diagnosed([
    { usage: usage(0, 50_000) }, // the first call writes, with nothing to compare
    { usage: usage(50_000, 300), diagnostics: null }, // read back
    { usage: usage(0, 52_000), diagnostics: { cache_miss_reason: { type: "tools_changed" } } },
    { usage: usage(0, 52_000), diagnostics: null }, // the same prefix, its entry gone
  ]);
  try {
    const through = w.through(t);
    for (let n = 0; n < 4; n++) await through(REQUEST, undefined, { kind: "think" });
    assertEquals(named, [
      { previous_message_id: null },
      { previous_message_id: "msg_1" },
      { previous_message_id: "msg_2" },
      { previous_message_id: "msg_3" },
    ]);
    assertEquals(said, [
      "think missed the cache: tools_changed, read 0, wrote 52000",
      "think read nothing back, wrote 52000: the prefix held, the cache had lapsed",
    ]);
    assertEquals(w.stop()?.previous, "msg_4");
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a provider not kept is asked nothing of the cache", async () => {
  const w = warmth({ everyMs: 60_000, say: () => {} });
  const { named, t } = diagnosed([{}]);
  try {
    await w.through(t, false)(REQUEST, undefined, { kind: "think" });
    assertEquals(named, [undefined]);
  } finally {
    w.stop();
  }
});

Deno.test("warmth: a stopped keeper hands over the ping it owes, and the next one sends it", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/run/a1.keep.json`;
  let clock = 0;
  const before = warmth({ everyMs: 100, beatMs: 5, now: () => clock });
  const first = calls();
  const after = calls();
  try {
    await before.through(first.t)(REQUEST, undefined, { kind: "think" });
    clock = 30;
    leaveOwed(path, before.stop());
    const owed = takeOwed(path);
    assertEquals(owed?.params, REQUEST);
    // the hour runs from the read, and the run's horizon from the session's last call
    assertEquals([owed?.started, owed?.since], [0, 0]);
    assertEquals(takeOwed(path), undefined); // taken once
    const said: string[] = [];
    const next = warmth({
      everyMs: 100,
      beatMs: 5,
      horizonMs: () => 250,
      now: () => clock,
      owed,
      say: (s) => said.push(s),
    });
    next.through(after.t);
    for (const at of [100, 200, 300]) {
      clock = at;
      await wait(30);
    }
    next.stop();
    assertEquals(first.seen.map((c) => c.kind), ["think"]);
    assertEquals(after.seen.map((c) => c.kind), ["keepalive", "keepalive"]);
    assertEquals(after.seen[0].max_tokens, 0);
    assertEquals(said, [
      "took up the last run's keep-alive, due in 0 min",
      "keep-alive run over, 0 h past the session's last call: the cache lapses",
    ]);
    const late = warmth({
      owed: { ...owed!, started: Date.now() - CACHE_HOUR_MS - 5 * 60_000 },
      say: (s) => said.push(s),
    });
    late.through(after.t);
    late.stop();
    assertEquals(said.at(-1), "the last run's keep-alive had lapsed 5 min before this one began");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
