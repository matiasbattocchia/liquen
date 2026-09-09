/**
 * connector.ts — the connector seam (DESIGN §4, §9): everything a connector may
 * import from mu, shipped or custom, through ONE module.
 *
 * A connector is a standalone process over the org's substrate (the `./data` root): ingest
 * publishes world events into the log, dispatch tails the log and delivers, connect
 * is the setup door writing the connection map and the vault. The shipped ones under
 * `src/connect/<service>/` import this module by path; the org's own under
 * `<org>/connectors/<name>/` (the org's code, shipped with its image) import it as
 * `@liquen/liquen/connector` — a deep import from a custom connector is a contract
 * violation, not a convenience. The contract itself: CONNECTORS.md.
 */

export { openLog } from "./store/log.ts";
export type { Appender, DeliveryPatch, Reader, ReadQuery, Subscriber } from "./store/log.ts";
export { openCredentials } from "./store/credentials.ts";
export type { CredentialRow, Credentials } from "./store/credentials.ts";
export { appJwt, createGrantBroker } from "./proxy/grants.ts";
export type { GrantBroker } from "./proxy/grants.ts";
export type { Connections } from "./store/connections.ts";
export { newId } from "./store/id.ts";
export { checkPort, checkStrings, connectorConfig, findRoot, orgFlag } from "./config.ts";
export type { ConnectorSpec } from "./config.ts";
export { declared } from "./connect/declare.ts";
export { DispatchError, failedStatus } from "./connect/errors.ts";
export { createDispatcher, isOutbound } from "./connect/dispatcher.ts";
export type { DispatcherDeps, Posted } from "./connect/dispatcher.ts";
export { serveIngest } from "./connect/serve.ts";
export { exitOnStop } from "./connect/stop.ts";
export type {
  Conversation,
  DataPart,
  Draft,
  Event,
  EventId,
  FilePart,
  Json,
  MessageEvent,
  Part,
} from "./types.ts";
