/**
 * src/connect/token/connect.ts — `liquen connect token`: a bearer token for any API, fronted.
 *
 * The generic door for the TOOL column of the credential grid (DESIGN §4): an API key the
 * org holds, or an agent's own, that no shipped connector knows. It writes ONE vault row
 * and nothing else — no connection, no membership, no event — because a tool credential is
 * capability, not identity: nothing ingests, nothing routes, nobody has to be listening.
 *
 *   token:<name>            the org's — every agent's environment fronts it
 *   token:<name>:<agent>    an agent's own — fronted in that pocket alone
 *
 * The row carries the token in `value.token` (static: the broker hands it back as-is) and
 * the proxy declaration in `extra`: `env`, the var user space holds the `mu-grant-…` handle
 * under, and `hosts`, the only authorities the swap spends it toward. From the next
 * `liquen start` the agent's `fetch -H "Authorization: Bearer $VAR" https://<host>/…` is
 * the whole of it (§9), the credential never in user space.
 *
 * `--probe <url>` spends the token once, from this process, before anything is written: a
 * GET under `Authorization: Bearer`, toward a declared host, and a status outside 2xx
 * refuses the paste. Which var fronts what is `frontedFor`'s rule, so the door says when
 * the row it wrote cannot be fronted — another row of the same scope claims the var, or
 * an org row shadows the agent's.
 *
 * Args: `<name> --env <VAR> --hosts <h1,h2,…> [--agent <id> | --org] [--probe <url>]`.
 * The token is pasted at a prompt, or piped (one line). Env: none.
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../connector.ts";
import { hostAllowed } from "../../proxy/grants.ts";
import { entry } from "../../entry.ts";

export const TOKEN_PREFIX = "token:";

export interface TokenArgs {
  name: string;
  env: string;
  hosts: string[];
  agentId?: string;
  probe?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const VAR = /^[A-Z_][A-Z0-9_]*$/;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** The door's own flags, after `--dir` has been taken. Throws on anything that would write
 *  a row the proxy could not front: a name that is not a key, a var bash could not export,
 *  a host the swap could not match, a probe outside the declaration. */
export function parseTokenArgs(argv: string[]): TokenArgs {
  let name: string | undefined;
  let env: string | undefined;
  let hosts: string[] | undefined;
  let agentId: string | undefined;
  let org = false;
  let probe: string | undefined;
  const value = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") env = value(a, i++);
    else if (a === "--hosts") hosts = value(a, i++).split(",").map((h) => h.trim()).filter(Boolean);
    else if (a === "--agent") agentId = value(a, i++);
    else if (a === "--probe") probe = value(a, i++);
    else if (a === "--org") org = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (name === undefined) name = a;
    else throw new Error(`one name — got "${name}" and "${a}"`);
  }
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
    if (!HOST.test(h)) {
      throw new Error(`--hosts takes hostnames or *.suffix wildcards — got "${h}"`);
    }
  }
  if (org && agentId) throw new Error("--org or --agent <id>, not both");
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
  }
  return { name, env, hosts, ...(agentId ? { agentId } : {}), ...(probe ? { probe } : {}) };
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
  creds: Pick<Credentials, "put" | "list">;
  /** The probe's GET — injectable for tests; default fetches with a 30s bound. */
  probe?: (url: string, token: string) => Promise<{ status: number }>;
}

/** Write the grant. Probes first when asked (nothing lands on a refusal). Returns the key
 *  and what `frontedFor` will make of it. */
export async function connectToken(
  args: TokenArgs,
  token: string,
  deps: TokenDeps,
): Promise<{ key: string; contention?: string }> {
  if (!token.trim()) throw new Error("an empty token — nothing written");
  if (args.probe) {
    const { status } = await (deps.probe ?? defaultProbe)(args.probe, token.trim());
    if (status < 200 || status >= 300) {
      throw new Error(`the token does not open ${args.probe} (HTTP ${status}) — nothing written`);
    }
  }
  const key = tokenKey(args.name, args.agentId);
  const row: CredentialRow = {
    key,
    value: { token: token.trim() },
    ...(args.agentId ? { agentId: args.agentId } : {}),
    extra: { env: args.env, hosts: args.hosts },
  };
  await deps.creds.put(row);
  const said = contention(await deps.creds.list(""), row);
  return { key, ...(said ? { contention: said } : {}) };
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

const USAGE =
  `usage: liquen connect token <name> --env <VAR> --hosts <h1,h2,…> [--agent <id> | --org]
                           [--probe <url>]

  A bearer token for any API, fronted through the egress proxy: the agent's environment
  holds a handle under <VAR>, and \`fetch -H "Authorization: Bearer $VAR" https://<host>/…\`
  spends the real token, which never enters user space. The token is pasted at a prompt,
  or piped (one line) for a secret manager. Picked up at the next \`liquen start\`.

  <name>          what the token is for (\`crm\`, \`sonar\`): the vault key is token:<name>
  --env <VAR>     the environment variable the agent reads the handle from
  --hosts <list>  the only authorities the token is spent toward — exact hostnames or
                  *.suffix wildcards, comma-separated
  --agent <id>    file the grant as that agent's own (fronted in its pocket alone; the key
                  becomes token:<name>:<id>); default: the org's, every agent's fallback
  --org           say the default out loud
  --probe <url>   GET it once with the token before writing; a status outside 2xx refuses
  --dir <org>     the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { findRoot, openCredentials, orgFlag } = await import("../../connector.ts");
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const args = parseTokenArgs(org.args);
    const root = findRoot(org);
    const dir = `${root}/data`;

    if (args.agentId) {
      // the roster is the catalog's say (`agents.<name>`): a door runs before any start
      const { readConfig } = await import("../../config.ts");
      const known = Object.keys((await readConfig(root)).agents);
      if (!known.includes(args.agentId)) {
        throw new Error(
          `no agent "${args.agentId}" on the roster — have: ${known.join(" · ") || "(none)"}`,
        );
      }
    }

    console.error(
      `Connecting a token for ${args.name} → ${
        args.agentId ? `agent "${args.agentId}"` : "the org"
      }, ` +
        `fronted as $${args.env} toward ${args.hosts.join(", ")}.\n`,
    );
    /** TTY: interactive prompt; piped stdin: the first line (secret managers). */
    const token = Deno.stdin.isTerminal()
      ? prompt("Paste the token:")?.trim()
      : (await new Response(Deno.stdin.readable).text()).split("\n")[0]?.trim();
    if (!token) {
      console.error("nothing pasted — nothing written");
      Deno.exit(2);
    }

    const creds = await openCredentials(dir);
    try {
      const { key, contention } = await connectToken(args, token, { creds });
      console.error(`\n✓ stored: ${key}${args.probe ? ` (probe ${args.probe} answered 2xx)` : ""}`);
      if (contention) console.error(`  but: ${contention}`);
      else console.error(`  fronted as $${args.env} from the next \`liquen start\``);
      console.error("  (deno task status shows the vault)");
    } finally {
      await creds.close();
    }
  });
}
