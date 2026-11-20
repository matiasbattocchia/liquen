import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Artifact } from "./artifacts.ts";
import { createServers, SERVER_LOG, socketOf } from "./artifact-servers.ts";

/** A server at `agents/cy/<name>`, from `code`. */
async function bed(code: string) {
  const dir = await Deno.makeTempDir();
  const folder = `${dir}/agents/cy/app`;
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(`${dir}/secret.txt`, "the org's");
  await Deno.writeTextFile(`${folder}/data.txt`, "the app's");
  await Deno.writeTextFile(`${folder}/server.ts`, code);
  const said: string[] = [];
  const servers = createServers({
    dir,
    // the bare ground: the argv as it is, the environment the harness has
    ground: (_agent, argv) => Promise.resolve({ argv, env: { PATH: Deno.env.get("PATH") ?? "" } }),
    say: (line) => said.push(line),
  });
  const artifact: Artifact = {
    slug: "app",
    id: "id-app",
    agentId: "cy",
    folder: "agents/cy/app",
    with: [],
    title: "App",
    files: {},
    server: { hosts: [], native: false },
    created: 0,
    until: Date.now() + 3_600_000,
    tokens: {},
  };
  const sock = socketOf(dir, artifact);
  const client = Deno.createHttpClient({ proxy: { transport: "unix", path: sock } });
  const ask = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://localhost${path}`, { client, headers });
    return await res.text();
  };
  /** Until the socket answers, or the time is out. */
  const up = async () => {
    for (let i = 0; i < 200; i++) {
      if ((await Deno.lstat(sock).catch(() => null))?.isSocket) {
        const ok = await fetch("http://localhost/", { client }).then((r) => r.body?.cancel()).then(
          () => true,
          () => false,
        );
        if (ok) return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`the server never answered: ${said.join("\n")}`);
  };
  return {
    dir,
    folder,
    said,
    servers,
    artifact,
    ask,
    up,
    async close() {
      await servers.close();
      client.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const HELPER = new URL("./artifact.ts", import.meta.url).href;

Deno.test({
  name:
    "servers: a server answers on its socket with its visitor, reads its own folder alone, and what it prints is said and kept",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const b = await bed(`
      import { serve } from "@liquen/liquen/artifact";
      console.log("hello from the app");
      serve(async (req, visitor) => {
        const { pathname } = new URL(req.url);
        if (pathname === "/mine") return new Response(await Deno.readTextFile("data.txt"));
        if (pathname === "/theirs") {
          try { return new Response(await Deno.readTextFile("../../../secret.txt")); }
          catch (e) { return new Response(e.name); }
        }
        if (pathname === "/out") {
          try { await fetch("https://example.com"); return new Response("reached"); }
          catch (e) { return new Response(e.name); }
        }
        return new Response("visitor " + visitor.phone);
      });
    `);
    try {
      await b.servers.start(b.artifact);
      await b.up();
      assertEquals(
        await b.ask("/", { "liquen-visitor": "5491100000001" }),
        "visitor 5491100000001",
      );
      assertEquals(await b.ask("/mine"), "the app's");
      assertEquals(await b.ask("/theirs"), "NotCapable");
      assertEquals(await b.ask("/out"), "NotCapable");
      assert(b.said.includes("[artifact app] hello from the app"));
      const kept = await Deno.readTextFile(`${b.folder}/${SERVER_LOG}`);
      assertStringIncludes(kept, "hello from the app");
      assertStringIncludes(kept, "listening");
      const map = JSON.parse(await Deno.readTextFile(`${b.dir}/system/artifact-imports.json`));
      assertEquals(map.imports["@liquen/liquen/artifact"], HELPER);
    } finally {
      await b.close();
    }
  },
});

Deno.test({
  name: "servers: one that ends is started again, and once stopped stays down with its socket gone",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const b = await bed(`
      import { serve } from "@liquen/liquen/artifact";
      serve((req) => {
        if (new URL(req.url).pathname === "/die") setTimeout(() => Deno.exit(3), 10);
        return new Response("up");
      });
    `);
    try {
      await b.servers.start(b.artifact);
      await b.up();
      await b.ask("/die");
      for (let i = 0; i < 100 && !b.said.some((l) => l.includes("ended (exit 3)")); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(b.said.some((l) => l.includes("[artifact app] ended (exit 3); starting again in 1s")));
      await b.up();
      assertEquals(await b.ask("/"), "up");

      await b.servers.reconcile([]);
      assertEquals(await Deno.lstat(socketOf(b.dir, b.artifact)).catch(() => null), null);
    } finally {
      await b.close();
    }
  },
});
