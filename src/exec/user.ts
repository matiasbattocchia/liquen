/**
 * exec/user.ts — the agent as a Linux user (DESIGN §9, the container story).
 *
 * The entrypoint materializes the roster as users named after the agents; the harness
 * runs as root and hands each agent's spawns to that uid. Everything the HARNESS creates
 * inside the agent's folder — the seeded docs, `bin/`, the door socket, an output spill —
 * is created by root, so the harness gives it to the agent as it goes: the kernel enforces
 * the classification only over what it can see the owner of.
 *
 * Local dev is one user with no roster in `/etc/passwd`: `agentUser` answers nothing and
 * every `own` is a no-op.
 */

import { agentsRow, asRoot, entry, heldName } from "../users.ts";

export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** The agent's Linux user, which a harness running as root drops to: the user of the
 *  agents' group by the agent's name. Absent off root. On root, an agent with no such user
 *  is refused, so nothing of an agent's runs as root or as a user of the machine's. */
export function agentUser(agentId: string): AgentUser | undefined {
  if (!asRoot()) return undefined;
  const row = entry("/etc/passwd", agentId);
  if (!row) {
    throw new Error(
      `agent ${agentId}: no Linux user by its name, and a harness running as root runs ` +
        `an agent only as its own`,
    );
  }
  if (!agentsRow(row)) throw new Error(heldName(agentId, row));
  const [name, , uid, gid, , home] = row;
  return { name, uid: Number(uid), gid: Number(gid), home };
}

/** Give one path to the agent. No user ⇒ nothing to give. */
export async function own(path: string, user: AgentUser | undefined): Promise<void> {
  if (!user) return;
  await Deno.chown(path, user.uid, user.gid);
}

/** Give a whole tree to the agent — the folder and everything under it, links not
 *  followed (what a link points at is someone else's). */
export async function ownTree(root: string, user: AgentUser | undefined): Promise<void> {
  if (!user) return;
  await own(root, user);
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isSymlink) continue;
    if (entry.isDirectory) await ownTree(path, user);
    else await own(path, user);
  }
}
