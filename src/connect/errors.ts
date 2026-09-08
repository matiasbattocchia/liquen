/**
 * connect/errors.ts — the dispatch failure stamp, shared by every dispatcher.
 *
 * A failed send stamps `status` with `state = "failed"`, `failed_at`, the error string,
 * and `error_code` — the HTTP class when the failure has one (422, 503, …), else nothing.
 * The code is the class the sweeper (`store/sweep.ts`) reads off the log: 4xx = permanent
 * (the same send is refused again), 5xx = transient (offered again), 429 = rate limited
 * (also again), absent = the request never reached the service (network — again). The
 * stamp is json_patch-merged, so a re-offer's `queued_at` and a later `dispatched_at` land
 * on top; a classless failure writes `error_code: null`, which the merge reads as removal,
 * so the class on the row is always the LAST failure's.
 */

/** An error that knows its HTTP class — dispatch `send`/`post` seams throw these. */
export class DispatchError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** The `failed` delivery stamp for `setDelivery` (§5: the agent's only sign a queued
 *  send never left). */
export function failedStatus(err: unknown): Record<string, string | number | null> {
  return {
    state: "failed",
    failed_at: new Date().toISOString(),
    error: String(err),
    error_code: err instanceof DispatchError && err.code !== undefined ? err.code : null,
  };
}
