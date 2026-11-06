/**
 * hole.ts — a file that only grows, kept to a size on disk (§9): a background job's output
 * and the run log. Past its cap, the file gives its older half back to the disk as a hole
 * punched up to the newer half's first line (`fallocate --punch-hole`). The offsets stay:
 * a reader that keeps one reads on, a `tail -f` follows, and what the writer appends
 * meanwhile lies past the size the hole was measured at, out of its reach.
 */

/** How far past the halfway mark a cut looks for the line it falls after. */
const LINE_REACH = 64 * 1024;

/** Punch the head of `path` when it holds more than `cap` on disk, up to the first line
 *  that starts past `size - cap / 2`; the offset the live part starts at, or undefined
 *  when nothing was punched. */
export async function halve(path: string, cap: number): Promise<number | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return undefined;
  }
  let cut: number;
  try {
    const stat = await file.stat();
    if ((stat.blocks ?? 0) * 512 <= cap) return undefined;
    const start = stat.size - cap / 2;
    const head = new Uint8Array(Math.min(LINE_REACH, stat.size - start));
    await file.seek(start, Deno.SeekMode.Start);
    let at = 0;
    while (at < head.length) {
      const n = await file.read(head.subarray(at));
      if (n === null) break;
      at += n;
    }
    cut = start + head.subarray(0, at).indexOf(10) + 1;
  } finally {
    file.close();
  }
  const args = ["--punch-hole", "--offset", "0", "--length", String(cut), path];
  const { success } = await new Deno.Command("fallocate", { args, stderr: "null" }).output();
  return success ? cut : undefined;
}
