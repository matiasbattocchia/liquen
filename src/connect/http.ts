/**
 * connect/http.ts — the bound on every connector's call to a third-party API.
 *
 * A dispatcher drains the log serially: one request that never answers holds every send
 * behind it. So no connector calls a service's HTTP API with a bare `fetch` — each call
 * carries a timeout signal, and a stalled request fails like any other network error
 * (no HTTP class, `failedStatus` stamps it without an `error_code`). Long-lived carriers
 * (the Socket Mode WebSocket) are not requests and take no bound.
 *
 * And the two ways a request fails BEFORE the service answers are SENTENCES, not faults
 * (`said`): a host that cannot be reached and a request that never answered are facts
 * about the world, and the person reading them — at a door, or off a `failed` stamp — is
 * owed the line, not the frames. `withTimeout` stays the primitive (a test injects it and
 * reads the TimeoutError); `timedFetch`, what every connector calls the world with, says it.
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

/** The host a request names — the subject of a sentence about it. */
function hostOf(input: RequestInfo | URL): string {
  try {
    return new URL(input instanceof Request ? input.url : input).host;
  } catch {
    return String(input);
  }
}

/** Whether `err` is `fetch` reporting that the request never reached a server, and the
 *  reason it gives. Deno words it two ways: `TypeError: fetch failed` with the transport's
 *  own error in `cause` (2.9+), or that transport message directly (earlier). Either way
 *  the useful part follows the url. */
function transportFailure(err: unknown): string | null {
  if (!(err instanceof TypeError)) return null;
  const inner = err.cause instanceof Error ? err.cause.message : err.message;
  if (err.message !== "fetch failed" && !/^error sending request/.test(inner)) return null;
  return inner.replace(/^error sending request for url \([^)]*\): /, "");
}

/** `fetchImpl` whose transport failures are plain `Error`s with a sentence: the runtime's
 *  network failure (`transportFailure`) becomes `cannot reach <host> — <cause>`, and the
 *  bound's TimeoutError becomes
 *  `no answer from <host> within <bound>`. A plain Error is what `entry` prints as one line
 *  and exits REFUSAL on (§9), and what a dispatcher's `failed` stamp carries as `error`.
 *  Everything else — a caller's own abort, a bug in the caller — passes through as it came. */
export function said(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  const bound = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchImpl(input, init);
    } catch (err) {
      const cause = transportFailure(err);
      if (cause !== null) throw new Error(`cannot reach ${hostOf(input)} — ${cause}`);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error(`no answer from ${hostOf(input)} within ${bound}`);
      }
      throw err;
    }
  }) as typeof fetch;
}

/** The global `fetch` under `API_TIMEOUT_MS`, failures said — what a connector calls an
 *  API with. */
export const timedFetch: typeof fetch = said(
  withTimeout((input, init) => fetch(input, init), API_TIMEOUT_MS),
  API_TIMEOUT_MS,
);
