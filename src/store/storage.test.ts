import { assert, assertEquals, assertRejects } from "@std/assert";
import { collect, fileStorage, keptIn, UNREFERENCED_KEEP_MS } from "./storage.ts";

Deno.test("the file store keeps a key once, lists it, and lets it go", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = fileStorage(dir);
    await store.put("media/a.png", new Uint8Array([1]), "image/png");
    await store.put("media/a.png", new Uint8Array([2]), "image/png"); // the same key: kept
    assertEquals([...(await store.get("media/a.png"))!], [1]);
    assertEquals(await store.get("media/none.png"), null);
    assertEquals((await Array.fromAsync(store.keys("media/"))).map((k) => k.key), ["media/a.png"]);
    await store.delete("media/a.png");
    await store.delete("media/a.png"); // gone already: no error
    assertEquals(await store.get("media/a.png"), null);
    // a key reaches nothing outside the store
    await assertRejects(() => store.get("../log/log.db"), Error, "not a storage key");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("keptIn: the kept objects a row's parts name, each once", () => {
  const file = (uri: string) => ({ type: "file", kind: "image", file: { uri } });
  assertEquals(
    keptIn([
      file("storage://media/a.png"),
      file("storage://media/a.png"),
      file("file:///home/ana/x.png"),
      file("https://x.io/y.png"),
      { type: "text", kind: "text", text: "storage://media/b.png" },
    ]),
    ["storage://media/a.png"],
  );
  assertEquals(keptIn(null), []);
});

Deno.test("collect: an object no event references goes once it is older than an upload's wait", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = fileStorage(dir);
    for (const k of ["kept", "orphan", "fresh"]) {
      await store.put(`media/${k}.png`, new Uint8Array([1]), "image/png");
    }
    const old = new Date(Date.now() - UNREFERENCED_KEEP_MS - 60_000);
    for (const k of ["kept", "orphan"]) {
      await Deno.utime(`${dir}/storage/media/${k}.png`, old, old);
    }
    const referenced = (uri: string) => Promise.resolve(uri === "storage://media/kept.png");
    assertEquals(await collect(store, referenced), 1);
    const left = (await Array.fromAsync(store.keys("media/"))).map((k) => k.key).sort();
    // the referenced one stays, and so does an upload whose message may still land
    assertEquals(left, ["media/fresh.png", "media/kept.png"]);
    assert(await store.get("media/fresh.png"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
