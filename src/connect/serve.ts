/**
 * serve.ts — the ingest's front door: bind the configured port, or any free one for 0.
 *
 * `ingestPort: 0` is for dialers that can read the announcement — `gh webhook forward`,
 * a test, a dev terminal: the bound port is chosen by the OS and announced on stderr.
 * A configured peer that HOLDS the org's address (the bridge's URL, an Events API
 * request URL) needs a declared port: an auto port re-rolls on every restart.
 *
 * A taken port names its own knob — parallel orgs each declare their own.
 */

/** Whether something is already answering on the org's ingest port.
 *
 *  The mirror of `serveIngest`, for the ONE door that needs it: a pairing hands a service
 *  the org's address, and the service dials it from that second on — the whatsmeow bridge
 *  posts the linked phone's history within seconds, and nothing retries it. So that door
 *  asks first, and refuses when the answer is no.
 *
 *  It is a CONNECT, not a bind: the ingest is the thing that binds, so asking the kernel
 *  for the port would only prove that NOBODY holds it. What this proves is the opposite
 *  and exactly as much as the door needs — someone is there. Which process it is, it does
 *  not ask; nothing else in the org wants that port, and a stranger holding it is the
 *  collision `serveIngest` already names.
 *
 *  It probes loopback, where the door runs. `ingestUrl` may name the org by an address
 *  only the service can resolve (a container's host alias), and that address is the
 *  service's to reach, not ours to verify. */
export async function ingestUp(port: number): Promise<boolean> {
  try {
    (await Deno.connect({ hostname: "127.0.0.1", port })).close();
    return true;
  } catch {
    return false;
  }
}

/** Serve `handler`, announcing the actually-bound port; a taken port throws naming
 *  `configKey` (e.g. `connections.slack.ingestPort`). */
export function serveIngest(
  configKey: string,
  port: number,
  handler: (req: Request) => Response | Promise<Response>,
  announce: (boundPort: number) => void,
): Deno.HttpServer<Deno.NetAddr> {
  try {
    return Deno.serve({ port, onListen: ({ port: bound }) => announce(bound) }, handler);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      throw new Error(`port ${port} in use — another org running? set ${configKey}`);
    }
    throw err;
  }
}
