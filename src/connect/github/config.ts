/**
 * src/connect/github/config.ts — the github connector's catalog (the config rules, §4):
 * its DEFAULT_s live here and nowhere else, used as argument defaults; the values heal
 * into `data/config.jsonc` under `connections.github` and are validated at boot.
 * Secrets live in the vault, written by `liquen connect github`: `github:app:<app_id>` (the
 * webhook secret + private key), `github:org` / `github:<principal>` (the identities).
 */

import { checkPort, checkStrings, connectorConfig, type ConnectorSpec } from "../../connector.ts";

export const DEFAULT_INGEST_PORT = 8788;
/** The events mapped by default. Others are acknowledged (2xx) but produce nothing. */
export const DEFAULT_EVENTS = [
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
];

export interface GithubConfig {
  ingestPort: number;
  events: string[];
}

export const SPEC: ConnectorSpec = {
  name: "github",
  doc: "github — webhook ingest and comment dispatch",
  entries: [
    {
      key: "ingestPort",
      value: DEFAULT_INGEST_PORT,
      doc: "where GitHub (or `gh webhook forward`) delivers; 0 = any free port, announced",
      check: checkPort,
    },
    {
      key: "events",
      value: DEFAULT_EVENTS,
      doc: "event types the ingest maps; anything else is acknowledged and dropped",
      check: checkStrings,
    },
  ],
};

/** Read (and heal) `connections.github` from the org's config.jsonc. */
export function githubConfig(root: string): Promise<GithubConfig> {
  return connectorConfig<GithubConfig>(root, SPEC);
}
