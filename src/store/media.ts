/**
 * store/media.ts — the media store (§8 conversation scope): received and sent files land
 * on disk, conversation-scoped and CONTENT-NAMED.
 *
 * `${root}/conversations/<safe(address)>/media/<content-hash>.<ext>` — the hash names the
 * bytes, so a re-download, a retry, and the dispatch echo all converge on one file (the
 * same idempotence the log gets from `external_id`). The conversation dir is already the
 * §8 conversation scope; media is just its binary shelf.
 *
 * The path IS the durable handle: a `FilePart.uri` points here, render shows it as a
 * kind marker (`<image/>`, `<audio/>`…) the agent can re-view any time (`aread`/bash), and `loadMediaBlock`
 * turns it into a real Messages-API base64 block for the TRAILING region only — the
 * model sees the picture while it's current, the marker once it's history (§5).
 */

import { encodeBase64 } from "@std/encoding/base64";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FilePart, MediaKind } from "../types.ts";

/** The scheme IS the distinction: `http(s)` = an external link (no local bytes, never
 *  fetched broker-side); everything else is local — canonically `file://`, bare paths
 *  tolerated on input. */
export function isExternal(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

/** A local uri → its filesystem path (`file://` unwrapped, bare passed through). */
export function pathOf(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/** ext ↔ mime, the small closed set the harness cares to name; everything else is a
 *  generic document (`.bin` / octet-stream) — the bytes still land and the path still works. */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));

/** The mime a path's extension declares (null when unknown). */
export function mimeOf(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? null;
}

/** mime → the coarse `MediaKind` render and connectors speak (§3). */
export function kindOf(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/** Mimes whose BYTES are the content — no useful text form: what `aread` hands back as
 *  an attachment (a media mark) instead of dumping mojibake. */
export function isBytes(mime: string): boolean {
  return (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf";
}

/** The afs→bash wire protocol for attachments (the CWD_MARK pattern): `aread` on a bytes
 *  file prints `MEDIA_MARK<abs path>` as a line; bash peels those lines off the text and
 *  returns the paths as the tool outcome's `files` — which ride the tool_result event as
 *  FileParts (§5). */
export const MEDIA_MARK = "__MU_MEDIA__:";

/** Magic-byte signatures — the FALLBACK when the extension says nothing (extension
 *  first: it's free and rarely lies). 16 bytes decide every format the mime map names. */
export function sniffMime(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "%PDF")) return "application/pdf";
  if (ascii(0, "ID3") || at(0, 0xff, 0xfb) || at(0, 0xff, 0xf3)) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(4, "ftyp")) return "video/mp4"; // the isobmff family (mp4/mov/m4a)
  return null;
}

/** The git/grep heuristic: a NUL in the head ⇒ not text. The last-resort classifier —
 *  an unknown binary reads as `[binary …]`, never as mojibake. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** A conversation address as a directory name — one-way slug, filesystem-safe. */
function safe(address: string): string {
  return address.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Store bytes for a conversation; returns the `FilePart.file` shape pointing at the
 *  local ABSOLUTE path. Content-hash named ⇒ idempotent: saving the same bytes twice
 *  (re-download, echo) is one file, and existing bytes are never rewritten. */
export async function saveMedia(
  root: string,
  conversation: string,
  bytes: Uint8Array,
  meta: { mime_type?: string; name?: string } = {},
): Promise<FilePart["file"]> {
  // params stripped: the wire says `audio/ogg; codecs=opus`, the maps key on the bare type
  const mime = meta.mime_type?.split(";")[0].trim() ?? (meta.name ? mimeOf(meta.name) : null) ??
    "application/octet-stream";
  const fromName = meta.name?.includes(".") ? meta.name.slice(meta.name.lastIndexOf(".") + 1) : "";
  const ext = (fromName || EXT[mime] || "bin").toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    .slice(0, 16);
  const dir = resolve(root, "conversations", safe(conversation), "media");
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${hash}.${ext}`;
  try {
    await Deno.writeFile(path, bytes, { createNew: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err; // same hash ⇒ same bytes
  }
  return {
    mime_type: mime,
    uri: pathToFileURL(path).toString(),
    ...(meta.name ? { name: meta.name } : {}),
    size: bytes.length,
  };
}

/** A file reference → a `FilePart` (the send side). A local path (bare or `file://`)
 *  is statted and classified — throws when it doesn't exist, and the tool_result
 *  carries that back as the error it is. An `http(s)` link passes through UNTOUCHED
 *  (no fetch, no size — mime guessed from the URL's extension): the platforms that
 *  take links send it as-is. */
export function filePartOf(ref: string): FilePart {
  if (isExternal(ref)) {
    const path = new URL(ref).pathname;
    const mime = mimeOf(path) ?? "application/octet-stream";
    const name = basename(path);
    return {
      type: "file",
      kind: kindOf(mime),
      file: { mime_type: mime, uri: ref, ...(name && name !== "/" ? { name } : {}) },
    };
  }
  const abs = resolve(pathOf(ref));
  const size = Deno.statSync(abs).size;
  const mime = mimeOf(abs) ?? sniffMime(headSync(abs)) ?? "application/octet-stream";
  return {
    type: "file",
    kind: kindOf(mime),
    file: { mime_type: mime, uri: pathToFileURL(abs).toString(), name: basename(abs), size },
  };
}

/** The first bytes of a file (sniffing window) — never the whole thing. */
function headSync(path: string, n = 16): Uint8Array {
  const f = Deno.openSync(path, { read: true });
  try {
    const buf = new Uint8Array(n);
    let at = 0;
    for (;;) {
      const r = f.readSync(buf.subarray(at));
      if (r === null || (at += r) >= n) break;
    }
    return buf.subarray(0, at);
  } finally {
    f.close();
  }
}

/** Raw-byte cap for inlining into a request (base64 ≈ ×4/3; the API caps ~5MB/image). */
const INLINE_CAP = 3 * 1024 * 1024;

/** What the model can SEE inline: images and PDFs (§5 — the trailing-region blocks). */
const inlineable = (mime: string): boolean =>
  mime.startsWith("image/") && mime !== "image/svg+xml" || mime === "application/pdf";

/** A stored file → the base64 payload for a Messages-API image/document block, or null
 *  (not inlineable, over the cap, missing). Sync — render stays free of async plumbing;
 *  only TRAILING-region files ever hit this, so the reads are few and recent. */
export function loadMediaBlock(uri: string): { media_type: string; data: string } | null {
  if (isExternal(uri)) return null; // external links inline as url-source blocks, not bytes
  const path = pathOf(uri);
  const named = mimeOf(path); // extension first; a nameless file sniffs from its bytes below
  if (named && !inlineable(named)) return null;
  try {
    const bytes = Deno.readFileSync(path);
    if (bytes.length > INLINE_CAP) return null;
    const mime = named ?? sniffMime(bytes);
    if (!mime || !inlineable(mime)) return null;
    return { media_type: mime, data: encodeBase64(bytes) };
  } catch {
    return null;
  }
}
