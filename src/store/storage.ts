/**
 * store/storage.ts — the object store (§8): the bytes the harness keeps, behind one port.
 *
 * An object is named `storage://<key>`, and the key is all the log ever holds of it: no
 * host path, no bucket, so the store can move without a row changing. Media is
 * `media/<hash>.<ext>`, the hash the bytes' SHA-256 cut to 32 hex (128 bits) in one
 * namespace for the org, so a file forwarded to three chats is kept once, and the
 * extension the bytes' own (`saveMedia`). The store holds blobs, never docs: discovery
 * walks no part of it.
 *
 * The filesystem backend keeps an object at `data/storage/<key>`, written once: the same
 * key is the same bytes, so a second put is a no-op.
 */

/** The scheme of an object the harness keeps. */
export const STORAGE_SCHEME = "storage://";

export interface Storage {
  /** Keep `bytes` under `key`, unless the key is kept already (the same key is the same
   *  bytes). */
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** The bytes under `key`, or null when none are kept. */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Let the bytes under `key` go; a key not kept is no error. */
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, with when it was kept. */
  keys(prefix: string): AsyncIterable<{ key: string; at: Date }>;
}

/** Whether a uri names an object the harness keeps. */
export const isStored = (uri: string): boolean => uri.startsWith(STORAGE_SCHEME);

/** The key a `storage://` uri names. */
export const keyOf = (uri: string): string => uri.slice(STORAGE_SCHEME.length);

/** The uri a key is named by. */
export const uriOf = (key: string): string => `${STORAGE_SCHEME}${key}`;

/** The kept objects a row's parts name, each once: what its references are. */
export function keptIn(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const uris = parts.flatMap((p) => {
    const uri = (p as { type?: unknown; file?: { uri?: unknown } })?.file?.uri;
    return (p as { type?: unknown })?.type === "file" && typeof uri === "string" && isStored(uri)
      ? [uri]
      : [];
  });
  return [...new Set(uris)];
}

/** How long an object no event references is kept: an upload lands before its message
 *  (the bridge's order, a remote attachment before its tool result), and one whose
 *  message never landed is let go after this. */
export const UNREFERENCED_KEEP_MS = 24 * 3_600_000;

/** References keep an object (§8): let go of every one under `prefix` that no event
 *  references and that was kept longer ago than `UNREFERENCED_KEEP_MS`. Answers how many
 *  went. */
export async function collect(
  storage: Storage,
  referenced: (uri: string) => Promise<boolean>,
  prefix = "media/",
  now = Date.now(),
): Promise<number> {
  let gone = 0;
  for await (const { key, at } of storage.keys(prefix)) {
    if (now - at.getTime() < UNREFERENCED_KEEP_MS) continue;
    if (await referenced(uriOf(key))) continue;
    await storage.delete(key);
    gone++;
  }
  return gone;
}

/** A key is a relative path of plain segments: nothing in it can reach outside the store. */
export function plainKey(key: string): boolean {
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) &&
    !key.split("/").some((s) => s === "." || s === "..");
}

/** The filesystem backend, under the data root `dir`. */
export function fileStorage(dir: string): Storage {
  const root = `${dir}/storage`;
  const at = (key: string) => {
    if (!plainKey(key)) throw new Error(`not a storage key: ${key}`);
    return `${root}/${key}`;
  };
  return {
    async put(key, bytes) {
      const path = at(key);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      // written beside, then renamed: a reader never meets half an object
      const tmp = `${path}.${crypto.randomUUID()}.part`;
      await Deno.writeFile(tmp, bytes);
      try {
        await Deno.link(tmp, path);
      } catch (err) {
        if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
      } finally {
        await Deno.remove(tmp).catch(() => {});
      }
    },
    async get(key) {
      try {
        return await Deno.readFile(at(key));
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return null;
        throw err;
      }
    },
    async delete(key) {
      await Deno.remove(at(key)).catch((err) => {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      });
    },
    async *keys(prefix) {
      const walk = async function* (rel: string): AsyncGenerator<{ key: string; at: Date }> {
        let entries: Deno.DirEntry[];
        try {
          entries = await Array.fromAsync(Deno.readDir(`${root}/${rel}`));
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return;
          throw err;
        }
        for (const e of entries) {
          const key = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory) yield* walk(key);
          else if (e.isFile && !e.name.endsWith(".part")) {
            const stat = await Deno.stat(`${root}/${key}`).catch(() => null);
            if (stat) yield { key, at: stat.mtime ?? new Date(0) };
          }
        }
      };
      const base = prefix.replace(/\/+$/, "");
      for await (const k of walk(base)) if (k.key.startsWith(prefix)) yield k;
    },
  };
}
