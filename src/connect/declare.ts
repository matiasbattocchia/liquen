/**
 * connect/declare.ts — the last step of every connect door (DESIGN §4, §9).
 *
 * A grant writes the MAP (connections, memberships, the vault); the catalog is what says
 * a PROCESS should run — `liquen start` spawns one child per `connections.<name>`. So the two
 * halves land together: the door that just earned the grant declares the connection, and
 * says so, because the file is git-tracked and the operator is owed the diff.
 */

import { type ConnectorSpec, declareConnection, readConfig } from "../config.ts";
import { ingestUp } from "./serve.ts";
import { socketOf } from "../edge.ts";
import { holder, MAIN, SUPERVISOR } from "../stop.ts";

/** Declare the service — `decided` is what the door earned — then report what
 *  config.jsonc now holds. A declared section is the operator's and is left as found. */
export async function declared(
  root: string,
  spec: ConnectorSpec,
  decided: Record<string, unknown> = {},
): Promise<void> {
  const added = await declareConnection(root, spec.name, decided);
  console.error(
    added
      ? `  declared "connections": { "${spec.name}": ${
        JSON.stringify(decided)
      } } in config.jsonc — \`liquen start\` runs it`
      : `  config.jsonc already declares "${spec.name}" — \`liquen start\` runs it`,
  );
}

/** How long a door waits for the org to come up around it, and how often it looks. */
export const INGEST_WAIT_MS = 120_000;
const INGEST_POLL_MS = 1_000;

/** Say `sentence`, then wait for `up` to answer yes, and refuse with the sentence when it
 *  does not in time. The person reading the line is at a terminal, and `liquen start` in
 *  the next one brings the org up in a second. */
async function awaited(
  up: () => Promise<boolean>,
  sentence: string,
  what: string,
  waitMs: number,
): Promise<void> {
  if (await up()) return;
  console.error(`${sentence}\n  waiting up to ${Math.round(waitMs / 1_000)}s for it…`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(INGEST_POLL_MS, waitMs)));
    if (await up()) {
      console.error(`  ${what} is up — going on`);
      return;
    }
  }
  throw new Error(sentence);
}

/** The door's FIRST step, before the service is asked for anything: the connection
 *  DECLARED, and its process UP.
 *
 *  Declared, because `liquen start` runs one child per `connections.<name>` and nothing
 *  else does — a door on a fresh org would otherwise wait for a listener nothing will ever
 *  start. Running the door is the decision, so the file says so from the first run on.
 *
 *  Up, because a grant makes the service deliver from that second on — the whatsmeow
 *  bridge posts the phone's history within seconds of a pairing, an installed Slack app
 *  was sending before the door ran — and a delivery that finds no listener is dropped by
 *  everyone. So the door refuses, in a sentence, rather than take a grant it cannot
 *  receive on. */
export async function requireIngest(
  root: string,
  spec: ConnectorSpec,
  decided: Record<string, unknown> = {},
  waitMs: number = INGEST_WAIT_MS,
): Promise<void> {
  if (!(spec.name in (await readConfig(root)).connections)) await declared(root, spec, decided);
  const sock = socketOf(root, spec.name, "ingest");
  await awaited(
    () => ingestUp(root, spec.name),
    `nothing is listening at ${sock} — ${spec.name}'s ingest is the door the service ` +
      `delivers to, and what arrives before it opens is lost. Run \`liquen start\` (it runs ` +
      `${spec.name} now that the file declares it), then this door.`,
    spec.name,
    waitMs,
  );
}

/** A sign-in door's first step: the edge UP, because the callback comes back to it —
 *  a browser on this machine dials `edge.port` — and a sign-in that lands on a closed port
 *  is a consent spent on nothing. */
export async function requireEdge(root: string, waitMs: number = INGEST_WAIT_MS): Promise<void> {
  const { port } = (await readConfig(root)).edge;
  const up = async () => {
    try {
      (await Deno.connect({ hostname: "127.0.0.1", port })).close();
      return true;
    } catch {
      return false;
    }
  };
  await awaited(
    up,
    `nothing is listening on :${port} — the edge is where the sign-in comes back ` +
      `(edge.port), and \`liquen start\` runs it. Start the org, then this door.`,
    `:${port}`,
    waitMs,
  );
}

/** The step that makes a door's writes take effect, phrased for the org as it is now:
 *  `liquen start` reads the catalog and the vault once, at boot, so a section or a grant a
 *  door just wrote waits for the next one. An org already up (its supervisor, or a main an
 *  interface raised) is restarted; one that is down is started. */
export async function startStep(root: string, what: string): Promise<string> {
  const dir = `${root}/data`;
  const up = (await holder(dir, SUPERVISOR)) !== null || (await holder(dir, MAIN)) !== null;
  return up
    ? `\`liquen stop\`, then \`liquen start\` — ${what}; the running org read the catalog ` +
      `and the vault when it booted`
    : `\`liquen start\` — ${what}`;
}

/** A door's closing lines: what to do now, in order. */
export function printNext(steps: string[]): void {
  if (steps.length) console.error(`\nnext:\n  ${steps.join("\n  ")}`);
}
