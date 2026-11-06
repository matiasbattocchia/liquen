/**
 * store/media.ts — media (§8): the files received and sent, kept in the object store
 * (`storage.ts`) and CONTENT-NAMED.
 *
 * `storage://media/<content-hash>.<ext>` — the hash names the bytes, so a re-download, a
 * retry, the dispatch echo and a file forwarded to three chats all converge on one object
 * (the same idempotence the log gets from `external_id`).
 *
 * A uri has three schemes: `storage://` for what the harness keeps, `file://` for the
 * agent's workspace (a file about to go out), `https://` for an outside link. The uri IS
 * the durable handle: a `FilePart.uri` holds it, render shows it in a kind marker
 * (`<image/>`, `<audio/>`…) the agent can re-read any time (`aread`), and `mediaLoader`
 * turns it into a real Messages-API base64 block beside it, until the checkpoint covers it
 * or the window's media budget is spent (§5).
 */

import { encodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FilePart, MediaKind } from "../types.ts";
import type { Credentials } from "./credentials.ts";
import { isStored, keyOf, plainKey, type Storage, uriOf } from "./storage.ts";

/** The scheme IS the distinction: `http(s)` = an external link (no local bytes, never
 *  fetched broker-side); `storage://` an object the harness keeps; everything else is a
 *  file on this machine — canonically `file://`, bare paths tolerated on input. */
