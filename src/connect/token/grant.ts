/**
 * src/connect/token/grant.ts — a token grant: the vault row `token:<name>[:<agent>]` and
 * the checks before it lands.
 *
 * `liquen connect token` (connect.ts) and a connector that provisions tokens (through
 * connector.ts) write it by this one path: `parseTokenArgs` is the door's flags,
 * `connectToken` the grant. No entry block here, so connector.ts can export it.
 */

import type { CredentialRow, Store } from "../../connector.ts";
import { hostAllowed, pathAllowed, plainPath } from "../../proxy/grants.ts";

export const TOKEN_PREFIX = "token:";

export interface TokenArgs {
  name: string;
  env: string;
  hosts: string[];
  paths?: string[];
  agentId?: string;
  probe?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const VAR = /^[A-Z_][A-Z0-9_]*$/;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** The door's own flags, after `--dir` has been taken, read and checked (`checkTokenArgs`). */
export function parseTokenArgs(argv: string[]): TokenArgs {
  let name: string | undefined;
  let env: string | undefined;
  let hosts: string[] | undefined;
  let paths: string[] | undefined;
  let agentId: string | undefined;
  let shared = false;
  let probe: string | undefined;
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const value = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") env = value(a, i++);
    else if (a === "--hosts") hosts = list(value(a, i++));
    else if (a === "--paths") paths = list(value(a, i++));
    else if (a === "--agent") agentId = value(a, i++);
    else if (a === "--probe") probe = value(a, i++);
    else if (a === "--shared") shared = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (name === undefined) name = a;
    else throw new Error(`one name — got "${name}" and "${a}"`);
  }
  if (shared && agentId) throw new Error("--shared or --agent <id>, not both");
  return checkTokenArgs({
    name: name ?? "",
    env: env ?? "",
    hosts: hosts ?? [],
    ...(paths ? { paths } : {}),
    ...(agentId ? { agentId } : {}),
    ...(probe ? { probe } : {}),
  });
}

/** Throws on anything that would write a row the proxy could not front: a name that is
 *  not a key, a var bash could not export, a host the swap could not match, a probe
 *  outside the declaration. Returns the args it was given. */
