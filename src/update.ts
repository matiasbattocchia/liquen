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
 * Every org is then synced to the release it runs (`--sync` does that alone). Its task list
 * is brought up to the scaffold's: a task the package ships and the org lacks is added the
 * way the scaffold spells it, so `liquen` names every command of the release the org runs.
 * A task the org has is its own — one whose command differs from the package's is named
 * with the package's, never rewritten. The docs under `data/system/` are brought too, by
 * the function boot runs (`bringSystemDocs`, store/seed.ts), against the manifest the
 * store keeps: one new in this release is laid, one the org left as the last release had
 * it takes the new words, one the release dropped goes. What boot leaves alone this
 * command settles: a doc the org edited or deleted and this release changed is asked
 * about at a terminal, or answered by a flag — `--restore`, `--replace`, `--beside`,
 * `--keep`, each naming docs or, bare, every doc it fits — and without either is left as
 * it is, named with the flags that settle it. The scaffold and the templates read are the
 * NEW release's: once the lock moves, the sync runs as `update --sync` through the org's
 * own import map, which now resolves to it.
 */

import { parse } from "@std/jsonc";
import { findRoot, orgFlag } from "./config.ts";
import { withMember, withoutMember } from "./jsonc.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { running } from "./stop.ts";
import { packageManifest } from "./package.ts";
import { openStore } from "./store/mod.ts";
import { bringSystemDocs, type Choice, choicesFor, type Pending } from "./store/seed.ts";

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

/** The commands this release exports, by subpath (`log`, `start`, …), or undefined when
 *  its manifest cannot be read (`package.ts`). */
export async function packageCommands(): Promise<string[] | undefined> {
  const exports = (await packageManifest()).exports;
  return exports && Object.keys(exports).map((k) => k.replace(/^\.\/?/, "")).filter(Boolean);
}

/** The package command a task runs, when it runs one: `@liquen/liquen/<subpath>`. */
const runsOf = (t: Task): string | undefined =>
  commandOf(t).match(new RegExp(`${escape(PACKAGE)}/([a-z][a-z0-9-]*)`))?.[1];

/** The org's task list brought up to `scaffold`: each task it lacks inserted, whole lines
 *  in its manifest with every other byte as it was; one it holds as the package's command
 *  alone given the package's description; one it holds with a different command named,
 *  untouched. A task running a command the release does not export (`commands`) is gone
 *  when it is the package's own, named after the command, and named as broken when it is
 *  the org's. */
export async function syncTasks(
  root: string,
  scaffold: Record<string, Task>,
  commands?: string[],
): Promise<
  { added: string[]; differing: [string, string][]; removed: string[]; broken: string[] }
