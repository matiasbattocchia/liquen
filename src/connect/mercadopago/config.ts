/**
 * src/connect/mercadopago/config.ts — the mercadopago connector's catalog (the config rules,
 * §4). It has no knobs: what it reads is every payment of the account, and the cadence is
 * the poll's. Secrets live in the vault, written by `liquen connect mercadopago`:
 * `mercadopago:<user_id>` — the account's access token, and the signing secret of its
 * application's webhook when one is configured.
 */

import type { ConnectorSpec } from "../../connector.ts";

export const SPEC: ConnectorSpec = {
  name: "mercadopago",
  doc: "mercadopago — the account's payments, by webhook and by poll",
  entries: [],
};
