/**
 * connect/declare.ts — the last step of every connect door (DESIGN §4, §9).
 *
 * A grant writes the MAP (connections, memberships, the vault); the catalog is what says
 * a PROCESS should run — `liquen start` spawns one child per `connections.<name>`. So the two
 * halves land together: the door that just earned the grant declares the connection, and
 * says so, because the file is git-tracked and the operator is owed the diff.
 */

import { declareConnection } from "../config.ts";

/** Declare the service — `body` is what the door decided for it, written with the
 *  section (a declared section is the operator's, left as found) — then report what
 *  config.jsonc now holds. */
export async function declared(
  root: string,
  name: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const added = await declareConnection(root, name, body);
  console.error(
    added
      ? `  declared "connections": { "${name}": ${
        JSON.stringify(body)
      } } in config.jsonc — \`liquen start\` runs it`
      : `  config.jsonc already declares "${name}" — \`liquen start\` runs it`,
  );
}
