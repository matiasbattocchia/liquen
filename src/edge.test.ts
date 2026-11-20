import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  callbackAddress,
  createEdge,
  ingestAddress,
  keepLegs,
  legDir,
  listensOn,
  localBase,
  pageAddress,
  pagesSocket,
  reached,
  routeOf,
  SIGN_IN_CLOSED,
  socketOf,
} from "./edge.ts";
import { serveIngest, serveLeg, serveSocket } from "./connect/serve.ts";
import { saveMedia, serveMedia, signMediaPath } from "./store/media.ts";
import { fileStorage } from "./store/storage.ts";

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
  assertEquals(socketOf("/o", "github", "ingest"), "/o/data/run/ingest/github.sock");
  assertEquals(socketOf("/o", "google", "oauth"), "/o/data/run/oauth/google.sock");
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
      "microsoft's ingest is not listening (data/run/ingest/microsoft.sock)",
    );

    // a door no sign-in holds open answers the person, not with a socket
    const closed = await edge(new Request(`${BASE}/microsoft/oauth/callback?state=x`));
    assertEquals(closed.status, 410);
    assertEquals(await closed.text(), SIGN_IN_CLOSED);

    const noRoute = await edge(new Request(`${BASE}/`));
    assertEquals(noRoute.status, 404);
  } finally {
    await ingest.shutdown();
    await door.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("createEdge: a signed media path, resolved against the ingest's address as the service resolves it, reaches the ingest that serves it", async () => {
  const root = await Deno.makeTempDir();
  const storage = fileStorage(root);
  const file = await saveMedia(storage, new TextEncoder().encode("bytes"), {
    mime_type: "image/png",
  });
  const path = await signMediaPath(file.uri, "s3cret");
  const ingest = await serveIngest(
    root,
    "whatsapp",
    async (req) =>
      await serveMedia(req, storage, () => "s3cret") ?? new Response("not media", { status: 400 }),
  );
  try {
    const edge = createEdge(root);
    for (const base of [BASE, localBase(8787)]) {
      const res = await edge(new Request(new URL(path, ingestAddress(base, "whatsapp"))));
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "bytes");
    }
    // a base with a path prefix keeps it: the path is relative to the ingest's address
    const prefixed = `${BASE}/org`;
    assertEquals(
      new URL(path, ingestAddress(prefixed, "whatsapp")).href,
      `${prefixed}/whatsapp/${path}`,
    );
  } finally {
    await ingest.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("createEdge: a page's path goes to main's pages socket as it came, and says so when none serves it", async () => {
  const root = await Deno.makeTempDir();
  const edge = createEdge(root);
  try {
    const down = await edge(new Request(`${BASE}/pages/abc`));
    assertEquals(down.status, 502);
    assertStringIncludes(await down.text(), "pages are not served (data/run/pages.sock)");

    const seen: string[] = [];
    const pages = await serveSocket(pagesSocket(root), (req) => {
      const url = new URL(req.url);
      seen.push(url.pathname + url.search);
      return new Response("a page");
    });
    try {
      const open = await edge(new Request(`${BASE}/pages/abc/k1/app.js?t=x`));
      assertEquals(await open.text(), "a page");
      assertEquals(seen, ["/pages/abc/k1/app.js?t=x"]);
      assertEquals((await edge(new Request(`${BASE}/pages`))).status, 404);
    } finally {
      await pages.shutdown();
    }
    assertEquals(pageAddress({ publicUrl: BASE, port: 8787 }, "abc"), `${BASE}/pages/abc`);
    assertEquals(
      pageAddress({ publicUrl: null, port: 8787 }, "abc"),
      `${localBase(8787)}/pages/abc`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("createEdge: only a connector the org has is forwarded to; any other name is a 404, said once, whatever socket answers under it", async () => {
  const root = await Deno.makeTempDir();
  const said: string[] = [];
  // the org's own sockets beside the leg folders, a server somebody put in one, and a
  // connector of the org's own
  const main = await serveSocket(`${root}/data/run/main.sock`, () => new Response("main"));
  const run = await serveSocket(`${root}/data/run/liquen.sock`, () => new Response("run"));
  const stray = await serveIngest(root, "buscador", () => new Response("a site"));
  await Deno.mkdir(`${root}/connectors/acme`, { recursive: true });
  const acme = await serveIngest(root, "acme", () => new Response("acme", { status: 202 }));
  try {
    const edge = createEdge(root, (line) => said.push(line));
    for (
      const path of [
        "/main/ingest",
        "/main/ingest/sign-in",
        "/liquen/ingest",
        "/buscador/ingest",
        "/buscador/oauth/start",
      ]
    ) {
      const res = await edge(new Request(`${BASE}${path}`, { method: "POST", body: "{}" }));
      assertEquals(res.status, 404, path);
      assertEquals(await res.text(), "no such door");
    }
    assertEquals(said, [
      "refused /main/ingest: no connector is named main",
      "refused /liquen/ingest: no connector is named liquen",
      "refused /buscador/ingest: no connector is named buscador",
    ]);
    const own = await edge(new Request(`${BASE}/acme/ingest`, { method: "POST", body: "{}" }));
    assertEquals(own.status, 202);
    assertEquals(await own.text(), "acme");
  } finally {
    for (const s of [main, run, stray, acme]) await s.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("keepLegs: a leg's folder keeps only the sockets named for a connector, and what else is there or appears is removed and said", async () => {
  const root = await Deno.makeTempDir();
  const said: string[] = [];
  const stray = await serveIngest(root, "buscador", () => new Response("a site"));
  const kept = await serveIngest(root, "github", () => new Response("ok"));
  const stop = await keepLegs(root, (line) => said.push(line));
  let late: Deno.HttpServer | undefined;
  try {
    assertEquals(said, ["removed data/run/ingest/buscador.sock: no connector is named buscador"]);
    assertEquals(await exists(socketOf(root, "buscador", "ingest")), false);

    late = await serveLeg(root, "site", "oauth", () => new Response("a site"));
    // a connector's name on a link to the org's own socket
    await Deno.symlink(`${root}/data/run/main.sock`, socketOf(root, "whatsapp", "ingest"));
    await Deno.writeTextFile(`${legDir(root, "ingest")}/notes.txt`, "x");
    await until(() => said.length === 4);
    assertEquals(
      new Set(said.slice(1)),
      new Set([
        "removed data/run/oauth/site.sock: no connector is named site",
        "removed data/run/ingest/whatsapp.sock: a link, not a socket",
        "removed data/run/ingest/notes.txt: not a connector's socket",
      ]),
    );
    assertEquals(await exists(socketOf(root, "site", "oauth")), false);
    assertEquals(await exists(socketOf(root, "whatsapp", "ingest")), false);
    assertEquals((await Deno.lstat(socketOf(root, "github", "ingest"))).isSocket, true);
  } finally {
    stop();
    for (const s of [stray, kept, late]) await s?.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listensOn: loopback when what dials the edge is on this machine, every interface when something the org does not run publishes it", () => {
  assertEquals(listensOn({ publicUrl: null, tunnel: null }), ["127.0.0.1", "::1"]);
  assertEquals(
    listensOn({ publicUrl: BASE, tunnel: ["cloudflared", "tunnel", "run", "acme"] }),
    ["127.0.0.1", "::1"],
  );
  assertEquals(listensOn({ publicUrl: BASE, tunnel: null }), ["::"]);
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const by = Date.now() + ms;
  while (!done()) {
    if (Date.now() > by) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("reached: an ingest names itself through the edge, and anything else is said", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/connectors/acme`, { recursive: true });
  const ingest = await serveIngest(root, "acme", () => new Response("posted"));
  const edge = Deno.serve({ port: 0, onListen: () => {} }, createEdge(root, () => {}));
  const base = `http://127.0.0.1:${(edge.addr as Deno.NetAddr).port}`;
  try {
    assertEquals(await reached(ingestAddress(base, "acme"), "acme"), null);
    assertStringIncludes(await reached(ingestAddress(base, "acme"), "other") ?? "", '"acme"');
    assertStringIncludes(await reached(ingestAddress(base, "github"), "github") ?? "", "502");
    assertStringIncludes(await reached(ingestAddress(base, "nobody"), "nobody") ?? "", "404");
  } finally {
    await edge.shutdown();
    await ingest.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reached: each check dials afresh, so a connection gone dead carries none into the next", async () => {
  const ports: number[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (_req, info) => {
    ports.push((info.remoteAddr as Deno.NetAddr).port);
    return new Response("acme");
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    assertEquals(await reached(ingestAddress(base, "acme"), "acme"), null);
    assertEquals(await reached(ingestAddress(base, "acme"), "acme"), null);
    assertEquals(ports.length, 2);
    assertEquals(new Set(ports).size, 2);
  } finally {
    await server.shutdown();
  }
});
