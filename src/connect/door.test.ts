import { assertEquals, assertThrows } from "@std/assert";
import { doorAddress, oneShot, serveDoor } from "./door.ts";
import { socketOf } from "../edge.ts";

Deno.test("oneShot: the first callback settles the door whichever way it went — a failure does not hang it", async () => {
  const { handler, outcome } = oneShot((req) =>
    Promise.resolve(
      new URL(req.url).pathname.endsWith("/callback")
        ? new Response("state mismatch", { status: 400 })
        : new Response(null, { status: 302 }),
    )
  );
  await handler(new Request("http://localhost/google/oauth/start"));
  const res = await handler(new Request("http://localhost/google/oauth/callback?state=x"));
  assertEquals(res.status, 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    outcome.then((r) => r.status),
    new Promise<string>((r) => (timer = setTimeout(() => r("hung"), 500))),
  ]);
  clearTimeout(timer);
  assertEquals(settled, 400);
});

Deno.test("doorAddress: a loopback callback is the browser here; a remote one is a member anywhere", () => {
  const local = doorAddress("http://localhost:8787/google/oauth/callback");
  assertEquals(local.loopback, true);
  assertEquals(local.start, "http://localhost:8787/google/oauth/start");
  assertEquals(doorAddress("http://127.0.0.1:7000/google/oauth/callback").loopback, true);
  const remote = doorAddress("https://liquen.example/slack/oauth/callback");
  assertEquals(remote.loopback, false);
  assertEquals(remote.start, "https://liquen.example/slack/oauth/start");
});

Deno.test("doorAddress: the callback goes back byte for byte — the provider matches the string", () => {
  const raw = "https://liquen.example:8443/hook/google/oauth/callback";
  const d = doorAddress(raw);
  assertEquals(d.callback, raw);
  assertEquals(d.start, "https://liquen.example:8443/hook/google/oauth/start");
});

Deno.test("doorAddress: an address the handler never answers is refused before anyone consents", () => {
  assertThrows(() => doorAddress("https://x.example/google/oauth"), Error, "/callback");
  assertThrows(() => doorAddress("nonsense"), Error, "not a URL");
});

Deno.test("serveDoor: the handler is mounted on the service's oauth socket", async () => {
  const root = await Deno.makeTempDir();
  try {
    const srv = await serveDoor(root, "google", () => Promise.resolve(new Response("door")));
    const path = socketOf(root, "google", "oauth");
    assertEquals(srv.addr.path, path);
    const client = Deno.createHttpClient({ proxy: { transport: "unix", path } });
    try {
      assertEquals(await (await fetch("http://x/google/oauth/start", { client })).text(), "door");
    } finally {
      client.close();
      await srv.shutdown();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
