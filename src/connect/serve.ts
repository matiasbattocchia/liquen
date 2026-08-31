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
