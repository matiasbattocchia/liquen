/**
 * connect/health.ts — the two writes every connector shares about its rows (§5): a state
 * on the transition, and the heartbeat.
 *
 * A state is one of `ConnectionState`'s words, stamped `<state>_at` when the row moves to
 * it and never again while it stays: the anchor says "since" off that stamp, so a word
 * rewritten by every process that restarts into it would move the "since" with each
 * restart. The comparison is against the row as stored, not a process's memory, for the
 * same reason. Only a live row is written: a state landing on a removed connection would
 * revive it (the upsert clears `deleted_at`).
 *
 * The heartbeat is what a connector says by being there: every `HEARD_EVERY_MS` it stamps
 * `extra.heard_at` on its service's live rows, and the anchor reads a row unstamped for
 * `SILENT_AFTER_MS` as `connector_down` since the last stamp. Nothing else can say it —
 * the supervisor never opens the log, and a dead process says nothing. The first beat
 * waits one interval, so a connector that dies at boot over and over never stamps.
 */

import type { ConnectionRow, Connections, ConnectionState } from "../store/connections.ts";
import { HEARD_EVERY_MS } from "../store/connections.ts";
import { findRoot, orgFlag } from "../config.ts";

type Rows = Pick<Connections, "connections" | "upsertConnections">;

/** Move the live row `service:address` to `state`, stamping when it moved; `error` rides
 *  along as the row's `error` (absent clears it), and `extra` merges as given. Answers
 *  whether the state moved. */
export async function setState(
  store: Rows,
  row: { service: string; address: string },
  state: ConnectionState,
  opts: { error?: string; extra?: Record<string, unknown>; now?: string } = {},
): Promise<boolean> {
  const live = (await store.connections()).find((r) =>
    r.service === row.service && r.address === row.address
  );
  if (!live) return false;
  const moved = live.extra?.state !== state;
  const error = opts.error ?? null;
  const extra = opts.extra ?? {};
  const same = !moved && (live.extra?.error ?? null) === error &&
    Object.entries(extra).every(([k, v]) => (live.extra?.[k] ?? null) === v);
  if (same) return false;
  await store.upsertConnections([{
    service: row.service,
    address: row.address,
    extra: {
      ...extra,
      state,
      ...(moved ? { [`${state}_at`]: opts.now ?? new Date().toISOString() } : {}),
      error,
    },
  }]);
  return moved;
}

/** What a door writes on the row of an account it has just linked: up, and no reason left
 *  standing from before — a signed-out account comes back through its door. */
export function linked(now = new Date().toISOString()): Record<string, unknown> {
  return { state: "connected", connected_at: now, error: null };
}

/** The live rows a refused credential authenticates (`credential_key`), or else the one the
 *  refusal came through — what a `SignedOut` marks. */
export async function rowsOf(
  store: Pick<Connections, "connections">,
  service: string,
  at: { key?: string; address?: string },
): Promise<ConnectionRow[]> {
  const rows = (await store.connections()).filter((r) => r.service === service);
  const byKey = at.key ? rows.filter((r) => r.credentialKey === at.key) : [];
  return byKey.length ? byKey : rows.filter((r) => r.address === at.address);
}

/** One beat: `heard_at` on every live row of `service`. */
export async function beat(store: Rows, service: string, now: string): Promise<void> {
  const rows = (await store.connections()).filter((r) => r.service === service);
  if (rows.length === 0) return;
  await store.upsertConnections(
    rows.map((r) => ({ service: r.service, address: r.address, extra: { heard_at: now } })),
  );
}

/** The heartbeat of a connector process over the org's store — resident once it returns.
 *  Returns stop: no more beats, the handle released. */
export async function heartbeat(service: string): Promise<() => Promise<void>> {
  const { openStore } = await import("../store/mod.ts");
  const store = await openStore(findRoot(orgFlag()));
  const log = await store.log();
  let beating: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    beating = beating
      .then(() => beat(log, service, new Date().toISOString()))
      .catch((err) => console.error(`[${service}] heartbeat FAILED:`, err));
  }, HEARD_EVERY_MS);
  return async () => {
    clearInterval(timer);
    await beating;
    await log.close();
  };
}
