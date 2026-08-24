/**
 * connect/google_webhook.ts — the Google ingest as a standalone service (open-bsp shape).
 *
 * Sibling of `slack.ts`/`github.ts`/`whatsapp.ts`: world → log, its own process, publishing
 * into `$MU_DIR/log`. The name follows the ingest family (the `*-webhook` convention the
 * others wear) even though the CARRIER here is a poll, not a webhook — Calendar's push door
 * (`events.watch`) needs a verified public endpoint, so on a laptop the only carrier is a
 * clock. This is the same split slack.ts names: "Socket Mode is a carrier, not an
 * architecture" — the mapping is the architecture, the transport is swappable. Swap the
 * ticker for a `(Request)=>Response` on the edge tier and the map/publish below is unchanged.
 *
 * What it watches: each google GRANT the org holds (`google:<email>`, minus the `google:app:`
 * client rows), across a set of calendars (default `primary`). What it emits: a `message` per
 * changed calendar event, in conversation `calendar:<calendarId>` on service `google`, with
 * the resource in a `{ type:"data", kind:"calendar" }` part — harness-derived, so NO `sender`
 * and NO `agent` (the same trick the transcriber uses to keep a broker-authored row off the
 * wire — dispatch wants `agent` — and out of fan-in, §4).
 *
 * A change speaks the SAME action language WhatsApp/Slack ingests do (§3), so an edit or a
 * cancellation reads as what it is, not as another opaque row:
 *   create   a plain message carrying the resource; `external_id` = the STABLE referent
 *            `calendar:<cal>:<id>` (the event's identity across versions).
 *   edit     its own event, `action:"edit"` + `ref_external_id` at the create, new content;
 *            the create row stays sealed (a `:<updated>`-versioned external_id dedupes replays).
 *   delete   its own event, `action:"delete"` + ref + EMPTY parts (the action is the meaning),
 *            plus a merge-only `status.deleted_at` on the create row.
 * Calendar's sync doesn't LABEL the change (no `message_changed`), so `classify` reads it off
 * the resource: `cancelled` ⇒ delete, `updated` past `created` ⇒ edit, else create. An edit or
 * delete of an event from before our window is a dangling ref — the soft reference the log
 * already tolerates for out-of-order revokes.
 *
 * The cursor is a syncToken, and it lives ON THE GRANT: `extra.calendar_sync[<calendarId>]`
 * in the vault (`put` shallow-merges `extra`, so it sits beside `client_id`/`expiry` without
 * disturbing them). It must ADVANCE every poll or the same changes replay forever, so it is
 * written back even on an empty delta. A first run with no token BOOTSTRAPS from now forward
 * (`timeMin = now`): only future changes ever become events, no history flood. A `410 Gone`
 * (token aged out) drops the cursor → the next tick re-bootstraps.
 *
 * Credentials (§8): the access token is fetched BROKER-side — `broker.accessTokenFor(
 * broker.issue(key))` — reusing the proxy's refresh+writeback. This process holds the grant;
 * the agent never does. The Calendar API is called directly (no proxy, no placeholder): the
 * broker is already the one code path that touches the secret, and this runs beside it.
 */

import type { Appender } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import type { GrantBroker } from "../proxy/grants.ts";
import type { Conversation, Draft, Json, MessageEvent } from "../types.ts";

const SERVICE = "google" as const;
const GRANT_PREFIX = "google:";
const APP_PREFIX = "google:app:";
const API = "https://www.googleapis.com/calendar/v3";

/** The slice of a Calendar `events` resource we read; the whole thing rides in `data`. */
export interface CalendarEvent {
  id?: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  created?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  [k: string]: unknown;
}

interface EventsList {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GoogleWebhookDeps {
  /** → the EventLog: a calendar change is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The vault: grants (the connections + the refresh_token) and the syncToken cursor. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  /** A live access token for a grant key, reusing the proxy's refresh machinery. */
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  /** Which calendars to watch on each grant. Default `["primary"]`. */
  calendars?: string[];
  /** Injectable for tests; defaults to global `fetch` against the Calendar API. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  /** Per-poll accounting (a grant, a calendar, how many rows published). */
  onPolled?: (key: string, calendarId: string, published: number) => void;
}

/** A poller bound to the vault + broker. `tick()` sweeps every grant once; callers drive the
 *  cadence (the entry runs it on a `setInterval`). Serialized per call — a slow poll delays
 *  the next tick's work for that grant, never overlaps it. */
export function createGoogleWebhook(deps: GoogleWebhookDeps): { tick(): Promise<void> } {
  const calendars = deps.calendars?.length ? deps.calendars : ["primary"];
  return {
    async tick(): Promise<void> {
      const grants = (await deps.creds.list(GRANT_PREFIX))
        .filter((r) => !r.key.startsWith(APP_PREFIX));
      for (const grant of grants) {
        for (const calendarId of calendars) {
          try {
            const n = await pollCalendar(deps, grant.key, grant.agentId, calendarId);
            deps.onPolled?.(grant.key, calendarId, n);
          } catch (err) {
            deps.onError?.(grant.key, err);
          }
        }
      }
    },
  };
}

/** One grant, one calendar: read the delta since the stored syncToken (or bootstrap from
 *  now), publish a row per change, advance the cursor. Returns the number published. */
async function pollCalendar(
  deps: GoogleWebhookDeps,
  key: string,
  agentId: string | undefined,
  calendarId: string,
): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
  if (!token) throw new Error(`no access token for ${key}`);

