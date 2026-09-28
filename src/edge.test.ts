import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  callbackAddress,
  createEdge,
  ingestAddress,
  localBase,
  reached,
  routeOf,
  socketOf,
} from "./edge.ts";
import { serveIngest, serveLeg } from "./connect/serve.ts";

const BASE = "https://acme.example.com";

Deno.test("the address grammar: one base, the service first, the leg after", () => {
  assertEquals(ingestAddress(BASE, "github"), `${BASE}/github/ingest`);
  assertEquals(ingestAddress(localBase(8787), "github"), "http://localhost:8787/github/ingest");
  assertEquals(
    callbackAddress({ publicUrl: BASE, port: 8787 }, "google"),
    `${BASE}/google/oauth/callback`,
  );
  assertEquals(
    callbackAddress({ publicUrl: null, port: 8787 }, "google"),
    "http://localhost:8787/google/oauth/callback",
  );
  // a platform that routes by function name is the same grammar under its own base
  assertEquals(
    ingestAddress("https://ref.supabase.co/functions/v1", "microsoft"),
    "https://ref.supabase.co/functions/v1/microsoft/ingest",
  );
  // the sockets behind the edge, under the org's own folder
  assertEquals(socketOf("/o", "github", "ingest"), "/o/data/run/github.sock");
  assertEquals(socketOf("/o", "google", "oauth"), "/o/data/run/google-oauth.sock");
});

Deno.test("routeOf: an ingest is handed the path under its root, a door the path as it came, anything else is no route", () => {
  assertEquals(routeOf("/github/ingest"), { service: "github", leg: "ingest", rest: "/" });
  assertEquals(routeOf("/github/ingest/"), { service: "github", leg: "ingest", rest: "/" });
  assertEquals(routeOf("/whatsapp/ingest/sessions/events"), {
    service: "whatsapp",
    leg: "ingest",
    rest: "/sessions/events",
  });
  assertEquals(routeOf("/google/oauth/callback"), {
    service: "google",
    leg: "oauth",
    rest: "/google/oauth/callback",
  });
  assertEquals(routeOf("/"), null);
  assertEquals(routeOf("/github"), null);
  assertEquals(routeOf("/github/webhook"), null);
  assertEquals(routeOf("/Github/ingest"), null);
});

Deno.test("createEdge: forwards to the sockets with query and body, keeps a redirect, names what is not there", async () => {
  const root = await Deno.makeTempDir();
  const seen: { url: string; method: string; body: string; host: string | null }[] = [];
  const ingest = await serveIngest(root, "github", async (req) => {
    seen.push({
      url: req.url,
      method: req.method,
      body: await req.text(),
      host: req.headers.get("x-forwarded-host"),
    });
    return new Response("ok", { status: 202 });
  });
  const door = await serveLeg(root, "google", "oauth", (req) => {
    seen.push({ url: req.url, method: req.method, body: "", host: null });
    return new Response(null, { status: 302, headers: { location: "https://accounts.example/x" } });
  });
  try {
    const edge = createEdge(root);

    const posted = await edge(
      new Request(`${BASE}/github/ingest?x=1`, { method: "POST", body: '{"a":1}' }),
    );
    assertEquals(posted.status, 202);
    assertEquals(await posted.text(), "ok");
    assertEquals(seen[0].method, "POST");
    assertEquals(new URL(seen[0].url).pathname + new URL(seen[0].url).search, "/?x=1");
    assertEquals(seen[0].body, '{"a":1}');
    assertEquals(seen[0].host, "acme.example.com");

    const start = await edge(new Request(`${BASE}/google/oauth/start?agent=cy`));
    assertEquals(start.status, 302);
    assertEquals(start.headers.get("location"), "https://accounts.example/x");
    assertEquals(new URL(seen[1].url).pathname, "/google/oauth/start");
    assertEquals(new URL(seen[1].url).search, "?agent=cy");

    const down = await edge(
      new Request(`${BASE}/microsoft/ingest`, { method: "POST", body: "{}" }),
    );
    assertEquals(down.status, 502);
    assertStringIncludes(
      await down.text(),
      `microsoft's ingest is not listening (${socketOf(root, "microsoft", "ingest")})`,
    );

    const noRoute = await edge(new Request(`${BASE}/`));
    assertEquals(noRoute.status, 404);
  } finally {
    await ingest.shutdown();
    await door.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reached: an ingest names itself through the edge, and anything else is said", async () => {
  const root = await Deno.makeTempDir();
  const ingest = await serveIngest(root, "acme", () => new Response("posted"));
  const edge = Deno.serve({ port: 0, onListen: () => {} }, createEdge(root));
  const base = `http://127.0.0.1:${(edge.addr as Deno.NetAddr).port}`;
  try {
    assertEquals(await reached(ingestAddress(base, "acme"), "acme"), null);
    assertStringIncludes(await reached(ingestAddress(base, "acme"), "other") ?? "", '"acme"');
    assertStringIncludes(await reached(ingestAddress(base, "nobody"), "nobody") ?? "", "502");
  } finally {
    await edge.shutdown();
    await ingest.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
