/**
 * init.ts — `liquen init <path>`: scaffold a new org project (§9).
 *
 * Dumb on purpose: materialize the catalog, copy the scaffold. The project it leaves
 * behind carries no runnable code — the CLI is the package its `deno.jsonc` names — and
 * `data/` fills at first boot: the catalog's roster becomes folders and rows then, not
 * here. What init decides is only what a human would otherwise type: the org's clock and
 * locale (the machine's). The roster starts empty; `liquen agent` adds each agent as its
 * own declaration.
 */

import { materialize, starterConfig } from "./config.ts";

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
}

if (import.meta.main) {
  const [path, ...rest] = Deno.args;
  if (!path || rest.length > 0) {
    console.error("usage: deno run -A jsr:@liquen/liquen/init <path>");
    Deno.exit(1);
  }
  try {
    await init(path);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
  console.log(
    `${path}: a liquen org. \`liquen agent <name>\` adds an agent; \`liquen start\` runs it.\n` +
      "(`liquen` is the org's `deno task` from anywhere inside it: " +
      "`deno install -g -A -n liquen jsr:@liquen/liquen/liquen` puts it on the PATH.)",
  );
}
