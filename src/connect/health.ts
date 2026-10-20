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
 *
 * A connector the service pushes to over the internet also checks, each beat, that its
 * own public address answers as it (`reached`, edge.ts) — the path the service dials,
 * tunnel and edge included, which nothing else watches: a tunnel that dies leaves the
 * connector up and beating, and the pushes are only read back at the next boot's
 * catch-up. `UNREACHED_ROUNDS` misses in a row put the piece that is not answering on
 * the rows as `extra.inbound` (`Inbound`), stamped `inbound_at` when it moved; the first
 * answer takes it off. It is not the row's `state`: the account is what it was, and comes
 * back as it was when the path does.
 */

import type { ConnectionRow, Connections, ConnectionState } from "../store/connections.ts";
import { HEARD_EVERY_MS } from "../store/connections.ts";
import { findRoot, orgFlag, readConfig } from "../config.ts";
import { ingestAddress, localBase, reached } from "../edge.ts";

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
export function linked(now: string = new Date().toISOString()): Record<string, unknown> {
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

/** The piece between the internet and a pushed connector that does not answer: the
 *  tunnel, when the edge answers on this machine, else the edge itself. */
export type Inbound = "tunnel_down" | "edge_down";

/** A probe's verdict: the piece down and what the address said, null when it answered as
 *  the service, undefined while misses are too few to say. */
export type InboundVerdict = { down: Inbound; error: string } | null | undefined;

/** Misses in a row before the path is called down: one is a blip, not a fact. */
export const UNREACHED_ROUNDS = 3;

/** The check a pushed connector makes each beat, keeping its run of misses: its public
 *  ingest, and on a miss the edge on this machine, which tells the tunnel from the edge. */
export function inboundProbe(
  service: string,
  edge: { publicUrl: string; port: number },
  reach: typeof reached = reached,
): () => Promise<InboundVerdict> {
  let misses = 0;
  return async () => {
    const error = await reach(ingestAddress(edge.publicUrl, service), service);
    if (error === null) {
      misses = 0;
      return null;
    }
    if (++misses < UNREACHED_ROUNDS) return undefined;
    const local = await reach(ingestAddress(localBase(edge.port), service), service);
    return { down: local === null ? "tunnel_down" : "edge_down", error };
  };
}

/** One beat: `heard_at` on every live row of `service`, and the probe's verdict when it
 *  gave one (`inboundProbe`). */
export async function beat(
  store: Rows,
  service: string,
  now: string,
  inbound?: InboundVerdict,
): Promise<void> {
  const rows = (await store.connections()).filter((r) => r.service === service);
  if (rows.length === 0) return;
  await store.upsertConnections(rows.map((r) => {
    const was = r.extra?.inbound ?? null;
    const path = inbound === undefined
      ? {}
      : inbound === null
      ? (was === null ? {} : { inbound: null, inbound_at: null, inbound_error: null })
      : {
        inbound: inbound.down,
        inbound_error: inbound.error,
        ...(was === inbound.down ? {} : { inbound_at: now }),
      };
    return { service: r.service, address: r.address, extra: { heard_at: now, ...path } };
  }));
}

/** The heartbeat of a connector process over the org's store — resident once it returns.
 *  `pushed`: the service dials this org from the internet, so each beat probes the path
 *  (`inboundProbe`) when the org has a public address. Returns stop: no more beats, the
 *  handle released. */
export async function heartbeat(
  service: string,
  opts: { pushed?: boolean } = {},
): Promise<() => Promise<void>> {
  const { openStore } = await import("../store/mod.ts");
  const root = findRoot(orgFlag());
  const { publicUrl, port } = (await readConfig(root)).edge;
  const probe = opts.pushed && publicUrl !== null
    ? inboundProbe(service, { publicUrl, port })
    : null;
  const store = await openStore(root);
  const log = await store.log();
  let beating: Promise<void> = Promise.resolve();
  let said: Inbound | null = null;
  const timer = setInterval(() => {
    beating = beating
      .then(async () => {
        const inbound = probe ? await probe() : undefined;
        // the run log says it once each way, not every beat
        if (inbound !== undefined && (inbound?.down ?? null) !== said) {
          said = inbound?.down ?? null;
          console.error(
            inbound === null
              ? `[${service}] ${publicUrl} answers again`
              : `[${service}] ${publicUrl} does not answer as ${service} (${inbound.error}): ` +
                inbound.down.replace("_", " "),
          );
        }
        await beat(log, service, new Date().toISOString(), inbound);
      })
      .catch((err) => console.error(`[${service}] heartbeat FAILED:`, err));
  }, HEARD_EVERY_MS);
  return async () => {
    clearInterval(timer);
    await beating;
    await log.close();
  };
}
