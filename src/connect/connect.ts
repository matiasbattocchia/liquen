/**
 * connect/connect.ts — `liquen connect`: the one front door to every connect flow (§4).
 *
 * Resolution is two-step: the shipped services (`src/connect/<service>/connect.ts`,
 * beside this module) first, then the org's own (`<org>/connectors/<name>/connect.ts`,
 * CONNECTORS.md). Every door is an `import.meta.main` entry, so the front door runs the
 * resolved file as a CHILD process with the remaining args — the same contract whether
 * the door is shipped, custom, or a pasted path; env (PORT, secrets) rides
 * through untouched. Unknown names fail listing every door that exists.
 */

import { findRoot, orgFlag } from "../config.ts";

/** The services that ship with the package — each `src/connect/<name>/` a connect door and
 *  a run.ts. A name, not a stat: where the package is may be a URL. */
export const SHIPPED = ["slack", "google", "whatsapp", "github"];

/** The connect door for `name`, as something `deno run` takes: a shipped door by its URL
 *  beside this module (a checkout's `file:`, the registry's `https:`), the org's own by
 *  path. Throws when there is none. */
export function resolveConnect(name: string, org: string): string {
  if (name.includes("/")) return name; // a module path — the dev knows best
  if (SHIPPED.includes(name)) return new URL(`./${name}/connect.ts`, import.meta.url).href;
  const custom = `${org}/connectors/${name}/connect.ts`;
  try {
    Deno.statSync(custom);
    return custom;
  } catch {
    throw new Error(
      `no connect door for "${name}" — available: ${available(org).join(" · ")}`,
    );
  }
}

/** Every name that resolves: the shipped services + each `<org>/connectors/<name>/connect.ts`. */
export function available(org: string): string[] {
  const custom: string[] = [];
  try {
    for (const e of Deno.readDirSync(`${org}/connectors`)) {
      if (!e.isDirectory) continue;
      try {
        Deno.statSync(`${org}/connectors/${e.name}/connect.ts`);
        custom.push(e.name);
      } catch {
        // a connector without a connect door (ingest-only) — nothing to list
      }
    }
  } catch {
    // no connectors/ dir — shipped only
  }
  return [...SHIPPED, ...custom.sort()];
}

const USAGE = `usage: liquen connect
       liquen connect <service> [args…]
       liquen connect ./path/to/connect.ts [args…]

  Connect a service to the org; bare, the map of what is connected. --help on any door.

  <service>     a shipped door: ${SHIPPED.join(" · ")}
  <path>        a door by module path (anything with a slash) — the org's own live under
                <org>/connectors/<name>/connect.ts and are named like the shipped ones
  --dir <org>   the org, when run from elsewhere`;

if (import.meta.main) {
  // the flag rides through to the door: the org is where its custom doors live, and its
  // to find again as a child
  const org = orgFlag();
  const [name, ...words] = org.args;
  if (name === "--help" || name === "-h") {
    console.log(USAGE);
    Deno.exit(0);
  }
  const rest = org.dir ? ["--dir", org.dir, ...words] : words;
  let target: string;
  try {
    target = name
      ? resolveConnect(name, findRoot(org))
      : new URL("./status.ts", import.meta.url).href; // bare `liquen connect` = the map
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(2);
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", target, ...rest],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.exit((await child.status).code);
}
