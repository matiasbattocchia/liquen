/**
 * bin/afs.ts — the filesystem binaries (DESIGN §9): aread · awrite · aedit.
 *
 * One source, three commands, invoked from the agent's bash via PATH shims (dev) or
 * `deno compile` outputs (image). Their contracts are the spec the db substrate's helper
 * functions mirror later (§9 symmetry).
 *
 *   afs read <path> [offset] [limit] [maxBytes]   head-truncated; continuation footer;
 *                                                 1-indexed; limit/maxBytes override the
 *                                                 default truncation (2000 lines / 50KB)
 *   afs write <path>                   content on stdin; creates parent dirs; overwrites
 *   afs edit <path>                    conflict-marker multi-edit spec on stdin
 *
 * Hardened for shared workspaces (an SMB mount as a workspace folder, §9): `edit` holds an
 * exclusive flock on the target for the whole read-modify-write (on a cifs mount that maps
 * to server-side byte-range locks, so it also serializes against Office apps), re-checking
 * the inode after acquiring (a rename-under-us retries); both `edit` and `write` commit via
 * temp + fsync + rename — atomic on the server, so a crash or dropped connection mid-write
 * can never leave a truncated file — preserving the original file's mode.
 */

import { applyEdits, parseEdits } from "../exec/edit.ts";
import { truncateHead } from "../exec/truncate.ts";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
  let size = 0;
  for (const c of chunks) size += c.length;
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

async function read(
  path: string,
  offset?: number,
  limit?: number,
  maxBytes?: number,
): Promise<string> {
  const content = await Deno.readTextFile(path);
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const start = offset ? Math.max(0, offset - 1) : 0;
  if (lines.length > 0 && start >= lines.length) {
    throw new Error(`offset ${offset} is beyond end of file (${lines.length} lines)`);
  }
  const window = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
  const t = truncateHead(window.join("\n"), { maxBytes, maxLines: limit });
  if (t.shownLines === 0 && window.length > 0) {
    return `[line ${start + 1} alone exceeds the byte cap (${maxBytes} bytes) — raise maxBytes: ` +
      `aread ${path} ${start + 1} ${limit ?? ""}`.trimEnd() + " <bytes>]";
  }
  const shownEnd = start + t.shownLines;
  const footer = shownEnd < lines.length
    ? `\n\n[showing lines ${start + 1}-${shownEnd} of ${lines.length} — continue: aread ${path} ${
      shownEnd + 1
    }]`
    : "";
  return t.text + footer;
}

async function write(path: string): Promise<string> {
  const content = await readStdin();
  const dir = path.replace(/\/[^/]*$/, "");
  if (dir && dir !== path) await Deno.mkdir(dir, { recursive: true });
  await commit(path, content); // atomic replace — a blind overwrite by contract, no lock
  return `wrote ${new TextEncoder().encode(content).length} bytes to ${path}`;
}

async function edit(path: string): Promise<string> {
  const spec = await readStdin();
  const edits = parseEdits(spec);
  // RMW under an exclusive lock: nothing may change the file between our read and our
  // commit. The lock is on the inode, so after acquiring we verify the path still points
  // at it (an atomic-replace by another writer while we waited → retry on the new file).
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await Deno.open(path, { read: true, write: true });
    try {
      await handle.lock(true);
      const [hStat, pStat] = [await handle.stat(), await Deno.stat(path)];
      if (hStat.ino !== null && pStat.ino !== null && hStat.ino !== pStat.ino) continue;
      const raw = new TextDecoder().decode(await readAll(handle));
      await commit(path, applyEdits(raw, edits));
      return `applied ${edits.length} edit(s) to ${path}`;
    } finally {
      handle.close(); // releases the lock
    }
  }
  throw new Error(`${path}: kept changing underneath (atomic replaces) — retry`);
}

async function readAll(handle: Deno.FsFile): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(64 * 1024);
  let size = 0;
  for (let n = await handle.read(buf); n !== null; n = await handle.read(buf)) {
    chunks.push(buf.slice(0, n));
    size += n;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/** Atomic replace: temp in the same dir (same fs — rename is atomic there), fsync, rename.
 *  A crash or dropped share mid-write can never leave a truncated target. Preserves the
 *  original file's mode (rename would otherwise leave the temp's default). */
async function commit(path: string, content: string): Promise<void> {
  const mode = await Deno.stat(path).then((s) => s.mode, () => null);
  const dir = path.includes("/") ? path.replace(/\/[^/]*$/, "") : ".";
  const tmp = `${dir}/.${path.split("/").pop()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  const out = await Deno.open(tmp, { create: true, write: true, truncate: true });
  try {
    await out.write(new TextEncoder().encode(content));
    await out.sync();
  } finally {
    out.close();
  }
  try {
    if (mode !== null) await Deno.chmod(tmp, mode);
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** CLI entry — also callable from the multi-call task binary (`mu-task afs …`). */
export async function run(args: string[]): Promise<number> {
  const [cmd, path, ...rest] = args;
  try {
    if (!path) throw new Error("usage: afs read|write|edit <path> [args]");
    if (cmd === "read") {
      const [offset, limit, maxBytes] = rest.map((n) => n === undefined ? undefined : Number(n));
      console.log(await read(path, offset, limit, maxBytes));
    } else if (cmd === "write") console.log(await write(path));
    else if (cmd === "edit") console.log(await edit(path));
    else throw new Error(`unknown command: ${cmd}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) Deno.exit(await run(Deno.args));
