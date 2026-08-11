/**
 * connect/errors.ts — the dispatch failure stamp, shared by every dispatcher.
 *
 * A failed send stamps `status` with `state = "failed"`, `failed_at`, the error string,
 * and — when the failure has an HTTP class — `error_code` (422, 503, …). No retry loop
 * lives here (that's the scheduler, PROJECT #10); the code is the tag a retrier reads
 * off the log later: 4xx = permanent (the same send is refused again), 5xx = transient
 * (try later), 429 = rate limited (also later), absent = the request never reached the
 * service (network). The stamp is json_patch-merged, so a successful retry's
 * `dispatched_at` and the echo's `state` simply land on top.
 */

/** An error that knows its HTTP class — dispatch `send`/`post` seams throw these. */
export class DispatchError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** The `failed` delivery stamp for `setDelivery` (§5: the agent's only sign a queued
 *  send never left). `error_code` rides along when the error carries one. */
export function failedStatus(err: unknown): Record<string, string | number> {
  return {
    state: "failed",
    failed_at: new Date().toISOString(),
    error: String(err),
    ...(err instanceof DispatchError && err.code !== undefined ? { error_code: err.code } : {}),
  };
}
