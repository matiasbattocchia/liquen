/**
 * exec/bubble.ts — an agent's shells inside bubblewrap (DESIGN §9, `system.sandbox: "bwrap"`).
 *
 * A bubble is a set of namespaces with one VIEW of the filesystem, held open by its first
 * process (exec/hold.ts). A call enters it — `setsid nsenter … bash -c` — so the call is a
 * process group the harness spawned, probes and kills exactly as a bare one, and a job it
 * leaves running lives on in the bubble until the bubble ends: with the harness, since the
 * holder dies with its parent.
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
 * The network is the bubble's own loopback. The holder listens there on the port
 * `HTTPS_PROXY` names and carries each connection over the unix socket the egress proxy
 * accepts on: the proxy is the only way out.
 */

import { denoDir } from "./bash.ts";

export interface Bubble {
  /** The argv a spawn runs under to be inside the bubble, standing at `cwd`: a bubble whose
   *  view holds `cwd`, opened on first need. */
  enter(cwd: string): Promise<string[]>;
  /** End every bubble: what runs in one ends with it. */
  close(jobs: "end" | "leave"): Promise<void>;
}

export interface BubbleOptions {
  /** The org's data root. */
  dir: string;
  agentId: string;
  /** The unix socket the egress proxy accepts on. */
  socket: string;
  /** The loopback port `HTTPS_PROXY` names. */
  port: number;
}

/** Where a bubble sees the egress proxy's socket. */
const INNER_SOCKET = "/run/liquen/egress.sock";
const HOLD_URL = import.meta.resolve("./hold.ts");
/** How long a holder is given to say `ready`. */
const READY_MS = 10_000;
/** The system dirs a distribution keeps either as directories or as links into /usr. */
const ROOT_DIRS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64"];

interface Holder {
  /** A process inside the bubble: what `nsenter` enters. */
  target: number;
  child: Deno.ChildProcess;
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

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

export async function openBubble(
  { dir, agentId, socket, port }: BubbleOptions,
): Promise<Bubble> {
  const root = dir.replace(/\/[^/]+$/, "");
  const home = `${dir}/agents/${agentId}`;
  // the folders the classification shows: a cwd under one of them needs no wider view
  const ground: [string, "rw" | "ro"][] = [
    [home, "rw"],
    [`${dir}/shared`, "rw"],
    [`${dir}/system`, "ro"],
    [`${dir}/conversations`, "ro"],
  ];
  const cache = await denoDir();
  await warm(cache);

  const viewFor = (wide?: string): string[] => {
    const args = [...systemBinds(), ...toolBinds(cache)];
    // the stood-in directory over the system, and the classification over it
    if (wide) args.push("--bind", wide, wide);
    if (wide && under(dir, wide)) args.push("--tmpfs", dir);
    for (const [path, mode] of ground) {
      args.push(mode === "rw" ? "--bind-try" : "--ro-bind-try", path, path);
    }
    if (wide && under(`${root}/.env`, wide)) {
      args.push("--ro-bind-try", "/dev/null", `${root}/.env`);
    }
    args.push("--ro-bind", socket, INNER_SOCKET);
    return args;
  };

  const holders = new Map<string, Promise<Holder>>();
  const hold = (key: string, wide?: string): Promise<Holder> => {
    let h = holders.get(key);
    if (!h) {
      h = startHolder(viewFor(wide), cache, port, `${agentId}${wide ? ` at ${wide}` : ""}`);
      holders.set(key, h);
      // a holder that ends takes its bubble with it: the next call opens a fresh one
      h.then((held) => held.child.status, () => {}).finally(() => {
        if (holders.get(key) === h) holders.delete(key);
      });
    }
    return h;
  };

  await hold("");
  return {
    async enter(cwd) {
      // the whole tree, bound, carries the machine's own /proc and every mount under it
      if (cwd === "/") throw new Error("a bubble cannot hold the root of the filesystem");
      const covered = ground.some(([path]) => under(cwd, path));
      const { target } = await (covered ? hold("") : hold(cwd, cwd));
      return [
        "nsenter",
        "-t",
        String(target),
        "-U",
        "-m",
        "-p",
        "-n",
        "-i",
        "-u",
        "--preserve-credentials",
        `--wdns=${cwd}`,
        "--",
      ];
    },
    async close() {
      const all = [...holders.values()];
      holders.clear();
      for (const h of all) {
        const held = await h.catch(() => undefined);
        if (!held) continue;
        try {
          held.child.kill("SIGKILL");
        } catch { /* already gone */ }
        await held.child.status;
      }
    },
  };
}

/** The holder's module, in the cache the bubble reads: a fetch the harness makes, once. */
async function warm(cache: string): Promise<void> {
  const o = await new Deno.Command("deno", {
    args: ["cache", HOLD_URL],
    env: { DENO_DIR: cache },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!o.success) {
    throw new Error(
      `cannot cache ${HOLD_URL} for the bubble: ${new TextDecoder().decode(o.stderr).trim()}`,
    );
  }
}

/** Open one bubble: bubblewrap with every namespace its own, the holder as its first
 *  process. The holder's environment is empty but for its cache — a shell in the bubble can
 *  read what the processes beside it were started with. */
async function startHolder(
  view: string[],
  cache: string,
  port: number,
  what: string,
): Promise<Holder> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("bwrap", {
      args: [
        ...view,
        "--unshare-all",
        "--die-with-parent",
        "--setenv",
        "DENO_DIR",
        cache,
        "--",
        Deno.execPath(),
        "run",
        "--cached-only",
        // a unix socket is network to deno, and a path it reads and writes
        `--allow-net=127.0.0.1,unix:${INNER_SOCKET}`,
        `--allow-read=${INNER_SOCKET}`,
        `--allow-write=${INNER_SOCKET}`,
        HOLD_URL,
        INNER_SOCKET,
        String(port),
      ],
      clearEnv: true,
      env: {},
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw new Error(
      `bubble for ${what}: cannot run bwrap (${
        err instanceof Error ? err.message : String(err)
      }) — system.sandbox "bwrap" needs bubblewrap installed`,
    );
  }
  // what the bubble says, said as it comes; until it opens, kept for the refusal too
  let said = "";
  const errors = child.stderr.pipeThrough(new TextDecoderStream()).pipeTo(
    new WritableStream({
      write(text) {
        said += text;
        for (const line of text.split("\n")) {
          if (line.trim()) console.error(`[bubble] ${what}: ${line.trim()}`);
        }
      },
    }),
  ).catch(() => {});
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    lines.read().then((r) => r.value?.startsWith("ready") ?? false),
    child.status.then(() => false),
    new Promise<false>((resolve) => timer = setTimeout(() => resolve(false), READY_MS)),
  ]);
  clearTimeout(timer);
  if (!ready) {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    await child.status;
    await errors;
    throw new Error(`bubble for ${what} did not open: ${said.trim() || "no word from it"}`);
  }
  lines.cancel().catch(() => {});
  // bwrap → the bubble's init → the holder: the holder stands in every namespace the bubble
  // has, its mounts already in place
  const init = childrenOf(child.pid)[0];
  const target = init === undefined ? undefined : childrenOf(init)[0] ?? init;
  if (target === undefined) {
    child.kill("SIGKILL");
    await child.status;
    throw new Error(`bubble for ${what}: its holder could not be found`);
  }
  return { target, child };
}

function childrenOf(pid: number): number[] {
  try {
    return Deno.readTextFileSync(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/)
      .filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
