/**
 * connect/connect.ts — `mu connect`: the one front door to every connect flow (§4).
 *
 *   deno task connect                        # no service: the map (status)
 *   deno task connect <service> [args...]    # the service's connect door
 *   deno task connect ./path/connect.ts      # a module path (anything with a slash)
 *
 * Resolution is two-step: the shipped services (`src/connect/<service>/connect.ts`)
 * first, then the org's own (`connectors/<name>/connect.ts` at the repo root,
 * CONNECTORS.md). Every door is an `import.meta.main` entry, so the front door runs the
 * resolved file as a CHILD process with the remaining args — the same contract whether
 * the door is shipped, custom, or a pasted path; env (PORT, secrets) rides
 * through untouched. Unknown names fail listing every door that exists.
 */

const SHIPPED = ["slack", "google", "whatsapp"];

const ROOT = new URL("../../", import.meta.url); // src/connect/ → the repo root

/** The connect door for `name`, as an absolute file path. Throws when there is none. */
export function resolveConnect(name: string, root: URL = ROOT): string {
  if (name.includes("/")) return name; // a module path — the dev knows best
  if (SHIPPED.includes(name)) {
    return new URL(`src/connect/${name}/connect.ts`, root).pathname;
  }
  const custom = new URL(`connectors/${name}/connect.ts`, root).pathname;
  try {
    Deno.statSync(custom);
    return custom;
  } catch {
    throw new Error(
      `no connect door for "${name}" — available: ${available(root).join(" · ")}`,
    );
  }
}

/** Every name that resolves: the shipped services + each connectors/<name>/connect.ts. */
export function available(root: URL = ROOT): string[] {
  const custom: string[] = [];
  try {
    for (const e of Deno.readDirSync(new URL("connectors/", root))) {
      if (!e.isDirectory) continue;
      try {
        Deno.statSync(new URL(`connectors/${e.name}/connect.ts`, root));
        custom.push(e.name);
      } catch {
        // a connector without a connect door (github: webhook-secret setup, no flow)
      }
    }
  } catch {
    // no connectors/ dir — shipped only
  }
  return [...SHIPPED, ...custom.sort()];
}

if (import.meta.main) {
  const [name, ...rest] = Deno.args;
  let target: string;
  try {
    target = name ? resolveConnect(name) : new URL("./status.ts", import.meta.url).pathname; // bare `mu connect` = the map
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
