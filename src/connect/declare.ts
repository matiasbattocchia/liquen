/**
 * connect/declare.ts — the last step of every connect door (DESIGN §4, §9).
 *
 * A grant writes the MAP (connections, memberships, the vault); the catalog is what says
 * a PROCESS should run — `mu start` spawns one child per `connections.<name>`. So the two
 * halves land together: the door that just earned the grant declares the connection, and
 * says so, because the file is git-tracked and the operator is owed the diff.
 */

import { declareConnection } from "../config.ts";

/** Declare the service, then report what config.jsonc now holds. */
export async function declared(root: string, name: string): Promise<void> {
  const added = await declareConnection(root, name);
  console.error(
    added
      ? `  declared "connections": { "${name}": {} } in config.jsonc — \`mu start\` runs it`
      : `  config.jsonc already declares "${name}" — \`mu start\` runs it`,
  );
}
