import { assert, assertEquals } from "@std/assert";
import { createGoogleWebhook } from "./calendar.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender } from "../../store/log.ts";
import type { DataPart, Draft, Event, MessageEvent } from "../../types.ts";

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
  calendars?: string[],
): { tick(): Promise<void> } {
  return createGoogleWebhook({
    publish,
    creds,
    broker: createGrantBroker({ creds }),
    calendars,
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

Deno.test("a new event is a create: a plain calendar message keyed on the stable referent", async () => {
  await withVault(async (creds) => {
    await poller(creds, () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" })))
      .tick(); // seed

    const created = {
      id: "ev1",
      status: "confirmed",
      summary: "Natación",
      description: "traer antiparras",
      location: "Club Náutico",
      created: "2026-08-24T10:00:00Z",
      updated: "2026-08-24T10:00:00Z", // created == updated ⇒ a create
      start: { dateTime: "2026-08-24T18:00:00Z" },
      end: { dateTime: "2026-08-24T19:00:00Z" },
      creator: { email: "ana@example.com", displayName: "Ana" },
      attendees: [{ email: "luis@example.com", responseStatus: "needsAction" }],
      etag: '"3400"', // wire noise — pruning must drop it
      iCalUID: "ev1@google.com",
    };
    const cap = captor();
    await poller(creds, (input) => {
      assertEquals(new URL(String(input)).searchParams.get("syncToken"), "tok1");
      return Promise.resolve(jsonResponse({ items: [created], nextSyncToken: "tok2" }));
    }, cap.publish).tick();

    assertEquals(cap.rows.length, 1);
    const row = cap.rows[0];
    assertEquals(row.envelope.service, "google");
    assertEquals(row.envelope.connection_address, "ana@example.com");
    // `primary` resolves to its true id — the grant's email (meeting ids copy across
    // attendee calendars, so a grant-relative referent would collide two grants' views)
    assertEquals(row.envelope.conversation.address, "calendar:ana@example.com");
    assertEquals(row.envelope.conversation.kind, "broadcast"); // fan-out, not a room
    assertEquals(row.envelope.external_id, "calendar:ana@example.com:ev1"); // the STABLE referent
    assertEquals(row.payload?.action, undefined); // a create has no action
    assertEquals(row.envelope.sender, { address: "ana@example.com", name: "Ana" }); // creator
    assertEquals(row.agent, undefined); // harness-derived: never dispatched
    const part = row.parts[0] as DataPart;
    assertEquals(part.kind, "calendar");
    assertEquals(part.text, undefined); // no prose — `data` IS the content
    assertEquals(part.data, {
      gid: "ev1",
      title: "Natación",
      start: "2026-08-24T18:00:00Z",
      end: "2026-08-24T19:00:00Z",
      loc: "Club Náutico",
      description: "traer antiparras",
      invitees: [{ email: "luis@example.com", status: "needsAction" }],
    }); // pruned: the wire's etag/iCalUID stopped at the connector
    assertEquals((await syncOf(creds))!.primary, "tok2"); // cursor moved
  });
});

Deno.test("an edit is action:edit referencing the create; the original stays sealed", async () => {
  await withVault(async (creds) => {
    await poller(creds, () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" })))
      .tick(); // seed

    const edited = {
      id: "ev1",
      status: "confirmed",
      summary: "Natación (movida)",
      created: "2026-08-24T10:00:00Z",
      updated: "2026-08-24T12:00:00Z", // well past created ⇒ an edit
      start: { dateTime: "2026-08-24T19:00:00Z" },
    };
    const cap = captor();
    await poller(
      creds,
      () => Promise.resolve(jsonResponse({ items: [edited], nextSyncToken: "tok2" })),
      cap.publish,
    ).tick();

    assertEquals(cap.rows.length, 1);
    const row = cap.rows[0];
    assertEquals(row.payload?.action, "edit");
    assertEquals(row.payload?.ref_external_id, "calendar:ana@example.com:ev1"); // points at the create
    assertEquals(
      row.envelope.external_id,
      "calendar:ana@example.com:ev1:2026-08-24T12:00:00Z", // own version
    );
    const data = (row.parts[0] as DataPart).data as Record<string, unknown>;
    assertEquals(data.title, "Natación (movida)"); // the new content rides the edit
    assertEquals(data.start, "2026-08-24T19:00:00Z");
  });
});

Deno.test("a cancellation is action:delete + a merge-only deleted_at stamp on the create", async () => {
  await withVault(async (creds) => {
    await poller(creds, () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "tok1" })))
      .tick(); // seed

    const cap = captor();
    await poller(creds, () =>
      Promise.resolve(jsonResponse({
        items: [{ id: "ev1", status: "cancelled" }], // a tombstone: minimal, no summary
        nextSyncToken: "tok2",
      })), cap.publish).tick();

    assertEquals(cap.rows.length, 2); // the delete event + the merge-only stamp
    const del = cap.rows[0];
    assertEquals(del.payload?.action, "delete");
    assertEquals(del.payload?.ref_external_id, "calendar:ana@example.com:ev1");
    assertEquals(del.envelope.external_id, "calendar:ana@example.com:ev1:cancelled");
    // the delete's whole content: the service-side handle that keeps the gone event
    // fetchable after its create scrolls out of the render window
    assertEquals((del.parts[0] as DataPart).data, { gid: "ev1" });
    assertEquals(del.envelope.sender, undefined); // a tombstone has no creator — no voice
    const stamp = cap.rows[1];
    assertEquals(stamp.envelope.external_id, "calendar:ana@example.com:ev1"); // merges onto the create
    assertEquals(stamp.status?.deleted_at, "2026-08-24T00:00:00.000Z");
    assertEquals((stamp as { parts?: unknown }).parts, undefined); // partless ⇒ content sealed
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

Deno.test("a named calendar keeps its own id — only `primary` resolves to the grant", async () => {
  await withVault(async (creds) => {
    const team = "team@group.calendar.google.com";
    await poller(
      creds,
      () => Promise.resolve(jsonResponse({ items: [], nextSyncToken: "t1" })),
      undefined,
      [team],
    ).tick(); // seed

    const created = {
      id: "ev9",
      status: "confirmed",
      summary: "Sync",
      created: "2026-08-24T10:00:00Z",
      updated: "2026-08-24T10:00:00Z",
    };
    const cap = captor();
    await poller(
      creds,
      () => Promise.resolve(jsonResponse({ items: [created], nextSyncToken: "t2" })),
      cap.publish,
      [team],
    ).tick();

    assertEquals(cap.rows[0].envelope.conversation.address, `calendar:${team}`);
    assertEquals(cap.rows[0].envelope.external_id, `calendar:${team}:ev9`);
    assertEquals((await syncOf(creds))![team], "t2"); // the cursor keys on the CONFIGURED id
  });
});

Deno.test("ticks never overlap — one landing mid-sweep joins the running one", async () => {
  await withVault(async (creds) => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = poller(
      creds,
      (async () => {
        calls++;
        await gate;
        return jsonResponse({ items: [], nextSyncToken: "tok1" });
      }) as typeof fetch,
    );

    const first = p.tick();
    const joined = p.tick(); // lands while the first sweep is parked on the API
    release();
    await Promise.all([first, joined]);
    assertEquals(calls, 1, "the joined tick must not run its own sweep");

    await p.tick(); // a LATER tick sweeps again
    assertEquals(calls, 2);
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
