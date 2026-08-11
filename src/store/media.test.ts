/**
 * media: conversation-scoped, content-named storage (§8) — the hash names the bytes, so
 * re-downloads and the dispatch echo converge on ONE file; the path is the durable handle.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { filePartOf, kindOf, loadMediaBlock, mimeOf, saveMedia } from "./media.ts";

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
