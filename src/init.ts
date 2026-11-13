/**
 * init.ts — `liquen init <path>`: scaffold a new org project (§9).
 *
 * Dumb on purpose: lay `config.yaml`, the catalog as a commented template; copy the
 * scaffold; seed the org's half of the doc cascade (`data/system/`, `data/shared/` — what
 * every agent will read, headers to fill). The project it leaves behind carries no
 * runnable code — the CLI is the package its `deno.jsonc` names — and what only a run can
 * make (the log, the CA, the shims) waits for the first boot. What init decides is only
 * what a human would otherwise type: the org's clock and locale (the machine's). The
 * roster starts empty; `liquen agent` makes each agent in the store, and lays that
 * agent's half of the cascade. The files laid here are the org's from this moment: no
 * later release rewrites them.
 */

import { CONFIG_FILE, materialize, starterConfig } from "./config.ts";
import { bringSystemDocs, onFiles, seedOrg } from "./store/seed.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

/** template name in `scaffold/` → name in the project (dotfiles ship undotted so the
 *  scaffold itself never acts as one) */
const SCAFFOLD: [string, string][] = [
  ["Dockerfile", "Dockerfile"],
  ["entrypoint.sh", "entrypoint.sh"],
  ["dockerignore", ".dockerignore"],
  ["deno.jsonc", "deno.jsonc"],
  ["env", ".env"],
  ["gitignore", ".gitignore"],
];

export async function init(path: string): Promise<void> {
  const exists = await Deno.stat(`${path}/${CONFIG_FILE}`).then(() => true, () => false);
  if (exists) {
    throw new Error(
      `${path} is already a liquen org — \`liquen agent <name>\` adds an agent to it`,
    );
  }
  for (const sub of ["", "/connectors", "/processors", "/data"]) {
    await Deno.mkdir(`${path}${sub}`, { recursive: true });
  }
  await Deno.writeTextFile(`${path}/${CONFIG_FILE}`, materialize(starterConfig()));
  // the scaffold travels with the module, whose URL is the registry's when init is run
  // straight off it — fetch reads both that and a checkout's file:
  for (const [from, to] of SCAFFOLD) {
    const res = await fetch(new URL(`./scaffold/${from}`, import.meta.url));
    await Deno.writeFile(`${path}/${to}`, new Uint8Array(await res.arrayBuffer()));
  }
  await Deno.chmod(`${path}/entrypoint.sh`, 0o755);
  // the org's own words, on disk before anything runs: a starter catalog keeps its docs
  // as files
  const bed = onFiles(`${path}/data`);
  await seedOrg(bed);
  await bringSystemDocs(bed);
}

export const USAGE = `usage: liquen init <path>

  Make a new org at <path>: its config.yaml, its scaffold, and the docs every agent reads.
  \`liquen agent <name>\` then adds an agent to it.`;

if (import.meta.main) {
  await entry(async () => {
    helpFlag(Deno.args, USAGE);
    const [path, ...rest] = Deno.args;
    // a flag is never an org's folder: `--typo` would otherwise become one
    if (!path || rest.length > 0 || path.startsWith("-")) {
      throw new Error(path?.startsWith("-") ? `unknown flag ${path}\n${USAGE}` : USAGE);
    }
    await init(path);
    console.log(
      `${path}: a liquen org. \`liquen agent <name>\` adds an agent; \`liquen start\` runs it.\n` +
        "(`liquen` is the org's `deno task` from anywhere inside it: " +
        "`deno install -g -A -n liquen jsr:@liquen/liquen/liquen` puts it on the PATH, and " +
        "`-n lq` again installs the short name.)",
    );
  });
}