export function isExternal(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

/** A file uri → its filesystem path (`file://` unwrapped, bare passed through). */
export function pathOf(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/** The bytes a kept or local uri holds: an object through the store, a file off the disk;
 *  null for a link, or when they are gone. */
export async function bytesOf(
  storage: Storage,
  uri: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (isExternal(uri)) return null;
  if (isStored(uri)) return await storage.get(keyOf(uri));
  try {
    return await Deno.readFile(pathOf(uri));
  } catch {
    return null;
  }
}

/** The name a uri's last segment gives a file that carries none. */
export function tailOf(uri: string): string {
  return isStored(uri) ? keyOf(uri).split("/").at(-1)! : basename(pathOf(uri));
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

/** How much of a file `imageSizeOf` reads: a JPEG's frame header can sit behind an EXIF
 *  block of up to 64KB. */
const SIZE_HEAD = 64 * 1024 + 1024;

/** An image's pixels from its header — PNG, JPEG, GIF and WebP — or null for anything
 *  else or a header cut short. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (n: number) => bytes.length >= n;
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  switch (sniffMime(bytes)) {
    case "image/png":
      return has(24) ? size(v.getUint32(16), v.getUint32(20)) : null;
    case "image/gif":
      return has(10) ? size(v.getUint16(6, true), v.getUint16(8, true)) : null;
    case "image/webp": {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8L") {
        if (!has(25)) return null;
        const b = v.getUint32(21, true);
        return size((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
      }
      if (!has(30)) return null;
      if (chunk === "VP8 ") {
        return size(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
      }
      if (chunk === "VP8X") {
        const w = bytes[24] | bytes[25] << 8 | bytes[26] << 16;
        const h = bytes[27] | bytes[28] << 8 | bytes[29] << 16;
        return size(w + 1, h + 1);
      }
      return null;
    }
    case "image/jpeg": {
      // walk the markers to the first start-of-frame (C0–CF, less DHT C4, JPG C8, DAC CC)
      let at = 2;
      while (has(at + 9)) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return size(v.getUint16(at + 7), v.getUint16(at + 5));
        }
        at += 2 + v.getUint16(at + 2);
      }
      return null;
    }
    default:
      return null;
  }
}

/** A kept or local image's pixels, from the head of its bytes; null when it is none or is
 *  gone. */
export async function imageSizeOf(
  storage: Storage,
  uri: string,
): Promise<{ width: number; height: number } | null> {
  if (isExternal(uri)) return null;
  try {
    if (isStored(uri)) {
      const bytes = await storage.get(keyOf(uri));
      return bytes ? imageSize(bytes.subarray(0, SIZE_HEAD)) : null;
    }
    return imageSize(await head(pathOf(uri), SIZE_HEAD));
  } catch {
    return null;
  }
}

/** The git/grep heuristic: a NUL in the head ⇒ not text. The last-resort classifier —
 *  an unknown binary reads as `[binary …]`, never as mojibake. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** The hex digits a media key's hash keeps of the SHA-256: 128 bits. */
const HASH_HEX = 32;

/** What bytes are, as a mime: the wire's word when it names a type, the bytes' own
 *  signature when it names none (`application/octet-stream`, the label a form upload
 *  wears by default), then the name's extension. */
export function mimeFor(bytes: Uint8Array, meta: { mime_type?: string; name?: string }): string {
  // params stripped: the wire says `audio/ogg; codecs=opus`, the maps key on the bare type
  const said = meta.mime_type?.split(";")[0].trim().toLowerCase();
  if (said && said !== "application/octet-stream") return said;
  return sniffMime(bytes) ?? (meta.name ? mimeOf(meta.name) : null) ?? "application/octet-stream";
}

/** Keep bytes as media; returns the `FilePart.file` shape naming the object. Content-hash
 *  named ⇒ idempotent: the same bytes saved twice (re-download, echo, a forward) are one
 *  object, never rewritten. The extension is the bytes': the mime's, else the name's when
 *  it is one, else `bin`. */
export async function saveMedia(
  storage: Storage,
  bytes: Uint8Array,
  meta: { mime_type?: string; name?: string } = {},
): Promise<FilePart["file"]> {
  const mime = mimeFor(bytes, meta);
  // the name's extension only when it IS one — a wire name is free text (a path, a title)
  const base = meta.name?.split("/").at(-1) ?? "";
  const fromName = /^[^.]+\.([A-Za-z0-9]{1,8})$/.exec(base)?.[1] ?? "";
  const ext = (EXT[mime] || fromName || "bin").toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    .slice(0, HASH_HEX);
  const key = `media/${hash}.${ext}`;
  await storage.put(key, bytes, mime);
  return {
    mime_type: mime,
    uri: uriOf(key),
    ...(meta.name ? { name: meta.name } : {}),
    size: bytes.length,
    ...imageSize(bytes),
  };
}

/* ── the pull leg: signed media paths ─────────────────────────────────────── */

/** How long a minted path stays fetchable: long enough for a connector to retry, short
 *  enough that a leaked one is worthless. Nothing else is timed against it. */
const MEDIA_TTL_MS = 10 * 60 * 1000;

/** The vault row holding the signing key (minted on first use, never rotated so far). */
const MEDIA_SECRET_KEY = "media:sign";

/** The signing key, from the vault — the signer (a dispatch) and the verifier (an ingest)
 *  are DIFFERENT PROCESSES over one data root, so the key cannot live in either's memory.
 *  Both read it per use: neither can hold a stale copy of a key the other minted. */
export async function mediaSecret(creds: Credentials): Promise<string> {
  const row = await creds.get(MEDIA_SECRET_KEY);
  if (row?.value.secret) return row.value.secret;
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await creds.put({ key: MEDIA_SECRET_KEY, value: { secret } });
  // re-read: a process racing us on first boot may have written its own, and the DB's
  // answer is the one both of us must sign with
  return (await creds.get(MEDIA_SECRET_KEY))!.value.secret;
}

/** Mint the path a service fetches outbound bytes from, for a kept object. The capability
 *  IS the url — `<expiry>:<key>`, HMAC'd — so verification holds no state and survives a
 *  restart (an in-memory token map does not, and a bridge retry after one would 404).
 *
 *  RELATIVE on purpose. The service already knows where liquen is: liquen's address is the one
 *  IT delivers to. Resolving `/m/…` against that base is the whole reason liquen never has
 *  to be told its own host — the inbound leg's address, reused. */
export async function signMediaPath(
  uri: string,
  secret: string,
  expiresAt = Date.now() + MEDIA_TTL_MS, // the clock seam; tests mint expired paths
): Promise<string> {
  if (!isStored(uri)) throw new Error(`only a kept object is signed: ${uri}`);
  const payload = `${expiresAt}:${keyOf(uri)}`;
  const mac = encodeBase64Url(await sign(secret, payload));
  return `/m/${encodeBase64Url(new TextEncoder().encode(payload))}.${mac}`;
}

/** Serve a signed path, or null when the request is not one — the caller's own routes
 *  take it from there. A bad mac, a stale expiry, and a key outside the media all answer
 *  the same 404: the signature proves who minted it, never that the key is innocent, so
 *  the boundary is checked on its own. */
export async function serveMedia(
  req: Request,
  storage: Storage,
  secret: () => string | Promise<string>, // lazy: the key is only read for OUR route
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/m/")) return null;
  const gone = new Response("gone", { status: 404 });
  const [body, mac] = path.slice(3).split(".");
  if (!body || !mac) return gone;
  let payload: string;
  try {
    payload = new TextDecoder().decode(decodeBase64Url(body));
  } catch {
    return gone;
  }
  if (!await verify(await secret(), payload, mac)) return gone;
  const cut = payload.indexOf(":");
  const expiresAt = Number(payload.slice(0, cut));
  const key = payload.slice(cut + 1);
  if (!(expiresAt > Date.now())) return gone;
  if (!key.startsWith("media/") || !plainKey(key)) return gone;
  const bytes = await storage.get(key).catch(() => null);
  if (!bytes) return gone;
  return new Response(bytes as BodyInit, {
    headers: { "content-type": mimeOf(key) ?? "application/octet-stream" },
  });
}

const hmacKey = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [use],
  );

const sign = async (secret: string, payload: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encode(payload)),
  );

/** `crypto.subtle.verify`, not a string compare — the comparison is constant-time there. */
async function verify(secret: string, payload: string, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      decodeBase64Url(mac) as BufferSource,
      encode(payload),
    );
  } catch {
    return false;
  }
}

