import { assertEquals, assertThrows } from "@std/assert";
import { doorAddress, oneShot } from "./door.ts";

Deno.test("oneShot: the first callback settles the door whichever way it went — a failure does not hang it", async () => {
  const { handler, outcome } = oneShot((req) =>
    Promise.resolve(
      new URL(req.url).pathname.endsWith("/callback")
        ? new Response("state mismatch", { status: 400 })
        : new Response(null, { status: 302 }),
    )
  );
  await handler(new Request("http://localhost/oauth/google/start"));
  const res = await handler(new Request("http://localhost/oauth/google/callback?state=x"));
  assertEquals(res.status, 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    outcome.then((r) => r.status),
    new Promise<string>((r) => (timer = setTimeout(() => r("hung"), 500))),
  ]);
  clearTimeout(timer);
  assertEquals(settled, 400);
});

Deno.test("doorAddress: a loopback callback is the browser here, and names the port to bind", () => {
  const d = doorAddress("http://localhost:8791/oauth/google/callback", 9999);
  assertEquals(d.loopback, true);
  assertEquals(d.port, 8791);
  assertEquals(d.start, "http://localhost:8791/oauth/google/start");
  assertEquals(doorAddress("http://127.0.0.1:7000/oauth/google/callback", 9999).port, 7000);
});

Deno.test("doorAddress: a remote callback is advertised, the configured port is bound", () => {
  const d = doorAddress("https://liquen.example/oauth/slack/callback", 8790);
  assertEquals(d.loopback, false);
  assertEquals(d.port, 8790);
  assertEquals(d.start, "https://liquen.example/oauth/slack/start");
});

Deno.test("doorAddress: the callback goes back byte for byte — the provider matches the string", () => {
  const raw = "https://liquen.example:8443/hook/oauth/google/callback";
  const d = doorAddress(raw, 8791);
  assertEquals(d.callback, raw);
  assertEquals(d.start, "https://liquen.example:8443/hook/oauth/google/start");
});

Deno.test("doorAddress: an address the handler never answers is refused before anyone consents", () => {
  assertThrows(() => doorAddress("https://x.example/oauth/google", 8791), Error, "/callback");
  assertThrows(() => doorAddress("nonsense", 8791), Error, "not a URL");
});
