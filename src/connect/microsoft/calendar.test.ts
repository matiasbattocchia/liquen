import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMicrosoftCalendar } from "./calendar.ts";
import { createGrantBroker } from "../../proxy/grants.ts";
import { openCredentials } from "../../store/credentials.ts";
import type { Appender } from "../../store/log.ts";
import type { CalendarPart, Draft, Event, MessageEvent } from "../../types.ts";

const KEY = "microsoft:ana@contoso.com";
const DELTA = "https://graph.microsoft.com/beta/me/calendar/events/delta";
const NOW = "2026-09-23T12:00:00.000Z";

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

/** A vault with one fresh microsoft grant (no refresh needed) + its app row. */
async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({
      key: "microsoft:app:cid",
      value: { client_id: "cid", client_secret: "sec" },
      extra: { tenant: "t-1" },
    });
    await creds.put({
      key: KEY,
      value: { access_token: "eyJ.fresh", refresh_token: "0.r" },
      agentId: "ana",
      extra: { client_id: "cid", expiry: new Date(Date.now() + 3600_000).toISOString() },
    });
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Call = { url: URL; headers: Headers };

/** A Graph that answers the delta by URL and a detail read by event id. */
function graph(
  delta: (url: URL) => unknown | Response,
  events: Record<string, unknown> = {},
  calls: Call[] = [],
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const m = url.pathname.match(/^\/v1\.0\/me\/events\/(.+)$/);
    if (m) {
      const ev = events[decodeURIComponent(m[1])];
      return Promise.resolve(
        ev ? Response.json(ev) : new Response("not found", { status: 404 }),
      );
    }
    const ans = delta(url);
    return Promise.resolve(ans instanceof Response ? ans : Response.json(ans));
  }) as typeof fetch;
}

function poller(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  fetchApi: typeof fetch,
  publish: Appender["publish"] = captor().publish,
  calendars?: string[],
): { tick(): Promise<void> } {
  return createMicrosoftCalendar({
    publish,
    creds,
    broker: createGrantBroker({ creds }),
    calendars,
    fetchApi,
    now: () => NOW,
  });
}

function syncOf(creds: Awaited<ReturnType<typeof openCredentials>>): Promise<
  Record<string, string> | undefined
> {
  return creds.get(KEY).then((r) => r!.extra?.calendar_sync as Record<string, string> | undefined);
}

/** Seed the cursor at `link` — a bootstrap round that lists nothing. */
async function seeded(
  creds: Awaited<ReturnType<typeof openCredentials>>,
  link = `${DELTA}?$deltatoken=d1`,
): Promise<void> {
  await poller(creds, graph(() => ({ value: [], "@odata.deltaLink": link }))).tick();
}

