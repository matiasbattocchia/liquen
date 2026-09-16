/**
 * update.ts — `liquen update`: the org onto the newest release of the harness (§9).
 *
 *   liquen update
 *
 * The org's `deno.jsonc` pins `@liquen/liquen` and its lock names the exact version every task
 * runs, so updating is one `deno outdated --update` against that manifest and nothing else —
 * no download of this command's own, no version it knows. The flags are the whole opinion:
 *
 *   `--latest`        the package IS the harness, so an org follows it past the range it was
 *                     born with instead of sitting on a line that stopped moving.
 *   `--min-dep-age 0` the registry is ours and a release is meant to be used the hour it
 *                     publishes. Deno's default holds back anything younger than a day and,
 *                     on a range, resolves to the newest version old enough — BACKWARDS, past
 *                     the very release the update was asked for.
 *   `@liquen/liquen`  only the harness is named: an org's own dependencies are its business.
 *
 * The lock is read either side of the run, so the command answers in the only terms that
 * matter — a version to a version — and a run in progress is named, because the new code
 * reaches it at the next boot and never before.
 *
 * An org that LINKS a checkout is refused instead: it runs that folder's files whatever the
 * lock resolved, so the version this command would print about it is not the code it runs.
 */

import { parse } from "@std/jsonc";
import { findRoot, orgFlag } from "./config.ts";
import { entry } from "./entry.ts";
import { holder } from "./stop.ts";

/** The package an org runs on — the one dependency this command is about. */
export const PACKAGE = "@liquen/liquen";

/** The version the lock pins the harness at, or null when the org has no lock, or none for
 *  this package: an org that has never been run has nothing resolved yet. */
export function pinned(root: string): string | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(`${root}/deno.lock`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const lock = JSON.parse(text) as { specifiers?: Record<string, string> };
  for (const [spec, version] of Object.entries(lock.specifiers ?? {})) {
    if (spec.startsWith(`jsr:${PACKAGE}@`)) return version;
  }
  return null;
}

/** One manifest, under either spelling. */
function manifest(dir: string): { name?: string; links?: unknown } | null {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      return parse(Deno.readTextFileSync(`${dir}/${name}`)) as { name?: string; links?: unknown };
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

/** The checkout this org links the harness to, if it links one — the dev shape, where the
 *  registry is stood in for by a folder. */
export function linked(root: string): string | null {
  const links = manifest(root)?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (typeof link !== "string") continue;
    const dir = link.startsWith("/") ? link : `${root}/${link}`;
    if (manifest(dir)?.name === PACKAGE) return dir;
  }
  return null;
}

if (import.meta.main) {
  await entry(async () => {
    const root = findRoot(orgFlag());
    const checkout = linked(root);
    if (checkout !== null) {
      throw new Error(
        `${checkout} is linked into this org — every task already runs that checkout, ` +
          `and no release can update it`,
      );
    }
    const before = pinned(root);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["outdated", "--update", "--latest", "--min-dep-age", "0", PACKAGE],
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    if (!status.success) {
      throw new Error(
        `deno outdated exited ${status.signal ?? `with ${status.code}`} — the org is unchanged`,
      );
    }
    const after = pinned(root);
    const shown = (v: string | null) => v ?? "nothing";
    console.log(
      after === before
        ? `${PACKAGE} ${shown(after)} — already the newest release`
        : `${PACKAGE} ${shown(before)} → ${shown(after)}`,
    );
    const pid = await holder(`${root}/data`);
    if (pid !== null) {
      console.log(
        `running as pid ${pid} — \`liquen stop\` then \`liquen start\` to run the new one`,
      );
    }
  });
}
