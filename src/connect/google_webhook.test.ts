import { assert, assertEquals } from "@std/assert";
import { createGoogleWebhook } from "./google_webhook.ts";
import { createGrantBroker } from "../proxy/grants.ts";
import { openCredentials } from "../store/credentials.ts";
import type { Appender } from "../store/log.ts";
import type { DataPart, Draft, Event, MessageEvent } from "../types.ts";

const KEY = "google:ana@example.com";

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

/** A vault with one fresh google grant (no refresh needed) + an app row. */
async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({ key: "google:app:cid", value: { client_id: "cid", client_secret: "sec" } });
    await creds.put({
      key: KEY,
      value: { access_token: "ya29.fresh", refresh_token: "1//r" },
      agentId: "ana",
      extra: { client_id: "cid", expiry: new Date(Date.now() + 3600_000).toISOString() },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function poller(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  fetchApi: typeof fetch,
  publish: Appender["publish"] = captor().publish,
): { tick(): Promise<void> } {
  return createGoogleWebhook({
    publish,
    creds,
    broker: createGrantBroker({ creds }),
    fetchApi,
    now: () => "2026-08-24T00:00:00.000Z",
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function syncOf(creds: Awaited<ReturnType<typeof openCredentials>>): Promise<
  Record<string, string> | undefined
> {
  return creds.get(KEY).then((r) => r!.extra?.calendar_sync as Record<string, string> | undefined);
}

Deno.test("first run bootstraps from now forward: seeds a cursor, publishes nothing", async () => {
  await withVault(async (creds) => {
    const urls: string[] = [];
    const cap = captor();
    const p = poller(
      creds,
      ((input: string | URL | Request) => {
        urls.push(String(input));
        return Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" }));
      }) as typeof fetch,
      cap.publish,
    );
    await p.tick();

    assertEquals(cap.rows.length, 0); // from-now: no history flood
    const u = new URL(urls[0]);
    assert(u.searchParams.has("timeMin"), "bootstrap lists by timeMin, not syncToken");
    assert(!u.searchParams.has("syncToken"));
    const row = (await creds.get(KEY))!;
    assertEquals((await syncOf(creds))!.primary, "tok1");
    assertEquals(row.extra!.client_id, "cid"); // untouched beside the cursor
  });
});

Deno.test("incremental sync: a change becomes a calendar data message; the cursor advances", async () => {
  await withVault(async (creds) => {
    await poller(creds, () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" })))
      .tick(); // seed

    const changed = {
      id: "ev1",
      status: "confirmed",
      summary: "Natación",
      updated: "2026-08-24T10:00:00Z",
      start: { dateTime: "2026-08-24T18:00:00Z" },
    };
    const cap = captor();
    await poller(creds, (input) => {
      assertEquals(new URL(String(input)).searchParams.get("syncToken"), "tok1");
      return Promise.resolve(jsonResponse({ items: [changed], nextSyncToken: "tok2" }));
    }, cap.publish).tick();

    assertEquals(cap.rows.length, 1);
    const row = cap.rows[0];
    assertEquals(row.envelope.service, "google");
    assertEquals(row.envelope.connection_address, "ana@example.com");
    assertEquals(row.envelope.conversation.address, "calendar:primary");
    assertEquals(row.envelope.external_id, "calendar:primary:ev1:2026-08-24T10:00:00Z");
    assert(row.agent === undefined && row.envelope.sender === undefined); // harness-derived
    const part = row.parts[0] as DataPart;
    assertEquals(part.type, "data");
    assertEquals(part.kind, "calendar");
    assertEquals(part.text, "Natación — 2026-08-24T18:00:00Z");
    assertEquals((await syncOf(creds))!.primary, "tok2"); // cursor moved
  });
});

Deno.test("a cancelled event passes through as a deletion (status carries it)", async () => {
  await withVault(async (creds) => {
    await poller(creds, () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" })))
      .tick(); // seed

    const cap = captor();
    await poller(creds, () =>
      Promise.resolve(jsonResponse({
        items: [{
          id: "ev1",
          status: "cancelled",
          summary: "Old",
          updated: "2026-08-24T11:00:00Z",
        }],
        nextSyncToken: "tok2",
      })), cap.publish).tick();

    assertEquals(cap.rows.length, 1);
    const part = cap.rows[0].parts[0] as DataPart<string, { status: string }>;
    assertEquals(part.text, "Old — cancelled");
    assertEquals(part.data.status, "cancelled");
  });
});

Deno.test("a 410 drops the cursor so the next tick re-bootstraps", async () => {
  await withVault(async (creds) => {
    let call = 0;
    const fetchApi = (() => {
      call++;
      if (call === 1) return Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" }));
      if (call === 2) return Promise.resolve(new Response("gone", { status: 410 }));
      return Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok3" }));
    }) as typeof fetch;
    const p = poller(creds, fetchApi);

    await p.tick(); // seed → tok1
    await p.tick(); // 410 → cursor dropped
    assertEquals((await syncOf(creds))?.primary, undefined, "cursor cleared after 410");
    await p.tick(); // re-bootstrap → tok3
    assertEquals((await syncOf(creds))!.primary, "tok3");
  });
});

Deno.test("app rows are not grants — they are never polled", async () => {
  await withVault(async (creds) => {
    let calendarCalls = 0;
    await poller(creds, (input) => {
      if (String(input).includes("/calendars/")) calendarCalls++;
      return Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" }));
    }).tick();
    assertEquals(calendarCalls, 1, "one grant, one calendar — the google:app: row is skipped");
  });
});