const encode = (s: string): BufferSource => new TextEncoder().encode(s) as BufferSource;

/** Where an agent's file references may point (§9 data classification): a relative path
 *  is from `cwd` — where the session's shell stands, the anchor's `cwd:` line — else from
 *  `home`, the agent's own folder; `roots` are the directories a reference may resolve
 *  INTO, symlinks followed first, so a link is judged by where it points. The same ground
 *  the agent's uid can read; the harness reads no further. */
export interface FileScope {
  home: string;
  cwd?: () => string;
  roots: string[];
}

/** The files port (§9): a file reference → the `FilePart` it sends as. `send({files})`
 *  and a tool's attachments both go through it, so where a reference may point and what
 *  it takes to read one is the adapter's whole say. The local adapter is `localFiles`; a
 *  remote sandbox's (`gatewayFiles`) moves the bytes onto the media shelf and answers with
 *  their uri there. */
export interface Files {
  /** Throws when the reference does not exist or points outside what the agent may
   *  attach — the tool_result carries that back as the error it is. */
  resolve(ref: string): Promise<FilePart>;
  /** The bytes a just-resolved part holds NOW, as the block it inlines as — null when it
   *  can't inline (kind, cap, gone). A tool's attachment is a snapshot of a file the agent
   *  keeps rewriting, so its result PINS this (§5): what the model saw stays what it saw,
   *  whatever the path holds by the next step. */
  snapshot(part: FilePart): Promise<MediaBlock | null>;
}

/** The local adapter: this filesystem, under a scope — or, without one, whatever the
 *  process can read. */
export const localFiles = (scope?: FileScope, storage?: Storage): Files => ({
  resolve: (ref) => filePartOf(ref, scope, storage),
  snapshot: (part) => loadMediaBlock(part.file.uri, storage),
});

/** A file reference → a `FilePart` (the send side). A local path (bare or `file://`)
 *  is statted and classified — throws when it doesn't exist or, under a `scope`, when it
 *  resolves outside the scope's roots. A `storage://` uri names an object already kept,
 *  read for its size and kind. An `http(s)` link passes through UNTOUCHED (no fetch, no
 *  size — mime guessed from the URL's extension): the platforms that take links send it
 *  as-is. */
export async function filePartOf(
  ref: string,
  scope?: FileScope,
  storage?: Storage,
): Promise<FilePart> {
  if (isStored(ref)) {
    const bytes = storage ? await storage.get(keyOf(ref)) : null;
    if (!bytes) throw new Error(`${ref}: no such file in storage`);
    const mime = mimeOf(ref) ?? sniffMime(bytes) ?? "application/octet-stream";
    return {
      type: "file",
      kind: kindOf(mime),
      file: {
        mime_type: mime,
        uri: ref,
        name: tailOf(ref),
        size: bytes.length,
        ...(mime.startsWith("image/") ? imageSize(bytes.subarray(0, SIZE_HEAD)) : {}),
      },
    };
  }
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
  const abs = scope
    ? await Deno.realPath(resolve(scope.cwd?.() ?? scope.home, pathOf(ref)))
    : resolve(pathOf(ref));
  if (scope && !scope.roots.some((root) => abs === root || abs.startsWith(`${root}/`))) {
    throw new Error(
      `${ref}: outside your files — attach from your folder or the org's, or a storage:// file`,
    );
  }
  const size = (await Deno.stat(abs)).size;
  const mime = mimeOf(abs) ?? sniffMime(await head(abs)) ?? "application/octet-stream";
  const uri = pathToFileURL(abs).toString();
  return {
    type: "file",
    kind: kindOf(mime),
    file: {
      mime_type: mime,
      uri,
      name: basename(abs),
      size,
      ...(mime.startsWith("image/") ? imageSize(await head(abs, SIZE_HEAD)) : {}),
    },
  };
}

