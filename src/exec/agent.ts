/**
 * exec/agent.ts — the `agent` tool: an agent makes another (§4, §9).
 *
 * The call makes the agent as `liquen agent <id>` does (`upsertAgent`): its row, with the
 * name and handles given, and its folder with `instructions.md` and `memories.md`; then
 * main brings it up. Its settings are the org's, and its principals are derived from
 * ownership, as a new row's are. It only makes: an id that exists is refused, since
 * moving a handle onto another agent would move whose lines steer it, and changing or
 * removing an agent stays the CLI's.
 *
 * Provisioning a member is two calls: this one with their email or phone, then `connect`
 * for them, whose sign-in lands only as the account that handle names.
 */

import type { ExecTool } from "../xi.ts";
import type { Registry } from "../store/agents.ts";
import type { Seedbed } from "../store/seed.ts";
import { upsertAgent } from "../roster.ts";

export const AGENT_SPEC = {
  name: "agent",
  input_schema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
    },
    required: ["id"],
  },
};

export interface AgentToolDeps {
  root: string;
  log: Registry;
  docs: Seedbed;
  /** Bring the new agent up: main's own word on what it did. */
  up: (agentId: string) => Promise<string>;
}

export function agentTool(deps: AgentToolDeps): ExecTool {
  return {
    spec: AGENT_SPEC,
    async execute(input) {
      const args = (input ?? {}) as Record<string, unknown>;
      const id = String(args.id ?? "").trim();
      if (!id) throw new Error("say `id`: the new agent's name, its folder and its user");
      if ((await deps.log.agents()).some((a) => a.agentId === id)) {
        throw new Error(`${id} exists: changing an agent is the CLI's (\`liquen agent ${id}\`)`);
      }
      const identity: Record<string, string> = {};
      for (const key of ["name", "email", "phone"] as const) {
        const v = typeof args[key] === "string" ? (args[key] as string).trim() : "";
        if (v) identity[key] = v;
      }
      await upsertAgent(deps.root, deps.log, id, { identity }, { docs: deps.docs });
      const said = await deps.up(id);
      return `${id} made, and ${said}. data/agents/${id}/instructions.md says who they are; ` +
        "every turn of theirs reads it fresh.";
    },
  };
}