  const syncToken = await cursorFor(deps, key, calendarId);
  // No cursor yet → seed one from now forward and publish nothing (from-now bootstrap).
  if (!syncToken) {
    const seeded = await bootstrap(fetchApi, token, calendarId, now());
    await storeCursor(deps, key, calendarId, seeded);
    return 0;
  }

  const email = key.slice(GRANT_PREFIX.length);
  const conversation: Conversation = { address: `calendar:${calendarId}`, kind: "channel" };
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let published = 0;
  do {
    let page: EventsList;
    try {
      page = await getEvents(fetchApi, token, calendarId, { syncToken, pageToken });
    } catch (err) {
      // token aged out: drop the cursor, re-bootstrap on the next tick
      if (err instanceof SyncTokenGone) {
        await storeCursor(deps, key, calendarId, undefined);
        return published;
      }
      throw err;
    }
    for (const item of page.items ?? []) {
      if (!item.id) continue;
      for (const draft of rowsFor(email, conversation, item, now)) await deps.publish(draft);
      published++;
    }
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  // advance the cursor even on an empty delta — else the same changes replay forever
  if (nextSyncToken) await storeCursor(deps, key, calendarId, nextSyncToken);
  return published;
}

/** A create/edit/delete window is later than its create by more than this — Google stamps
 *  `created == updated` on insert (± server jitter), so a wider gap means a real edit. */
const EDIT_EPSILON_MS = 2000;

/** The change an incremental resource represents, in the action language (§3). Calendar's
 *  sync doesn't LABEL the change the way a Slack `message_changed` does, so we read it off
 *  the resource: `cancelled` ⇒ delete; `updated` well past `created` ⇒ edit; else create. */
function classify(item: CalendarEvent): "create" | "edit" | "delete" {
  if (item.status === "cancelled") return "delete";
  const created = item.created ? Date.parse(item.created) : NaN;
  const updated = item.updated ? Date.parse(item.updated) : NaN;
  const edited = Number.isFinite(created) && Number.isFinite(updated) &&
    updated - created > EDIT_EPSILON_MS;
  return edited ? "edit" : "create";
}

/** The stable referent for a calendar event — its identity across versions, what an edit or
 *  delete points `ref_external_id` at (and the create row's own external_id). */
function refFor(conversation: Conversation, id: string): string {
  return `${conversation.address}:${id}`;
}

/**
 * One changed resource → the events it means, in the SAME action language WhatsApp/Slack
 * speak (§3):
 *   create  a plain `message` carrying the resource, external_id = the stable referent.
 *   edit    its OWN event, `action:"edit"` + `ref_external_id` at the create, new content;
 *           the create row stays sealed (a versioned external_id keeps replays idempotent).
 *   delete  its OWN event, `action:"delete"` + ref + EMPTY parts (the action IS the meaning),
 *           PLUS a merge-only `status.deleted_at` stamp on the create row. An edit/delete of
 *           an event from before our window is a dangling ref — the tolerated soft reference.
 * All harness-derived: no sender, no agent (off the wire, out of fan-in — like transcribe).
 */
function rowsFor(
  email: string,
  conversation: Conversation,
  item: CalendarEvent,
  now: () => string,
): Draft<MessageEvent>[] {
  const id = item.id!;
  const ref = refFor(conversation, id);
  const ts = item.updated ?? now();
  const base = { service: SERVICE, connection_address: email, conversation };
  const change = classify(item);

  if (change === "delete") {
    return [
      {
        ts,
        type: "message",
        payload: { action: "delete", ref_external_id: ref },
        envelope: { ...base, external_id: `${ref}:cancelled` },
        parts: [],
      },
      // merge-only: no `parts` key, so the upsert leaves the sealed original untouched and
      // only the lifecycle stamp lands (soft-inserts a stub if the create was before us)
      {
        ts,
        type: "message",
        envelope: { ...base, external_id: ref },
        status: { deleted_at: ts },
      } as unknown as Draft<MessageEvent>,
    ];
  }

  // create/edit both carry the resource; the loose `unknown`-valued interface above is for
  // the few fields we read, not a claim the parsed JSON isn't Json
  const parts: MessageEvent["parts"] = [
    { type: "data", kind: "calendar", text: summarize(item), data: item as unknown as Json },
  ];
  if (change === "edit") {
    return [{
      ts,
      type: "message",
      payload: { action: "edit", ref_external_id: ref },
      envelope: { ...base, external_id: `${ref}:${item.updated ?? ""}` },
      parts,
    }];
  }
  return [{ ts, type: "message", envelope: { ...base, external_id: ref }, parts }];
}

/** A one-line human form for render; the full resource is in `data`. Deletes never reach
 *  here — they carry no parts (the action is the meaning). */
function summarize(item: CalendarEvent): string {
  const title = item.summary ?? "(no title)";
  const start = item.start?.dateTime ?? item.start?.date;
  return start ? `${title} — ${start}` : title;
}

/* ── the cursor: a syncToken per calendar, on the grant's `extra` ─────────────────── */

async function cursorFor(
  deps: GoogleWebhookDeps,
  key: string,
  calendarId: string,
): Promise<string | undefined> {
  const row = await deps.creds.get(key);
  const map = row?.extra?.calendar_sync;
  const token = map && typeof map === "object"
    ? (map as Record<string, unknown>)[calendarId]
    : undefined;
  return typeof token === "string" ? token : undefined;
}

async function storeCursor(
  deps: GoogleWebhookDeps,
  key: string,
  calendarId: string,
  token: string | undefined,
): Promise<void> {
  const row = await deps.creds.get(key);
  const prior = (row?.extra?.calendar_sync ?? {}) as Record<string, unknown>;
  const calendar_sync = { ...prior };
  if (token) calendar_sync[calendarId] = token;
  else delete calendar_sync[calendarId];
  // put shallow-merges extra, so this sits beside client_id/expiry untouched
  await deps.creds.put({ key, value: {}, extra: { calendar_sync } });
}

/* ── the Calendar API (direct fetch; the broker already holds the secret) ─────────── */

/** Thrown on a 410 — the syncToken is too old; the caller re-bootstraps. */
class SyncTokenGone extends Error {}

async function getEvents(
  fetchApi: typeof fetch,
  token: string,
  calendarId: string,
  q: { syncToken?: string; pageToken?: string },
): Promise<EventsList> {
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`);
  if (q.syncToken) url.searchParams.set("syncToken", q.syncToken);
  if (q.pageToken) url.searchParams.set("pageToken", q.pageToken);
  const res = await fetchApi(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 410) {
    await res.body?.cancel();
    throw new SyncTokenGone();
  }
  if (!res.ok) {
    throw new Error(`calendar events ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json() as EventsList;
}

/** Page an events.list from `timeMin` to its LAST page purely to harvest a `nextSyncToken` —
 *  the cursor future incremental syncs resume from. Publishes nothing (from-now bootstrap). */
async function bootstrap(
  fetchApi: typeof fetch,
  token: string,
  calendarId: string,
  timeMin: string,
): Promise<string | undefined> {
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) { // a bound; a fresh-from-now list is one page
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("showDeleted", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetchApi(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`calendar bootstrap ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const page = await res.json() as EventsList;
    if (page.nextSyncToken) return page.nextSyncToken;
    if (!page.nextPageToken) return undefined;
    pageToken = page.nextPageToken;
  }
  return undefined;
}

/* ── local entry: a standalone poll service into $MU_DIR/log ───────────────────────
 *
 *   deno task ingest:google        # sweeps every google grant on a metronome
 *
 * The harness (`deno task cli`) on the SAME MU_DIR turns each calendar change into a poke.
 * Env: MU_DIR (default ./data) · GOOGLE_CALENDARS (comma list, default `primary`) ·
 * GOOGLE_POLL_MS (default 60000). The store imports are dynamic so importing
 * `createGoogleWebhook` (e.g. from an edge function) never pulls in file I/O. */
if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const { openCredentials } = await import("../store/credentials.ts");
  const { createGrantBroker } = await import("../proxy/grants.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const calendars = (Deno.env.get("GOOGLE_CALENDARS") ?? "primary")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const pollMs = Number(Deno.env.get("GOOGLE_POLL_MS") ?? 60_000);

  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const poller = createGoogleWebhook({
    publish: log.publish,
    creds,
    broker,
    calendars,
    onError: (key, err) => console.error(`[google] poll FAILED on ${key}:`, err),
    onPolled: (key, cal, n) => n && console.error(`[google] ${key} ${cal}: +${n} events`),
  });
  console.error(
    `[google] calendar poll every ${pollMs}ms → ${dir}/log  (calendars: ${calendars.join(", ")})`,
  );
  await poller.tick(); // once at boot: seed cursors / catch up
  setInterval(() => poller.tick(), pollMs);
}
