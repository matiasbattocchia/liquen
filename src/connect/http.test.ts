import { assert, assertEquals, assertRejects } from "@std/assert";
import { API_TIMEOUT_MS, said, timedFetch, withTimeout } from "./http.ts";

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

Deno.test("http: said turns the two transport failures into sentences and lets the rest through", async () => {
  // the runtime's network failure, both ways Deno has worded it: wrapped (2.9+, the
  // transport's error in `cause`) and bare
  const transport = "error sending request for url (http://127.0.0.1:9/x): client error " +
    "(Connect): tcp connect error: Connection refused (os error 111)";
  for (
    const refused of [
      new TypeError("fetch failed", { cause: new Error(transport) }),
      new TypeError(transport),
    ]
  ) {
    const failing = (() => Promise.reject(refused)) as typeof fetch;
    const down = await assertRejects(() => said(failing, 30_000)("http://127.0.0.1:9/x"));
    assert((down as Error).constructor === Error, "a plain Error — a refusal, not a fault");
    assertEquals(
      (down as Error).message,
      "cannot reach 127.0.0.1:9 — client error (Connect): tcp connect error: " +
        "Connection refused (os error 111)",
    );
  }

  // the bound's own timeout
  const slow = await assertRejects(() =>
    said(withTimeout(hang, 20), 30_000)("https://api.example/x")
  );
  assert((slow as Error).constructor === Error);
  assertEquals((slow as Error).message, "no answer from api.example within 30s");

  // a caller's own abort is the caller's, and a bug is a bug
  const own = new AbortController();
  const p = said(withTimeout(hang, 10_000), 10_000)("https://api.example/x", {
    signal: own.signal,
  });
  own.abort(new Error("caller cancelled"));
  assertEquals(((await assertRejects(() => p)) as Error).message, "caller cancelled");
  const bug = (() => Promise.reject(new TypeError("x is not a function"))) as typeof fetch;
  assert((await assertRejects(() => said(bug, 1)("https://api.example/x"))) instanceof TypeError);
});

Deno.test("http: timedFetch says it for a real refused connection", async () => {
  const probe = Deno.listen({ port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close(); // nobody is on it now
  const err = await assertRejects(() => timedFetch(`http://127.0.0.1:${port}/x`));
  assert((err as Error).constructor === Error, String(err));
  assert(
    (err as Error).message.startsWith(`cannot reach 127.0.0.1:${port} — `),
    (err as Error).message,
  );
});
