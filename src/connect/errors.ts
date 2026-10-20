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

/** The service ended an account's access (§5 `signed_out`): a refresh it refused for good
 *  (`invalid_grant`), an app uninstalled, a token revoked. Permanent — the same send is
 *  refused until the principal links the account again — and it names what to mark down:
 *  the vault grant (`key`) when the refusal knows it, else the row the send rode. */
export class SignedOut extends DispatchError {
  constructor(message: string, readonly key?: string) {
    super(message, 401);
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
