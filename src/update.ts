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
 * An org that LINKS a checkout has no release to move to: it runs that folder's files
 * whatever the lock resolved, so the version this command would print about it is not the
 * code it runs, and it is said so.
 *
 * Every org's task list is then brought up to the scaffold's (`--tasks` does that alone): a
 * task the package ships and the org lacks is added the way the scaffold spells it, so
 * `liquen` names every command of the release the org runs. A task the org has is its own —
 * one whose command differs from the package's is named with the package's, never
 * rewritten. The scaffold read is the NEW release's: once the lock moves, the sync runs as
 * `update --tasks` through the org's own import map, which now resolves to it.
 */

import { parse } from "@std/jsonc";
import { findRoot, orgFlag, withMember } from "./config.ts";
import { entry } from "./entry.ts";
import { running } from "./stop.ts";

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

/** A deno task, in either of the forms the manifest takes. */
export type Task = string | { command: string; description?: string };

const commandOf = (t: Task): string => typeof t === "string" ? t : t.command;

interface Manifest {
  name?: string;
  links?: unknown;
  tasks?: Record<string, Task>;
}

/** The path of the manifest in `dir`, under either spelling, or null. */
function manifestPath(dir: string): string | null {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      Deno.statSync(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

/** One manifest, under either spelling. */
function manifest(dir: string): Manifest | null {
  const path = manifestPath(dir);
  return path === null ? null : parse(Deno.readTextFileSync(path)) as Manifest;
}

/** The tasks an org made from this release carries — the scaffold beside this module,
 *  fetched because the module's URL is the registry's when it runs off it. */
export async function scaffoldTasks(): Promise<Record<string, Task>> {
  const res = await fetch(new URL("./scaffold/deno.jsonc", import.meta.url));
  return (parse(await res.text()) as Manifest).tasks ?? {};
}

/** The org's task list brought up to `scaffold`: each task it lacks inserted, whole lines
 *  in its manifest with every other byte as it was; one it holds as the package's command
 *  alone given the package's description; one it holds with a different command named,
 *  untouched. */
export async function syncTasks(
  root: string,
  scaffold: Record<string, Task>,
): Promise<{ added: string[]; differing: [string, string][] }> {
  const path = manifestPath(root);
  if (path === null) throw new Error(`${root} has no deno.json or deno.jsonc`);
  const raw = await Deno.readTextFile(path);
  const have = (parse(raw) as Manifest).tasks ?? {};
  let text = raw;
  const added: string[] = [];
  const differing: [string, string][] = [];
  let described = false;
  for (const [name, task] of Object.entries(scaffold)) {
    const rendered = JSON.stringify(task, null, 2).replaceAll("\n", "\n    ");
    const held = have[name];
    if (held === undefined) {
      text = withMember(text, "tasks", `"${name}": ${rendered}`, path);
      added.push(name);
    } else if (commandOf(held) !== commandOf(task)) {
      differing.push([name, commandOf(task)]);
    } else if (typeof held === "string" && typeof task !== "string") {
      // the package's own command, bare: it takes the package's description with it, so
      // the list `liquen` prints describes every command alike
      const bare = new RegExp(`"${name}"\\s*:\\s*${escape(JSON.stringify(held))}`);
      const next = text.replace(bare, `"${name}": ${rendered}`);
      described ||= next !== text;
      text = next;
    }
  }
  if (added.length > 0 || described) {
    parse(text); // a manifest that would not read back is never written
    await Deno.writeTextFile(path, text);
  }
  return { added, differing };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sync, said: what was added, and each task of the org's own the package spells
 *  otherwise. */
async function tasks(root: string): Promise<void> {
  const { added, differing } = await syncTasks(root, await scaffoldTasks());
  if (added.length > 0) console.log(`tasks added: ${added.join(" · ")}`);
  for (const [name, command] of differing) {
    console.log(`task ${name} is your own — the package's runs: ${command}`);
  }
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
    const org = orgFlag();
    const root = findRoot(org);
    if (org.args.includes("--tasks")) return await tasks(root);
    const checkout = linked(root);
    if (checkout !== null) {
      console.log(
        `${checkout} is linked into this org — every task already runs that checkout, ` +
          `and no release can update it`,
      );
      return await tasks(root);
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
    if (after === before) await tasks(root);
    else {
      const sync = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", `${PACKAGE}/update`, "--tasks"],
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status;
      if (!sync.success) {
        throw new Error(`the task sync exited with ${sync.code} — tasks unchanged`);
      }
    }
    const live = await running(`${root}/data`);
    if (live.size > 0) {
      const who = [...live].map(([role, pid]) => `${role} (${pid})`).join(" · ");
      console.log(`running ${who} — \`liquen stop\` then \`liquen start\` to run the new one`);
    }
  });
}
