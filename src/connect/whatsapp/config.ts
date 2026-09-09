/**
 * connect/whatsapp/config.ts — the whatsapp connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.whatsapp` and are validated at boot.
 * The bridge TOKEN is the one thing that stays in env (a secret): WA_BRIDGE_TOKEN.
 *
 * Only what is whatsapp's lives here: the two addresses of the bridge seam. liquen's own
 * address is not among them — outbound bytes ride a RELATIVE signed path the bridge
 * resolves against the ingest it already delivers to (`store/media.ts`) — and the
 * bridge's `organizationId` is a constant in `connect.ts`, since a data root is one org
 * and the bridge is single-tenant to it.
 */

import { checkPort, connectorConfig, type ConnectorSpec } from "../../config.ts";

export const DEFAULT_INGEST_PORT = 8793;
export const DEFAULT_BRIDGE_URL = "http://localhost:8081";

export interface WhatsappConfig {
  ingestPort: number;
  bridgeUrl: string;
}

const aString = (v: unknown): string | null =>
  typeof v === "string" && v ? null : "must be a non-empty string";

export const SPEC: ConnectorSpec = {
  name: "whatsapp",
  doc: "whatsapp — the whatsmeow bridge's liquen side (ingest, dispatch, pairing)",
  entries: [
    {
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc:
        "where the bridge POSTs webhook batches — the bridge holds this address, so declare it (0 re-rolls per restart)",
      check: checkPort,
    },
    {
      key: "bridgeUrl",
      value: DEFAULT_BRIDGE_URL,
      doc: "the whatsmeow bridge's base URL",
      check: aString,
    },
  ],
};

/** Read (and heal) `connections.whatsapp` from the org's config.jsonc. */
export function whatsappConfig(root: string): Promise<WhatsappConfig> {
  return connectorConfig<WhatsappConfig>(root, SPEC);
}
