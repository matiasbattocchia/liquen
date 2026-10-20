/**
 * connect/whatsapp/probe.ts — whether the whatsmeow bridge is there at all.
 *
 * The bridge tells its sessions' lifecycle itself (ingest.ts writes each on the
 * connections map), and a bridge that is not running tells nothing: its rows go on saying
 * `connected` while no message comes in and every send fails. The probe is the one word
 * the bridge cannot say: it asks after each WhatsApp session (`GET /sessions/{address}`)
 * and, `MISSES` rounds in a row with no answer, writes `bridge_down` on the rows, which
 * the anchor shows as down (§5). A round it answers sets each row to the bridge's word:
 * `connected`, `unavailable`, or `signed_out` for a session the bridge does not hold — a
 * device unlinked while its notice went nowhere, which the map would otherwise keep as
 * `connected` forever. A `suspended` row stays so until the bridge says it is connected:
 * a banned number is not connected either, and the ban is the truer word.
 */

import type { ConnectionRow, Connections, ConnectionState } from "../../store/connections.ts";
import { SERVICE } from "./ingest.ts";
import { timedFetch } from "../http.ts";
import { setState } from "../health.ts";

/** How often the bridge is asked after its sessions. */
export const PROBE_MS = 30_000;
/** Rounds in a row without an answer before the sessions are marked down: a restart of the
 *  bridge passes without a word. */
export const MISSES = 3;

/** One session as the bridge sees it; null when the bridge holds no such session. Throws
 *  when the bridge does not answer. */
export type BridgeStatus = (address: string) => Promise<{ connected: boolean } | null>;

/** `GET <base>/sessions/{address}` with the bridge's bearer: 404 is a session it does not
 *  hold, any other refusal or silence is a bridge not there. */
export function bridgeStatus(
  base: string,
  token: string,
  fetchApi: typeof fetch = timedFetch,
): BridgeStatus {
  return async (address) => {
    const res = await fetchApi(`${base}/sessions/${encodeURIComponent(address)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`bridge /sessions HTTP ${res.status}`);
    }
    const out = await res.json() as { connected?: boolean };
    return { connected: out.connected === true };
  };
}

export interface BridgeProbeDeps {
  status: BridgeStatus;
  store: Pick<Connections, "connections" | "upsertConnections">;
  now?: () => string;
  /** A round the bridge did not answer, and why. */
  onError?: (err: unknown) => void;
  /** A round it answered. */
  onAnswered?: () => void;
}

/** A probe over the connections map's WhatsApp rows. `tick()` asks once; callers drive the
 *  cadence. */
export function createBridgeProbe(deps: BridgeProbeDeps): { tick(): Promise<void> } {
  const now = deps.now ?? (() => new Date().toISOString());
  let missed = 0;
  const mark = (row: ConnectionRow, state: ConnectionState) =>
    setState(deps.store, row, state, { now: now() });
  return {
    async tick() {
      const rows = (await deps.store.connections()).filter((r) => r.service === SERVICE);
      const heard = new Map<string, { connected: boolean } | null>();
      let silent = false;
      for (const row of rows) {
        try {
          heard.set(row.address, await deps.status(row.address));
        } catch (err) {
          silent = true;
          deps.onError?.(err);
          break; // one silence is the bridge's: the others would say the same
        }
      }
      if (silent) {
        if (++missed < MISSES) return;
        for (const row of rows) await mark(row, "bridge_down");
        return;
      }
      missed = 0;
      deps.onAnswered?.();
      for (const row of rows) {
        const said = heard.get(row.address);
        const word = said === null ? "signed_out" : said?.connected ? "connected" : "unavailable";
        if (word === "unavailable" && row.extra?.state === "suspended") continue;
        await mark(row, word);
      }
    },
  };
}
