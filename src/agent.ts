/**
 * agent.ts — `mu agent <name> [--name <full name>] [--email <address>] [--phone <number>]`:
 * add an agent to the roster (§9).
 *
 * One declaration in the catalog: `agents.<name>`, its identity holding the handles the
 * flags gave and null for the rest. The name is the agent's id, its folder under
 * `data/agents/` and its unix user in the container — boot compiles the entry into those
 * at the next `mu start`, and nothing is made here. Runs from anywhere inside the org, or
 * against one named with `--dir`.
 */

import { declareAgent, findRoot, type Identity, IDENTITY_KEYS, orgFlag } from "./config.ts";

export const USAGE =
  "usage: mu agent [--dir <org>] <name> [--name <full name>] [--email <address>] [--phone <number>]";

/** The command line, `--dir` already taken out: one positional, the identity flags in
 *  either spelling (`--email x`, `--email=x`). Anything else is a usage error. */
export function parseAgentArgs(args: string[]): { name: string; identity: Identity } {
  const positional: string[] = [];
  const identity: Identity = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (!(IDENTITY_KEYS as readonly string[]).includes(flag)) {
      throw new Error(`unknown flag --${flag}\n${USAGE}`);
    }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value.length === 0) {
      throw new Error(`--${flag} needs a value\n${USAGE}`);
    }
    identity[flag as (typeof IDENTITY_KEYS)[number]] = value;
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { name: positional[0], identity };
}

if (import.meta.main) {
  const org = orgFlag();
  try {
    const { name, identity } = parseAgentArgs(org.args);
    const root = findRoot(org);
    await declareAgent(root, name, identity);
    const declared = IDENTITY_KEYS.filter((k) => identity[k] !== undefined);
    const handles = declared.length > 0 ? ` (${declared.join(", ")} declared)` : "";
    console.log(`${root}/config.jsonc: agents.${name}${handles}. \`mu start\` gives it a home.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
