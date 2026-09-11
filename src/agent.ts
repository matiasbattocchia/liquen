/**
 * agent.ts — `liquen agent <name> [--name <full name>] [--email <address>] [--phone <number>]
 * [--principal <member>]… [--no-mind]`: add a member to the roster (§9).
 *
 * One declaration in the catalog: `agents.<name>`, its identity holding the handles the
 * flags gave and null for the rest; `principals` when `--principal` named who steers it
 * (roster names, repeatable); `mind: false` when `--no-mind` made it a person alone. The
 * name is the member's id, its folder under `data/agents/` and its unix user in the
 * container. The declaration is the only thing boot needs — it compiles the roster into
 * rows and homes at every `liquen start` — but the home is laid HERE too, with the agent's
 * half of the doc cascade (`seedAgent`: `instructions/agent.md`, a memory to write the next
 * by), because the persona is what a person writes between declaring an agent and running
 * it, and there is nowhere to write it until the folder exists. Seeding never overwrites,
 * so the door and boot are the same call. `--no-mind` makes a person alone: a row, no
 * folder. Runs from anywhere inside the org, or against one named with `--dir`.
 */

import {
  type AgentEntry,
  declareAgent,
  findRoot,
  type Identity,
  IDENTITY_KEYS,
  orgFlag,
} from "./config.ts";
import { seedAgent } from "./store/seed.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE =
  "usage: liquen agent [--dir <org>] <name> [--name <full name>] [--email <address>] " +
  "[--phone <number>] [--principal <member>]... [--no-mind]";

/** The command line, `--dir` already taken out: one positional, the identity flags in
 *  either spelling (`--email x`, `--email=x`), `--principal` as often as there are
 *  principals, `--no-mind` bare. Anything else is a usage error. */
export function parseAgentArgs(
  args: string[],
): { name: string; identity: Identity; rest: Pick<AgentEntry, "principals" | "mind"> } {
  const positional: string[] = [];
  const identity: Identity = {};
  const rest: Pick<AgentEntry, "principals" | "mind"> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (flag === "no-mind") {
      rest.mind = false;
      continue;
    }
    if (flag !== "principal" && !(IDENTITY_KEYS as readonly string[]).includes(flag)) {
      throw new Error(`unknown flag --${flag}\n${USAGE}`);
    }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value.length === 0) {
      throw new Error(`--${flag} needs a value\n${USAGE}`);
    }
    if (flag === "principal") (rest.principals ??= []).push(value);
    else identity[flag as (typeof IDENTITY_KEYS)[number]] = value;
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { name: positional[0], identity, rest };
}

if (import.meta.main) {
  await entry(async () => {
    helpFlag(orgFlag().args, USAGE);
    const org = orgFlag();
    const { name, identity, rest } = parseAgentArgs(org.args);
    const root = findRoot(org);
    await declareAgent(root, name, identity, rest);
    // the home and the words that make it someone — a person alone (§4) has neither
    if (rest.mind !== false) await seedAgent(`${root}/data`, name);
    const declared = [
      ...IDENTITY_KEYS.filter((k) => identity[k] !== undefined),
      ...(rest.principals ? [`principals: ${rest.principals.join(", ")}`] : []),
      ...(rest.mind === false ? ["no mind"] : []),
    ];
    const handles = declared.length > 0 ? ` (${declared.join(", ")})` : "";
    const next = rest.mind === false
      ? "they steer, and no session of theirs will run."
      : `data/agents/${name}/ is the workspace; write instructions/agent.md in it to say ` +
        "who they are (every turn reads it fresh, so it is never too late). `liquen start` " +
        "runs them.";
    console.log(`${root}/config.jsonc: agents.${name}${handles}. ${next}`);
  });
}
