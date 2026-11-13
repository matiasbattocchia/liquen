/**
 * users.ts — the agents as Linux users, and the data classification (DESIGN §9).
 *
 * A harness running as root, the container's case, gives Linux to its agents: each is a
 * user named after it, whose `$HOME` is its folder on the volume, and the kernel enforces
 * who reads what. A container's `/etc/passwd` is made anew at every start, so the users
 * are made from the roster's rows at every boot, and one more when an agent is added
 * while the org runs. Off root (a laptop, bare or in bubbles) there is no user to make,
 * and every function here does nothing.
 *
 * The classification, over the org's data root:
 *
 *   agents/<name>/   <name>:agents 0700   the agent's own, invisible to its peers
 *   log/             root:root 0700       the substrate is the system's
 *   shared/          root:agents          the shared floor: folders 2775, files g+rw, and
 *                                         a default ACL giving the group rwX, so what one
 *                                         agent lays another may edit
 *   system/          read-only to all     the harness's docs, but `ca.key`: the egress
 *                                         CA's key, root's alone, 0600
 *
 * The order is boot's to keep: the group, then the users, then the owners; the seeding,
 * then `system/` made read-only. The sweeps are recursive, so a boot also mends ownership
 * that drifted.
 */

/** The group every agent's user is in: the shared floor's. */
export const GROUP = "agents";

/** What a root deployment's image must hold (`setfacl` is the `acl` package). */
const TOOLS = ["groupadd", "useradd", "userdel", "chown", "chmod", "setfacl"];

/** Whether the harness gives Linux to its agents: it runs as root, on Linux. */
export function asRoot(): boolean {
  return Deno.build.os === "linux" && Deno.uid() === 0;
}

async function run(cmd: string, args: string[]): Promise<void> {
  const out = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped" })
    .output();
  if (!out.success) {
    const said = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`${cmd} ${args.join(" ")}: ${said || `exited ${out.code}`}`);
  }
}

/** A row of a `passwd`-shaped file, by its first field. */
async function entry(file: string, name: string): Promise<string[] | undefined> {
  const text = await Deno.readTextFile(file).catch(() => "");
  return text.split("\n").map((l) => l.split(":")).find((f) => f[0] === name);
}

/** Refuse, naming it, when a tool the classification runs is not in the image. */
export async function requireTools(): Promise<void> {
  if (!asRoot()) return;
  const path = (Deno.env.get("PATH") ?? "").split(":").filter(Boolean);
  for (const tool of TOOLS) {
    let found = false;
    for (const dir of path) {
      if (await Deno.stat(`${dir}/${tool}`).then((s) => s.isFile, () => false)) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(
        `${tool} is not in this image, and a harness running as root gives each agent a ` +
          `Linux user with it — install it (setfacl is the acl package)`,
      );
    }
  }
}

/** The POSIX `cksum` of a name: the uid an agent gets is pinned by it. */
export function cksum(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let crc = 0;
  const feed = (byte: number) => {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  };
  for (const b of bytes) feed(b);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) feed(n & 0xff);
  return ~crc >>> 0;
}

/** The agents' group, made where missing. */
export async function ensureGroup(): Promise<void> {
  if (!asRoot()) return;
  if (!(await entry("/etc/group", GROUP))) await run("groupadd", [GROUP]);
}

/** The agent's user and its folder: the user made where missing, its uid pinned by name
 *  (a hash, probed past collisions) so ownership on the volume holds across rebuilds;
 *  `/home/<name>` a link to the folder, so its `$HOME` is its workspace; the folder its
 *  own, 0700. */
export async function ensureUser(dir: string, name: string): Promise<void> {
  if (!asRoot()) return;
  await ensureGroup();
  const home = `${dir}/agents/${name}`;
  if (!(await entry("/etc/passwd", name))) {
    const taken = new Set(
      (await Deno.readTextFile("/etc/passwd")).split("\n").map((l) => Number(l.split(":")[2])),
    );
    let uid = 20000 + cksum(name) % 10000;
    while (taken.has(uid)) uid++;
    await run("useradd", [
      "-u",
      String(uid),
      "-g",
      GROUP,
      "-M",
      "-d",
      `/home/${name}`,
      "-s",
      "/bin/bash",
      name,
    ]);
  }
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir("/home", { recursive: true });
  const link = `/home/${name}`;
  const points = await Deno.readLink(link).catch(() => null);
  if (points !== home) {
    await Deno.remove(link, { recursive: true }).catch(() => {});
    await Deno.symlink(home, link);
  }
  await run("chown", ["-R", `${name}:${GROUP}`, home]);
  await run("chmod", ["700", home]);
}

/** The agent's user and its home link, gone. */
export async function dropUser(name: string): Promise<void> {
  if (!asRoot()) return;
  if (await entry("/etc/passwd", name)) await run("userdel", [name]);
  await Deno.remove(`/home/${name}`).catch(() => {});
}

/** The floors the agents stand on, given their owners: `log/` and `shared/`. Run before
 *  the seeding, so what boot lays in `shared/` inherits the floor's group and ACL. */
export async function classifyFloors(dir: string): Promise<void> {
  if (!asRoot()) return;
  await ensureGroup();
  for (const floor of ["log", "shared", "system"]) {
    await Deno.mkdir(`${dir}/${floor}`, { recursive: true });
  }
  await run("chown", ["-R", "root:root", `${dir}/log`]);
  await run("chmod", ["700", `${dir}/log`]);
  await run("chown", ["-R", `root:${GROUP}`, `${dir}/shared`]);
  await shareTree(`${dir}/shared`);
  await run("setfacl", ["-R", "-d", "-m", `g:${GROUP}:rwX`, `${dir}/shared`]);
}

/** A tree of the shared floor: each folder setgid and group-writable (2775), so what is
 *  made in it keeps the group; each file group-writable. Links are not followed. */
async function shareTree(path: string): Promise<void> {
  await Deno.chmod(path, 0o2775);
  for await (const e of Deno.readDir(path)) {
    const child = `${path}/${e.name}`;
    if (e.isSymlink) continue;
    if (e.isDirectory) await shareTree(child);
    else await Deno.chmod(child, ((await Deno.stat(child)).mode ?? 0o644) & 0o7777 | 0o060);
  }
}

/** `system/` made read-only to all, once everything boot lays there is laid; the egress
 *  CA's key stays root's alone. */
export async function sealSystem(dir: string): Promise<void> {
  if (!asRoot()) return;
  await run("chmod", ["-R", "a-w,a+rX", `${dir}/system`]);
  const key = `${dir}/system/ca.key`;
  if (await Deno.stat(key).then(() => true, () => false)) await run("chmod", ["600", key]);
  // the harness's own state there is its alone too
  const state = `${dir}/system/proxy.json`;
  if (await Deno.stat(state).then(() => true, () => false)) await run("chmod", ["600", state]);
}
