/**
 * raise.ts — main raised by code that embeds the package (§9).
 *
 * Whoever raises main applies `config.yaml` to the store first, and main reads the store:
 * `liquen start` does at boot, an interface does before it raises an ephemeral main
 * (attach.ts), and an embedder does here. A config that gives its principals in code
 * (tests) has no file to apply.
 */

import { type Main, type MainConfig, start as boot } from "./main.ts";
import { conflictLines } from "./org.ts";
import { applied } from "./reload.ts";
import type { ModelTransport } from "./transport/mod.ts";

/** Apply the org's file, say what it left in conflict, and raise main over the store. */
export async function start(
  config: MainConfig,
  overrides: { transport?: ModelTransport } = {},
): Promise<Main> {
  if (config.root && config.principals === undefined) {
    for (const line of conflictLines(await applied(config.root))) console.error(line);
  }
  return await boot(config, overrides);
}
