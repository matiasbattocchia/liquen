/**
 * agent.ts — `liquen agent`: the roster, listed, and an agent made, changed or removed (§9).
 *
 *   liquen agent                         every agent: declared or not, running or paused,
 *                                        its last turn
 *   liquen agent <name> [flags]          make the agent, or change it
 *   liquen agent --remove <name>         remove it, whole
 *
 * The command writes the store (`roster.ts`) and tells the running org, so the change
 * runs without a reload: main brings the agent up, down, or onto its new settings while
 * the others run on. The name is the agent's id, its folder under `data/agents/` and its
 * unix user in the container. A new agent's half of the doc cascade (`instructions.md`
 * and `memories.md`) is laid with its row, because the persona is what a person writes
 * between making an agent and running it. A key `config.yaml` declares is the file's:
 * the command refuses to change it, and says where it is declared. Runs from anywhere
 * inside the org, or against one named with `--dir`.
 *
 * The flags, each naming only what changes:
 *
 *   --name · --email · --phone <value>   the identity: the name it goes by, the handles
 *                                        of the account it acts as
 *   --principal <member>…                who steers it, repeatable; `'*'` for anyone
 *                                        writing in its steering room
 *   --no-principals                      nobody steers it
 *   --no-mind · --mind                   pause it (a person alone: a row, no session), or
 *                                        run it again
 *   --<setting> <value>                  any `shared.agents` key for this agent alone, the
 *                                        value read as YAML (`--tools '[send, bash]'`,
 *                                        `--sleepHours null`)
 *   --unset <key>                        the setting inherits from the org again; a
 *                                        handle is cleared; `principals` is derived from
 *                                        ownership again
 */

import { parse } from "@std/yaml";
import {
  AGENT_KEYS,
  type AgentDefaults,
  CONFIG_FILE,
  findRoot,
  IDENTITY_KEYS,
  orgFlag,
} from "./config.ts";
import {
  type AgentChange,
  type Member,
  members,
  poke,
  removeAgent,
  taken,
  upsertAgent,
} from "./roster.ts";
import { openStore } from "./store/mod.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = `usage: liquen agent [--dir <org>]
       liquen agent [--dir <org>] <name> [--name <full name>] [--email <address>]
                    [--phone <number>] [--principal <member>]... [--no-principals]
                    [--no-mind | --mind] [--<setting> <value>]... [--unset <key>]...
       liquen agent [--dir <org>] --remove <name>

  With no name, lists every agent. With one, makes the agent or changes it: a setting is
  any shared.agents key (--model, --effort, --tools '[send, bash]'), its value read as
  YAML; --unset <key> makes it inherit again. --remove takes the agent out, whole.`;

/** What the command line asks for. */
export type AgentAsk =
  | { list: true }
  | { remove: string }
  | { name: string; change: AgentChange };

/** The command line, `--dir` already taken out: at most one positional; each flag in
 *  either spelling (`--email x`, `--email=x`). Anything else is a usage error. */
export function parseAgentArgs(args: string[]): AgentAsk {
  const positional: string[] = [];
  const change: AgentChange = {};
  let remove: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const set = (change.set ??= {}) as Record<string, unknown>;
    if (flag === "no-mind" || flag === "mind") {
      set.mind = flag === "mind";
      continue;
    }
    if (flag === "no-principals") {
      change.principals = [];
      continue;
    }
    const known = flag === "principal" || flag === "unset" || flag === "remove" ||
      (IDENTITY_KEYS as readonly string[]).includes(flag) || AGENT_KEYS.includes(flag);
    if (!known) throw new Error(`unknown flag --${flag}\n${USAGE}`);
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value.length === 0) {
      throw new Error(`--${flag} needs a value\n${USAGE}`);
    }
    if (flag === "remove") remove = value;
    else if (flag === "principal") {
      if (value === "*") change.principals = "*";
      else {
        const list = Array.isArray(change.principals) ? change.principals : [];
        change.principals = [...list, value];
      }
    } else if (flag === "unset") {
      if (value === "principals") change.principals = null;
      else if ((IDENTITY_KEYS as readonly string[]).includes(value)) {
        (change.identity ??= {})[value as (typeof IDENTITY_KEYS)[number]] = null;
      } else if (AGENT_KEYS.includes(value)) (change.unset ??= []).push(value);
      else throw new Error(`--unset ${value}: not a setting, a handle or principals\n${USAGE}`);
    } else if ((IDENTITY_KEYS as readonly string[]).includes(flag)) {
      (change.identity ??= {})[flag as (typeof IDENTITY_KEYS)[number]] = value;
    } else {
      try {
        set[flag] = parse(value);
      } catch {
        throw new Error(`--${flag} ${value}: not a YAML value\n${USAGE}`);
      }
    }
  }
  if (Object.keys(change.set ?? {}).length === 0) delete change.set;
  if (remove !== undefined) {
    if (positional.length > 0 || Object.keys(change).length > 0) throw new Error(USAGE);
    return { remove };
  }
  if (positional.length === 0 && Object.keys(change).length === 0) return { list: true };
  if (positional.length !== 1) throw new Error(USAGE);
  return { name: positional[0], change };
}

/** The roster as lines: each agent, whose word it is, whether it runs, its last turn. */
export function listed(all: Member[]): string[] {
  if (all.length === 0) return ["no agents — `liquen agent <name>` makes one"];
  const wide = Math.max(...all.map((m) => m.agentId.length));
  return all.map((m) =>
    [
      m.agentId.padEnd(wide),
      m.declared
        ? `declared in ${CONFIG_FILE}`
        : "made at runtime".padEnd(`declared in ${CONFIG_FILE}`.length),
      m.runs ? "runs  " : "paused",
      m.last ? `last turn ${m.last.slice(0, 16).replace("T", " ")}Z` : "no turn yet",
    ].join("  ")
  );
}

/** What changed, in a few words. */
function said(change: AgentChange): string {
  const parts = [
    ...Object.keys(change.identity ?? {}),
    ...(change.principals !== undefined
      ? [
        change.principals === null
          ? "principals derived"
          : change.principals === "*"
          ? "principals: anyone in its room"
          : `principals: ${change.principals.join(", ") || "nobody"}`,
      ]
      : []),
    ...Object.entries(change.set ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
    ...(change.unset ?? []).map((k) => `${k} inherited`),
  ];
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

if (import.meta.main) {
  await entry(async () => {
    helpFlag(orgFlag().args, USAGE);
    const org = orgFlag();
    const ask = parseAgentArgs(org.args);
    const root = findRoot(org);
    const store = await openStore(root);
    const log = await store.log();
    const docs = await store.docs();
    try {
      if ("list" in ask) {
        for (const line of listed(await members(root, log))) console.log(line);
        return;
      }
      if ("remove" in ask) {
        await removeAgent(root, log, ask.remove);
        console.log(
          `${ask.remove} removed: its row, its connections, keys, verdicts and folder. ` +
            "What it wrote stays in the log.",
        );
        return;
      }
      const { name, change } = ask;
      const { made } = await upsertAgent(root, log, name, change, { docs: docs.bed });
      const took = taken(await poke(root, { agent: name }));
      const paused = (change.set as Partial<AgentDefaults> | undefined)?.mind === false;
      const next = !made
        ? ""
        : paused
        ? " They steer, and no session of theirs will run."
        : ` data/agents/${name}/ is the workspace; write instructions.md in it to say who ` +
          "they are (every turn reads it fresh, so it is never too late).";
      console.log(`${name} ${made ? "made" : "changed"}${said(change)} — ${took}.${next}`);
    } finally {
      await docs.close();
      await log.close();
    }
  });
}
