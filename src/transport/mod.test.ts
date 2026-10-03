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
    () => silenced(working(1, 5_000), 200)(REQUEST),
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
  const message = await silenced(working(8, 100), 300)(REQUEST, (d) => seen.push(d));
  assertEquals(message, DONE);
  assertEquals(seen.length, 8);
});

Deno.test("silenced: the turn's interrupt is not taken for silence", async () => {
  const turn = new AbortController();
  setTimeout(() => turn.abort(), 50);
  const err = await assertRejects(
    () => silenced(working(1, 5_000), 5_000)(REQUEST, undefined, {}, turn.signal),
  );
  assertEquals((err as Error).name, "AbortError");
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
