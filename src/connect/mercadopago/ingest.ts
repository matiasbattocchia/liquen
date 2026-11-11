/**
 * src/connect/mercadopago/ingest.ts — the ingest: Mercado Pago's notice that a payment
 * changed, as a portable `(Request) => Response` (the github ingest's shape).
 *
 * What dials it is a payment's own `notification_url`: an agent creating a payment link
 * names the org's ingest there, and that payment notifies as it moves. A notification is
 * a POINTER — `{type: "payment", data: {id}}` and the account's `user_id` — so the
 * handler reads the payment back from the API with that account's grant and publishes the
 * row it is now (payments.ts). Nothing the body says is published, so an unsigned
 * delivery is taken: a forged one can at most make the org read one of its own payments
 * again.
 *
 * Mercado Pago wants a 200 or 201 within 22 seconds and retries anything else, so only a
 * read or a publish that failed answers otherwise; whatever a delivery that never arrives
 * would have said, the poll reads.
 */

import { GRANT_PREFIX, namedRow, SERVICE, wire } from "./payments.ts";
import type { Appender, Credentials, GrantBroker } from "../../connector.ts";
import { findRoot, orgFlag, tokenOf } from "../../connector.ts";
import { entry } from "../../entry.ts";

export interface MercadopagoWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The vault: the grants, the token a notification is read back with. Read on every
   *  delivery, so a door's write needs no restart. */
  creds: Pick<Credentials, "get">;
  broker: Pick<GrantBroker, "issue" | "accessTokenFor" | "refusal">;
  /** Injectable for tests; defaults to global `fetch` against the API. */
  fetchApi?: typeof fetch;
  now?: () => string;
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** The read back has to fit inside the 22 seconds Mercado Pago waits for the answer. */
const READ_TIMEOUT_MS = 15_000;

interface Notification {
  type?: string;
  live_mode?: boolean;
  user_id?: number | string;
  data?: { id?: string | number };
}

/** Build the ingest handler. Pure over its deps — call once, serve the result anywhere. */
export function createMercadopagoWebhook(deps: MercadopagoWebhookDeps): WebhookHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const names = new Map<string, string | undefined>();

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    const dataId = new URL(req.url).searchParams.get("data.id")?.trim() || undefined;
    // a body that is not a notification is acknowledged like any other topic: Mercado Pago
    // retries every answer but a 200 or 201, and nothing it could resend would read better
    let n: Notification;
    try {
      n = JSON.parse(await req.text()) as Notification;
    } catch {
      n = {};
    }
    // 1. acks that never touch the log: another topic, test mode, an account not ours
    if (n.type !== "payment") return text(200, `ignored: ${n.type ?? "no type"}`);
    if (n.live_mode === false) return text(200, "ignored: test mode");
    const id = dataId ?? (n.data?.id !== undefined ? String(n.data.id) : undefined);
    if (!id) return text(200, "ignored: no payment id");
    const grant = await deps.creds.get(`${GRANT_PREFIX}${n.user_id}`);
    if (!grant) return text(200, `ignored: no grant for user ${n.user_id}`);

    // 2. read the payment back and publish the state it is in — dedupe is the store's
    //    (`external_id` per state), so a retry, or the poll reading it too, merges
    try {
      const token = await tokenOf(deps.broker, grant.key, grant.agentId);
      const w = wire(deps.fetchApi ?? fetch, token, grant.key, READ_TIMEOUT_MS);
      const self = grant.key.slice(GRANT_PREFIX.length);
      const row = await namedRow(w, await w.payment(id), self, now(), names);
      if (row) await deps.publish(row);
    } catch (err) {
      console.error(`[ingest] payment ${id} on ${grant.key} FAILED:`, err);
      return text(500, "read failed");
    }
    return text(200, "accepted");
  };
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── local entry: the thin Deno server over the org's log ─────────────────────────── */

/** Wire the ingest over the org's log — resident once it returns (serving). Returns stop:
 *  refuse new deliveries, finish the ones in flight, release the handles. Env: none. */
export async function runWebhook(): Promise<() => Promise<void>> {
  const { openStore, serveIngest, createGrantBroker } = await import("../../connector.ts");
  const root = findRoot(orgFlag());
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  // `log.publish` passed straight through — a wrapper lambda would flatten its overloads
  const server = await serveIngest(
    root,
    SERVICE,
    createMercadopagoWebhook({ publish: log.publish, creds, broker: createGrantBroker({ creds }) }),
  );
  console.error(`[ingest] serving ${server.addr.path} → ${root}/data/log`);
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await entry(runWebhook);
