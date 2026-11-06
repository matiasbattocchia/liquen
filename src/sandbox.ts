/**
 * sandbox.ts — the exec plane as one provider (DESIGN §9).
 *
 * Everything an agent's shell needs to exist is exec: the egress proxy that fronts its
 * credentials, the trust bundle its tools verify against, the ground it stands on (its
 * folder, the PATH cascade, its uid), and the shell each session opens there. One provider
 * owns all of it, and main holds only the provider: `sandbox.forAgent(id).session(sid)` is
 * where a session's `exec`, `ambient`, `stand`, `reap` and `files` come from, and `close`
 * ends or leaves every shell's jobs and stops the proxy. The proxy travels with bash because
 * it exists for bash — user space is what must hold a placeholder instead of a credential — so a host
 * with no exec plane has no proxy either, and a remote sandbox brings its own.
 */

import { type ExecGround, type ExecPlane, installExecGround, shippedAt } from "./exec/bash.ts";
import type { ShellUpdate } from "./exec/jobs.ts";
import { type Files, localFiles } from "./store/media.ts";
import type { Store } from "./store/mod.ts";
import type { Storage } from "./store/storage.ts";
import { createGrantBroker, frontedFor, hostAllowed } from "./proxy/grants.ts";
import { openCA } from "./proxy/ca.ts";
import { defaultAudit, type Proxy, type ProxyDeps, sentinelOf, startProxy } from "./proxy/proxy.ts";
import { timingSafeEqual } from "node:crypto";
import { sessionAddress } from "./session.ts";
import {
  type Gateway,
  gatewayFiles,
  gatewayFor,
  lease,
  remoteShell,
  sandboxIdOf,
} from "./exec/gateway.ts";
import { DEFAULT_SANDBOX_SLEEP_MINUTES } from "./config.ts";
import { openBubble } from "./exec/bubble.ts";

/** One session's place in the sandbox: its shell (where it stands, what it left running),
 *  the agent's folder on this ground, and the files port its references resolve through. */
export interface SandboxSession extends ExecPlane {
  home: string;
  files: Files;
}

/** One agent's ground, prepared once; `session` opens (or returns) a session's shell on it. */
export interface SandboxAgent {
  session(sessionId: string): SandboxSession;
}

/** The exec plane's provider. `forAgent` answers for every agent the sandbox was opened
 *  for and refuses any other: a ground is prepared, never improvised. */
export interface Sandbox {
  forAgent(agentId: string): SandboxAgent;
  /** Stop the proxy, and with `jobs: "end"` kill every shell's jobs (the org was stopped);
   *  else leave them running for the next harness to adopt (§9). */
  close(opts?: { jobs?: "end" | "leave" }): Promise<void>;
}

/** Each shell's jobs, as `close` was asked. */
async function closeShells(shells: Iterable<ExecPlane>, jobs: "end" | "leave"): Promise<void> {
  for (const shell of shells) {
    if (jobs === "end") await shell.reap();
    else shell.leave();
  }
}

/** What a shell told of a call after its answer, and the session whose shell it is. */
export interface SessionUpdate extends ShellUpdate {
  agentId: string;
  sessionId: string;
}

export interface LocalSandboxOptions {
  /** The org's store: the proxy fronts the vault's credential rows. */
  store: Store;
  /** The agents that run: each gets a ground under `<dir>/agents/<id>`. */
  agents: string[];
  /** The org's locale, issued into user space under the names every program reads (§9):
   *  the shell speaks the org's language, and a script the agent runs by hand does too.
   *  Null is the catalog's word for none. */
  locale?: string | null;
  /** The org's clock, issued into user space as `TZ`: `date`, and every stamp a program
   *  the agent runs prints, reads the zone its system prompt names, not the machine's. */
  timezone?: string | null;
  /** The `system.bashWaitMs` knob: how long a call is waited on by default. */
  bashWaitMs?: number;
  /** Each agent's `export` knob: the variables of this process's environment its shells
   *  inherit, read at each call. One the environment does not hold is not issued. */
  exports?: Record<string, string[]>;
  /** Where every shell tells what its calls do after their answers (late.ts), with the
   *  session whose shell it is. */
  tell?: (u: SessionUpdate) => void;
  /** Each agent's shells run in its bubble (exec/bubble.ts): `deployment.sandbox: "bwrap"`. */
  bubble?: boolean;
  /** The `deployment.mounts` knob: more of the machine a bubble shows. */
  mounts?: string[];
}