export function checkTokenArgs(args: TokenArgs): TokenArgs {
  const { name, env, hosts, paths, probe } = args;
  if (!name) throw new Error("a name is required — what the token is for: `crm`, `sonar`");
  if (!NAME.test(name)) {
    throw new Error(`the name is lowercase letters, digits, dashes — got "${name}"`);
  }
  if (!env) throw new Error("--env is required — the var the agent reads the handle from");
  if (!VAR.test(env)) throw new Error(`--env is an environment variable name — got "${env}"`);
  if (!hosts?.length) {
    throw new Error("--hosts is required — the authorities the token is spent toward");
  }
  for (const h of hosts) {
    // a wildcard stands under a domain, never for a whole top-level one
    if (!HOST.test(h) || (h.startsWith("*.") && !h.slice(2).replace(/:\d+$/, "").includes("."))) {
      throw new Error(
        `--hosts takes hostnames or *.suffix wildcards, each perhaps with a :port — got "${h}"`,
      );
    }
  }
  if (paths !== undefined && !paths.length) throw new Error("--paths names at least one path");
  for (const p of paths ?? []) {
    if (!plainPath(p) || /[?#%]/.test(p)) {
      throw new Error(
        `--paths takes absolute paths with no dot segments, escapes or query — got "${p}"`,
      );
    }
  }
  if (probe !== undefined) {
    let url: URL;
    try {
      url = new URL(probe);
    } catch {
      throw new Error(`--probe is a URL — got "${probe}"`);
    }
    if (!hostAllowed(hosts, url.host)) {
      throw new Error(
        `--probe ${url.host} is outside --hosts ${
          hosts.join(",")
        } — the token would never reach it`,
      );
    }
    if (!pathAllowed(paths, url.pathname)) {
      throw new Error(
        `--probe ${url.pathname} is outside --paths ${
          paths!.join(",")
        } — the token would never reach it`,
      );
    }
  }
  return args;
}

/** The vault key the grant lands under: the org's by name, an agent's by name and id. */
export function tokenKey(name: string, agentId?: string): string {
  return agentId ? `${TOKEN_PREFIX}${name}:${agentId}` : `${TOKEN_PREFIX}${name}`;
}

/** The sentence `frontedFor` would say about `row` among `rows` (the rule: per var, the
 *  org's row when there is exactly one, else the agent's own when there is exactly one).
 *  undefined when the row is what fronts its var. */
export function contention(
  rows: Pick<CredentialRow, "key" | "agentId" | "extra">[],
  row: Pick<CredentialRow, "key" | "agentId" | "extra">,
): string | undefined {
  const env = row.extra?.env;
  const peers = rows.filter((r) => r.key !== row.key && r.extra?.env === env);
  const orgs = peers.filter((r) => !r.agentId);
  if (row.agentId) {
    if (orgs.length === 1) {
      return `$${env} is the org's ${orgs[0].key} in every pocket — ${row.key} is never fronted`;
    }
    const own = peers.filter((r) => r.agentId === row.agentId);
    if (own.length) {
      return `$${env} is claimed by ${
        own.map((r) => r.key).join(", ")
      } too — ${row.agentId} gets neither`;
    }
    return undefined;
  }
  if (orgs.length) {
    return `$${env} is claimed by ${orgs.map((r) => r.key).join(", ")} too — nobody gets either`;
  }
  return undefined;
}

export interface TokenDeps {
  /** The probe's GET — injectable for tests; default fetches with a 30s bound. */
  probe?: (url: string, token: string) => Promise<{ status: number }>;
}

/** Write the grant: `liquen connect token`, and a connector that provisions tokens, by this
 *  one path. The args are checked and an agent's own grant must name an agent the store
 *  holds before the token is asked for (`token` as a function: the door's prompt, so a
 *  typo refuses before a secret is pasted); then the probe, when asked; nothing lands on a
 *  refusal. Returns the key and what `frontedFor` will make of it. */
export async function connectToken(
  store: Pick<Store, "log" | "vault">,
  args: TokenArgs,
  token: string | (() => Promise<string | undefined>),
  deps: TokenDeps = {},
): Promise<{ key: string; contention?: string }> {
  checkTokenArgs(args);
  if (args.agentId) {
    const log = await store.log();
    let known: string[];
    try {
      known = (await log.agents()).map((a) => a.agentId);
    } finally {
      await log.close();
    }
    if (!known.includes(args.agentId)) {
      throw new Error(
        `no agent "${args.agentId}" on the roster — have: ${known.join(" · ") || "(none)"}`,
      );
    }
  }
  const pasted = (typeof token === "string" ? token : await token())?.trim();
  if (!pasted) throw new Error("an empty token — nothing written");
  if (args.probe) {
    const { status } = await (deps.probe ?? defaultProbe)(args.probe, pasted);
    if (status < 200 || status >= 300) {
      throw new Error(`the token does not open ${args.probe} (HTTP ${status}) — nothing written`);
    }
  }
  const key = tokenKey(args.name, args.agentId);
  const row: CredentialRow = {
    key,
    value: { token: pasted },
    ...(args.agentId ? { agentId: args.agentId } : {}),
    extra: { env: args.env, hosts: args.hosts, ...(args.paths ? { paths: args.paths } : {}) },
  };
  const creds = await store.vault();
  try {
    await creds.put(row);
    const said = contention(await creds.list(""), row);
    return { key, ...(said ? { contention: said } : {}) };
  } finally {
    await creds.close();
  }
}

const PROBE_TIMEOUT_MS = 30_000;

async function defaultProbe(url: string, token: string): Promise<{ status: number }> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await res.body?.cancel();
  return { status: res.status };
}