> {
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
  const removed: string[] = [];
  const broken: string[] = [];
  for (const [name, task] of Object.entries(have)) {
    const runs = runsOf(task);
    if (commands === undefined || runs === undefined || commands.includes(runs)) continue;
    if (name === runs && !(name in scaffold)) {
      text = withoutMember(text, "tasks", name, path);
      removed.push(name);
    } else broken.push(name);
  }
  if (added.length > 0 || described || removed.length > 0) {
    parse(text); // a manifest that would not read back is never written
    await Deno.writeTextFile(path, text);
  }
  return { added, differing, removed, broken };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sync, said: what was added, and each task of the org's own the package spells
 *  otherwise. */
async function tasks(root: string): Promise<void> {
  const { added, differing, removed, broken } = await syncTasks(
    root,
    await scaffoldTasks(),
    await packageCommands(),
  );
  if (added.length > 0) console.log(`tasks added: ${added.join(" · ")}`);
  if (removed.length > 0) console.log(`tasks removed: ${removed.join(" · ")}`);
  for (const name of broken) {
    console.log(`task ${name} runs a command this release does not have — edit or remove it`);
  }
  for (const [name, command] of differing) {
    console.log(`task ${name} is your own — the package's runs: ${command}`);
  }
}

/** The choices a person gave on the command line, each with the docs it names; a choice
 *  with no name is for every doc it fits. */
export type Chosen = Partial<Record<Choice, string[]>>;

/** What a pending doc is, in a sentence. */
function described(p: Pending): string {
  const doc = `system/${p.doc}.md`;
  if (p.state === "deleted") return `${doc} is deleted here, and this release changed it`;
  if (p.state === "dropped") return `${doc} is edited here, and this release no longer ships it`;
  return `${doc} is edited here, and this release changed it`;
}

/** What each choice does to a pending doc, as the question names it. */
const MEANS: Record<Choice, string> = {
  replace: "take the release's word",
  restore: "lay it again",
  beside: "lay the release's beside it as .md.new",
  keep: "keep the org's",
};

/** The system docs brought to this release (`bringSystemDocs`), said. Each doc only a
 *  person can settle is settled by `chosen`, else asked at a terminal, else left as the
 *  org has it and named with the flags that settle it. */
async function systemDocs(root: string, chosen: Chosen): Promise<void> {
  const store = await openStore(root);
  const docs = await store.docs();
  const log = await store.log();
  try {
    const decide = (p: Pending): Promise<Choice | undefined> => {
      const fits = choicesFor(p, docs.bed);
      for (const choice of fits) {
        const named = chosen[choice];
        if (named && (named.length === 0 || named.includes(p.doc))) return Promise.resolve(choice);
      }
      if (!Deno.stdin.isTerminal()) return Promise.resolve(undefined);
      const menu = fits.map((c) => `${c} (${MEANS[c]})`).join(", ");
      const said = prompt(`${described(p)} — ${menu}, or nothing to leave it:`)?.trim();
      return Promise.resolve(fits.find((c) => c === said));
    };
    const b = await bringSystemDocs(docs.bed, log, decide);
    if (b.laid.length > 0) console.log(`system docs laid: ${b.laid.join(" · ")}`);
    if (b.replaced.length > 0) {
      console.log(`system docs brought to this release: ${b.replaced.join(" · ")}`);
    }
    if (b.deleted.length > 0) {
      console.log(`system docs this release no longer ships, removed: ${b.deleted.join(" · ")}`);
    }
    if (b.beside.length > 0) {
      console.log(
        `the release's words laid beside yours: ${
          b.beside.map((d) => `system/${d}.md.new`).join(" · ")
        } — \`liquen update --keep <doc>\` once yours holds what you want of them`,
      );
    }
    for (const p of b.pending.filter((p) => !b.beside.includes(p.doc))) {
      const flags = choicesFor(p, docs.bed).map((c) => `--${c} ${p.doc}`).join(" | ");
      console.log(`${described(p)} — left as it is; \`liquen update ${flags}\` settles it`);
    }
  } finally {
    await log.close();
    await docs.close();
  }
}

/** The org synced to the release it runs: its tasks, then its system docs. */
async function sync(root: string, chosen: Chosen): Promise<void> {
  await tasks(root);
  await systemDocs(root, chosen);
}

/** The choices as the arguments that say them. */
function flagsOf(chosen: Chosen): string[] {
  return Object.entries(chosen).flatMap(([choice, docs]) => [`--${choice}`, ...docs]);
}

/** The sync, run as the release the org's import map resolves to, with the org's `.env`
 *  where it has one: a docs table is reached with PGPASSWORD. */
async function synced(root: string, chosen: Chosen): Promise<void> {
  const env = await Deno.stat(`${root}/.env`).then(() => ["--env-file=.env"], () => []);
  const status = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ...env, `${PACKAGE}/update`, "--sync", ...flagsOf(chosen)],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`the sync exited with ${status.code}`);
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

export const USAGE =
  `usage: liquen update [--restore [<doc>…]] [--replace [<doc>…]] [--beside [<doc>…]]
                     [--keep [<doc>…]] [--dir <org>]

  Move the org onto the newest release of liquen, then bring its tasks and the docs under
  data/system/ up to that release's. A doc you left as the last release had it takes the
  new words; one you edited or deleted, and this release changed, is yours to settle — at
  the prompt, or with a flag (a doc is named as it lies under data/system/, tools/bash;
  no name means every doc the flag fits):

  --restore   lay again a doc you deleted
  --replace   take the release's words over yours, and delete a doc it no longer ships
  --beside    lay the release's words beside yours, as <doc>.md.new
  --keep      keep yours: the doc is quiet until a release changes it again`;

const CHOICES: readonly Choice[] = ["restore", "replace", "beside", "keep"];

/** The command line, `--dir` taken out: whether this is the release's own second half
 *  (`--sync`), and the choices given, each flag followed by the docs it names. */
export function parseUpdateArgs(args: string[]): { sync: boolean; chosen: Chosen } {
  const chosen: Chosen = {};
  let sync = false;
  let into: string[] | undefined;
  for (const arg of args) {
    if (arg === "--sync") {
      sync = true;
      into = undefined;
    } else if (arg.startsWith("--") && (CHOICES as readonly string[]).includes(arg.slice(2))) {
      into = chosen[arg.slice(2) as Choice] ??= [];
    } else if (arg.startsWith("-") || into === undefined) {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    } else into.push(arg.replace(/^system\//, "").replace(/\.md$/, ""));
  }
  return { sync, chosen };
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    // --sync is the release's own second half, not a person's word
    const { sync: second, chosen } = parseUpdateArgs(org.args);
    const root = findRoot(org);
    if (second) return await sync(root, chosen);
    const checkout = linked(root);
    if (checkout !== null) {
      console.log(
        `${checkout} is linked into this org — every task already runs that checkout, ` +
          `and no release can update it`,
      );
      return await synced(root, chosen);
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
    await synced(root, chosen);
    const live = await running(`${root}/data`);
    if (live.size > 0) {
      const who = [...live].map(([role, pid]) => `${role} (${pid})`).join(" · ");
      console.log(`running ${who} — \`liquen stop\` then \`liquen start\` to run the new one`);
    }
  });
}
