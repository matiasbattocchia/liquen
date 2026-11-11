import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { connectMercadopago } from "./connect.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../connector.ts";

/** A store and a publish that capture what the door writes. */
function capture() {
  const connections: unknown[] = [];
  const memberships: unknown[] = [];
  const notes: Draft<MessageEvent>[] = [];
  return {
    connections,
    memberships,
    notes,
    store: {
      upsertConnections: (rows: unknown[]) => {
        connections.push(...rows);
        return Promise.resolve();
      },
      upsertMemberships: (rows: unknown[]) => {
        memberships.push(...rows);
        return Promise.resolve();
      },
    },
    publish: ((e: Draft<Event>) => {
      notes.push(e as Draft<MessageEvent>);
      return Promise.resolve({ ...e, id: "id" } as Event);
    }) as Appender["publish"],
  };
}

async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const whoami = () => Promise.resolve({ id: 78777806, nickname: "RESCAT" });

Deno.test("door — the grant, fronted as MP_ACCESS_TOKEN, mapped to its principal", async () => {
  await withVault(async (creds) => {
    const c = capture();
    const { account, contention } = await connectMercadopago(" APP_USR-x ", {
      principal: "ana",
      ingest: "https://acme.example/mercadopago/ingest",
      creds,
      store: c.store as never,
      publish: c.publish,
      whoami,
      now: () => "2026-11-10T20:00:00.000Z",
    });
    assertEquals(account, { id: "78777806", nickname: "RESCAT" });
    assertEquals(contention, undefined);
    const row = await creds.get("mercadopago:78777806");
    assertEquals(row?.value, { token: "APP_USR-x" });
    assertEquals(row?.agentId, "ana");
    assertEquals(row?.extra, { env: "MP_ACCESS_TOKEN", hosts: ["api.mercadopago.com"] });
    assertEquals(c.connections, [{
      service: "mercadopago",
      address: "78777806",
      agentId: "ana",
      credentialKey: "mercadopago:78777806",
      extra: { state: "connected", connected_at: "2026-11-10T20:00:00.000Z", error: null },
    }]);
    assertEquals(c.memberships, [
      { service: "mercadopago", connection: "78777806", conversation: "connect", agentId: "ana" },
    ]);
    assertEquals(c.notes.length, 1);
    // the agent holding the account learns where a payment link's notification_url points
    const said = (c.notes[0].parts[0] as { text: string }).text;
    assertStringIncludes(said, "notification_url=https://acme.example/mercadopago/ingest");
  });
});

Deno.test("door — another row claiming MP_ACCESS_TOKEN is named", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: "token:mercadopago:ana",
      value: { token: "APP_USR-x" },
      agentId: "ana",
      extra: { env: "MP_ACCESS_TOKEN", hosts: ["api.mercadopago.com"] },
    });
    const c = capture();
    const { contention } = await connectMercadopago("APP_USR-x", {
      principal: "ana",
      creds,
      store: c.store as never,
      publish: c.publish,
      whoami,
    });
    assertEquals(
      contention,
      "$MP_ACCESS_TOKEN is claimed by token:mercadopago:ana too — ana gets neither",
    );
  });
});

Deno.test("door — a token Mercado Pago refuses writes nothing", async () => {
  await withVault(async (creds) => {
    const c = capture();
    await assertRejects(
      () =>
        connectMercadopago("APP_USR-bad", {
          principal: "ana",
          creds,
          store: c.store as never,
          publish: c.publish,
          whoami: () => Promise.resolve({ message: "invalid access token" }),
        }),
      Error,
      "invalid access token",
    );
    assertEquals(await creds.list("mercadopago:"), []);
    assertEquals(c.connections, []);
    assertEquals(c.notes, []);
  });
});
