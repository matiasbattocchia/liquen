/**
 * inputs.ts — what a step's request was made of, as a hash per input, so a reader of the
 * log can tell which turns read changed instructions, tools or settings (`liquen log
 * turns`). Only hashes are kept: a hash says THAT an input changed, and the input's
 * contents stay where they live — the docs store, the org's folder.
 *
 * An input's name is what a person would look for: a doc by its scope and name
 * (`shared/instructions/sonar`), a tool by its name (`tool/bash`), a program file by its
 * path under the folder that put it on PATH (`bin/sonar-cli/api.ts`), the agent's settings
 * as `config`, the package as `liquen` (whose value is its version, not a hash).
 *
 * A step stamps the set on its first row (`extra.inputs`) only when it differs from the
 * last set the session stamped, so the log carries one row per change and the history
 * between two stamps read the same inputs. A process that starts stamps its first step.
 */

import { relative } from "node:path";
import type { DocEntry, DocRef } from "./store/docs.ts";
import type { BinDir } from "./types.ts";
import { packageManifest } from "./package.ts";

/** Each input's name and its content hash (the package's: its version). */
export type Inputs = Record<string, string>;

/** Workspace noise a program folder never contributes. */
const SKIP = new Set([".git", "node_modules", ".out"]);
/** How many files one program folder contributes at most. */
const FILES = 1_000;

/** The first 12 hex digits of a text's SHA-256 — enough to tell versions apart. */
export async function hashOf(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a step's request was made of. `read` pulls a doc's body the list left out (a lazy
 *  doc), `settings` is the agent's turn configuration, `version` the package's. */
export async function inputsOf(parts: {
  docs: DocEntry[];
  read: (ref: DocRef) => Promise<string | null>;
  tools: unknown[];
  bins?: BinDir[];
  settings: Record<string, unknown>;
  version?: string;
}): Promise<Inputs> {
  const out: Inputs = {};
  for (const { header, body } of parts.docs) {
    if (header.kind === "memory") continue; // what the agent writes for itself, every turn
    const text = body ?? await parts.read(header) ?? "";
    out[`${header.scope}/${header.name}`] = await hashOf(
      `${JSON.stringify({ description: header.description, load: header.load })}\n${text}`,
    );
  }
  for (const tool of parts.tools) {
    const name = (tool as { name?: string }).name ?? "?";
    out[`tool/${name}`] = await hashOf(JSON.stringify(tool));
  }
  for (const bin of parts.bins ?? []) {
    for (const [path, bytes] of await filesUnder(bin.dir)) {
      out[`bin/${relative(bin.dir, path)}`] = await hashOf(bytes);
    }
  }
  out.config = await hashOf(JSON.stringify(parts.settings, Object.keys(parts.settings).sort()));
  if (parts.version) out.liquen = parts.version;
  return out;
}

/** A folder's files, depth first, sorted, symlinks followed; nothing when it is gone. */
async function filesUnder(dir: string): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  const walk = async (here: string) => {
    let names: Deno.DirEntry[];
    try {
      names = await Array.fromAsync(Deno.readDir(here));
    } catch {
      return;
    }
    names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of names) {
      if (out.length >= FILES || SKIP.has(e.name)) continue;
      const path = `${here}/${e.name}`;
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(path);
      } catch {
        continue; // a dangling link
      }
      if (info.isDirectory) await walk(path);
      else if (info.isFile) {
        try {
          out.push([path, await Deno.readFile(path)]);
        } catch { /* unreadable: not an input this step could have run */ }
      }
    }
  };
  await walk(dir);
  return out;
}

/** The names whose hash differs between two sets — added, removed or changed — sorted. */
export function changedInputs(before: Inputs, after: Inputs): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

/** Two sets that name the same inputs with the same hashes. */
export function sameInputs(a: Inputs | undefined, b: Inputs): boolean {
  return a !== undefined && changedInputs(a, b).length === 0;
}

/** The package's version, when its manifest can be read (`package.ts`). */
export async function packageVersion(): Promise<string | undefined> {
  return (await packageManifest()).version;
}