/** The local provider: subprocesses on this machine, ONE GROUND PER AGENT, ONE SHELL PER
 *  SESSION (§9). The ground is the agent's folder — `agents/<id>`, where its docs and
 *  memories already are — with the org's binaries on PATH; the shell on it is the
 *  session's, so where one session stands and what it left running is never another's.
 *  Shells open on first contact and are reaped at close. What an agent may ATTACH (§9
 *  data classification) is the same ground its uid can read: its own folder, the shared
 *  floor, the system docs, and the media store — a `send` naming a path elsewhere is
 *  refused broker-side, before any byte is read. */
export async function openLocalSandbox(
  dir: string,
  {
    store,
    agents,
    locale,
    timezone,
    bashWaitMs,
    exports = {},
    tell,
    bubble,
    mounts = [],
  }: LocalSandboxOptions,
): Promise<Sandbox> {
  // the egress proxy (§9): front every credential row that declares an env var — user
  // space gets the placeholder + proxy env, never a real credential
  const proxy = await installProxy(dir, store);
  const storage = store.storage();
  const localeEnv = orgEnv(locale, timezone);
  const grounds = new Map<string, ExecGround>();
  for (const agentId of agents) {
    const exported = () =>
      Object.fromEntries(
        (exports[agentId] ?? []).flatMap((name) => {
          const v = Deno.env.get(name);
          return v === undefined ? [] : [[name, v]];
        }),
      );
    const userEnv = async () => ({
      ...exported(),
      ...(await proxy.env(agentId)),
      ...localeEnv,
    });
    const bubbled = bubble ? () => openBubble({ dir, agentId, mounts }) : undefined;
    grounds.set(agentId, await installExecGround(dir, agentId, userEnv, bashWaitMs, bubbled));
  }
  const shells = new Map<string, ExecPlane>();
  const homeOf = (agentId: string) => `${dir}/agents/${agentId}`;
  const filesOf = (agentId: string, shell: ExecPlane): Files => {
    const home = homeOf(agentId);
    return localFiles({
      home,
      cwd: shell.cwd,
      roots: [home, `${dir}/shared`, `${dir}/system`],
    }, storage);
  };
  return {
    forAgent(agentId) {
      const ground = grounds.get(agentId);
      if (!ground) throw new Error(`agent ${agentId}: no ground prepared in this sandbox`);
      return {
        session(sessionId) {
          const key = sessionAddress(agentId, sessionId);
          let shell = shells.get(key);
          if (!shell) {
            const told = tell && ((u: ShellUpdate) => tell({ ...u, agentId, sessionId }));
            shell = ground.shell(told);
            shells.set(key, shell);
          }
          return { ...shell, home: homeOf(agentId), files: filesOf(agentId, shell) };
        },
      };
    },
    async close({ jobs = "end" } = {}) {
      await closeShells(shells.values(), jobs); // each session's own jobs (§9)
      for (const ground of grounds.values()) await ground.close(jobs);
      await proxy.close(); // stop the egress proxy and close its vault handle
    },
  };
}

export interface CloudflareSandboxOptions {
  /** The gateway's URL (`deployment.sandbox`). */
  url: string;
  /** Its bearer token (`SANDBOX_API_KEY`). */
  token: string;
  /** Where a file the agent attaches is kept. */
  storage: Storage;
  /** The agents that run: each gets a sandbox of its own. */
  agents: string[];
  locale?: string | null;
  timezone?: string | null;
  bashWaitMs?: number;
  /** The `deployment.sandboxSleepMinutes` knob: a sandbox's life after its last bash call. */
  sleepMinutes?: number;
  /** Where every shell tells what its calls do after their answers (late.ts). */
  tell?: (u: SessionUpdate) => void;
}

