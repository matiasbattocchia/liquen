/**
 * connect/poll.ts — what every polling ingest shares: the cursor on the grant, the sweep
 * over grants, and the resident loop. The calendar pollers and the mail pollers of both
 * Google and Microsoft are built on it; a service's connector owns its WIRE and hands the
 * rows it reads to the log through the grammar its kind shares (`calendar.ts`, `mail.ts`).
 *
 * The CARRIER is a clock. The change feeds of these services push a bare "something
 * changed" at best, and only to a verified public endpoint, so on a laptop the truth comes
 * from asking — a delta query that returns nothing when nothing changed. A push carrier on
 * the edge tier wakes the same poll.
 *
 * The cursor lives ON THE GRANT: `extra.<namespace>[<resource>]` in the vault (`put`
 * shallow-merges `extra`, so it sits beside `client_id`/`expiry` without disturbing them),
 * keyed by the resource as the connector names it. It must ADVANCE every poll or the same
 * changes replay forever, so a service writes it back even on an empty delta. No cursor
 * means a first run: the service BOOTSTRAPS from now forward and publishes nothing — only
 * future changes ever become events, no history flood — and a cursor the service has aged
 * out is dropped, so the next tick re-bootstraps.
 *
 * Credentials (§9): the access token is fetched BROKER-side — `broker.accessTokenFor(
 * broker.issue(key))` — reusing the proxy's refresh+writeback. The poller holds the grant;
 * the agent never does. The service's API is called directly (no proxy, no placeholder):
 * the broker is already the one code path that touches the secret, and this runs beside it.
 */

import type { Appender } from "../store/log.ts";
import type { CredentialRow, Credentials } from "../store/credentials.ts";
import type { Connections } from "../store/connections.ts";
import type { GrantBroker } from "../proxy/grants.ts";
import type { Service } from "../types.ts";
import { findRoot, orgFlag } from "../config.ts";

/* ── the cursor: one per resource, on the grant's `extra` ─────────────────────────── */

type CursorVault = Pick<Credentials, "get" | "put">;

export async function cursorFor(
  creds: CursorVault,
  key: string,
  namespace: string,
  resource: string,
): Promise<string | undefined> {
  const row = await creds.get(key);
  const map = row?.extra?.[namespace];
  const token = map && typeof map === "object"
    ? (map as Record<string, unknown>)[resource]
    : undefined;
  return typeof token === "string" ? token : undefined;
}

/** Write the cursor; `undefined` drops it so the next tick re-bootstraps. */
export async function storeCursor(
  creds: CursorVault,
  key: string,
  namespace: string,
  resource: string,
  token: string | undefined,
): Promise<void> {
  const row = await creds.get(key);
  const prior = (row?.extra?.[namespace] ?? {}) as Record<string, unknown>;
  const map = { ...prior };
  if (token) map[resource] = token;
  else delete map[resource];
  // put shallow-merges extra, so this sits beside client_id/expiry untouched. The broker's
  // expiry write-back (another process) does the same read-merge-write on this row; a stale
  // read can regress the other's field, and both losses self-heal — a regressed expiry just
  // re-refreshes, a regressed cursor replays a delta into the external_id dedupe.
  await creds.put({ key, value: {}, extra: { [namespace]: map } });
}

/** Whether a grant's recorded consent carries one of `scopes`. The door writes the scopes
 *  the wire GRANTED on the row (`extra.scope`, space-separated), so a poll that needs one
 *  reads it off the grant rather than learning it from a 403 every sweep. */
export function granted(grant: CredentialRow, scopes: string[]): boolean {
  const have = typeof grant.extra?.scope === "string" ? grant.extra.scope.split(/\s+/) : [];
  return scopes.some((s) => have.includes(s));
}

/* ── the sweep: every grant, every resource, one verdict per grant ─────────────────── */

/** A sweep that cannot read a grant is not yet an outage: one slow answer from the API is a
 *  blip, and calling it a disconnection wakes the anchor to announce nothing. A grant is
 *  `failing` once it has missed this many sweeps in a row — minutes, at the entry's cadence.
 *  Recovery stays instant: the first sweep that reads is `connected` again. */
