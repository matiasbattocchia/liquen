/**
 * exec/bubble.ts — an agent's shells inside bubblewrap (DESIGN §9, `deployment.sandbox: "bwrap"`).
 *
 * A bubble is a set of namespaces with one VIEW of the filesystem, held open by its first
 * process, the holder, which only waits. A call enters it — `setsid nsenter … bash -c` — so
 * the call is a process group the harness spawned, probes and kills exactly as a bare one,
 * and a job it leaves running lives on in the bubble.
 *
 * The view is the data classification, enforced by the mounts instead of by owners:
 *   the system underneath   read-only: /usr, /etc, the runtime, its module cache, the package
 *   agents/<id>             the agent's own folder, writable — its HOME
 *   shared/                 the shared floor, writable
 *   system/ · conversations/  read-only
 *   everything else         absent: log/, the peers' folders, the org's .env, the user's home
 * A session that stands outside the agent's ground (the directory `liquen cli` attached
 * from) gets a bubble whose view adds that directory, writable, with the classification laid
 * over it again — the data root emptied and refilled, the org's .env unreadable — so standing
 * in the org's own folder shows its code and none of its state.
 *
 * The org may show more of the machine (`deployment.mounts`), read-only unless an entry says
 * `:rw`: the folders a tool installed in the user's home runs on beside its PATH folder, a
 * repository a coding agent works in.
 *
 * The network is the machine's: a bubble fences files, processes and the environment, and
 * its shells reach the world, this machine's loopback and the egress proxy as a bare shell
 * does.
 *
 * A bubble outlives the harness that opened it, as its jobs do: each is recorded under
 * `log/bubbles/<agent>/`, and the next harness adopts the one whose view it would open
 * itself. One opened for another view, by another version, stays while a job runs in it
 * and ends once none does. `close("end")` ends them all.
 */

import { denoDir } from "./bash.ts";

export interface Bubble {
  /** The argv a spawn runs under to be inside the bubble, standing at `cwd`: a bubble whose
   *  view holds `cwd`, opened on first need. */
  enter(cwd: string): Promise<string[]>;
  /** Let go of every bubble: with `"end"` they end, and what runs in them; with
   *  `"leave"` they stay for the next harness. */
  close(jobs: "end" | "leave"): Promise<void>;
}

export interface BubbleOptions {
  /** The org's data root. */
  dir: string;
  agentId: string;
  /** The `deployment.mounts` knob: more of the machine the bubble shows, each read-only unless
   *  it ends in `:rw`. */
  mounts?: string[];
}

/** The folders tools installed in the user's home run on, beside their PATH folders. */
const TOOL_HOMES = ["~/.local/share/mise", "~/.nvm", "~/.local/share/uv"];
/** The holder: it says `ready` once the namespaces exist, then holds them open. */
const HOLDER = ["/bin/sh", "-c", "echo ready && exec sleep infinity"];
/** How long a holder is given to say `ready`. */
const READY_MS = 10_000;
const SSH_DROP_INS = "/etc/ssh/ssh_config.d";
/** The system dirs a distribution keeps either as directories or as links into /usr. */
const ROOT_DIRS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64"];

/** One bubble, as its record keeps it. */
interface Kept {
  /** The bubble's first process: its pid namespace ends with it. */
  init: number;
  /** When `init` started (/proc stat), so a pid taken again is told apart. */
  start: string;
  /** The holder, which `nsenter` enters. */
  target: number;
  /** The view and the holder it was opened with. */
  view: string;
}

