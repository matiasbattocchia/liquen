/**
 * media: conversation-scoped, content-named storage (§8) — the hash names the bytes, so
 * re-downloads and the dispatch echo converge on ONE file; the path is the durable handle.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { openCredentials } from "./credentials.ts";
import {
  filePartOf,
  kindOf,
  loadMediaBlock,
  mediaSecret,
  memoizedLoader,
  mimeOf,
  saveMedia,
  serveMedia,
  signMediaPath,
} from "./media.ts";

Deno.test("saveMedia: content-named and idempotent — same bytes, same path, one file", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bytes = new TextEncoder().encode("the same bytes");
    const a = await saveMedia(root, "C1", bytes, { mime_type: "image/png", name: "shot.png" });
    const b = await saveMedia(root, "C1", bytes, { mime_type: "image/png", name: "shot.png" });
    assertEquals(a.uri, b.uri);
    assertEquals(a.size, bytes.length);
    assert(a.uri.startsWith("file://")); // the canonical local scheme
    assert(a.uri.endsWith(".png"));
    assert(a.uri.includes("/conversations/C1/media/"));
    assertEquals(await Deno.readTextFile(new URL(a.uri)), "the same bytes");
    // a conversation address with unsafe chars slugs into a directory name
    const c = await saveMedia(root, "dm:ana:bo", bytes, { name: "x.pdf" });
    assert(c.uri.includes("/conversations/dm_ana_bo/media/"));
    assertEquals(c.mime_type, "application/pdf"); // inferred from the name
    // mime params stripped: a WA voice note says `audio/ogg; codecs=opus` — it lands
    // as .ogg (a .bin was unplayable AND invisible to the extension-keyed maps)
    const d = await saveMedia(root, "C1", bytes, { mime_type: "audio/ogg; codecs=opus" });
    assert(d.uri.endsWith(".ogg"));
    assertEquals(d.mime_type, "audio/ogg");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mimeOf/kindOf: the small closed map; unknown falls to document/octet-stream", () => {
  assertEquals(mimeOf("a/b/photo.JPG"), "image/jpeg");
  assertEquals(mimeOf("noext"), null);
  assertEquals(kindOf("image/png"), "image");
  assertEquals(kindOf("audio/mpeg"), "audio");
  assertEquals(kindOf("video/mp4"), "video");
  assertEquals(kindOf("application/pdf"), "document");
});

Deno.test("filePartOf: a real path stats and classifies; a missing one throws (tool error)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/report.pdf`;
    await Deno.writeTextFile(path, "pdf bytes");
    const p = filePartOf(path);
    assertEquals(p.kind, "document");
    assertEquals(p.file.mime_type, "application/pdf");
    assertEquals(p.file.name, "report.pdf");
    assertEquals(p.file.size, 9);
    assert(p.file.uri.startsWith("file://")); // bare path in, canonical uri out
    assertEquals(filePartOf(p.file.uri).file.uri, p.file.uri); // file:// in is idempotent
    assertThrows(() => filePartOf(`${root}/gone.png`));
    // an http(s) link passes through UNTOUCHED: no fetch, no size, mime from the extension
    const ext = filePartOf("https://example.com/pics/cat.jpg");
    assertEquals(ext.file.uri, "https://example.com/pics/cat.jpg");
    assertEquals(ext.kind, "image");
    assertEquals(ext.file.mime_type, "image/jpeg");
    assertEquals(ext.file.name, "cat.jpg");
    assertEquals(ext.file.size, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadMediaBlock: images/PDFs inline as base64; other kinds and missing files don't", async () => {
  const root = await Deno.makeTempDir();
  try {
    const img = `${root}/dot.png`;
    await Deno.writeFile(img, new Uint8Array([1, 2, 3]));
    const block = loadMediaBlock(img);
    assertEquals(block?.media_type, "image/png");
    assertEquals(block?.data, "AQID");
    assertEquals(loadMediaBlock(`file://${img}`)?.data, "AQID"); // canonical form too
    assertEquals(loadMediaBlock("https://x.com/a.png"), null); // external: url block, not bytes
    const audio = `${root}/note.mp3`;
    await Deno.writeFile(audio, new Uint8Array([1]));
    assertEquals(loadMediaBlock(audio), null); // not inlineable — the marker stands alone
    assertEquals(loadMediaBlock(`${root}/gone.pdf`), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sniffMime/looksBinary: magic bytes decide when the extension says nothing", async () => {
  const { looksBinary, sniffMime } = await import("./media.ts");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assertEquals(sniffMime(png), "image/png");
  assertEquals(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffMime(new TextEncoder().encode("%PDF-1.7")), "application/pdf");
  assertEquals(sniffMime(new TextEncoder().encode("GIF89a")), "image/gif");
  assertEquals(sniffMime(new TextEncoder().encode("plain prose")), null);
  assertEquals(looksBinary(new Uint8Array([104, 0, 108])), true); // a NUL ⇒ not text
  assertEquals(looksBinary(new TextEncoder().encode("hola")), false);
});

Deno.test("extension-less media classifies by its bytes — whole pipeline, not just aread", async () => {
  const root = await Deno.makeTempDir();
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const path = `${root}/snapshot`; // no extension at all
    await Deno.writeFile(path, png);
    const p = filePartOf(path);
    assertEquals(p.kind, "image"); // sniffed
    assertEquals(p.file.mime_type, "image/png");
    const block = loadMediaBlock(path);
    assertEquals(block?.media_type, "image/png"); // inlines despite the nameless path
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/* ── the pull leg: signed, relative, stateless ─────────────────────────────── */

