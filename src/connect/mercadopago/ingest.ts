/**
 * src/connect/mercadopago/ingest.ts — the webhook: Mercado Pago's notice that a payment
 * changed, as a portable `(Request) => Response` (the github ingest's shape).
 *
 * A notification is a POINTER — `{type: "payment", data: {id}}` and the account's
 * `user_id` — so the handler reads the payment back from the API with that account's grant
 * and publishes the row it is now (payments.ts). Nothing the body says is published: a
 * forged notification can at most make the org read one of its own payments again.
 *
 * Verified when the vault holds a webhook secret: `x-signature` is `ts=<ts>,v1=<hex>`, the
 * HMAC-SHA256 of `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, with `data.id` as the
 * query string carries it and a pair left out when its value is. With no secret, unsigned
 * deliveries are taken. Mercado Pago wants a 200 or 201 within 22 seconds and retries
 * anything else, so only a read or a publish that failed answers otherwise; whatever a
 * delivery that never arrives would have said, the poll reads.
 */

import { GRANT_PREFIX, namedRow, SERVICE, wire } from "./payments.ts";
import type { Appender, Credentials, GrantBroker } from "../../connector.ts";
import { findRoot, orgFlag, tokenOf } from "../../connector.ts";
import { entry } from "../../entry.ts";

export interface MercadopagoWebhookDeps {
  /** → the EventLog (the connection's only write). */
  publish: Appender["publish"];
  /** The vault: the grants — the token a notification is read back with, and the secrets
   *  it is verified against. Read on every delivery, so a door's write needs no restart. */
  creds: Pick<Credentials, "list">;
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
    const body = await req.text();

    // 1. verify (boundary check) — a missing/bad signature never reaches the API or the log
    const grants = await deps.creds.list(GRANT_PREFIX);
    const secrets = grants
      .map((g) => g.value.webhook_secret)
      .filter((s): s is string => typeof s === "string" && s !== "");
    if (secrets.length && !(await signed(secrets, req.headers, dataId))) {
      return text(401, "bad signature");
    }

    let n: Notification;
    try {
      n = JSON.parse(body) as Notification;
    } catch {
      return text(400, "invalid json");
    }
    // 2. acks that never touch the log: another topic, test mode, an account not ours
    if (n.type !== "payment") return text(200, `ignored: ${n.type ?? "no type"}`);
    if (n.live_mode === false) return text(200, "ignored: test mode");
    const id = dataId ?? (n.data?.id !== undefined ? String(n.data.id) : undefined);
    if (!id) return text(200, "ignored: no payment id");
    const grant = grants.find((g) => g.key === `${GRANT_PREFIX}${n.user_id}`);
    if (!grant) return text(200, `ignored: no grant for user ${n.user_id}`);

    // 3. read the payment back and publish the state it is in — dedupe is the store's
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

/* ── signature verification (Web-standard, constant-time) ─────────────────────────── */

const encoder = new TextEncoder();

/** Whether `x-signature` is the HMAC of the manifest under one of `secrets`. */
async function signed(secrets: string[], headers: Headers, dataId?: string): Promise<boolean> {
  const fields = new Map<string, string>();
  for (const part of (headers.get("x-signature") ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const ts = fields.get("ts");
  const v1 = fields.get("v1");
  if (!ts || !/^\d+$/.test(ts) || !v1) return false;
  const requestId = headers.get("x-request-id")?.trim() || undefined;
  const manifest = (dataId ? `id:${dataId};` : "") +
    (requestId ? `request-id:${requestId};` : "") + `ts:${ts};`;
  for (const secret of secrets) {
    if (timingSafeEqual(await hmacHex(secret, manifest), v1)) return true;
  }
  return false;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison — never leak where two hex digests diverge. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── local entry: the thin Deno server over the org's log ─────────────────────────── */

/** Wire the webhook over the org's log — resident once it returns (serving). Returns stop:
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
