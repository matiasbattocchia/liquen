/**
 * stop.ts — a connection's answer to SIGTERM: the shape main gives the same signal.
 *
 * A connection process (run.ts) is resident halves — an ingest serving, a dispatcher
 * subscribed. Stopping is: stop taking work, await what is in flight, exit — so the
 * supervisor's grace (`STOP_TIMEOUT_MS`, then SIGKILL) is a window the process
 * actually uses. What a hard kill can leave — a send on the wire whose stamp never
 * landed — is bounded by the delivery contract: `send` answers queued, nothing claims
 * delivery before `dispatched_at`, and a restart may duplicate that one message.
 */

/** Install SIGTERM/SIGINT handling over each half's stop. A second signal during the
 *  drain exits immediately — the caller asked twice. */
export function exitOnStop(stops: (() => Promise<void>)[]): void {
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sig, () => {
      if (stopping) Deno.exit(1);
      stopping = true;
      Promise.allSettled(stops.map((stop) => stop())).then(() => Deno.exit(0));
    });
  }
}
