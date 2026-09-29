/**
 * connect/connect.ts — `liquen connect`: the one front door to every connect flow (§4).
 *
 * Resolution is two-step: the shipped services (`src/connect/<service>/connect.ts`,
 * beside this module) first, then the org's own (`<org>/connectors/<name>/connect.ts`,
 * CONNECTORS.md). Every door is an `import.meta.main` entry, so the front door runs the
 * resolved file as a CHILD process with the remaining args — the same contract whether
 * the door is shipped, custom, or a pasted path; env (PORT, secrets) rides
 * through untouched. Unknown names fail listing every door that exists.
 *
 * `--remove` is the way back out, and runs here rather than in a door: what a grant left
 * is the same three records whichever door wrote them (`remove.ts`).
 */

import { findRoot, orgFlag, undeclareConnection } from "../config.ts";
import { entry, report } from "../entry.ts";
import { openStore } from "../store/mod.ts";
import { moved, reload } from "../reload.ts";
import { removeConnection } from "./remove.ts";

/** The services that ship with the package — each `src/connect/<name>/` a connect door.
 *  A name, not a stat: where the package is may be a URL. */
export const SHIPPED = ["slack", "google", "whatsapp", "github", "microsoft", "token"];
/** The shipped services with a run.ts — the ones that ingest or deliver, so `liquen start`
 *  runs one process each. `token` grants a bearer and runs nothing. */
export const RUNNING = ["slack", "google", "whatsapp", "github", "microsoft"];

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

/** The usage, naming every door this org has — the shipped ones, and its own when there is
 *  an org to look in. */
export function usage(doors: string[]): string {
  return `usage: liquen connect <service> [args…]
       liquen connect ./path/to/connect.ts [args…]
       liquen connect --remove <service>:<address>

  Connect a service to the org. --help on any door. \`liquen status\` is the map of what is
  connected.

  <service>     a door — token is any API's bearer:
                ${doors.join(" · ")}
  <path>        a door by module path (anything with a slash) — the org's own live under
                <org>/connectors/<name>/connect.ts and are named like the shipped ones
  --remove <t>  take a grant back: a connection or a token as \`liquen status\` prints it.
                Its secret leaves the vault, and the service leaves config.jsonc with its
                last connection; the platform keeps its side until revoked there
  --dir <org>   the org, when run from elsewhere`;
}

if (import.meta.main) {
  await entry(async () => {
    // the flag rides through to the door: the org is where its custom doors live, and its
    // to find again as a child
    const org = orgFlag();
    const [name, ...words] = org.args;
    const doors = () => {
      try {
        return available(findRoot(org));
      } catch {
        return SHIPPED; // no org here — the usage still names what ships
      }
    };
    if (name === "--help" || name === "-h") {
      console.log(usage(doors()));
      Deno.exit(0);
    }
    // said bare, the command is a question about itself
    if (!name) {
      console.error(usage(doors()));
      Deno.exit(2);
    }
    if (name === "--remove" || name.startsWith("--remove=")) {
      const target = name === "--remove" ? words[0] : name.slice("--remove=".length);
      if (!target) throw new Error(`--remove needs a target\n${usage(doors())}`);
      await remove(findRoot(org), target);
      return;
    }
    const rest = org.dir ? ["--dir", org.dir, ...words] : words;
    let target: string;
    try {
      target = resolveConnect(name, findRoot(org));
    } catch (err) {
      report(err);
      Deno.exit(2); // 2 says "no such door": nothing was spawned
    }
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", target, ...rest],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    Deno.exit((await child.status).code);
  });
}

/** `--remove`: the grant undone in the store and the catalog, then who still holds it. */
async function remove(root: string, target: string): Promise<void> {
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  try {
    const said = await removeConnection(target, {
      store: log,
      creds,
      undeclare: (service) => undeclareConnection(root, service),
      services: available(root),
    });
    for (const line of said) console.log(line);
  } finally {
    await creds.close();
    await log.close();
  }
  // the processes read the vault on every use; a connection no longer declared is one the
  // running org stops
  const moves = await reload(root);
  if (moves !== null) console.log(`the running org took it up: ${moved(moves)}`);
}
