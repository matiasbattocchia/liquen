import { assertEquals, assertRejects } from "@std/assert";
import { ingestUp, serveIngest, serveSocket } from "./serve.ts";
import { socketOf } from "../edge.ts";

/** A fetch through the socket, the way the edge dials it. */
async function over(path: string, url: string, init?: RequestInit): Promise<string> {
  const client = Deno.createHttpClient({ proxy: { transport: "unix", path } });
  try {
    return await (await fetch(url, { ...init, client })).text();
  } finally {
    client.close();
  }
}

Deno.test("serveIngest: the socket under the org's run dir names itself to a GET / and hands the rest over", async () => {
  const root = await Deno.makeTempDir();
  try {
    const srv = await serveIngest(root, "x", () => new Response("ok"));
    const sock = socketOf(root, "x", "ingest");
    assertEquals(srv.addr.path, sock);
    assertEquals(await over(sock, "http://x/", { method: "POST" }), "ok");
    assertEquals(await over(sock, "http://x/"), "x");
    assertEquals(await over(sock, "http://x/m/1"), "ok");
    // a socket somebody answers on is another process of this org — refused, not stolen
    await assertRejects(
      () => serveIngest(root, "x", () => new Response(null)),
      Error,
      `${sock} is already served`,
    );
    await srv.shutdown();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("serveSocket: a file nobody answers on is a run that ended — replaced; a path too long is refused", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/stale.sock`;
    await Deno.writeTextFile(path, "");
    const srv = await serveSocket(path, () => new Response("fresh"));
    assertEquals(await over(path, "http://x/"), "fresh");
    await srv.shutdown();
    await assertRejects(
      () => serveSocket(`${root}/${"a".repeat(120)}.sock`, () => new Response(null)),
      Error,
      "a socket path holds",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ingestUp: a served socket answers, an absent one does not", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await ingestUp(root, "x"), false);
    const srv = await serveIngest(root, "x", () => new Response("ok"));
    try {
      assertEquals(await ingestUp(root, "x"), true);
    } finally {
      await srv.shutdown();
    }
    assertEquals(await ingestUp(root, "x"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