/** The first bytes of a file (sniffing window) — never the whole thing. */
async function head(path: string, n = 16): Promise<Uint8Array> {
  const f = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(n);
    let at = 0;
    for (;;) {
      const r = await f.read(buf.subarray(at));
      if (r === null || (at += r) >= n) break;
    }
    return buf.subarray(0, at);
  } finally {
    f.close();
  }
}

/** Raw-byte cap for inlining into a request (base64 ≈ ×4/3; the API caps ~5MB/image).
 *  Render budgets on it too: a file above it never loads, so it never spends. */
export const INLINE_CAP = 3 * 1024 * 1024;

/** What the model can SEE inline: images (not svg) and PDFs (§5 — the trailing-region
 *  blocks). One rule, applied by the loader to the bytes and by render to the known mime. */
export const inlineable = (mime: string): boolean =>
  mime.startsWith("image/") && mime !== "image/svg+xml" || mime === "application/pdf";

/** A stored file as the Messages-API block it inlines as (§5): the mime, and the bytes in
 *  base64. */
export interface MediaBlock {
  media_type: string;
  data: string;
}

/** The media port (§5): the bytes behind a uri, as a block — or null when there is nothing
 *  to inline (not inlineable, over the cap, gone). The file adapter is `loadMediaBlock`;
 *  an adapter over a blob store answers the same question under its own uri scheme. */
export type MediaLoader = (uri: string) => Promise<MediaBlock | null>;

/** A loader remembered across calls: a RECEIVED file is content-named, so what its uri
 *  holds never changes, and a tool loop renders the same trailing attachments on every
 *  step. A tool's attachment is a workspace path that does change — its bytes ride on the
 *  result (`extra.media`, pinned by `Files.snapshot`), so no loader is asked for them.
 *  Bounded by the raw bytes held — the oldest entry goes first. A miss is not remembered:
 *  the file may still be on its way. */
export function memoizedLoader(load: MediaLoader, capBytes = MEDIA_MEMO_BYTES): MediaLoader {
  const held = new Map<string, MediaBlock>();
  let size = 0;
  return async (uri) => {
    const hit = held.get(uri);
    if (hit) return hit;
    const b = await load(uri);
    if (!b) return null;
    held.set(uri, b);
    size += b.data.length;
    for (const [k, v] of held) {
      if (size <= capBytes) break;
      held.delete(k);
      size -= v.data.length;
    }
    return b;
  };
}

/** Base64 held by `memoizedLoader` at most, across every agent this process renders. */
const MEDIA_MEMO_BYTES = 64 * 1024 * 1024;

/** The media port's adapter: a kept object or a local file → the base64 payload for a
 *  Messages-API image/document block, or null (not inlineable, over the cap, missing, an
 *  object with no store to ask). Only TRAILING-region files are ever asked for, so the
 *  reads are few and recent. */
export async function loadMediaBlock(uri: string, storage?: Storage): Promise<MediaBlock | null> {
  if (isExternal(uri)) return null; // external links inline as url-source blocks, not bytes
  if (isStored(uri) && !storage) return null;
  const named = mimeOf(isStored(uri) ? keyOf(uri) : pathOf(uri)); // a nameless file sniffs
  if (named && !inlineable(named)) return null;
  try {
    const bytes = isStored(uri) ? await storage!.get(keyOf(uri)) : await Deno.readFile(pathOf(uri));
    if (!bytes || bytes.length > INLINE_CAP) return null;
    const mime = named ?? sniffMime(bytes);
    if (!mime || !inlineable(mime)) return null;
    return { media_type: mime, data: encodeBase64(bytes) };
  } catch {
    return null;
  }
}