const CREATED = {
  id: "AAMk1",
  subject: "Natación",
  body: { contentType: "text", content: "traer antiparras\r\n" },
  start: { dateTime: "2026-09-24T18:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-09-24T19:00:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  location: { displayName: "Club Náutico", locationType: "default" },
  organizer: { emailAddress: { name: "Ana", address: "ana@contoso.com" } },
  attendees: [
    {
      type: "required",
      status: { response: "none", time: "0001-01-01T00:00:00Z" },
      emailAddress: { name: "Luis", address: "luis@contoso.com" },
    },
    {
      type: "required",
      status: { response: "tentativelyAccepted", time: "2026-09-23T11:00:00Z" },
      emailAddress: { address: "eva@contoso.com" },
    },
    {
      type: "required",
      status: { response: "organizer", time: "0001-01-01T00:00:00Z" },
      emailAddress: { name: "Ana", address: "ana@contoso.com" },
    },
  ],
  createdDateTime: "2026-09-23T10:00:00.1234567Z",
  lastModifiedDateTime: "2026-09-23T10:00:00.9876543Z", // within jitter of created ⇒ a create
  changeKey: "abc==", // wire noise — pruning must drop it
  webLink: "https://outlook.office365.com/…",
};

Deno.test("first run bootstraps from now forward on the beta events delta: seeds the deltaLink, publishes nothing", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    const cap = captor();
    await poller(
      creds,
      graph(
        (url) => {
          // the first round pages to its deltaLink; the listed events are NOT read
          if (url.searchParams.has("startDateTime")) {
            return { value: [{ id: "AAMk0" }], "@odata.nextLink": `${DELTA}?$skiptoken=s1` };
          }
          return { value: [{ id: "AAMk0b" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d1` };
        },
        {},
        calls,
      ),
      cap.publish,
    ).tick();

    assertEquals(cap.rows.length, 0); // from-now: no history flood
    assertEquals(calls[0].url.origin + calls[0].url.pathname, DELTA);
    assertEquals(calls[0].url.searchParams.get("startDateTime"), NOW);
    assertEquals(calls[0].headers.get("authorization"), "Bearer eyJ.fresh");
    assertEquals(calls[1].url.searchParams.get("$skiptoken"), "s1"); // the nextLink, as given
    assertEquals(calls.length, 2, "no detail read on a bootstrap round");
    assertEquals((await syncOf(creds))!.primary, `${DELTA}?$deltatoken=d1`);
    assertEquals((await creds.get(KEY))!.extra!.client_id, "cid"); // untouched beside the cursor
  });
});

Deno.test("a new event is a create: the deltaLink is fetched as it is, the event read in UTC as text, pruned onto the canonical shape", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const calls: Call[] = [];
    const cap = captor();
    await poller(
      creds,
      graph(
        (url) => {
          assertEquals(url.searchParams.get("$deltatoken"), "d1"); // the stored cursor, verbatim
          return { value: [{ id: "AAMk1" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d2` };
        },
        { AAMk1: CREATED },
        calls,
      ),
      cap.publish,
    ).tick();

    const read = calls[1];
    assertEquals(read.url.pathname, "/v1.0/me/events/AAMk1");
    assertStringIncludes(read.url.searchParams.get("$select")!, "lastModifiedDateTime");
    assertStringIncludes(read.headers.get("prefer")!, 'outlook.timezone="UTC"');
    assertStringIncludes(read.headers.get("prefer")!, 'outlook.body-content-type="text"');

    assertEquals(cap.rows.length, 1);
    const row = cap.rows[0];
    assertEquals(row.envelope.service, "microsoft");
    assertEquals(row.envelope.connection_address, "ana@contoso.com");
    // `primary` resolves to its true id — the grant's address
    assertEquals(row.envelope.conversation.address, "calendar:ana@contoso.com");
    assertEquals(row.envelope.conversation.kind, "broadcast");
    assertEquals(row.envelope.external_id, "calendar:ana@contoso.com:AAMk1"); // the STABLE referent
    assertEquals(row.payload?.action, undefined);
    assertEquals(row.envelope.sender, { address: "ana@contoso.com", name: "Ana" }); // organizer
    assertEquals(row.agent, undefined); // harness-derived: never dispatched
    assertEquals(row.ts, "2026-09-23T10:00:00.9876543Z");
    const part = row.parts[0] as CalendarPart;
    assertEquals(part.kind, "calendar");
    assertEquals(part.text, "traer antiparras"); // the body, as text, trimmed
    assertEquals(part.data, {
      gid: "AAMk1",
      title: "Natación",
      start: "2026-09-24T18:00:00Z", // Graph's wall clock in UTC → an instant
      end: "2026-09-24T19:00:00Z",
      loc: "Club Náutico",
      invitees: [
        { name: "Luis", email: "luis@contoso.com", status: "needsAction" },
        { email: "eva@contoso.com", status: "tentative" },
        { name: "Ana", email: "ana@contoso.com" }, // the organizer answers nothing
      ],
    });
    assertEquals((await syncOf(creds))!.primary, `${DELTA}?$deltatoken=d2`); // cursor moved
  });
});

Deno.test("an all-day event is its dates, the shape a date-only start has everywhere", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const cap = captor();
    await poller(
      creds,
      graph(() => ({ value: [{ id: "AAMk2" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d2` }), {
        AAMk2: {
          subject: "Feriado",
          isAllDay: true,
          start: { dateTime: "2026-10-12T00:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-10-13T00:00:00.0000000", timeZone: "UTC" },
          body: { contentType: "text", content: "" },
          createdDateTime: "2026-09-23T10:00:00Z",
          lastModifiedDateTime: "2026-09-23T10:00:00Z",
        },
      }),
      cap.publish,
    ).tick();
    const part = cap.rows[0].parts[0] as CalendarPart;
    assertEquals(part.data.start, "2026-10-12");
    assertEquals(part.data.end, "2026-10-13");
    assertEquals(part.text, undefined); // an empty body is no prose
    assertEquals(cap.rows[0].envelope.sender, undefined);
  });
});

Deno.test("an edit is action:edit referencing the create; the original stays sealed", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const cap = captor();
    await poller(
      creds,
      graph(() => ({ value: [{ id: "AAMk1" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d2` }), {
        AAMk1: {
          ...CREATED,
          subject: "Natación (movida)",
          start: { dateTime: "2026-09-24T19:00:00.0000000", timeZone: "UTC" },
          lastModifiedDateTime: "2026-09-23T12:00:00Z", // well past created ⇒ an edit
        },
      }),
      cap.publish,
    ).tick();

    assertEquals(cap.rows.length, 1);
    const row = cap.rows[0];
    assertEquals(row.payload?.action, "edit");
    assertEquals(row.payload?.ref_external_id, "calendar:ana@contoso.com:AAMk1");
    assertEquals(row.envelope.external_id, "calendar:ana@contoso.com:AAMk1:2026-09-23T12:00:00Z");
    const data = (row.parts[0] as CalendarPart).data;
    assertEquals(data.title, "Natación (movida)");
    assertEquals(data.start, "2026-09-24T19:00:00Z");
  });
});

