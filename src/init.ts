/**
 * init.ts — `liquen init <path>`: scaffold a new org project (§9).
 *
 * Dumb on purpose: materialize the catalog, copy the scaffold, seed the org's half of the
 * doc cascade (`data/system/`, `data/organizations/` — what every agent will read, placeholders to
 * edit). The project it leaves behind carries no runnable code — the CLI is the package
 * its `deno.jsonc` names — and what only a run can make (the log, the CA, the shims) waits
 * for the first boot. What init decides is only what a human would otherwise type: the
 * org's clock and locale (the machine's). The roster starts empty; `liquen agent` adds
 * each agent as its own declaration, and lays that agent's half of the cascade.
 */

import { materialize, starterConfig } from "./config.ts";
import { seedOrg } from "./store/seed.ts";
import { entry } from "./entry.ts";

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
  const exists = await Deno.stat(`${path}/config.jsonc`).then(() => true, () => false);
  if (exists) {
    throw new Error(
      `${path} is already a liquen org — \`liquen agent <name>\` adds an agent to it`,
    );
  }
  for (const sub of ["", "/connectors", "/processors", "/data"]) {
    await Deno.mkdir(`${path}${sub}`, { recursive: true });
  }
  await Deno.writeTextFile(`${path}/config.jsonc`, materialize(starterConfig()));
  // the scaffold travels with the module, whose URL is the registry's when init is run
  // straight off it — fetch reads both that and a checkout's file:
  for (const [from, to] of SCAFFOLD) {
    const res = await fetch(new URL(`./scaffold/${from}`, import.meta.url));
    await Deno.writeFile(`${path}/${to}`, new Uint8Array(await res.arrayBuffer()));
  }
  await Deno.chmod(`${path}/entrypoint.sh`, 0o755);
  await seedOrg(`${path}/data`); // the org's own words, on disk before anything runs
}

if (import.meta.main) {
  await entry(async () => {
    const [path, ...rest] = Deno.args;
    if (!path || rest.length > 0) {
      console.error("usage: deno run -A jsr:@liquen/liquen/init <path>");
      Deno.exit(1);
    }
    await init(path);
    console.log(
      `${path}: a liquen org. \`liquen agent <name>\` adds an agent; \`liquen start\` runs it.\n` +
        "(`liquen` is the org's `deno task` from anywhere inside it: " +
        "`deno install -g -A -n liquen jsr:@liquen/liquen/liquen` puts it on the PATH.)",
    );
  });
}
