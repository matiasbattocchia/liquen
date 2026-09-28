import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  callbackAddress,
  createEdge,
  type Door,
  doorsOf,
  ingestAddress,
  reached,
  routeOf,
} from "./edge.ts";
import { serveIngest } from "./connect/serve.ts";
import { materialize, starterConfig } from "./config.ts";

const BASE = "https://acme.example.com";

Deno.test("the address grammar: one base, the service first, the leg after", () => {
  assertEquals(ingestAddress(BASE, "github"), `${BASE}/github/ingest`);
  assertEquals(ingestAddress(null, "github"), null);
  assertEquals(callbackAddress(BASE, "google", 8791), `${BASE}/google/oauth/callback`);
  assertEquals(
    callbackAddress(null, "google", 8791),
    "http://localhost:8791/google/oauth/callback",
  );
  // a platform that routes by function name is the same grammar under its own base
  assertEquals(
    ingestAddress("https://ref.supabase.co/functions/v1", "microsoft"),
    "https://ref.supabase.co/functions/v1/microsoft/ingest",
  );
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

Deno.test("createEdge: forwards by door table with query and body, keeps a redirect, names what is not there", async () => {
  const seen: { url: string; method: string; body: string; host: string | null }[] = [];
  const fetchApi = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "",
      host: new Headers(init?.headers).get("x-forwarded-host"),
    });
    if (url.includes(":8791")) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://accounts.example/x" } }),
      );
    }
    if (url.includes(":8788")) return Promise.resolve(new Response("ok", { status: 202 }));
    return Promise.reject(new TypeError("connection refused"));
  }) as typeof fetch;
  const doors = new Map<string, Door>([
    ["github", { ingest: 8788 }],
    ["google", { oauth: 8791 }],
    ["microsoft", { ingest: 8794 }],
  ]);
  const edge = createEdge(doors, fetchApi);

  const posted = await edge(
    new Request(`${BASE}/github/ingest?x=1`, { method: "POST", body: '{"a":1}' }),
  );
  assertEquals(posted.status, 202);
  assertEquals(seen[0], {
    url: "http://127.0.0.1:8788/?x=1",
    method: "POST",
    body: '{"a":1}',
    host: "acme.example.com",
  });

  const start = await edge(new Request(`${BASE}/google/oauth/start?agent=cy`));
  assertEquals(start.status, 302);
  assertEquals(start.headers.get("location"), "https://accounts.example/x");
  assertEquals(seen[1].url, "http://127.0.0.1:8791/google/oauth/start?agent=cy");

  const down = await edge(new Request(`${BASE}/microsoft/ingest`, { method: "POST", body: "{}" }));
  assertEquals(down.status, 502);
  assertStringIncludes(await down.text(), "microsoft's ingest is not answering on :8794");

  const noLeg = await edge(new Request(`${BASE}/github/oauth/callback`));
  assertEquals(noLeg.status, 404);
  assertStringIncludes(await noLeg.text(), "github has no oauth here");

  const noRoute = await edge(new Request(`${BASE}/`));
  assertEquals(noRoute.status, 404);
});

Deno.test("doorsOf: the shipped specs' ports, as the connector reads them; 0 and a portless connector are no door", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cfg = starterConfig();
    cfg.connections = {
      github: { ingestPort: 9001 },
      google: {},
      slack: { ingestPort: 0 },
      token: {},
    };
    await Deno.writeTextFile(`${root}/config.jsonc`, materialize(cfg));
    const doors = await doorsOf(root, Object.keys(cfg.connections));
    assertEquals(doors.get("github"), { ingest: 9001 });
    assertEquals(doors.get("google"), { oauth: 8791 });
    assertEquals(doors.get("slack"), { oauth: 8790 });
    assertEquals(doors.has("token"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reached: an ingest names itself through the edge, and anything else is said", async () => {
  let ingestPort = 0;
  const ingest = serveIngest(
    "connections.acme.ingestPort",
    0,
    () => new Response("posted"),
    (p) => ingestPort = p,
  );
  const edge = Deno.serve(
    { port: 0, onListen: () => {} },
    createEdge(new Map([["acme", { ingest: ingestPort }]])),
  );
  const base = `http://127.0.0.1:${(edge.addr as Deno.NetAddr).port}`;
  try {
    assertEquals(await reached(`${base}/acme/ingest`, "acme"), null);
    assertStringIncludes(await reached(`${base}/acme/ingest`, "other") ?? "", '"acme"');
    assertStringIncludes(await reached(`${base}/nobody/ingest`, "nobody") ?? "", "404");
  } finally {
    await edge.shutdown();
    await ingest.shutdown();
  }
});