Deno.test("a removal is action:delete + a merge-only deleted_at stamp — and reads nothing back", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const calls: Call[] = [];
    const cap = captor();
    await poller(
      creds,
      graph(
        () => ({
          value: [{ id: "AAMk1", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": `${DELTA}?$deltatoken=d2`,
        }),
        {},
        calls,
      ),
      cap.publish,
    ).tick();

    assertEquals(calls.length, 1, "a removed id has no event to read");
    assertEquals(cap.rows.length, 2); // the delete event + the merge-only stamp
    const del = cap.rows[0];
    assertEquals(del.payload?.action, "delete");
    assertEquals(del.payload?.ref_external_id, "calendar:ana@contoso.com:AAMk1");
    assertEquals(del.envelope.external_id, "calendar:ana@contoso.com:AAMk1:cancelled");
    assertEquals((del.parts[0] as CalendarPart).data, { gid: "AAMk1" });
    assertEquals(del.envelope.sender, undefined); // a tombstone has no voice
    assertEquals(del.ts, NOW); // the wire stamps nothing on a removal
    const stamp = cap.rows[1];
    assertEquals(stamp.envelope.external_id, "calendar:ana@contoso.com:AAMk1");
    assertEquals(stamp.status?.deleted_at, NOW);
    assertEquals((stamp as { parts?: unknown }).parts, undefined);
  });
});

Deno.test("an organizer's cancellation lands on the attendee's copy as isCancelled — a delete", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const cap = captor();
    await poller(
      creds,
      graph(() => ({ value: [{ id: "AAMk1" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d2` }), {
        AAMk1: { ...CREATED, isCancelled: true, lastModifiedDateTime: "2026-09-23T12:30:00Z" },
      }),
      cap.publish,
    ).tick();
    assertEquals(cap.rows.length, 2);
    assertEquals(cap.rows[0].payload?.action, "delete");
    assertEquals(cap.rows[0].ts, "2026-09-23T12:30:00Z");
  });
});

Deno.test("an id gone between the list and the read is skipped; the cursor still advances", async () => {
  await withVault(async (creds) => {
    await seeded(creds);
    const cap = captor();
    await poller(
      creds,
      graph(() => ({ value: [{ id: "AAMkX" }], "@odata.deltaLink": `${DELTA}?$deltatoken=d2` })),
      cap.publish,
    ).tick();
    assertEquals(cap.rows.length, 0);
    assertEquals((await syncOf(creds))!.primary, `${DELTA}?$deltatoken=d2`);
  });
});

Deno.test("a 410 drops the cursor so the next tick re-bootstraps", async () => {
  await withVault(async (creds) => {
    let call = 0;
    const p = poller(
      creds,
      graph(() => {
        call++;
        if (call === 1) return { value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=d1` };
        if (call === 2) return new Response("gone", { status: 410 });
        return { value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=d3` };
      }),
    );
    await p.tick(); // seed → d1
    await p.tick(); // 410 → cursor dropped
    assertEquals((await syncOf(creds))?.primary, undefined, "cursor cleared after 410");
    await p.tick(); // re-bootstrap → d3
    assertEquals((await syncOf(creds))!.primary, `${DELTA}?$deltatoken=d3`);
  });
});

Deno.test("a named calendar is asked by id and keeps it — only `primary` resolves to the grant", async () => {
  await withVault(async (creds) => {
    const team = "AAMkCal=";
    const calls: Call[] = [];
    const link =
      `https://graph.microsoft.com/beta/me/calendars/${team}/events/delta?$deltatoken=t1`;
    await poller(
      creds,
      graph(() => ({ value: [], "@odata.deltaLink": link }), {}, calls),
      undefined,
      [team],
    ).tick(); // seed
    assertEquals(
      calls[0].url.pathname,
      `/beta/me/calendars/${encodeURIComponent(team)}/events/delta`,
    );

    const cap = captor();
    await poller(
      creds,
      graph(() => ({ value: [{ id: "AAMk9" }], "@odata.deltaLink": `${link}b` }), {
        AAMk9: { ...CREATED, id: "AAMk9" },
      }),
      cap.publish,
      [team],
    ).tick();
    assertEquals(cap.rows[0].envelope.conversation.address, `calendar:${team}`);
    assertEquals(cap.rows[0].envelope.external_id, `calendar:${team}:AAMk9`);
    assertEquals((await syncOf(creds))![team], `${link}b`); // the cursor keys on the CONFIGURED id
  });
});

Deno.test("app rows are not grants — they are never polled", async () => {
  await withVault(async (creds) => {
    const calls: Call[] = [];
    await poller(
      creds,
      graph(() => ({ value: [], "@odata.deltaLink": `${DELTA}?$deltatoken=d1` }), {}, calls),
    ).tick();
    assertEquals(calls.length, 1, "one grant, one calendar — the microsoft:app: row is skipped");
    assert(calls[0].url.pathname.startsWith("/beta/me/calendar/"));
  });
});
