/**
 * s3: the object store over the S3 API, against a real one — `LIQUEN_TEST_S3` names a
 * bucket (`http://127.0.0.1:59000/org`), and `STORAGE_ACCESS_KEY_ID` /
 * `STORAGE_SECRET_ACCESS_KEY` its keys. Unset, the round trip is skipped; the address
 * rules run either way.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { s3AddressOf, s3Storage } from "./s3.ts";
import { collect, UNREFERENCED_KEEP_MS } from "./storage.ts";
import { saveMedia } from "./media.ts";

const BUCKET = Deno.env.get("LIQUEN_TEST_S3");

Deno.test("s3AddressOf: the bucket off the path, the region off the query, the keys off the env", () => {
  const env = (n: string) => ({ STORAGE_ACCESS_KEY_ID: "k", STORAGE_SECRET_ACCESS_KEY: "s" })[n];
  assertEquals(s3AddressOf("https://acct.r2.cloudflarestorage.com/org", env), {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "org",
    region: "auto",
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  assertEquals(
    s3AddressOf("https://s3.amazonaws.com/org?region=eu-west-1", env).region,
    "eu-west-1",
  );
  assertThrows(
    () => s3AddressOf("https://acct.r2.cloudflarestorage.com/", env),
    Error,
    "no bucket",
  );
  assertThrows(
    () => s3AddressOf("https://x.io/org", () => undefined),
    Error,
    "STORAGE_ACCESS_KEY_ID",
  );
});

Deno.test({
  name:
    "s3 store: a signed round trip — kept once, read back, listed, let go; a wrong key is refused",
  ignore: BUCKET === undefined,
  async fn() {
    const at = s3AddressOf(BUCKET!);
    const store = s3Storage(at);
    const run = crypto.randomUUID().slice(0, 8);
    const bytes = new TextEncoder().encode(`hola ${run}`);
    const file = await saveMedia(store, bytes, { mime_type: "text/plain", name: "a b+c.txt" });
    const key = file.uri.slice("storage://".length);
    assertEquals(new TextDecoder().decode((await store.get(key))!), `hola ${run}`);
    assertEquals(await store.get(`media/${run}-none.txt`), null);
    const listed = (await Array.fromAsync(store.keys("media/"))).map((k) => k.key);
    assertEquals(listed.includes(key), true);
    // nothing references it, but it is fresh: an upload's wait spares it
    assertEquals(await collect(store, () => Promise.resolve(false)), 0);
    // a day on, it goes
    const later = Date.now() + UNREFERENCED_KEEP_MS + 60_000;
    await collect(store, () => Promise.resolve(false), "media/", later);
    assertEquals(await store.get(key), null);
    // a signature made with another secret is the service's to refuse
    const forged = s3Storage({ ...at, secretAccessKey: "not-the-secret" });
    await assertRejects(
      () => forged.put(`media/${run}.txt`, bytes, "text/plain"),
      Error,
      "HTTP 403",
    );
  },
});
