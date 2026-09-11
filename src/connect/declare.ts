/**
 * connect/declare.ts — the last step of every connect door (DESIGN §4, §9).
 *
 * A grant writes the MAP (connections, memberships, the vault); the catalog is what says
 * a PROCESS should run — `liquen start` spawns one child per `connections.<name>`. So the two
 * halves land together: the door that just earned the grant declares the connection, and
 * says so, because the file is git-tracked and the operator is owed the diff.
 *
 * The door also picks the ports, because it is the only moment anyone can. A default port
 * is a good address for the FIRST org on a machine and a collision for the second, and the
 * collision surfaces at boot, in a restart loop, with nothing but the knob's name to go on.
 * Here there is still a human at the terminal and a file being written: a taken port is
 * stepped over and the free one is declared, out loud.
 */

import {
  checkPort,
  connectorConfig,
  type ConnectorSpec,
  declareConnection,
  readConfig,
} from "../config.ts";
import { ingestUp } from "./serve.ts";

/** The first port from `want` up that nothing is listening on — the honest test is the
 *  bind itself, since a port is taken by a RUNNING process, not by a config file. So a
 *  sibling org that is merely installed does not move this one, and its own boot will
 *  find whichever of the two started first; the answer is only as true as the moment.
 *  0 is already "any free port", and 64 tries in means giving up and letting boot say so. */
function freePort(want: number): number {
  if (want === 0) return 0;
  for (let port = want; port < want + 64 && port < 65536; port++) {
    try {
      Deno.listen({ port }).close();
      return port;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  return want;
}

/** What the connector's catalog says is a port: `checkPort` is the whole declaration —
 *  a knob validated as a port IS one, so a new connector gets this by writing its spec. */
export function pickPorts(
  spec: ConnectorSpec,
  decided: Record<string, unknown> = {},
): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const e of spec.entries) {
    if (e.check !== checkPort || typeof e.value !== "number" || e.key in decided) continue;
    const free = freePort(e.value);
    if (free !== e.value) moved[e.key] = free; // silence is the default: only a move is news
  }
  return moved;
}

/** Declare the service — `decided` is what the door earned, plus any port the default
 *  could not have — then report what config.jsonc now holds. A declared section is the
 *  operator's and is left as found, ports included. */
export async function declared(
  root: string,
  spec: ConnectorSpec,
  decided: Record<string, unknown> = {},
): Promise<void> {
  const moved = pickPorts(spec, decided);
  for (const [key, port] of Object.entries(moved)) {
    const was = spec.entries.find((e) => e.key === key)!.value;
    console.error(`  port ${was} is in use here — declaring ${key} ${port} instead`);
  }
  const body = { ...decided, ...moved };
  const added = await declareConnection(root, spec.name, body);
  console.error(
    added
      ? `  declared "connections": { "${spec.name}": ${
        JSON.stringify(body)
      } } in config.jsonc — \`liquen start\` runs it`
      : `  config.jsonc already declares "${spec.name}" — \`liquen start\` runs it`,
  );
}

/** How long a door waits for the org to come up around it, and how often it looks. */
export const INGEST_WAIT_MS = 120_000;
const INGEST_POLL_MS = 1_000;

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
 *  receive on. Between saying so and refusing it WAITS: the person reading the line is at
 *  a terminal, and `liquen start` in the next one brings the port up in a second.
 *
 *  `ingestPort: 0` skips the probe: an OS-picked port is held by no service and read off
 *  the announcement by a human (`gh webhook forward`, a dev loop) — nothing delivers there
 *  unattended, so there is nothing to protect. */
export async function requireIngest(
  root: string,
  spec: ConnectorSpec,
  decided: Record<string, unknown> = {},
  waitMs: number = INGEST_WAIT_MS,
): Promise<void> {
  if (!(spec.name in (await readConfig(root)).connections)) await declared(root, spec, decided);
  const { ingestPort } = await connectorConfig<{ ingestPort: number }>(root, spec);
  if (ingestPort === 0) return;
  if (await ingestUp(ingestPort)) return;
  const sentence = `nothing is listening on :${ingestPort} — ${spec.name}'s ingest is the door ` +
    `the service delivers to, and what arrives before it opens is lost. Run \`liquen start\` ` +
    `(it runs ${spec.name} now that the file declares it), then this door.`;
  console.error(`${sentence}\n  waiting up to ${Math.round(waitMs / 1_000)}s for it…`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(INGEST_POLL_MS, waitMs)));
    if (await ingestUp(ingestPort)) {
      console.error(`  :${ingestPort} is up — going on`);
      return;
    }
  }
  throw new Error(sentence);
}
