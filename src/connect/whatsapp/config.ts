/**
 * connect/whatsapp/config.ts — the whatsapp connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.whatsapp` and are validated at boot.
 * The bridge TOKEN is the one thing that stays in env (a secret): WA_BRIDGE_TOKEN.
 *
 * Only what is whatsapp's lives here: the addresses of the bridge seam and the tenant the
 * bridge files this org's sessions under — the bridge is multi-tenant, so two orgs on one
 * sidecar each name their own, and each names where ITS traffic lands. The pairing door
 * hands the bridge that address once (`webhook_url` on `POST /sessions`, kept with the
 * session), and everything the bridge dials for this org — batches, media, session events,
 * the RELATIVE signed media path (`store/media.ts`) — resolves against it. `ingestUrl` is
 * that address as the bridge reaches it; null derives it from `ingestPort` on localhost,
 * which is right whenever the sidecar shares the host.
 */

import { checkPort, connectorConfig, type ConnectorSpec } from "../../config.ts";

export const DEFAULT_INGEST_PORT = 8793;
export const DEFAULT_BRIDGE_URL = "http://localhost:8081";

export interface WhatsappConfig {
  ingestPort: number;
  bridgeUrl: string;
  /** null until `liquen connect whatsapp` declares it (the folder's name) */
  organizationId: string | null;
  /** null ⇒ `http://localhost:<ingestPort>` — see `ingestUrlOf` */
  ingestUrl: string | null;
}

/** Where the bridge reaches this org's ingest — what the pairing door registers with the
 *  session. The declared value verbatim, else localhost on the ingest's port: a bridge in
 *  a container, or on another host, is the case that declares one. */
export function ingestUrlOf(cfg: Pick<WhatsappConfig, "ingestPort" | "ingestUrl">): string {
  if (cfg.ingestUrl) return cfg.ingestUrl;
  if (cfg.ingestPort === 0) {
    throw new Error(
      "connections.whatsapp.ingestPort is 0 — the bridge keeps the ingest's address with the session, so declare a fixed port or an ingestUrl",
    );
  }
  return `http://localhost:${cfg.ingestPort}`;
}

const aString = (v: unknown): string | null =>
  typeof v === "string" && v ? null : "must be a non-empty string";
const aStringOrNull = (v: unknown): string | null => v === null ? null : aString(v);

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
    {
      key: "organizationId",
      value: null,
      doc:
        "the tenant the bridge files this org's sessions under — orgs sharing one bridge each name their own; null ⇒ `liquen connect whatsapp` declares the folder's name",
      check: aStringOrNull,
    },
    {
      key: "ingestUrl",
      value: null,
      doc:
        "this org's ingest as the bridge reaches it — registered with the session at pairing; null ⇒ http://localhost:<ingestPort>, right when the bridge shares the host",
      check: aStringOrNull,
    },
  ],
};

/** Read (and heal) `connections.whatsapp` from the org's config.jsonc. */
export function whatsappConfig(root: string): Promise<WhatsappConfig> {
  return connectorConfig<WhatsappConfig>(root, SPEC);
}
