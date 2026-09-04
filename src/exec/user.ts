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

export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** The agent's Linux user, when there is one to drop to: the harness runs as root and a
 *  passwd entry carries the agent's name. Absent otherwise. */
export function agentUser(agentId: string): AgentUser | undefined {
  if (Deno.build.os !== "linux" || Deno.uid() !== 0) return undefined;
  try {
    for (const line of Deno.readTextFileSync("/etc/passwd").split("\n")) {
      const [name, , uid, gid, , home] = line.split(":");
      if (name === agentId) return { name, uid: Number(uid), gid: Number(gid), home };
    }
  } catch { /* no passwd to read — nothing to drop to */ }
  return undefined;
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
