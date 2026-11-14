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
 * the proxy declaration in `extra`: `env`, the var user space holds the `sentinel-<VAR>`
 * placeholder under, `hosts`, the only authorities the swap spends it toward, and `paths` when given,
 * the only paths there (a tenant's `/organization/<id>/`, for a key that opens every
 * tenant's). From the next
 * `liquen start` the agent's `fetch -H "Authorization: Bearer $VAR" https://<host>/…` is
 * the whole of it (§9), the credential never in user space.
 *
 * `--probe <url>` spends the token once, from this process, before anything is written: a
 * GET under `Authorization: Bearer`, toward a declared host, and a status outside 2xx
 * refuses the paste. Which var fronts what is `frontedFor`'s rule, so the door says when
 * the row it wrote cannot be fronted — another row of the same scope claims the var, or
 * an org row shadows the agent's.
 *
 * This file is the door's flags and prompt; the grant itself is `grant.ts`, the one path a
 * connector that provisions tokens takes too.
 *
 * Args: `<name> --env <VAR> --hosts <h1,h2,…> [--paths <p1,p2,…>] [--agent <id> | --shared]
 * [--probe <url>]`.
 * The token is pasted at a prompt, or piped (one line). Env: none.
 */

import { helpFlag } from "../help.ts";
import { entry } from "../../entry.ts";
import { connectToken, parseTokenArgs } from "./grant.ts";

const USAGE = `usage: liquen connect token <name> --env <VAR> --hosts <h1,h2,…> [--paths <p1,p2,…>]
                           [--agent <id> | --shared] [--probe <url>]

  A bearer token for any API, fronted through the egress proxy: the agent's environment
  holds a handle under <VAR>, and \`fetch -H "Authorization: Bearer $VAR" https://<host>/…\`
  spends the real token, which never enters user space. The token is pasted at a prompt,
  or piped (one line) for a secret manager. Picked up at the next \`liquen start\`.

  <name>          what the token is for (\`crm\`, \`sonar\`): the vault key is token:<name>
  --env <VAR>     the environment variable the agent reads the handle from
  --hosts <list>  the only authorities the token is spent toward — exact hostnames or
                  *.suffix wildcards, comma-separated; a :port binds that port alone
                  (\`localhost:8080\`, a local service reached over plain HTTP)
  --paths <list>  the only paths the token is spent on there, comma-separated: a path and
                  everything under it, by whole segments (\`/organization/42/\` holds
                  \`/organization/42/deals\`, never \`/organization/420\`); default: any
  --agent <id>    file the grant as that agent's own (fronted in its pocket alone; the key
                  becomes token:<name>:<id>); default: shared, every agent's fallback
  --shared        say the default out loud
  --probe <url>   GET it once with the token before writing; a status outside 2xx refuses
  --dir <org>     the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { findRoot, openStore, orgFlag } = await import(
      "../../connector.ts"
    );
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const args = parseTokenArgs(org.args);
    const root = findRoot(org);
    const store = await openStore(root);

    console.error(
      `Connecting a token for ${args.name} → ${
        args.agentId ? `agent "${args.agentId}"` : "the org"
      }, ` +
        `fronted as $${args.env} toward ${args.hosts.join(", ")}` +
        `${args.paths ? `, under ${args.paths.join(", ")}` : ""}.\n`,
    );
    /** TTY: interactive prompt; piped stdin: the first line (secret managers). */
    const paste = async () =>
      Deno.stdin.isTerminal()
        ? prompt("Paste the token:") ?? undefined
        : (await new Response(Deno.stdin.readable).text()).split("\n")[0];
    const { key, contention } = await connectToken(store, args, paste);
    console.error(`\n✓ stored: ${key}${args.probe ? ` (probe ${args.probe} answered 2xx)` : ""}`);
    if (contention) console.error(`  but: ${contention}`);
    console.error("  (deno task status shows the vault)");
  });
}