const FAILING_AFTER_SWEEPS = 3;

export interface PollerDeps {
  service: Service;
  /** The vault namespace of this service's grants, and of its app rows within it: the app
   *  rows are the client's credentials, not accounts, and are never polled. */
  grantPrefix: string;
  appPrefix: string;
  creds: Pick<Credentials, "list">;
  /** The connections map (§4): a grant's state is written on the transition — `failing`
   *  when a sweep cannot read it (a refresh refused, the API unreachable), `connected`
   *  when it reads again — so the anchor can say a surface is down (§5). */
  store?: Pick<Connections, "upsertConnections">;
  /** Which resources to poll on each grant — calendars, mail folders — as the connector
   *  names them. */
  resources: string[];
  /** A grant the poll applies to. Absent ⇒ every grant; a poll whose grant lacks the
   *  consent it needs is skipped without a verdict, since nothing about it is failing. */
  watches?: (grant: CredentialRow) => boolean;
  /** One grant, one resource: read the delta, publish, advance. Returns how many changes. */
  poll: (grant: CredentialRow, resource: string) => Promise<number>;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  /** Per-poll accounting (a grant, a resource, how many changes published). */
  onPolled?: (key: string, resource: string, published: number) => void;
}

/** A poller bound to the vault. `tick()` sweeps every grant once; callers drive the
 *  cadence (the entry runs it on a `setInterval`). Ticks never overlap: one that lands while
 *  a sweep runs JOINS it — two sweeps reading one cursor would each publish the same delta
 *  and race the write-back, and a stalled poll must not pile intervals behind it. */
export function createPoller(deps: PollerDeps): { tick(): Promise<void> } {
  const now = deps.now ?? (() => new Date().toISOString());
  // one state per grant, written only when it changes: a sweep that reads is `connected`,
  // one that cannot is `failing` — the row carries the reason
  const known = new Map<string, string>();
  // consecutive sweeps a grant has missed — reset by the first one that reads
  const missed = new Map<string, number>();
  const mark = async (key: string, state: string, error?: string) => {
    if (!deps.store || known.get(key) === state) return;
    known.set(key, state);
    await deps.store.upsertConnections([{
      service: deps.service,
      address: key.slice(deps.grantPrefix.length),
      extra: { state, [`${state}_at`]: now(), ...(error !== undefined ? { error } : {}) },
    }]);
  };
  const sweep = async (): Promise<void> => {
    const grants = (await deps.creds.list(deps.grantPrefix))
      .filter((r) => !r.key.startsWith(deps.appPrefix))
      .filter((r) => deps.watches?.(r) ?? true);
    for (const grant of grants) {
      let failure: string | undefined;
      for (const resource of deps.resources) {
        try {
          const n = await deps.poll(grant, resource);
          deps.onPolled?.(grant.key, resource, n);
        } catch (err) {
          failure ??= err instanceof Error ? err.message : String(err);
          deps.onError?.(grant.key, err);
        }
      }
      if (failure === undefined) {
        missed.delete(grant.key);
        await mark(grant.key, "connected");
      } else {
        const n = (missed.get(grant.key) ?? 0) + 1;
        missed.set(grant.key, n);
        if (n >= FAILING_AFTER_SWEEPS) await mark(grant.key, "failing", failure);
      }
    }
  };
  let inflight: Promise<void> | null = null;
  return {
    tick(): Promise<void> {
      inflight ??= sweep().finally(() => (inflight = null));
      return inflight;
    },
  };
}

/* ── the wire's client: bounded calls, a pool that never outlives the gap ──────────── */

// a socket that hangs without closing would stall its grant's polling FOREVER (the tick
// join above holds every later tick behind it) — bound every call, fail into onError
export const FETCH_TIMEOUT_MS = 30_000;

/** How long a connection may sit idle in the pool before it is dropped. Under the poll
 *  cadence on purpose: between one sweep and the next, every socket is closed and the
 *  next call dials a new one. A pooled connection outliving the gap is the one the far
 *  side may already have closed without telling us, and reusing it does not fail — it
 *  hangs, then times out, and the next sweep reaches for the same dead socket. One
 *  handshake a minute is the whole cost of never meeting one. */
