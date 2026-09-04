import { assert, assertEquals, assertRejects } from "@std/assert";
import { API_TIMEOUT_MS, timedFetch, withTimeout } from "./http.ts";

/** A fetch that never answers on its own — only the signal ends it, as a stalled socket
 *  would behave under a real `fetch`. */
const hang =
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;

Deno.test("http: withTimeout ends a hung request with a TimeoutError inside the bound", async () => {
  const t0 = Date.now();
  const err = await assertRejects(() => withTimeout(hang, 20)("https://api.example/x"));
  assert(err instanceof DOMException && err.name === "TimeoutError", String(err));
  assert(Date.now() - t0 < 1_000, "the bound held");
});

Deno.test("http: a caller's own signal still aborts, and the timeout rides alongside it", async () => {
  const own = new AbortController();
  const p = withTimeout(hang, 10_000)("https://api.example/x", { signal: own.signal });
  own.abort(new Error("caller cancelled"));
  const err = await assertRejects(() => p);
  assertEquals((err as Error).message, "caller cancelled");
});

Deno.test("http: timedFetch carries the module's bound on every call", async () => {
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_i: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    const res = await timedFetch("https://api.example/x", { method: "POST" });
    assertEquals(await res.text(), "ok");
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(seen.length, 1);
  assertEquals(seen[0].method, "POST");
  assert(seen[0].signal instanceof AbortSignal, "a signal rides the call");
  assert(API_TIMEOUT_MS > 0);
});