interface Holder extends Kept {
  path: string;
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A path, `~/` read as the harness user's home. */
const expand = (path: string) =>
  path.startsWith("~/")
    ? `${(Deno.env.get("HOME") ?? "").replace(/\/+$/, "")}${path.slice(1)}`
    : path;

/** A `deployment.mounts` entry: its path, expanded, and whether the bubble may write there. */
export function mountOf(entry: string): { path: string; mode: "rw" | "ro" } {
  const rw = entry.endsWith(":rw");
  return { path: expand(rw ? entry.slice(0, -3) : entry), mode: rw ? "rw" : "ro" };
}

/** The tool folders in the user's home that hold a PATH folder and that no mount shows
 *  whole: a bubble shows them only by those PATH folders. As written in `TOOL_HOMES`. */
export function partialToolHomes(mounts: string[]): string[] {
  const shown = mounts.map((m) => mountOf(m).path);
  const path = (Deno.env.get("PATH") ?? "").split(":");
  return TOOL_HOMES.filter((t) => {
    const home = expand(t);
    return path.some((d) => under(d, home)) && !shown.some((m) => under(home, m));
  });
}

/** The read-only system underneath every view, then the bubble's own /proc, /dev and /tmp. */
function systemBinds(): string[] {
  const args = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc"];
  args.push("--ro-bind-try", "/opt", "/opt");
  for (const d of ROOT_DIRS) {
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymlink) args.push("--symlink", Deno.readLinkSync(d), d);
    else if (st.isDirectory) args.push("--ro-bind", d, d);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  // the system's ssh drop-ins show owned by nobody here, and ssh refuses a config so owned
  // whole: the system's own file stands, without them
  try {
    if (Deno.statSync(SSH_DROP_INS).isDirectory) {
      args.push("--tmpfs", SSH_DROP_INS, "--remount-ro", SSH_DROP_INS);
    }
  } catch { /* no ssh, or none of its drop-ins */ }
  return args;
}

/** What the shims and the agent's own tools run on, read-only: the runtime, the module
 *  cache the shims read, the package when it is a checkout, and every PATH directory the
 *  system dirs do not already hold. */
function toolBinds(cache: string): string[] {
  const dirs = new Set<string>([Deno.execPath().replace(/\/[^/]+$/, ""), cache]);
  const pkg = new URL("../../", import.meta.url);
  if (pkg.protocol === "file:") dirs.add(pkg.pathname.replace(/\/$/, ""));
  for (const d of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!d.startsWith("/") || ["/usr", ...ROOT_DIRS].some((r) => under(d, r))) continue;
    dirs.add(d);
  }
  return [...dirs].flatMap((d) => ["--ro-bind-try", d, d]);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** When `pid` started, or null when there is no such process. */
function startOf(pid: number): string | null {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

const living = (r: Kept) => startOf(r.init) === r.start && startOf(r.target) !== null;

/** Does anything but the bubble's own two processes run in it? */
function holdsJobs(r: Kept): boolean {
  let ns: string;
  try {
    ns = Deno.readLinkSync(`/proc/${r.target}/ns/pid`);
  } catch {
    return false;
  }
  for (const e of Deno.readDirSync("/proc")) {
    const pid = Number(e.name);
    if (!Number.isInteger(pid) || pid === r.init || pid === r.target) continue;
    try {
      if (Deno.readLinkSync(`/proc/${pid}/ns/pid`) === ns) return true;
    } catch { /* gone, or not ours to read */ }
  }
  return false;
}

/** End a bubble: its first process, and its pid namespace with it. */
async function end(h: Holder): Promise<void> {
  if (living(h)) {
    try {
      Deno.kill(h.init, "SIGKILL");
    } catch { /* already gone */ }
  }
  await Deno.remove(h.path).catch(() => {});
}

export async function openBubble(
  { dir, agentId, mounts = [] }: BubbleOptions,
): Promise<Bubble> {
  const root = dir.replace(/\/[^/]+$/, "");
  const shown = mounts.map(mountOf);
  for (const { path: m } of shown) {
    if (under(root, m) || under(m, root)) {
      throw new Error(
        `deployment.mounts: ${m} ${under(root, m) ? "holds" : "lies in"} the org's ` +
          "folder, which a bubble shows by the data classification alone",
      );
    }
  }
  const home = `${dir}/agents/${agentId}`;
  const records = `${dir}/log/bubbles/${agentId}`;
  // the folders the classification shows: a cwd under one of them needs no wider view
  const ground: [string, "rw" | "ro"][] = [
    [home, "rw"],
    [`${dir}/shared`, "rw"],
    [`${dir}/system`, "ro"],
    [`${dir}/conversations`, "ro"],
  ];
  const cache = await denoDir();
  await Deno.mkdir(records, { recursive: true });

  const viewFor = (wide?: string): string[] => {
    const args = [...systemBinds(), ...toolBinds(cache)];
    for (const { path, mode } of shown) {
      args.push(mode === "rw" ? "--bind-try" : "--ro-bind-try", path, path);
    }
    // the stood-in directory over the system, and the classification over it
    if (wide) args.push("--bind", wide, wide);
    if (wide && under(dir, wide)) args.push("--tmpfs", dir);
    for (const [path, mode] of ground) {
      args.push(mode === "rw" ? "--bind-try" : "--ro-bind-try", path, path);
    }
    if (wide && under(`${root}/.env`, wide)) {
      args.push("--ro-bind-try", "/dev/null", `${root}/.env`);
    }
    return args;
  };

  // the bubbles the last harness left: one is adopted when the view it holds is the one
  // this harness would open, the rest end once nothing runs in them
  const holders = new Map<string, Promise<Holder>>();
  const stale: Holder[] = [];
  for await (const e of Deno.readDir(records)) {
    if (!e.name.endsWith(".json")) continue;
    const path = `${records}/${e.name}`;
    let h: Holder;
    try {
      h = { ...JSON.parse(await Deno.readTextFile(path)), path };
    } catch {
      await Deno.remove(path).catch(() => {});
      continue;
    }
    if (living(h)) stale.push(h);
    else await Deno.remove(path).catch(() => {});
  }
  const viewHash = (view: string[]) => sha256(JSON.stringify([view, HOLDER]));

  const hold = (wide?: string): Promise<Holder> => {
    const key = wide ?? "";
    const known = holders.get(key);
    if (known) {
      return known.then((h) => {
        if (living(h)) return h;
        if (holders.get(key) === known) holders.delete(key);
        return hold(wide);
      });
    }
    const opened = (async () => {
      const view = viewFor(wide);
      const hash = await viewHash(view);
      const path = `${records}/${(await sha256(key)).slice(0, 16)}.json`;
      const left = stale.findIndex((h) => h.view === hash && h.path === path);
      if (left >= 0) return stale.splice(left, 1)[0];
      const what = `${agentId}${wide ? ` at ${wide}` : ""}`;
      const record = await startHolder(view, `${path.slice(0, -5)}.log`, what);
      const h = { ...record, view: hash, path };
      await Deno.writeTextFile(path, JSON.stringify({ ...record, view: hash }));
      return h;
    })();
    holders.set(key, opened);
    opened.catch(() => {
      if (holders.get(key) === opened) holders.delete(key);
    });
    return opened;
  };

  await hold();
  for (const h of [...stale]) {
    if (holdsJobs(h)) continue;
    stale.splice(stale.indexOf(h), 1);
    await end(h);
  }
  return {
    async enter(cwd) {
      // the whole tree, bound, carries the machine's own /proc and every mount under it
      if (cwd === "/") throw new Error("a bubble cannot hold the root of the filesystem");
      const covered = ground.some(([path]) => under(cwd, path));
      const { target } = await hold(covered ? undefined : cwd);
      return [
        "nsenter",
        "-t",
        String(target),
        "-U",
        "-m",
        "-p",
        "-i",
        "-u",
        "--preserve-credentials",
        `--wdns=${cwd}`,
        "--",
      ];
    },
    async close(jobs) {
      if (jobs === "leave") return;
      const all = [...holders.values()];
      holders.clear();
      for (const h of all) {
        const held = await h.catch(() => undefined);
        if (held) await end(held);
      }
      for (const h of stale.splice(0)) await end(h);
    },
  };
}

/** Open one bubble: bubblewrap with the namespaces its own and the holder as its first
 *  process, in a session of its own so it outlives the harness, bubblewrap's errors into
 *  the bubble's log ($0). The holder's environment is a PATH alone — a shell in the
 *  bubble can read what the processes beside it were started with. */
async function startHolder(view: string[], log: string, what: string): Promise<Omit<Kept, "view">> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("setsid", {
      args: [
        "sh",
        "-c",
        'exec "$@" 2>>"$0"',
        log,
        "bwrap",
        ...view,
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--uid",
        String(Deno.uid()),
        "--gid",
        String(Deno.gid()),
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--",
        ...HOLDER,
      ],
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw new Error(
      `bubble for ${what}: cannot run setsid (${
        err instanceof Error ? err.message : String(err)
      }) — deployment.sandbox "bwrap" needs util-linux`,
    );
  }
  child.unref();
  // what goes wrong before bubblewrap runs is said on stderr, which closes once it does
  const before = new Response(child.stderr).text().catch(() => "");
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    lines.read().then((r) => r.value?.startsWith("ready") ?? false, () => false),
    child.status.then(() => false),
    new Promise<false>((resolve) => timer = setTimeout(() => resolve(false), READY_MS)),
  ]);
  clearTimeout(timer);
  lines.cancel().catch(() => {});
  if (!ready) {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    const said = [await before, await Deno.readTextFile(log).catch(() => "")]
      .join("\n").trim().split("\n").slice(-5).join("\n");
    throw new Error(
      `bubble for ${what} did not open: ${said || "no word from it"} — ` +
        `deployment.sandbox "bwrap" needs bubblewrap and util-linux`,
    );
  }
  // bwrap → the bubble's init → the holder: the holder stands in every namespace the
  // bubble has, its mounts already in place
  const init = childrenOf(child.pid)[0];
  const target = init === undefined ? undefined : childrenOf(init)[0];
  const start = init === undefined ? null : startOf(init);
  if (target === undefined || start === null) {
    try {
      if (init !== undefined) Deno.kill(init, "SIGKILL");
    } catch { /* already gone */ }
    throw new Error(`bubble for ${what}: its holder could not be found`);
  }
  return { init, start, target };
}

function childrenOf(pid: number): number[] {
  try {
    return Deno.readTextFileSync(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/)
      .filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
