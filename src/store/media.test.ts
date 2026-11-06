/**
 * media: content-named objects (§8) — the hash names the bytes, so re-downloads, the
 * dispatch echo and a forward converge on ONE object; the uri is the durable handle.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { openCredentials } from "./credentials.ts";
import { fileStorage } from "./storage.ts";
import {
  bytesOf,
  filePartOf,
  imageSize,
  kindOf,
  loadMediaBlock,
  localFiles,
  mediaSecret,
  memoizedLoader,
  mimeOf,
  saveMedia,
  serveMedia,
  signMediaPath,
} from "./media.ts";

Deno.test("imageSize: the pixels off a PNG, GIF, WebP or JPEG header, and none off anything else", () => {
  const bytes = (...xs: (number | string)[]) =>
    new Uint8Array(
      xs.flatMap((x) => typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x]),
    );
  const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const le16 = (n: number) => [n & 255, n >> 8];
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, n >> 16];
  const png = bytes(0x89, "PNG\r\n", 0x1a, "\n", ...be32(13), "IHDR", ...be32(1600), ...be32(1200));
  assertEquals(imageSize(png), { width: 1600, height: 1200 });
  assertEquals(imageSize(bytes("GIF89a", ...le16(320), ...le16(240))), { width: 320, height: 240 });
  const riff = (chunk: string, ...body: number[]) =>
    bytes("RIFF", 0, 0, 0, 0, "WEBP", chunk, 0, 0, 0, 0, ...body, 0, 0, 0, 0);
  assertEquals(imageSize(riff("VP8X", 0, 0, 0, 0, ...le24(511), ...le24(511))), {
    width: 512,
    height: 512,
  });
  const vp8l = (511 | 511 << 14) >>> 0;
  assertEquals(
    imageSize(riff("VP8L", 0x2f, vp8l & 255, (vp8l >> 8) & 255, (vp8l >> 16) & 255, vp8l >>> 24)),
    {
      width: 512,
      height: 512,
    },
  );
  assertEquals(imageSize(riff("VP8 ", 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600))), {
    width: 800,
    height: 600,
  });
  // a JPEG's frame header comes after whatever segments precede it
  const jpeg = bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    "JFIF",
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    0x04,
    0xb0,
    0x06,
    0x40,
    3,
  );
  assertEquals(imageSize(jpeg), { width: 1600, height: 1200 });
  assertEquals(imageSize(bytes("%PDF-1.7")), null);
  assertEquals(imageSize(png.subarray(0, 20)), null); // cut short
});

Deno.test("saveMedia: content-named in one namespace — the same bytes are one object, wherever they came from", async () => {
  const root = await Deno.makeTempDir();
  try {
    const storage = fileStorage(root);
    const bytes = new TextEncoder().encode("the same bytes");
    const a = await saveMedia(storage, bytes, { mime_type: "image/png", name: "shot.png" });
    const b = await saveMedia(storage, bytes, { mime_type: "image/png", name: "other.png" });
    assertEquals(a.uri, b.uri);
    assertEquals(a.size, bytes.length);
    assert(/^storage:\/\/media\/[0-9a-f]{32}\.png$/.test(a.uri), a.uri);
    assertEquals(new TextDecoder().decode((await storage.get(a.uri.slice(10)))!), "the same bytes");
    assertEquals(
      [...Deno.readDirSync(`${root}/storage/media`)].map((e) => e.name),
      [a.uri.slice(16)],
    );
    // a name says what nameless bytes are
    const c = await saveMedia(storage, bytes, { name: "x.pdf" });
    assertEquals(c.mime_type, "application/pdf");
    // mime params stripped: a WA voice note says `audio/ogg; codecs=opus` — it lands
    // as .ogg (a .bin was unplayable AND invisible to the extension-keyed maps)
    const d = await saveMedia(storage, bytes, { mime_type: "audio/ogg; codecs=opus" });
    assert(d.uri.endsWith(".ogg"));
    assertEquals(d.mime_type, "audio/ogg");
    // labelled as bare bytes, the bytes say what they are: an upload's default label
    const ogg = new Uint8Array([..."OggS"].map((ch) => ch.charCodeAt(0)).concat(0, 2, 0, 0));
    const e = await saveMedia(storage, ogg, {
      mime_type: "application/octet-stream",
      name: "file",
    });
    assertEquals([e.mime_type, e.uri.endsWith(".ogg")], ["audio/ogg", true]);
    // and what neither the label nor the bytes nor the name say is .bin
    const f = await saveMedia(storage, bytes, { mime_type: "application/octet-stream" });
    assert(f.uri.endsWith(".bin"));
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
    const p = await filePartOf(path);
    assertEquals(p.kind, "document");
    assertEquals(p.file.mime_type, "application/pdf");
    assertEquals(p.file.name, "report.pdf");
    assertEquals(p.file.size, 9);
    assert(p.file.uri.startsWith("file://")); // bare path in, canonical uri out
    assertEquals((await filePartOf(p.file.uri)).file.uri, p.file.uri); // file:// in is idempotent
    await assertRejects(() => filePartOf(`${root}/gone.png`));
    // an http(s) link passes through UNTOUCHED: no fetch, no size, mime from the extension
    const ext = await filePartOf("https://example.com/pics/cat.jpg");
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
    const block = await loadMediaBlock(img);
    assertEquals(block?.media_type, "image/png");
    assertEquals(block?.data, "AQID");
    assertEquals((await loadMediaBlock(`file://${img}`))?.data, "AQID"); // canonical form too
    assertEquals(await loadMediaBlock("https://x.com/a.png"), null); // external: url block, not bytes
    const audio = `${root}/note.mp3`;
    await Deno.writeFile(audio, new Uint8Array([1]));
    assertEquals(await loadMediaBlock(audio), null); // not inlineable — the marker stands alone
    assertEquals(await loadMediaBlock(`${root}/gone.pdf`), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a kept object resolves as a part and inlines through the store; with no store it does neither", async () => {
  const root = await Deno.makeTempDir();
  try {
    const storage = fileStorage(root);
    const kept = await saveMedia(storage, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), {
      name: "dot.png",
    });
    const part = await localFiles(undefined, storage).resolve(kept.uri);
    assertEquals(
      [part.kind, part.file.uri, part.file.size, part.file.name],
      ["image", kept.uri, 6, kept.uri.slice(16)],
    );
    assertEquals((await loadMediaBlock(kept.uri, storage))?.media_type, "image/png");
    assertEquals(await loadMediaBlock(kept.uri), null);
    await assertRejects(() => localFiles().resolve(kept.uri), Error, "no such file in storage");
    await assertRejects(
      () => localFiles(undefined, storage).resolve("storage://media/gone.png"),
      Error,
      "no such file in storage",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("localFiles.snapshot: the part's bytes NOW, as its block — nothing for what can't inline", async () => {
  const root = await Deno.makeTempDir();
  try {
    const files = localFiles();
    const img = `${root}/dot.png`;
    await Deno.writeFile(img, new Uint8Array([1, 2, 3]));
    const part = await files.resolve(img);
    assertEquals(await files.snapshot(part), { media_type: "image/png", data: "AQID" });
    await Deno.writeFile(img, new Uint8Array([4])); // the same part, asked again: what is there now
    assertEquals((await files.snapshot(part))?.data, "BA==");
    await Deno.writeTextFile(`${root}/a.txt`, "x");
    assertEquals(await files.snapshot(await files.resolve(`${root}/a.txt`)), null);
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
    const p = await filePartOf(path);
    assertEquals(p.kind, "image"); // sniffed
    assertEquals(p.file.mime_type, "image/png");
    const block = await loadMediaBlock(path);
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
    const storage = fileStorage(root);
    const file = await saveMedia(storage, new TextEncoder().encode("bytes"), {
      mime_type: "image/png",
      name: "a.png",
    });
    const secret = "s3cret";
    const path = await signMediaPath(file.uri, secret);
    // relative on purpose: the fetching service resolves it against liquen's own address,
    // which is the one it already delivers to — liquen never states its host
    assert(path.startsWith("/m/"));
    const res = await serveMedia(req(path), storage, () => secret);
    assertEquals(res?.status, 200);
    assertEquals(res?.headers.get("content-type"), "image/png");
    assertEquals(await res?.text(), "bytes");
    // stateless: nothing was minted into memory, so a "restarted" verifier still serves it
    assertEquals((await serveMedia(req(path), fileStorage(root), () => secret))?.status, 200);
    // and it stays valid for a retry — a served path is not consumed
    assertEquals((await serveMedia(req(path), storage, () => secret))?.status, 200);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signed media path: another path is not one, a forged one is gone", async () => {
  const root = await Deno.makeTempDir();
  try {
    const storage = fileStorage(root);
    const file = await saveMedia(storage, new TextEncoder().encode("bytes"), { name: "a.png" });
    const path = await signMediaPath(file.uri, "s3cret");
    const serve = (p: string, secret = "s3cret") => serveMedia(req(p), storage, () => secret);
    // not our route at all ⇒ null, so the caller's own handler answers it
    assertEquals(await serve("/whatsapp-web-webhook"), null);
    // a different key, a tampered mac, a tampered payload, a shape that is not one
    assertEquals((await serve(path, "other"))?.status, 404);
    assertEquals((await serve(`${path}x`))?.status, 404);
    assertEquals((await serve("/m/bm90aGluZw.bWFj"))?.status, 404);
    assertEquals((await serve("/m/"))?.status, 404);
    // expired ⇒ gone, however well signed
    const stale = await signMediaPath(file.uri, "s3cret", Date.now() - 1);
    assertEquals((await serve(stale))?.status, 404);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signed media path: only a kept object is signed, and only media is served", async () => {
  const root = await Deno.makeTempDir();
  try {
    const storage = fileStorage(root);
    // a file on this machine is no object: it is kept first, then signed
    await assertRejects(() => signMediaPath(`file://${root}/system/x.md`, "s3cret"), Error, "kept");
    // a signature proves who minted the path, never that the key is innocent: a secret that
    // leaked (or a bug that signed the wrong thing) still reads nothing outside the media
    await storage.put("other/x.md", new TextEncoder().encode("not media"), "text/markdown");
    for (const key of ["other/x.md", "media/../other/x.md"]) {
      const path = await signMediaPath(`storage://${key}`, "s3cret");
      assertEquals((await serveMedia(req(path), storage, () => "s3cret"))?.status, 404);
    }
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
    const storage = fileStorage(root);
    const bytes = new TextEncoder().encode("bytes");
    const a = await saveMedia(storage, bytes, {
      mime_type: "image/png",
      name: "weird.name/with slash",
    });
    assert(a.uri.endsWith(".png"), a.uri);
    const b = await saveMedia(storage, bytes, { name: "no.such ext" });
    assert(b.uri.endsWith(".bin"), b.uri);
    assertEquals(new TextDecoder().decode((await bytesOf(storage, b.uri))!), "bytes");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("memoizedLoader: a uri loads once, and the memo is bounded by bytes held", async () => {
  let loads = 0;
  const load = (uri: string) => {
    loads++;
    return Promise.resolve(
      uri === "/gone" ? null : { media_type: "image/png", data: "x".repeat(100) },
    );
  };
  const memo = memoizedLoader(load, 250);
  assertEquals((await memo("/a"))?.data.length, 100);
  assertEquals((await memo("/a"))?.data.length, 100);
  assertEquals(loads, 1);
  assertEquals(await memo("/gone"), null);
  assertEquals(await memo("/gone"), null); // a miss is not remembered — the file may appear
  assertEquals(loads, 3);
  await memo("/b");
  await memo("/c"); // over the cap: /a is the oldest and goes
  await memo("/a");
  assertEquals(loads, 6);
});

Deno.test("localFiles: a scoped reference resolves from the agent's home and stays inside its roots", async () => {
  const tmp = await Deno.realPath(await Deno.makeTempDir());
  try {
    const home = `${tmp}/agents/ana`;
    const files = localFiles({ home, roots: [home, `${tmp}/shared`] });
    await Deno.mkdir(`${home}/notes`, { recursive: true });
    await Deno.mkdir(`${tmp}/shared`, { recursive: true });
    await Deno.mkdir(`${tmp}/log`, { recursive: true });
    await Deno.mkdir(`${tmp}/agents/bo`, { recursive: true });
    await Deno.writeTextFile(`${home}/notes/plan.md`, "# plan");
    await Deno.writeTextFile(`${tmp}/shared/shared.csv`, "a,b");
    await Deno.writeTextFile(`${tmp}/log/log.db`, "sqlite");
    await Deno.writeTextFile(`${tmp}/agents/bo/secret.md`, "bo's");
    // relative = from the agent's home, not the harness's cwd
    assertEquals((await files.resolve("notes/plan.md")).file.uri, `file://${home}/notes/plan.md`);
    assertEquals((await files.resolve(`${tmp}/shared/shared.csv`)).file.name, "shared.csv");
    // the substrate and a peer's folder are outside — the tool_result carries the refusal
    await assertRejects(() => files.resolve(`${tmp}/log/log.db`), Error, "outside");
    await assertRejects(() => files.resolve(`${tmp}/agents/bo/secret.md`), Error, "outside");
    await assertRejects(() => files.resolve("../bo/secret.md"), Error, "outside");
    // a symlink inside pointing outside is judged by where it POINTS
    await Deno.symlink(`${tmp}/log/log.db`, `${home}/innocent.db`);
    await assertRejects(() => files.resolve(`${home}/innocent.db`), Error, "outside");
    // links pass untouched: nothing local is read
    assertEquals(
      (await files.resolve("https://example.com/a.pdf")).file.uri,
      "https://example.com/a.pdf",
    );
    // with a shell, relative is from where it stands, and the roots judge it all the same
    let cwd = `${home}/notes`;
    const shelled = localFiles({ home, cwd: () => cwd, roots: [home, `${tmp}/shared`] });
    assertEquals((await shelled.resolve("plan.md")).file.uri, `file://${home}/notes/plan.md`);
    cwd = `${tmp}/shared`;
    assertEquals((await shelled.resolve("shared.csv")).file.name, "shared.csv");
    await assertRejects(() => shelled.resolve("../log/log.db"), Error, "outside");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
