import { assertEquals } from "@std/assert";
import { createMercadopagoWebhook } from "./ingest.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../connector.ts";

const SELF = "78777806";
const KEY = `mercadopago:${SELF}`;
const SECRET = "s3cr3t";
const enc = new TextEncoder();

/** Sign a notification the way Mercado Pago does. */
async function sign(
  dataId: string,
  requestId: string,
  ts: string,
  secret = SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(manifest));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ts=${ts},v1=${hex}`;
}

function notification(
  body: Record<string, unknown>,
  opts: { dataId?: string; sig?: string; requestId?: string } = {},
): Request {
  const url = new URL("http://localhost/");
  if (opts.dataId) url.searchParams.set("data.id", opts.dataId);
  url.searchParams.set("type", String(body.type));
  const headers = new Headers({ "x-request-id": opts.requestId ?? "req-1" });
  if (opts.sig) headers.set("x-signature", opts.sig);
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers });
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

/** A handler over a vault holding one grant (with `secret` when given), the API faked. */
async function withHandler(
  secret: string | undefined,
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
    await creds.put({
      key: KEY,
      value: { token: "APP_USR-x", ...(secret ? { webhook_secret: secret } : {}) },
      agentId: "ana",
    });
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

Deno.test("webhook — a signed payment notification is read back and published", async () => {
  await withHandler(SECRET, async ({ handle, rows, asked }) => {
    const sig = await sign("184795054122", "req-1", "1704908010");
    const res = await handle(notification(BODY, { dataId: "184795054122", sig }));
    assertEquals(res.status, 200);
    assertEquals(asked, ["/v1/payments/184795054122"]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].envelope.external_id, "mp:184795054122:approved:accredited");
    assertEquals(rows[0].envelope.sender, { address: "1433184923", name: "ana@example.com" });
  });
});

Deno.test("webhook — a bad signature is refused before the API is asked", async () => {
  await withHandler(SECRET, async ({ handle, rows, asked }) => {
    const forged = await sign("184795054122", "req-1", "1704908010", "not-the-secret");
    assertEquals(
      (await handle(notification(BODY, { dataId: "184795054122", sig: forged }))).status,
      401,
    );
    assertEquals((await handle(notification(BODY, { dataId: "184795054122" }))).status, 401);
    assertEquals(asked, []);
    assertEquals(rows, []);
  });
});

Deno.test("webhook — no secret in the vault: an unsigned delivery is taken", async () => {
  await withHandler(undefined, async ({ handle, rows }) => {
    assertEquals((await handle(notification(BODY, { dataId: "184795054122" }))).status, 200);
    assertEquals(rows.length, 1);
  });
});

Deno.test("webhook — other topics, test mode, and other accounts are acknowledged and dropped", async () => {
  await withHandler(undefined, async ({ handle, rows, asked }) => {
    const ok = async (body: Record<string, unknown>) =>
      assertEquals((await handle(notification(body, { dataId: "1" }))).status, 200);
    await ok({ ...BODY, type: "topic_merchant_order_wh" });
    await ok({ ...BODY, live_mode: false });
    await ok({ ...BODY, user_id: 999 });
    assertEquals(asked, []);
    assertEquals(rows, []);
  });
});

Deno.test("webhook — a read that fails answers 500, so Mercado Pago retries", async () => {
  await withHandler(
    undefined,
    async ({ handle, rows }) => {
      assertEquals((await handle(notification(BODY, { dataId: "184795054122" }))).status, 500);
      assertEquals(rows, []);
    },
    () => new Response("down", { status: 503 }),
  );
});
