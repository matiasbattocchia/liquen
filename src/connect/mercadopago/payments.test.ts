import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMercadopagoPoller, type Payment, paymentRow, wire } from "./payments.ts";
import { SignedOut } from "../errors.ts";
import { cursorFor } from "../poll.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import { membersAt } from "../../testing.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../connector.ts";

const SELF = "78777806";
const KEY = `mercadopago:${SELF}`;
const NOW = "2026-11-10T20:00:00.000Z";

/** A publish that captures the drafts (satisfying the overloaded Appender signature). */
function captor(): { publish: Appender["publish"]; rows: Draft<MessageEvent>[] } {
  const rows: Draft<MessageEvent>[] = [];
  const publish = ((e: Draft<Event> | Draft<Event>[]) => {
    const one = (d: Draft<Event>) => {
      rows.push(d as Draft<MessageEvent>);
      return { ...d, id: `id${rows.length}` } as Event;
    };
    return Promise.resolve(Array.isArray(e) ? e.map(one) : one(e));
  }) as Appender["publish"];
  return { publish, rows };
}

const paidIn: Payment = {
  id: 184795054122,
  status: "approved",
  status_detail: "accredited",
  operation_type: "money_transfer",
  transaction_amount: 11000,
  currency_id: "ARS",
  description: "Varios",
  payment_method_id: "account_money",
  date_last_updated: "2026-10-17T10:00:00.000-04:00",
  live_mode: true,
  collector_id: Number(SELF),
  collector: null,
  payer: { id: "1433184923", email: "ana@example.com" },
};

const paidOut: Payment = {
  id: 188679711338,
  status: "approved",
  status_detail: "partially_refunded",
  operation_type: "regular_payment",
  transaction_amount: 42624,
  transaction_amount_refunded: 15429,
  currency_id: "ARS",
  description: "Dlo*uber*eats",
  payment_method_id: "account_money",
  date_last_updated: "2026-11-09T13:12:18.000-04:00",
  live_mode: true,
  collector_id: null,
  collector: { id: 246176764 },
  payer: null,
};

Deno.test("paymentRow — money in: the payer speaks, by email, in their conversation", () => {
  const row = paymentRow(paidIn, SELF, NOW)!;
  assertEquals(row.ts, "2026-10-17T14:00:00.000Z");
  assertEquals(row.envelope, {
    service: "mercadopago",
    connection_address: SELF,
    conversation: { address: "1433184923", kind: "broadcast", name: "ana@example.com" },
    sender: { address: "1433184923", name: "ana@example.com" },
    external_id: "mp:184795054122:approved:accredited",
  });
  assertEquals(row.extra, { sender_email: "ana@example.com" });
  assertEquals(row.parts, [{
    type: "data",
    kind: "payment",
    data: {
      id: "184795054122",
      way: "in",
      status: "approved",
      detail: "accredited",
      amount: 11000,
      currency: "ARS",
      method: "account_money",
      type: "money_transfer",
    },
    text: "Varios",
  }]);
});

Deno.test("paymentRow — money out: the account speaks, in the payee's conversation", () => {
  const row = paymentRow(paidOut, SELF, NOW, "PREDAIDCOLLECTOR")!;
  assertEquals(row.envelope.conversation, {
    address: "246176764",
    kind: "broadcast",
    name: "PREDAIDCOLLECTOR",
  });
  assertEquals(row.envelope.sender, { address: SELF });
  assertEquals(row.extra, undefined);
  const data = (row.parts[0] as { data: Record<string, unknown> }).data;
  assertEquals(data.way, "out");
  assertEquals(data.refunded, 15429);
});

Deno.test("paymentRow — each state is its own row; test mode is none", () => {
  const authorized = paymentRow(
    { ...paidOut, status: "authorized", status_detail: "pending_capture" },
    SELF,
    NOW,
  )!;
  const approved = paymentRow(paidOut, SELF, NOW)!;
  assert(authorized.envelope.external_id !== approved.envelope.external_id);
  assertEquals(paymentRow({ ...paidOut, live_mode: false }, SELF, NOW), null);
});

Deno.test("paymentRow — a top-up from the account's own bank is the account's own line", () => {
  const row = paymentRow(
    {
      ...paidIn,
      operation_type: "account_fund",
      payer: { id: SELF, email: "me@example.com" },
    },
    SELF,
    NOW,
  )!;
  assertEquals(row.envelope.conversation.address, SELF);
  assertEquals(row.envelope.sender?.address, SELF);
});

Deno.test("wire — a refused token is SignedOut, so the account reads signed out", async () => {
  const w = wire(
    () => Promise.resolve(new Response('{"message":"invalid"}', { status: 401 })),
    "t",
    KEY,
  );
  await assertRejects(() => w.payment("1"), SignedOut);
});

/** A vault with one static mercadopago grant. */
async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await membersAt(dir, "ana", "bo");
  const creds = await openCredentials(dir);
  try {
    await creds.put({
      key: KEY,
      value: { token: "APP_USR-x" },
      agentId: "ana",
      extra: { env: "MP_ACCESS_TOKEN", hosts: ["api.mercadopago.com"] },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("poll — the first sweep seeds the cursor at now and publishes nothing", async () => {
  await withVault(async (creds) => {
    const { publish, rows } = captor();
    let calls = 0;
    const poller = createMercadopagoPoller({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: () => {
        calls++;
        return Promise.resolve(new Response("{}"));
      },
      now: () => NOW,
    });
    await poller.tick();
    assertEquals(calls, 0);
    assertEquals(rows.length, 0);
    assertEquals(await cursorFor(creds, KEY, "payments", "updated"), NOW);
  });
});

Deno.test("poll — reads behind the cursor, publishes every row, counts and advances past it", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: KEY,
      value: {},
      extra: { payments: { updated: "2026-11-09T17:00:00.000Z" } },
    });
    const { publish, rows } = captor();
    const asked: URL[] = [];
    const polled: number[] = [];
    const older = { ...paidIn, date_last_updated: "2026-11-09T16:55:00.000Z" }; // in the overlap
    const fetchApi = (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url);
      if (url.pathname === "/v1/payments/search") {
        return Promise.resolve(Response.json({ results: [older, paidOut] }));
      }
      if (url.pathname === "/users/246176764") {
        return Promise.resolve(Response.json({ nickname: "PREDAIDCOLLECTOR" }));
      }
      return Promise.resolve(new Response("not here", { status: 404 }));
    };
    const poller = createMercadopagoPoller({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi,
      now: () => NOW,
      onPolled: (_k, _r, n) => polled.push(n),
    });
    await poller.tick();

    const search = asked.find((u) => u.pathname === "/v1/payments/search")!;
    assertEquals(search.searchParams.get("range"), "date_last_updated");
    assertEquals(search.searchParams.get("begin_date"), "2026-11-09T16:50:00.000Z");
    assertEquals(search.searchParams.get("sort"), "date_last_updated");
    assertEquals(search.searchParams.get("criteria"), "asc");
    assertEquals(rows.length, 2); // the overlap's row is published again — it merges
    assertEquals(rows[1].envelope.conversation.name, "PREDAIDCOLLECTOR");
    assertEquals(polled, [1]);
    assertEquals(await cursorFor(creds, KEY, "payments", "updated"), "2026-11-09T17:12:18.000Z");
  });
});