const req = (path: string) => new Request(`http://ingest${path}`);

Deno.test("signed media path: minted relative, served by any process holding the key", async () => {
  const root = await Deno.makeTempDir();
  try {
    const file = await saveMedia(root, "C1", new TextEncoder().encode("bytes"), {
      mime_type: "image/png",
      name: "a.png",
    });
    const secret = "s3cret";
    const path = await signMediaPath(file.uri, secret);
    // relative on purpose: the fetching service resolves it against mu's own address,
    // which is the one it already delivers to — mu never states its host
    assert(path.startsWith("/m/"));
    const res = await serveMedia(req(path), root, () => secret);
    assertEquals(res?.status, 200);
    assertEquals(res?.headers.get("content-type"), "image/png");
    assertEquals(await res?.text(), "bytes");
    // stateless: nothing was minted into memory, so a "restarted" verifier still serves it
    assertEquals((await serveMedia(req(path), root, () => secret))?.status, 200);
    // and it stays valid for a retry — a served path is not consumed
    assertEquals((await serveMedia(req(path), root, () => secret))?.status, 200);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signed media path: another path is not one, a forged one is gone", async () => {
  const root = await Deno.makeTempDir();
  try {
    const file = await saveMedia(root, "C1", new TextEncoder().encode("bytes"), { name: "a.png" });
    const path = await signMediaPath(file.uri, "s3cret");
    // not our route at all ⇒ null, so the caller's own handler answers it
    assertEquals(await serveMedia(req("/whatsapp-web-webhook"), root, () => "s3cret"), null);
    // a different key, a tampered mac, a tampered payload, a shape that is not one
    assertEquals((await serveMedia(req(path), root, () => "other"))?.status, 404);
    assertEquals((await serveMedia(req(`${path}x`), root, () => "s3cret"))?.status, 404);
    assertEquals((await serveMedia(req("/m/bm90aGluZw.bWFj"), root, () => "s3cret"))?.status, 404);
    assertEquals((await serveMedia(req("/m/"), root, () => "s3cret"))?.status, 404);
    // expired ⇒ gone, however well signed
    const stale = await signMediaPath(file.uri, "s3cret", Date.now() - 1);
    assertEquals((await serveMedia(req(stale), root, () => "s3cret"))?.status, 404);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signed media path: the store's boundary is checked on its own", async () => {
  const root = await Deno.makeTempDir();
  try {
    // a signature proves who minted the path, never that the path is innocent: a secret
    // that leaked (or a bug that signed the wrong thing) still cannot read the org's docs
    const outside = `${root}/system/instructions/principal.md`;
    await Deno.mkdir(`${root}/system/instructions`, { recursive: true });
    await Deno.writeTextFile(outside, "the operator's own file");
    const path = await signMediaPath(outside, "s3cret");
    assertEquals((await serveMedia(req(path), root, () => "s3cret"))?.status, 404);
    // ...and the traversal spelling of the same thing
    const climb = await signMediaPath(`${root}/conversations/../system/x.md`, "s3cret");
    assertEquals((await serveMedia(req(climb), root, () => "s3cret"))?.status, 404);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the signing key lives in the vault, so two processes agree on it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // the dispatch process mints it...
    const signer = await openCredentials(dir);
    const secret = await mediaSecret(signer);
    assert(secret.length >= 32);
    assertEquals(await mediaSecret(signer), secret); // minted once, not per call
    // ...the ingest process, a different process over the same root, reads the same one
    const verifier = await openCredentials(dir);
    assertEquals(await mediaSecret(verifier), secret);
    await signer.close();
    await verifier.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saveMedia: the extension comes from the name only when the name carries one", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bytes = new TextEncoder().encode("bytes");
    const a = await saveMedia(root, "C1", bytes, {
      mime_type: "image/png",
      name: "weird.name/with slash",
    });
    assert(a.uri.endsWith(".png"), a.uri);
    const b = await saveMedia(root, "C1", bytes, { name: "no.such ext" });
    assert(b.uri.endsWith(".bin"), b.uri);
    assertEquals(await Deno.readTextFile(new URL(b.uri)), "bytes");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("memoizedLoader: a uri loads once, and the memo is bounded by bytes held", () => {
  let loads = 0;
  const load = (uri: string) => {
    loads++;
    return uri === "/gone" ? null : { media_type: "image/png", data: "x".repeat(100) };
  };
  const memo = memoizedLoader(load, 250);
  assertEquals(memo("/a")?.data.length, 100);
  assertEquals(memo("/a")?.data.length, 100);
  assertEquals(loads, 1);
  assertEquals(memo("/gone"), null);
  assertEquals(memo("/gone"), null); // a miss is not remembered — the file may appear
  assertEquals(loads, 3);
  memo("/b");
  memo("/c"); // over the cap: /a is the oldest and goes
  memo("/a");
  assertEquals(loads, 6);
});
