/**
 * connect/http.ts — the bound on every connector's call to a third-party API.
 *
 * A dispatcher drains the log serially: one request that never answers holds every send
 * behind it. So no connector calls a service's HTTP API with a bare `fetch` — each call
 * carries a timeout signal, and a stalled request fails like any other network error
 * (no HTTP class, `failedStatus` stamps it without an `error_code`). Long-lived carriers
 * (the Socket Mode WebSocket) are not requests and take no bound.
 */

/** How long one API request may take, headers to body. */
export const API_TIMEOUT_MS = 30_000;

/** `fetchImpl` with a timeout on every call — a caller's own signal keeps aborting too. */
export function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

/** The global `fetch` under `API_TIMEOUT_MS` — what a connector calls an API with. */
export const timedFetch: typeof fetch = withTimeout(
  (input, init) => fetch(input, init),
  API_TIMEOUT_MS,
);
