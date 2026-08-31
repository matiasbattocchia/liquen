/**
 * init.ts — `mu init <path> [agent...]`: scaffold a new org project (§9).
 *
 * Dumb on purpose: materialize the catalog, copy the scaffold, interpolate the name.
 * The project it leaves behind carries no runnable code — the `mu` CLI ships with core —
 * and `data/` fills at first boot: the catalog's roster becomes folders and rows then,
 * not here. What init decides is only what a human would otherwise type: the org's name
 * (the folder's), its clock (the machine's), and the first agent (the caller, unless
 * named).
 */

import { userInfo } from "node:os";
import { materialize, starterConfig } from "./config.ts";

/** template name in `scaffold/` → name in the project (dotfiles ship undotted so the
 *  scaffold itself never acts as one) */
const SCAFFOLD: [string, string][] = [
  ["AGENTS.md", "AGENTS.md"],
  ["Dockerfile", "Dockerfile"],
  ["entrypoint.sh", "entrypoint.sh"],
  ["deno.jsonc", "deno.jsonc"],
  ["env", ".env"],
  ["gitignore", ".gitignore"],
];

export async function init(path: string, agents: string[]): Promise<void> {
  const exists = await Deno.stat(`${path}/config.jsonc`).then(() => true, () => false);
  if (exists) throw new Error(`${path} is already a mu project (config.jsonc exists)`);
  const name = (await Deno.realPath(path).catch(() => path)).replace(/\/+$/, "")
    .split("/").pop()!;
  for (const sub of ["", "/connectors", "/processors", "/data"]) {
    await Deno.mkdir(`${path}${sub}`, { recursive: true });
  }
  await Deno.writeTextFile(`${path}/config.jsonc`, materialize(starterConfig(agents)));
  for (const [from, to] of SCAFFOLD) {
    const raw = await Deno.readTextFile(new URL(`./scaffold/${from}`, import.meta.url));
    await Deno.writeTextFile(`${path}/${to}`, raw.replaceAll("{{name}}", name));
  }
  await Deno.chmod(`${path}/entrypoint.sh`, 0o755);
}

if (import.meta.main) {
  const [path, ...named] = Deno.args;
  if (!path) {
    console.error("usage: mu init <path> [agent...]");
    Deno.exit(1);
  }
  const agents = named.length > 0 ? named : [userInfo().username];
  await init(path, agents);
  console.log(`${path}: a mu org — agents: ${agents.join(", ")}. \`mu start\` runs it.`);
}
