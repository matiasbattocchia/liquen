/**
 * src/connect/ai/connect.ts — `liquen connect ai`: a model provider's API key, in the vault.
 *
 * The key a model call spends, kept where every other secret is instead of in the harness's
 * environment. It writes ONE vault row and nothing else — no connection, no membership, no
 * event: a model key is the harness's own capability, never fronted to user space (the
 * model call is main's, not a tool's).
 *
 *   ai:<provider>            the org's — every agent on that provider spends it
 *   ai:<provider>:<agent>    an agent's own — spent by that agent alone, before the org's
 *
 * The row carries the key in `value.api_key`. main reads it at EVERY call (transport/mod.ts),
 * so a key connected or rotated while the org runs is spent from the next call, no restart.
 * With no row the SDK's own chain answers, as before: `ANTHROPIC_API_KEY` or an
 * `ant auth login`, `GEMINI_API_KEY` — the environment and the org's `.env`.
 *
 * The key is tried before anything is written: one model listing through the provider's
 * own client, so a key the provider refuses never lands. `--no-probe` writes it untried.
 *
 * Args: `<provider> [--agent <id> | --org] [--no-probe]`. The key is pasted at a prompt, or
 * piped (one line). Env: none.
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../connector.ts";
import { type ProviderName, PROVIDERS } from "../../config.ts";
import { aiKey } from "../../transport/mod.ts";
import { entry } from "../../entry.ts";

export interface AiArgs {
  provider: ProviderName;
  agentId?: string;
  probe: boolean;
}

/** The variable the provider's SDK reads when the vault holds no key. */
export const ENV_KEY: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

/** The door's own flags, after `--dir` has been taken. */
export function parseAiArgs(argv: string[]): AiArgs {
  let provider: string | undefined;
  let agentId: string | undefined;
  let org = false;
  let probe = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") {
      agentId = argv[++i];
      if (agentId === undefined || agentId.startsWith("--")) {
        throw new Error("--agent needs a value");
      }
    } else if (a === "--org") org = true;
    else if (a === "--no-probe") probe = false;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (provider === undefined) provider = a;
    else throw new Error(`one provider — got "${provider}" and "${a}"`);
  }
  if (!provider) throw new Error(`a provider is required — one of ${PROVIDERS.join(", ")}`);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`no provider "${provider}" — one of ${PROVIDERS.join(", ")}`);
  }
  if (org && agentId) throw new Error("--org or --agent <id>, not both");
  return { provider: provider as ProviderName, ...(agentId ? { agentId } : {}), probe };
}

export interface AiDeps {
  creds: Pick<Credentials, "put">;
  /** The try: resolves when the provider takes the key, throws its refusal otherwise.
   *  Injectable for tests; default lists the provider's models through its own client. */
  probe?: (provider: ProviderName, key: string) => Promise<void>;
}

/** Write the key, tried first unless told not to (nothing lands on a refusal). Returns the
 *  vault key and who spends it. */
export async function connectAi(
  args: AiArgs,
  key: string,
  deps: AiDeps,
): Promise<{ key: string; spentBy: string }> {
  const secret = key.trim();
  if (!secret) throw new Error("an empty key — nothing written");
  if (args.probe) {
    try {
      await (deps.probe ?? defaultProbe)(args.provider, secret);
    } catch (err) {
      throw new Error(`${args.provider} refused the key (${refusal(err)}) — nothing written`);
    }
  }
  const vaultKey = aiKey(args.provider, args.agentId);
  const row: CredentialRow = {
    key: vaultKey,
    value: { api_key: secret },
    ...(args.agentId ? { agentId: args.agentId } : {}),
  };
  await deps.creds.put(row);
  const spentBy = args.agentId
    ? `${args.agentId} alone, before the org's`
    : `every agent on ${args.provider} that holds no key of its own`;
  return { key: vaultKey, spentBy };
}

/** A refusal in the provider's own words: Google's client hands its answer back as the
 *  message, a JSON body, whose own message is the sentence worth saying. */
export function refusal(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  try {
    const e = JSON.parse(text)?.error;
    if (typeof e?.message === "string") return e.code ? `${e.code} ${e.message}` : e.message;
  } catch {
    // not JSON: already a sentence
  }
  return text;
}

async function defaultProbe(provider: ProviderName, key: string): Promise<void> {
  if (provider === "google") {
    const { googleClient } = await import("../../transport/google.ts");
    await googleClient(key).models.list({ config: { pageSize: 1 } });
  } else {
    const { anthropicClient } = await import("../../transport/anthropic.ts");
    await anthropicClient(key).models.list({ limit: 1 });
  }
}

const USAGE = `usage: liquen connect ai <provider> [--agent <id> | --org] [--no-probe]

  A model provider's API key, kept in the vault: main reads it at every model call, so it
  is spent from the next call on, no restart. With none, the provider's SDK reads the
  environment as before (ANTHROPIC_API_KEY, GEMINI_API_KEY, .env). The key is pasted at a
  prompt, or piped (one line) for a secret manager.

  <provider>      ${PROVIDERS.join(" · ")}: the vault key is ai:<provider>
  --agent <id>    that agent's own (ai:<provider>:<id>), spent by it alone and before the
                  org's; default: the org's, every agent's
  --org           say the default out loud
  --no-probe      write the key untried; by default one model listing tries it first
  --dir <org>     the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { findRoot, openStore, orgFlag } = await import("../../connector.ts");
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const args = parseAiArgs(org.args);
    const root = findRoot(org);

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
      `Connecting a ${args.provider} key → ${
        args.agentId ? `agent "${args.agentId}"` : "the org"
      }.\n`,
    );
    /** TTY: interactive prompt; piped stdin: the first line (secret managers). */
    const key = Deno.stdin.isTerminal()
      ? prompt("Paste the key:")?.trim()
      : (await new Response(Deno.stdin.readable).text()).split("\n")[0]?.trim();
    if (!key) {
      console.error("nothing pasted — nothing written");
      Deno.exit(2);
    }

    const store = await openStore(root);
    const creds = await store.vault();
    try {
      const { key: stored, spentBy } = await connectAi(args, key, { creds });
      console.error(`\n✓ stored: ${stored}${args.probe ? ` (${args.provider} took it)` : ""}`);
      console.error(`  spent by ${spentBy}, from the next model call`);
      if (Deno.env.get(ENV_KEY[args.provider])) {
        console.error(
          `  ${
            ENV_KEY[args.provider]
          } in the environment now answers only when the vault holds none`,
        );
      }
      console.error("  (deno task status shows the vault)");
    } finally {
      await creds.close();
    }
  });
}
