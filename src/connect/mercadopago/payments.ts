/**
 * src/connect/mercadopago/payments.ts — the Mercado Pago wire: a payment read from the API,
 * the row it becomes, and the poll that finds what changed.
 *
 * A payment is one row per STATE it reaches: `external_id` is the payment's id with its
 * `status` and `status_detail`, so an authorization, its capture, a partial refund and a
 * chargeback (`in_mediation`, `charged_back`) each land as their own event, while the same
 * state read twice — by a notification and the poll, by a retried notification, by the
 * poll's overlap — merges into the row already there (§4).
 *
 * Its conversation is the COUNTERPARTY, by Mercado Pago user id: the one handle the wire
 * gives in both directions (a payer's email comes only on what they pay in; a payee is the
 * id alone, and its nickname is asked of `/users/<id>`). Nobody answers there, so it is a
 * `broadcast`. The line's voice is the side that paid: the counterparty on money in, the
 * account itself on money out. A processor collects for many merchants under one id, so
 * their payments share one conversation, and the description says whose each was.
 *
 * Test-mode payments (`live_mode: false`) never become rows.
 *
 * The poll is the carrier every payment rides: a clock over `/v1/payments/search`, by
 * `date_last_updated`, which lists the account's payments both ways — what it pays, what
 * it collects, the transfers in and out. Only a payment created with a `notification_url`
 * (a link an agent made) also dials the ingest. The cursor is the newest
 * `date_last_updated` read, on the grant (poll.ts); a first run seeds it at now and
 * publishes nothing.
 */

import {
  createPoller,
  cursorFor,
  FETCH_TIMEOUT_MS,
  type PollIngestDeps,
  runPollIngest,
  storeCursor,
} from "../poll.ts";
import { SignedOut } from "../errors.ts";
import type { Appender } from "../../store/log.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import { type GrantBroker, tokenOf } from "../../proxy/grants.ts";
import type { DataPart, Draft, MessageEvent } from "../../types.ts";
import { SENDER_EMAIL } from "../../sender.ts";
import { entry } from "../../entry.ts";

export const SERVICE = "mercadopago" as const;
export const GRANT_PREFIX = "mercadopago:";
const API = "https://api.mercadopago.com";
/** The grant's proxy declaration (§9): the variable `mpcli` reads its token from, and the
 *  one host the API answers on. */
export const GRANT_ENV = "MP_ACCESS_TOKEN";
export const GRANT_HOSTS = ["api.mercadopago.com"];

/** The slice of a `/v1/payments` resource we read. Money in names the account as
 *  `collector_id` and the counterparty as `payer`; money out names the counterparty as
 *  `collector` and no payer. */
export interface Payment {
  id: number | string;
  status?: string;
  status_detail?: string;
  operation_type?: string;
  transaction_amount?: number;
  transaction_amount_refunded?: number;
  currency_id?: string;
  description?: string | null;
  payment_method_id?: string;
  date_last_updated?: string;
  live_mode?: boolean;
  collector_id?: number | null;
  collector?: { id?: number | null } | null;
  payer?: { id?: string | number | null; email?: string | null } | null;
}

/** What of a payment the agent reads: the resource pruned to the facts a person acts on. */
export type PaymentData = {
  id: string;
  /** Which way the money went, seen from the account. */
  way: "in" | "out";
  status: string;
  detail?: string;
  amount?: number;
  currency?: string;
  refunded?: number;
  method?: string;
  type?: string;
};

export type PaymentPart = DataPart<"payment", PaymentData>;

/* ── the row ─────────────────────────────────────────────────────────────────────── */

/** Who the payment was with, and which way the money went. A side the wire leaves blank
 *  is the account's own. */
export function counterparty(
  p: Payment,
  self: string,
): { address: string; way: "in" | "out"; email?: string } {
  if (String(p.collector_id ?? "") === self) {
    const email = p.payer?.email || undefined;
    return {
      way: "in",
      address: p.payer?.id ? String(p.payer.id) : self,
      ...(email ? { email } : {}),
    };
  }
  return { way: "out", address: p.collector?.id ? String(p.collector.id) : self };
}

/** A payment as the row of the state it is in, seen from the account `self`; null for a
 *  test-mode payment. `name` is what the counterparty is called where the payment carries
 *  no email for them. */
export function paymentRow(
  p: Payment,
  self: string,
  now: string,
  name?: string,
): Draft<MessageEvent> | null {
  if (p.live_mode === false) return null;
  const { address, way, email } = counterparty(p, self);
  const status = p.status ?? "unknown";
  const data: PaymentData = { id: String(p.id), way, status };
  if (p.status_detail) data.detail = p.status_detail;
  if (p.transaction_amount !== undefined) data.amount = p.transaction_amount;
  if (p.currency_id) data.currency = p.currency_id;
  if (p.transaction_amount_refunded) data.refunded = p.transaction_amount_refunded;
  if (p.payment_method_id) data.method = p.payment_method_id;
  if (p.operation_type) data.type = p.operation_type;
  const called = email ?? name;
  const part: PaymentPart = {
    type: "data",
    kind: "payment",
    data,
    ...(p.description ? { text: p.description } : {}),
  };
  const updated = p.date_last_updated ? Date.parse(p.date_last_updated) : NaN;
  return {
    ts: Number.isNaN(updated) ? now : new Date(updated).toISOString(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: self,
      conversation: { address, kind: "broadcast", ...(called ? { name: called } : {}) },
      sender: way === "in" ? { address, ...(called ? { name: called } : {}) } : { address: self },
      external_id: `mp:${p.id}:${status}:${p.status_detail ?? ""}`,
    },
    parts: [part],
    ...(email ? { extra: { [SENDER_EMAIL]: email } } : {}),
  };
}

