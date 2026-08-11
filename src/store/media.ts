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
 * `<media/>` marker the agent can re-view any time (`aread`/bash), and `loadMediaBlock`
 * turns it into a real Messages-API base64 block for the TRAILING region only — the
 * model sees the picture while it's current, the marker once it's history (§5).
 */

import { encodeBase64 } from "@std/encoding/base64";
import { basename, resolve } from "node:path";
import type { FilePart, MediaKind } from "../types.ts";

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
  const mime = meta.mime_type ?? (meta.name ? mimeOf(meta.name) : null) ??
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
    uri: path,
    ...(meta.name ? { name: meta.name } : {}),
    size: bytes.length,
  };
}

/** A local path → a `FilePart` (the send side: the agent names workspace/media paths,
 *  the harness stats and classifies them). Throws when the path doesn't exist — the
 *  tool_result carries that back as the error it is. */
export function filePartOf(path: string): FilePart {
  const abs = resolve(path);
  const size = Deno.statSync(abs).size;
  const mime = mimeOf(abs) ?? "application/octet-stream";
  return {
    type: "file",
    kind: kindOf(mime),
    file: { mime_type: mime, uri: abs, name: basename(abs), size },
  };
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
  const mime = mimeOf(uri);
  if (!mime || !inlineable(mime)) return null;
  try {
    const bytes = Deno.readFileSync(uri);
    if (bytes.length > INLINE_CAP) return null;
    return { media_type: mime, data: encodeBase64(bytes) };
  } catch {
    return null;
  }
}