/** The org's language and clock under the names every program reads: `LANG` and `TZ`. */
function orgEnv(locale?: string | null, timezone?: string | null): Record<string, string> {
  return { ...(locale ? { LANG: locale } : {}), ...(timezone ? { TZ: timezone } : {}) };
}

/** Where an agent stands in its Cloudflare sandbox: the container's workspace, which is the
 *  agent's alone, since the sandbox is. */
export const REMOTE_HOME = "/workspace";

/** Where the sandbox image lays the harness's programs (`sandbox/cloudflare/Dockerfile`). */
const REMOTE_SHIPPED = "/usr/local/bin";

/** The environment a remote shell runs with, alone: the container's own tools, the agent's
 *  `bin/` first, as the local PATH cascade puts the narrowest scope first. */
const REMOTE_ENV: Record<string, string> = {
  PATH: `${REMOTE_HOME}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: "/home/sandbox",
  USER: "sandbox",
  LOGNAME: "sandbox",
  SHELL: "/bin/bash",
  TERM: "dumb",
};

/** The Cloudflare provider: ONE SANDBOX PER AGENT behind the gateway at `url`
 *  (`sandbox/cloudflare/`), ONE SHELL PER SESSION on it (§9). The sandbox is named by the
 *  agent's id, started by its first bash call and kept by one lease its sessions share
 *  (`lease`); its workspace is the agent's folder, scratch that a stopped container does
 *  not keep — the docs are in the table. A file the agent attaches is copied into the
 *  object store. Closing ends or leaves every shell's jobs, and leaves the sandboxes to the
 *  gateway's sleep. */
export function openCloudflareSandbox(
  { url, token, storage, agents, locale, timezone, bashWaitMs, sleepMinutes, tell }:
    CloudflareSandboxOptions,
): Sandbox {
  const env = { ...REMOTE_ENV, ...orgEnv(locale, timezone) };
  const minutes = sleepMinutes ?? DEFAULT_SANDBOX_SLEEP_MINUTES;
  const sandboxes = new Map(agents.map((id) => {
    const gateway = gatewayFor(url, token, sandboxIdOf(id), minutes);
    return [id, { gateway, lease: lease(gateway, minutes) }];
  }));
  const shells = new Map<string, ExecPlane>();
  return {
    forAgent(agentId) {
      const sandbox = sandboxes.get(agentId);
      if (!sandbox) throw new Error(`agent ${agentId}: no sandbox opened for it`);
      const { gateway, lease } = sandbox;
      return {
        session(sessionId) {
          const key = sessionAddress(agentId, sessionId);
          let shell = shells.get(key);
          if (!shell) {
            shell = remoteShell(
              gateway,
              {
                workspace: REMOTE_HOME,
                env: () => env,
                ...(bashWaitMs ? { defaultWaitMs: bashWaitMs } : {}),
                lease,
              },
              tell && ((u: ShellUpdate) => tell({ ...u, agentId, sessionId })),
            );
            shells.set(key, shell);
          }
          // off, the container and what it held are gone: a read there would start a new one
          const reading: Gateway = {
            ...gateway,
            read: (path) => lease.on() ? gateway.read(path) : Promise.resolve(null),
          };
          const files = gatewayFiles(reading, { home: REMOTE_HOME, cwd: shell.cwd, storage });
          return {
            ...shell,
            // the place an attach names is the principal's, on this machine: no address
            // in the sandbox, so the shell stands in the workspace whoever is connected
            stand: () => shell.stand(undefined),
            bins: () => Promise.resolve([shippedAt(REMOTE_SHIPPED)]),
            home: REMOTE_HOME,
            files,
          };
        },
      };
    },
    async close({ jobs = "end" } = {}) {
      await closeShells(shells.values(), jobs);
    },
  };
}

/** The egress proxy — the org's single credential-bearing egress — as the env provider
 *  bash issues into every spawn (§9), PER AGENT. A shell, bare or in its bubble, is pointed
 *  at it by HTTPS_PROXY and by HTTP_PROXY in both cases (curl reads plain HTTP's only
 *  lowercase), with nothing left out: the proxy dials loopback as readily as the world, so
 *  a grant naming a local service is spent there too, and a client that reads no proxy
 *  setting goes straight out. The proxy terminates only the authorities a fronted
 *  grant binds (where a placeholder can ride and the swap has to see plaintext) and
 *  bridges every other tunnel blind, so the world answers with its own certificates.
 *  The trust file user space is handed is the system
 *  bundle plus the liquen CA, under every name the common clients read it by: a tool
 *  verifying against its own roots still reaches the world, and one honoring the file
 *  reaches the fronted hosts too. Which placeholders ride is the VAULT's say, not this
 *  file's: a credential row that declares `extra.env` (the connect doors write it) is
 *  fronted under that var as `sentinel-<VAR>`, and which row fronts which agent is
 *  `frontedFor` — the org's, or the agent's own, never a peer's. The proxy URL names the
 *  agent by a nonce of its own, so the agent and the variable pick exactly one grant, and
 *  every audit line's agent is the caller. Node's `fetch` reads the proxy settings only
 *  under `NODE_USE_ENV_PROXY`, so the shells carry it. */
interface ProxyHandle {
  env: (agentId: string) => Promise<Record<string, string>>;
  close(): Promise<void>;
}

// where a Linux system keeps its CA bundle, by distribution; the first that exists is it
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/** The trust file user space is handed: the system's roots followed by the liquen CA, written
 *  under the org at boot. It replaces the roots of every tool that reads it, so a machine
 *  with no system bundle refuses to start: the liquen CA alone would leave curl, git and
 *  python trusting nothing but the fronted hosts. */
async function writeTrustBundle(dir: string, caPath: string): Promise<string> {
  let system = "";
  for (const path of SYSTEM_CA_BUNDLES) {
    try {
      system = await Deno.readTextFile(path);
      break;
    } catch { /* not this distribution */ }
  }
  if (!system) {
    throw new Error(
      `no system CA bundle at ${SYSTEM_CA_BUNDLES.join(", ")}: the agents' tools would trust ` +
        `nothing but the fronted hosts. Install ca-certificates.`,
    );
  }
  const out = `${dir}/system/ca-bundle.pem`;
  await Deno.mkdir(`${dir}/system`, { recursive: true });
  await Deno.writeTextFile(out, `${system.trimEnd()}\n${await Deno.readTextFile(caPath)}`);
  return out;
}

