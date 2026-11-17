/**
 * package.ts — this release's own manifest: its version and the commands it exports.
 *
 * A checkout reads `deno.json` beside `src/`. The registry serves no manifest file; it
 * serves the module under a URL that names the version (`jsr.io/@liquen/liquen/<v>/src/…`)
 * and that version's metadata (`<v>_meta.json`), whose `exports` are the manifest's.
 */

export interface PackageManifest {
  version?: string;
  /** The manifest's exports, by subpath (`./log`) to module. */
  exports?: Record<string, string>;
}

const JSR = /^(https:\/\/jsr\.io\/@[^/]+\/[^/]+)\/([^/]+)\/src\//;

let manifest: Promise<PackageManifest> | undefined;

/** The manifest of the release this module was loaded from; empty when it cannot be read. */
export function packageManifest(): Promise<PackageManifest> {
  manifest ??= read(import.meta.url);
  return manifest;
}

/** What runs, in a word: the release's version, and for a checkout the commit it stands on
 *  (`liquen 0.1.4 at 0a86d4e`), since a linked org runs whatever the checkout holds. */
export async function running(): Promise<string> {
  const version = (await packageManifest()).version;
  const commit = await checkoutCommit(import.meta.url);
  return `liquen ${version ?? "?"}${commit ? ` at ${commit}` : ""}`;
}

/** The short commit of the git checkout a module at `url` lives in; nothing when it was
 *  loaded from the registry, or git cannot say. */
export async function checkoutCommit(url: string): Promise<string | undefined> {
  if (!url.startsWith("file:")) return undefined;
  try {
    const out = await new Deno.Command("git", {
      args: ["-C", new URL(".", url).pathname, "rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const commit = new TextDecoder().decode(out.stdout).trim();
    return out.success && commit ? commit : undefined;
  } catch {
    return undefined;
  }
}

/** The manifest a module at `url` belongs to. */
export async function read(url: string): Promise<PackageManifest> {
  try {
    const jsr = url.match(JSR);
    if (jsr) {
      const res = await fetch(`${jsr[1]}/${jsr[2]}_meta.json`);
      const exports = res.ok
        ? (await res.json() as { exports?: Record<string, string> }).exports
        : undefined;
      return { version: jsr[2], ...(exports ? { exports } : {}) };
    }
    const res = await fetch(new URL("../deno.json", url));
    if (!res.ok) return {};
    const m = await res.json() as PackageManifest;
    return {
      ...(typeof m.version === "string" ? { version: m.version } : {}),
      ...(m.exports ? { exports: m.exports } : {}),
    };
  } catch {
    return {};
  }
}
