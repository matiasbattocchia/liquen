import { assert, assertEquals, assertThrows } from "@std/assert";
import { available, resolveConnect } from "./connect.ts";

/** A fake repo root: shipped doors + a custom connector with/without a connect door. */
async function withRoot(fn: (root: URL) => void): Promise<void> {
  const dir = await Deno.makeTempDir();
  const put = async (rel: string) => {
    const p = `${dir}/${rel}`;
    await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(p, "// door");
  };
  try {
    await put("src/connect/slack/connect.ts");
    await put("connectors/acme/connect.ts");
    await put("connectors/github/ingest.ts"); // a connector WITHOUT a connect door
    fn(new URL(`file://${dir}/`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a shipped service resolves under src/connect — no filesystem probe", async () => {
  await withRoot((root) => {
    assertEquals(
      resolveConnect("slack", root),
      new URL("src/connect/slack/connect.ts", root).pathname,
    );
    // shipped names resolve by the map, not by stat: google has no file in the fake root
    assertEquals(
      resolveConnect("google", root),
      new URL("src/connect/google/connect.ts", root).pathname,
    );
  });
});

Deno.test("a custom connector resolves at connectors/<name>/connect.ts", async () => {
  await withRoot((root) => {
    assertEquals(
      resolveConnect("acme", root),
      new URL("connectors/acme/connect.ts", root).pathname,
    );
  });
});

Deno.test("a path with a slash passes through as given", () => {
  assertEquals(resolveConnect("./anywhere/connect.ts"), "./anywhere/connect.ts");
});

Deno.test("an unknown name fails listing every door that exists", async () => {
  await withRoot((root) => {
    const err = assertThrows(() => resolveConnect("nope", root), Error);
    assert(err.message.includes("acme"), "custom doors are advertised");
    assert(err.message.includes("slack"), "shipped doors are advertised");
    assert(!err.message.includes("github"), "a connector without a connect door is not");
  });
});

Deno.test("available = shipped + custom doors, doorless connectors excluded", async () => {
  await withRoot((root) => {
    assertEquals(available(root), ["slack", "google", "whatsapp", "acme"]);
  });
});