/** What the proxy keeps across restarts, beside the CA: the port it listens on and each
 *  agent's nonce, so a job that outlives the harness reaches the next one at the address
 *  it was handed. Readable by the harness alone: a nonce is what lets a connection in. */
interface ProxyState {
  port?: number;
  nonces: Record<string, string>;
}

const PROXY_STATE = "system/proxy.json";

async function readProxyState(dir: string): Promise<ProxyState> {
  try {
    const s = JSON.parse(await Deno.readTextFile(`${dir}/${PROXY_STATE}`));
    return {
      ...(typeof s.port === "number" ? { port: s.port } : {}),
      nonces: s.nonces && typeof s.nonces === "object" ? s.nonces : {},
    };
  } catch {
    return { nonces: {} };
  }
}

async function writeProxyState(dir: string, state: ProxyState): Promise<void> {
  const tmp = `${dir}/${PROXY_STATE}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await Deno.rename(tmp, `${dir}/${PROXY_STATE}`);
}

/** Whether two nonces are the same, in time that tells nothing of where they differ. */
function sameNonce(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

async function installProxy(dir: string, store: Store): Promise<ProxyHandle> {
  const creds = await store.vault();
  const log = await store.log();
  const broker = createGrantBroker({ creds });
  const ca = await openCA(dir);
  // the vault as it reads now: a grant stored while the org runs is fronted from the next
  // command on, and one removed stops swapping at once
  const read = async () => (await creds.list("")).filter((r) => typeof r.extra?.env === "string");
  let fronted = await read();
  const state = await readProxyState(dir);
  let saving = Promise.resolve();
  const save = () => saving = saving.then(() => writeProxyState(dir, state));
  const deps: ProxyDeps = {
    ca,
    broker,
    caller: (agentId, nonce) =>
      Object.hasOwn(state.nonces, agentId) && sameNonce(state.nonces[agentId], nonce),
    grantFor: async (agentId, name) => {
      fronted = await read();
      const row = frontedFor(fronted, agentId).find((r) => r.extra?.env === name);
      return row
        ? { credentialKey: row.key, ...(row.agentId ? { agentId: row.agentId } : {}) }
        : null;
    },
    // every request said on stderr and kept in the egress table (`liquen log requests`)
    audit: (a) => {
      defaultAudit(a);
      const { agentId, ...made } = a;
      void log.egress({ created_at: new Date().toISOString(), agent_id: agentId, ...made })
        .catch((err) => console.error("[proxy] its request could not be recorded:", err));
    },
    terminates: (authority) => fronted.some((r) => hostAllowed(r.extra?.hosts, authority)),
    plain: (authority) =>
      fronted.some((r) =>
        Array.isArray(r.extra?.hosts) &&
        r.extra.hosts.some((h: unknown) =>
          typeof h === "string" && /:\d+$/.test(h) && hostAllowed([h], authority)
        )
      ),
  };
  // the port it held before, while nothing else does
  let proxy: Proxy;
  try {
    proxy = startProxy(deps, { port: state.port });
  } catch (err) {
    if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    proxy = startProxy(deps);
  }
  if (state.port !== proxy.port) {
    state.port = proxy.port;
    await save();
  }
  const bundle = await writeTrustBundle(dir, proxy.caPath);
  const base: Record<string, string> = {
    NODE_USE_ENV_PROXY: "1", // node's own fetch and http read the proxy settings
    SSL_CERT_FILE: bundle, // OpenSSL-based tools: curl, git, wget, Go
    REQUESTS_CA_BUNDLE: bundle, // python requests, and pip through it
    PIP_CERT: bundle,
    NODE_EXTRA_CA_CERTS: proxy.caPath, // node adds to its own roots — the CA alone suffices
    DENO_CERT: proxy.caPath, // so does deno
  };
  // what each agent was last fronted, so the line is said when it changes
  const said = new Map<string, string>();
  console.error(`egress proxy on :${proxy.port}`);
  return {
    env: async (agentId) => {
      fronted = await read();
      if (!Object.hasOwn(state.nonces, agentId)) {
        state.nonces[agentId] = crypto.randomUUID().replaceAll("-", "");
        await save();
      }
      const at = `http://${encodeURIComponent(agentId)}:${
        state.nonces[agentId]
      }@127.0.0.1:${proxy.port}`;
      const env: Record<string, string> = {
        ...base,
        HTTPS_PROXY: at,
        HTTP_PROXY: at,
        http_proxy: at,
      };
      const mine = frontedFor(fronted, agentId);
      for (const r of mine) env[r.extra!.env as string] = sentinelOf(r.extra!.env as string);
      const keys = mine.map((r) => r.key).join(", ");
      if (keys !== (said.get(agentId) ?? "")) {
        console.error(`[proxy] ${agentId} fronted: ${keys || "nothing"}`);
      }
      said.set(agentId, keys);
      return env;
    },
    async close() {
      await proxy.shutdown();
      await creds.close();
      await log.close();
    },
  };
}
