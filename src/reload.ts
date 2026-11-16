/**
 * reload.ts — `liquen reload`: config.yaml applied to the store (§9), and the run's socket.
 *
 *   liquen reload [--overwrite]
 *
 * The file is applied here, three-way (`org.ts`): an edit to the file lands, a key a
 * command changed since stays, and a key both changed is said, with the store's value
 * kept and the two ways out. Then the run is poked, and nothing restarts: main and the
 * connectors read the store on each use, the supervisor starts a connection declared or
 * enabled since and stops one removed or disabled, and main brings each agent in line
 * with its row. A change only a start takes up is named in the answer, with the
 * `liquen restart` that takes it up.
 *
 * The run answers on `data/run/liquen.sock` (start.ts): a POST of `{ restart? }` has the
 * supervisor bring its processes in line with the store, give a process that refused
 * another go, and restart each process named, answered with what moved. A command that
 * declares, disables or removes a connection pokes it the same way (`reconciled`).
 */

import { findRoot, orgFlag, readFile } from "./config.ts";
import { applyFile, type Conflict, conflictLines } from "./org.ts";
import { poke } from "./roster.ts";
import { openStore } from "./store/mod.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { socketUp } from "./connect/serve.ts";
import { holder, MAIN, SUPERVISOR } from "./stop.ts";

export const USAGE = `usage: liquen reload [--overwrite] [--dir <org>]

  Apply config.yaml to the store: an edit to the file lands, a key a command changed
  since stays, and a key both changed keeps the store's value and is said. The running
  org reads what changed; a connection declared or enabled starts, one removed or
  disabled stops, and a change only a start takes up is named with its \`liquen restart\`.

  --overwrite    take the file's value wherever it differs from the store's
  --dir <org>    the org, when run from elsewhere`;

/** The socket the run answers on. */
export function runSocket(root: string): string {
  return `${root}/data/run/${SUPERVISOR}.sock`;
}

/** A key a process reads only at its start, changed since it started: the processes that
 *  take it up at their next start. */
export interface Owed {
  path: string;
  processes: string[];
}

/** What the run moved, by process name, and what it owes a restart. */
export interface Moves {
  stop: string[];
  restart: string[];
  start: string[];
  owed: Owed[];
}

/** The moves in words: `slack restarted · whatsapp started`, or that nothing changed. */
export function moved(m: Moves): string {
  const said = [
    ...m.stop.map((name) => `${name} stopped`),
    ...m.restart.map((name) => `${name} restarted`),
    ...m.start.map((name) => `${name} started`),
  ];
  return said.length > 0 ? said.join(" · ") : "no process moved";
}

/** A line per key the run owes a restart, with the command that pays it. */
export function owedLines(owed: Owed[]): string[] {
  return owed.map((o) =>
    `${o.path} changed: \`liquen restart ${o.processes.join(" ")}\` takes it up`
  );
}

/** Apply the file to the store, through a handle of this call's own; the conflicts it
 *  left. */
export async function applied(
  root: string,
  opts: { overwrite?: boolean } = {},
): Promise<Conflict[]> {
  const log = await (await openStore(root)).log();
  try {
    return (await applyFile(root, log, opts)).conflicts;
  } finally {
    await log.close();
  }
}

/** Have the run bring its processes in line with the store, restarting the ones named.
 *  What moved, or null when no `liquen start` runs this org. A refusal the run answers
 *  with, a name it does not run, is thrown as its sentence. */
export async function reconcile(root: string, restart: string[] = []): Promise<Moves | null> {
  const sock = runSocket(root);
  if (!(await socketUp(sock))) return null;
  const client = Deno.createHttpClient({ proxy: { transport: "unix", path: sock } });
  try {
    const res = await fetch("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ restart }),
      client,
    });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  } finally {
    client.close();
  }
}

/** What a door says after it wrote the store: who took the change up, and what moved. */
export async function reconciled(root: string, restart: string[] = []): Promise<string> {
  const moves = await reconcile(root, restart);
  if (moves !== null) return `the running org took it up: ${moved(moves)}`;
  const mind = await holder(`${root}/data`, MAIN);
  return mind === null
    ? "`liquen start` runs it"
    : `main (pid ${mind}) runs without \`liquen start\`, which is what runs connections`;
}

/** What a reload did: the conflicts the apply left, what the run moved (null with no
 *  run), and what main said of its agents (null with no main). */
export interface Reloaded {
  conflicts: Conflict[];
  moves: Moves | null;
  agents: string | null;
}

/** Apply the file, then poke the run and main. */
export async function reload(
  root: string,
  opts: { overwrite?: boolean } = {},
): Promise<Reloaded> {
  await readFile(root);
  const conflicts = await applied(root, opts);
  const moves = await reconcile(root);
  const agents = await poke(root);
  return { conflicts, moves, agents };
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const overwrite = org.args.includes("--overwrite");
    const stray = org.args.find((a) => a !== "--overwrite");
    if (stray !== undefined) throw new Error(`unknown argument ${stray}\n${USAGE}`);
    const root = findRoot(org);
    const { conflicts, moves, agents } = await reload(root, { overwrite });
    for (const line of conflictLines(conflicts)) console.error(line);
    if (moves === null && agents === null) {
      console.log(`config.yaml applied — nothing running at ${root}; \`liquen start\` runs it`);
      return;
    }
    const said = [
      ...(moves ? [moved(moves)] : []),
      ...(agents ? [agents] : []),
    ];
    console.log(`config.yaml applied: ${said.join(" · ")}`);
    for (const line of owedLines(moves?.owed ?? [])) console.log(line);
  });
}
