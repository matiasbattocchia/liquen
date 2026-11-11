/**
 * src/connect/mercadopago/config.ts — the mercadopago connector's catalog (the config rules,
 * §4). It has no knobs: what it reads is every payment of the account, and the cadence is
 * the poll's. The secret lives in the vault, written by `liquen connect mercadopago`:
 * `mercadopago:<user_id>`, the account's access token.
 */

import type { ConnectorSpec } from "../../connector.ts";

export const SPEC: ConnectorSpec = {
  name: "mercadopago",
  doc: "mercadopago — the account's payments, by poll and by a payment's notification_url",
  entries: [],
};