const POOL_IDLE_MS = 20_000;

/** The poller's own client, so the pool it keeps is bounded by POOL_IDLE_MS rather than
 *  by whatever the process-wide default is. */
export function pollingClient(): Deno.HttpClient {
  return Deno.createHttpClient({ poolIdleTimeout: POOL_IDLE_MS });
}

/* ── the resident loop: a standalone poll service into the org log (./data) ─────────── */

/** What a service's `runIngest` is handed to build its poller with: the org's log, vault
 *  and broker, the resources to poll, and a fetch on the bounded client. */
export interface PollIngestDeps {
  publish: Appender["publish"];
  creds: Credentials;
  broker: GrantBroker;
  store: Pick<Connections, "upsertConnections">;
  /** The data root the media shelf hangs off (`saveMedia`). */
  dir: string;
  resources: string[];
  fetchApi: typeof fetch;
  onError: (key: string, err: unknown) => void;
  onPolled: (key: string, resource: string, published: number) => void;
}

/** Wire a service's poller over the org's log on a metronome — resident once it returns.
 *  `what` names the poll in the log lines (`calendar`, `mail`). Returns stop: disarm the
 *  metronome, finish the sweep in flight, release the handles.
 *  Env: none — the data root is `./data`; the resources come from the service (its catalog
 *  or its constants), the cadence is a constant. The store imports are dynamic so importing
 *  a service's factory (e.g. from an edge function) never pulls in file I/O. */
export async function runPollIngest(
  service: string,
  what: string,
  resourcesOf: (root: string) => Promise<string[]>,
  create: (deps: PollIngestDeps) => { tick(): Promise<void> },
): Promise<() => Promise<void>> {
  const POLL_MS = 60_000;
  /** A connection pool can die without saying so: a suspended host leaves sockets that accept
   *  writes and never answer, so every poll after that times out against the same dead pool
   *  and no amount of retrying reaches the network again. Only a fresh process clears it, and
   *  the supervisor makes one in a second — so a poller this far gone stands down and lets it.
   *  Well past FAILING_AFTER_SWEEPS: the connection is called down before anyone gives up. */
  const WEDGED_AFTER_SWEEPS = 5;
  const { openLog } = await import("../store/log.ts");
  const { openCredentials } = await import("../store/credentials.ts");
  const { createGrantBroker } = await import("../proxy/grants.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const resources = await resourcesOf(root);

  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  // this sweep's verdict, and how many in a row have come back empty-handed
  const swept = { failed: false, inARow: 0 };
  const client = pollingClient();
  const poller = create({
    publish: log.publish,
    creds,
    broker,
    store: log,
    dir,
    resources,
    fetchApi: (input, init) => fetch(input, { ...init, client }),
    onError: (key, err) => {
      swept.failed = true;
      console.error(`[ingest] ${what} poll FAILED on ${key}:`, err);
    },
    onPolled: (key, res, n) => n && console.error(`[ingest] ${key} ${res}: +${n} ${what}`),
  });
  console.error(
    `[ingest] ${service} ${what} poll every ${POLL_MS}ms → ${dir}/log  (${resources.join(", ")})`,
  );
  let sweep = poller.tick(); // once at boot: seed cursors / catch up
  await sweep;
  // a tick landing mid-sweep JOINS it (createPoller), and one sweep is one verdict
  let counted: Promise<void> | null = null;
  const timer = setInterval(() => {
    const tick = poller.tick();
    sweep = tick;
    if (tick === counted) return;
    counted = tick;
    tick.finally(() => {
      swept.inARow = swept.failed ? swept.inARow + 1 : 0;
      swept.failed = false; // the verdict is in; the next sweep starts clean
      if (swept.inARow < WEDGED_AFTER_SWEEPS) return;
      console.error(
        `[ingest] ${swept.inARow} sweeps in a row reached nothing — standing down for a ` +
          `fresh process`,
      );
      Deno.exit(1);
    });
  }, POLL_MS);
  return async () => {
    clearInterval(timer);
    await sweep.catch(() => {/* onError already said it */});
    client.close();
    await creds.close();
    await log.close();
  };
}
