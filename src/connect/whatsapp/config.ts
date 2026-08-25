/**
 * connect/whatsapp/config.ts — the whatsapp connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.whatsapp` and are validated at boot.
 * The bridge TOKEN is the one thing that stays in env (a secret): WA_BRIDGE_TOKEN.
 */

import { checkPort, type ConnectorSpec, ensureConnectorConfig } from "../../config.ts";

export const DEFAULT_INGEST_PORT = 8793;
export const DEFAULT_MEDIA_PORT = 8792;
export const DEFAULT_MEDIA_HOST = "localhost";
export const DEFAULT_BRIDGE_URL = "http://localhost:8081";
export const DEFAULT_BRIDGE_ORG = "mu";

export interface WhatsappConfig {
  ingestPort: number;
  mediaPort: number;
  mediaHost: string;
  bridgeUrl: string;
  bridgeOrg: string;
}

const aString = (v: unknown): string | null =>
  typeof v === "string" && v ? null : "must be a non-empty string";

const SPEC: ConnectorSpec = {
  name: "whatsapp",
  doc: "whatsapp — the whatsmeow bridge's mu side (ingest, dispatch, pairing)",
  entries: [
    {
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc: "where the bridge POSTs webhook batches",
      check: checkPort,
    },
    {
      key: "mediaPort",
      value: DEFAULT_MEDIA_PORT,
      doc: "dispatch's media server — the bridge fetches outbound media here",
      check: checkPort,
    },
    {
      key: "mediaHost",
      value: DEFAULT_MEDIA_HOST,
      doc: "the host the bridge dials for that media server",
      check: aString,
    },
    {
      key: "bridgeUrl",
      value: DEFAULT_BRIDGE_URL,
      doc: "the whatsmeow bridge's base URL",
      check: aString,
    },
    {
      key: "bridgeOrg",
      value: DEFAULT_BRIDGE_ORG,
      doc: "the organizationId sessions are filed under on the bridge",
      check: aString,
    },
  ],
};

/** Read (and heal) `connections.whatsapp` from the org's config.jsonc. */
export function whatsappConfig(dir = "./data"): Promise<WhatsappConfig> {
  return ensureConnectorConfig<WhatsappConfig>(dir, SPEC);
}
