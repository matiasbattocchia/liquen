/**
 * catalog.ts — `liquen config`: the org's configuration as the store holds it, printed as
 * YAML (§9). Read-only.
 *
 * A key the store holds — set by `config.yaml` at a boot or a reload, or by a command —
 * is a line; a key it does not hold is a comment showing the value it resolves to, the
 * catalog's default. So a line is what a person copies into `config.yaml` to pin it
 * there, and the comments are every other knob there is. `deployment` is the file's own
 * section, printed as the file reads.
 */

import { findRoot, materialize, orgFlag, orgOf, readFile } from "./config.ts";
import { openStore } from "./store/mod.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = `usage: liquen config [--dir <org>]

  Print the org's configuration as the store holds it, as YAML: a key that is set is a
  line, one that is not a comment with its default. Changes nothing.`;

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    if (org.args.length > 0) throw new Error(`unknown argument ${org.args[0]}\n${USAGE}`);
    const root = findRoot(org);
    const { deployment } = await readFile(root);
    const log = await (await openStore(root)).log();
    try {
      const rows = await log.config();
      const held = new Set(rows.map((r) => `${r.scope}\0${r.key}`));
      console.log(
        materialize(orgOf(deployment, rows, await log.agents()), {
          docs: false,
          set: (scope, key) => scope === "deployment" || held.has(`${scope}\0${key}`),
        }).trimEnd(),
      );
    } finally {
      await log.close();
    }
  });
}
