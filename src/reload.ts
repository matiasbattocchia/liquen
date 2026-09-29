/**
 * reload.ts — `liquen reload`: the running org takes up config.jsonc as it is now (§9).
 *
 *   liquen reload [<process>…]
 *
 * The file is read here first, so a key it gets wrong is this command's refusal and the run
 * goes on as it was. A file boot takes is handed to the supervisor over the run's socket,
 * `data/run/liquen.sock` (start.ts), which brings the run in line with it: a process whose
 * part of the file changed restarts, a connection declared since starts, one no longer
 * declared stops, one that refused gets another go, and each process NAMED restarts
 * whatever the file says of it — for what a process reads once at boot and the file does
 * not hold, such as the carrier a connection's ingest picks off the vault. The supervisor
 * answers with what moved, so the caller can say it.
 *
 * The setup doors that write the file — `liquen connect`, `liquen agent` — reload the run
 * themselves, so the command is for an edit made by hand.
 */

import { findRoot, orgFlag, readConfig } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import { socketUp } from "./connect/serve.ts";
import { holder, MAIN, SUPERVISOR } from "./stop.ts";

export const USAGE = `usage: liquen reload [<process>…] [--dir <org>]

  The running org takes up config.jsonc: what the edit touched restarts, a connection
  declared since starts, one removed stops. A process named restarts either way.

  --dir <org>    the org, when run from elsewhere`;

/** The socket the run answers on: a POST of `{ restart: string[] }` — the processes to
 *  restart whatever the file says of them — answered with the `Moves` it made, or with
 *  the sentence it refused on. */
export function runSocket(root: string): string {
  return `${root}/data/run/${SUPERVISOR}.sock`;
}

/** What a reload moved, by process name. */
export interface Moves {
  stop: string[];
  restart: string[];
  start: string[];
}

/** The moves in words: `slack restarted · whatsapp started`, or that nothing changed. */
export function moved(m: Moves): string {
  const said = [
    ...m.stop.map((name) => `${name} stopped`),
    ...m.restart.map((name) => `${name} restarted`),
    ...m.start.map((name) => `${name} started`),
  ];
  return said.length > 0 ? said.join(" · ") : "nothing changed";
}

/** Have the org's run read config.jsonc again, once the file reads, and restart the
 *  processes named besides. What the run moved, or null when no `liquen start` runs this
 *  org. A refusal the run answers with — a file it cannot take, a name it does not run —
 *  is thrown as its sentence. */
export async function reload(root: string, restart: string[] = []): Promise<Moves | null> {
  await readConfig(root);
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

/** What a door says after it wrote the file: who took the change up, and what moved. */
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
        ? `nothing running — ${root}; \`liquen start\` runs the file as it is`
        : `the run took up config.jsonc: ${moved(moves)}`,
    );
  });
}
