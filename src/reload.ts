/**
 * reload.ts — `liquen reload`: config.yaml applied to the store, and the running org
 * brought in line with it (§9).
 *
 *   liquen reload [<process>…]
 *
 * The file is read here first, so a key it gets wrong is this command's refusal and the run
 * goes on as it was. A file boot takes is handed to the supervisor over the run's socket,
 * `data/run/liquen.sock` (start.ts), which applies it to the store — a key it declares
 * overwrites the store's, a key it leaves out keeps the store's value — and brings the
 * run in line with what the store then holds: a process whose part of it changed
 * restarts, a connection declared since starts, one no longer declared stops, one that
 * refused gets another go, main reconciles each agent from its row while the others run
 * on, and each process NAMED restarts whatever the store says of it — for what a process
 * reads once at boot and the store's configuration does not hold, such as the carrier a
 * connection's ingest picks off the vault. The supervisor answers with what moved, so the
 * caller can say it. With no run, the file is applied here, for the next start to find.
 *
 * The commands that write the store — `liquen connect`, `liquen agent` — tell the run
 * themselves, so this one is for an edit to the file.
 */

import { findRoot, orgFlag, readFile } from "./config.ts";
import { applyFile } from "./org.ts";
import { poke } from "./roster.ts";
import { openStore } from "./store/mod.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { socketUp } from "./connect/serve.ts";
import { holder, MAIN, SUPERVISOR } from "./stop.ts";

export const USAGE = `usage: liquen reload [<process>…] [--dir <org>]

  Apply config.yaml to the store and bring the running org in line with it: what the
  edit touched restarts, a connection declared since starts, one removed stops, an agent
  changed is taken up by main. A process named restarts either way.

  --dir <org>    the org, when run from elsewhere`;

/** The socket the run answers on: a POST of `{ restart: string[] }` — the processes to
 *  restart whatever the store says of them — answered with the `Moves` it made, or with
 *  the sentence it refused on. */
export function runSocket(root: string): string {
  return `${root}/data/run/${SUPERVISOR}.sock`;
}

/** What a reload moved, by process name, and what main said of its agents when it was
 *  asked to reconcile them. */
export interface Moves {
  stop: string[];
  restart: string[];
  start: string[];
  agents?: string;
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

/** Apply the file to the store, through a handle of this call's own. */
export async function applied(root: string): Promise<void> {
  const log = await (await openStore(root)).log();
  try {
    await applyFile(root, log);
  } finally {
    await log.close();
  }
}

/** Have the org's run apply config.yaml and come in line with the store, once the file
 *  reads, restarting the processes named besides. What the run moved, or null when no
 *  `liquen start` runs this org: the file is applied here then, and a main an interface
 *  raised is told. A refusal the run answers with — a file it cannot take, a name it does
 *  not run — is thrown as its sentence. */
export async function reload(root: string, restart: string[] = []): Promise<Moves | null> {
  await readFile(root);
  const sock = runSocket(root);
  if (!(await socketUp(sock))) {
    await applied(root);
    await poke(root);
    return null;
  }
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
export async function reloaded(root: string, restart: string[] = []): Promise<string> {
  const moves = await reload(root, restart);
  if (moves !== null) return `the running org took it up: ${moved(moves)}`;
  const mind = await holder(`${root}/data`, MAIN);
  return mind === null
    ? "`liquen start` runs it"
    : `main (pid ${mind}) runs without \`liquen start\`, which is what runs connections`;
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const stray = org.args.find((a) => a.startsWith("-"));
    if (stray !== undefined) throw new Error(`unknown argument ${stray}\n${USAGE}`);
    const root = findRoot(org);
    const moves = await reload(root, org.args);
    console.log(
      moves === null
        ? `config.yaml applied — nothing running at ${root}; \`liquen start\` runs it`
        : `config.yaml applied: ${moved(moves)}${moves.agents ? ` · ${moves.agents}` : ""}`,
    );
  });
}
