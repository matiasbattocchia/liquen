import { assertEquals } from "@std/assert";
import { createMercadopagoWebhook } from "./ingest.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../connector.ts";

const SELF = "78777806";
const KEY = `mercadopago:${SELF}`;

function notification(body: Record<string, unknown>, dataId?: string): Request {
  const url = new URL("http://localhost/");
  if (dataId) url.searchParams.set("data.id", dataId);
  url.searchParams.set("type", String(body.type));
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

const PAYMENT = {
  id: 184795054122,
  status: "approved",
  status_detail: "accredited",
  transaction_amount: 11000,
  currency_id: "ARS",
  description: "Varios",
  date_last_updated: "2026-10-17T10:00:00.000-04:00",
  live_mode: true,
  collector_id: Number(SELF),
  payer: { id: "1433184923", email: "ana@example.com" },
};

const BODY = {
  type: "payment",
  action: "payment.updated",
  live_mode: true,
  user_id: Number(SELF),
  data: { id: "184795054122" },
};

/** A handler over a vault holding one grant, the API faked. */
async function withHandler(
  fn: (h: {
    handle: (req: Request) => Promise<Response>;
    rows: Draft<MessageEvent>[];
    asked: string[];
  }) => Promise<void>,
  answer: () => Response = () => Response.json(PAYMENT),
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({ key: KEY, value: { token: "APP_USR-x" }, agentId: "ana" });
    const rows: Draft<MessageEvent>[] = [];
    const publish = ((e: Draft<Event>) => {
      rows.push(e as Draft<MessageEvent>);
      return Promise.resolve({ ...e, id: "id" } as Event);
    }) as Appender["publish"];
    const asked: string[] = [];
    const handle = createMercadopagoWebhook({
      publish,
      creds,
      broker: createGrantBroker({ creds }),
      fetchApi: (input) => {
        asked.push(new URL(String(input)).pathname);
        return Promise.resolve(answer());
      },
      now: () => "2026-11-10T20:00:00.000Z",
    });
    await fn({ handle, rows, asked });
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("ingest — a payment notification is read back and published", async () => {
  await withHandler(async ({ handle, rows, asked }) => {
    const res = await handle(notification(BODY, "184795054122"));
    assertEquals(res.status, 200);
    assertEquals(asked, ["/v1/payments/184795054122"]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].envelope.external_id, "mp:184795054122:approved:accredited");
    assertEquals(rows[0].envelope.sender, { address: "1433184923", name: "ana@example.com" });
  });
});

Deno.test("ingest — the payment id comes from the body when the query has none", async () => {
  await withHandler(async ({ handle, asked }) => {
    assertEquals((await handle(notification(BODY))).status, 200);
    assertEquals(asked, ["/v1/payments/184795054122"]);
  });
});

Deno.test("ingest — other topics, test mode, and other accounts are acknowledged and dropped", async () => {
  await withHandler(async ({ handle, rows, asked }) => {
    const ok = async (body: Record<string, unknown>) =>
      assertEquals((await handle(notification(body, "1"))).status, 200);
    await ok({ ...BODY, type: "topic_merchant_order_wh" });
    await ok({ ...BODY, live_mode: false });
    await ok({ ...BODY, user_id: 999 });
    const ipn = new Request("http://localhost/?topic=payment&id=1", { method: "POST" });
    assertEquals((await handle(ipn)).status, 200);
    assertEquals(asked, []);
    assertEquals(rows, []);
  });
});

Deno.test("ingest — a read that fails answers 500, so Mercado Pago retries", async () => {
  await withHandler(
    async ({ handle, rows }) => {
      assertEquals((await handle(notification(BODY, "184795054122"))).status, 500);
      assertEquals(rows, []);
    },
    () => new Response("down", { status: 503 }),
  );
});