/** The row, named: a counterparty the payment does not name by email is called by its
 *  nickname, asked once per process (`names`). */
export async function namedRow(
  w: Wire,
  p: Payment,
  self: string,
  now: string,
  names: Map<string, string | undefined>,
): Promise<Draft<MessageEvent> | null> {
  if (p.live_mode === false) return null;
  const { address, email } = counterparty(p, self);
  if (!email && !names.has(address)) names.set(address, await w.nickname(address));
  return paymentRow(p, self, now, email ? undefined : names.get(address));
}

/* ── the API (direct fetch; the broker already holds the secret) ─────────────────── */

export interface SearchPage {
  results?: Payment[];
}

/** The API, spent with one grant's token. */
export interface Wire {
  payment(id: string): Promise<Payment>;
  search(q: URLSearchParams): Promise<SearchPage>;
  /** A user's public nickname; undefined when the API does not say. */
  nickname(id: string): Promise<string | undefined>;
}

export function wire(
  fetchApi: typeof fetch,
  token: string,
  key: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Wire {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchApi(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      throw new SignedOut(`mercadopago ${path} 401: ${(await res.text()).slice(0, 300)}`, key);
    }
    if (!res.ok) {
      throw new Error(`mercadopago ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return await res.json();
  };
  return {
    payment: async (id) => await get(`/v1/payments/${encodeURIComponent(id)}`) as Payment,
    search: async (q) => await get(`/v1/payments/search?${q}`) as SearchPage,
    nickname: async (id) => {
      try {
        const user = await get(`/users/${encodeURIComponent(id)}`) as { nickname?: string };
        return user.nickname || undefined;
      } catch {
        return undefined; // a name is a nicety: the row lands under the id
      }
    },
  };
}

/* ── the poll ─────────────────────────────────────────────────────────────────────── */

/** The cursor's place on the grant (`extra.payments.updated`). */
const CURSOR = "payments";
const RESOURCE = "updated";
/** How far behind the cursor each poll reads again: a payment can reach the search a while
 *  after its `date_last_updated` says, and what is read twice merges. */
const OVERLAP_MS = 10 * 60_000;
const PAGE = 100;
/** Pages per poll; a backlog past them is the next poll's, from the cursor this one left. */
const MAX_PAGES = 10;

export interface MercadopagoDeps {
  publish: Appender["publish"];
  /** The vault: the grants (the tokens) and the cursor. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  broker: Pick<GrantBroker, "issue" | "accessTokenFor" | "refusal">;
  store?: Pick<Connections, "connections" | "upsertConnections">;
  /** Injectable for tests; defaults to global `fetch` against the API. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, resource: string, published: number) => void;
}

/** The poller: the shared sweep over `mercadopago:` grants, `pollPayments` on each. */
export function createMercadopagoPoller(deps: MercadopagoDeps): { tick(): Promise<void> } {
  const names = new Map<string, string | undefined>();
  return createPoller({
    service: SERVICE,
    name: "payments",
    grantPrefix: GRANT_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: [RESOURCE],
    poll: (grant) => pollPayments(deps, grant.key, grant.agentId, names),
    now: deps.now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
}

/** One grant: every payment updated since the cursor, a row each, the cursor advanced to
 *  the newest. Returns how many are past the cursor — the overlap's are merges. */
async function pollPayments(
  deps: MercadopagoDeps,
  key: string,
  agentId: string | undefined,
  names: Map<string, string | undefined>,
): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const cursor = await cursorFor(deps.creds, key, CURSOR, RESOURCE);
  if (!cursor) {
    await storeCursor(deps.creds, key, CURSOR, RESOURCE, now());
    return 0;
  }
  const w = wire(deps.fetchApi ?? fetch, await tokenOf(deps.broker, key, agentId), key);
  const self = key.slice(GRANT_PREFIX.length);
  const since = Date.parse(cursor);
  let newest = since;
  let published = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      range: "date_last_updated",
      begin_date: new Date(since - OVERLAP_MS).toISOString(),
      end_date: "NOW",
      sort: "date_last_updated",
      criteria: "asc",
      limit: String(PAGE),
      offset: String(page * PAGE),
    });
    const results = (await w.search(q)).results ?? [];
    for (const p of results) {
      const row = await namedRow(w, p, self, now(), names);
      if (row) await deps.publish(row);
      const at = Date.parse(p.date_last_updated ?? "");
      if (at > since) {
        if (row) published++;
        newest = Math.max(newest, at);
      }
    }
    if (results.length < PAGE) break;
  }
  if (newest > since) {
    await storeCursor(deps.creds, key, CURSOR, RESOURCE, new Date(newest).toISOString());
  }
  return published;
}

/* ── local entry: every mercadopago grant, on a metronome ────────────────────────── */

export function runPoll(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "payments",
    () => Promise.resolve([RESOURCE]),
    (deps: PollIngestDeps) => createMercadopagoPoller(deps),
  );
}

if (import.meta.main) await entry(runPoll);
