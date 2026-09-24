/**
 * connect/google/calendar.ts — the Google Calendar wire, over the shared calendar poller
 * (connect/poll.ts: the cursor, the sweep, the resident loop) in the shared row grammar
 * (connect/calendar.ts).
 *
 * The CARRIER is a poll: Calendar's push door (`events.watch`) needs a verified public
 * endpoint, so on a laptop the only carrier is a clock. The mapping is the architecture,
 * the transport is swappable — swap the ticker for a `(Request)=>Response` on the edge tier
 * and the map/publish below is unchanged.
 *
 * What it watches: each google GRANT the org holds (`google:<email>`, minus the `google:app:`
 * client rows), across a set of calendars (config `connections.google.calendars`). The
 * cursor is Calendar's `syncToken`; a first run harvests one from an `events.list` bounded
 * at `timeMin = now`, a `410 Gone` (token aged out) drops it. Calendar's sync doesn't LABEL
 * the change, so `classify` reads it off the resource: `cancelled` ⇒ delete, `updated` past
 * `created` ⇒ edit, else create. Two shapes land as dangling-but-tolerated refs: a cancelled
 * INSTANCE of a recurring event (`<masterId>_<ts>` — the master was the create), and a
 * re-cancellation after a restore (the restore is an edit that leaves `deleted_at` standing;
 * the second delete dedupes on `:cancelled` — un-delete has no verb here, same as the wire
 * services).
 */

import { DEFAULT_CALENDARS } from "./config.ts";
import {
  CALENDAR_SYNC,
  type CalendarChange,
  calendarConversation,
  calendarRows,
  createOrEdit,
} from "../calendar.ts";
import {
  createPoller,
  cursorFor,
  FETCH_TIMEOUT_MS,
  type PollIngestDeps,
  runPollIngest,
  storeCursor,
} from "../poll.ts";
import type { Appender } from "../../store/log.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import type { GrantBroker } from "../../proxy/grants.ts";
import type { CalendarData } from "../../types.ts";
import { entry } from "../../entry.ts";

const SERVICE = "google" as const;
const GRANT_PREFIX = "google:";
const APP_PREFIX = "google:app:";
const API = "https://www.googleapis.com/calendar/v3";

/** The slice of a Calendar `events` resource we read — and all we KEEP: `data` carries the
 *  pruned shape (`pruned` below), never the raw resource with its etags and policy noise.
 *  Pruning is the connector's job; render is service-agnostic and shows whatever rides here. */
export interface CalendarEvent {
  id?: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  creator?: { email?: string; displayName?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
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
  store?: Pick<Connections, "upsertConnections">;
  /** Which calendars to watch on each grant. Default `DEFAULT_CALENDARS`. */
  calendars?: string[];
  /** Injectable for tests; defaults to global `fetch` against the Calendar API. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, calendarId: string, published: number) => void;
}

/** The Google poller: the shared sweep over `google:` grants, `pollCalendar` per calendar. */
export function createGoogleWebhook(deps: GoogleWebhookDeps): { tick(): Promise<void> } {
  return createPoller({
    service: SERVICE,
    grantPrefix: GRANT_PREFIX,
    appPrefix: APP_PREFIX,
    creds: deps.creds,
    store: deps.store,
    resources: deps.calendars?.length ? deps.calendars : DEFAULT_CALENDARS,
    poll: (grant, calendarId) => pollCalendar(deps, grant.key, grant.agentId, calendarId),
    now: deps.now,
    onError: deps.onError,
    onPolled: deps.onPolled,
  });
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

  const syncToken = await cursorFor(deps.creds, key, CALENDAR_SYNC, calendarId);
  if (!syncToken) {
    const seeded = await bootstrap(fetchApi, token, calendarId, now());
    await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, seeded);
    return 0;
  }

  const email = key.slice(GRANT_PREFIX.length);
  // `primary` is an ALIAS, not an identity — its true calendarId is the grant's email. The
  // API is still called by the configured alias; only what we publish resolves.
  const conversation = calendarConversation(calendarId === "primary" ? email : calendarId);
  const base = { service: SERVICE, connection_address: email, conversation };
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let published = 0;
  do {
    let page: EventsList;
    try {
      page = await getEvents(fetchApi, token, calendarId, { syncToken, pageToken });
    } catch (err) {
      if (err instanceof SyncTokenGone) {
        await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, undefined);
        return published;
      }
      throw err;
    }
    for (const item of page.items ?? []) {
      if (!item.id) continue;
      for (const draft of calendarRows(base, changeOf(item, now))) await deps.publish(draft);
      published++;
    }
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, nextSyncToken);
  return published;
}

/** One incremental resource → the change it is, read off the resource: `cancelled` ⇒
 *  delete; `updated` well past `created` ⇒ edit; else create. */
function changeOf(item: CalendarEvent, now: () => string): CalendarChange {
  const id = item.id!;
  const ts = item.updated ?? now();
  if (item.status === "cancelled") return { id, change: "delete", ts };
  return {
    id,
    change: createOrEdit(item.created, item.updated),
    ts,
    // the creator is the line's voice — `from` in render, findable by name in search
    sender: item.creator?.email
      ? {
        address: item.creator.email,
        ...(item.creator.displayName ? { name: item.creator.displayName } : {}),
      }
      : undefined,
    data: pruned(item),
    text: item.description || undefined,
  };
}

/** What of a resource is WORTH the agent's tokens: the wire resource pruned to the canonical
 *  `CalendarData` (types.ts) — `data` verbatim is what render shows (as a TS literal) and
 *  what the search column indexes (string leaves), so everything else — etags, iCalUIDs,
 *  reminder policy, html links — stops here. Google's `responseStatus` vocabulary IS the
 *  canonical PARTSTAT set, so it passes through the whitelist unchanged. */
function pruned(item: CalendarEvent): CalendarData {
  const out: CalendarData = { gid: item.id! };
  if (item.summary) out.title = item.summary;
  const start = item.start?.dateTime ?? item.start?.date;
  if (start) out.start = start;
  const end = item.end?.dateTime ?? item.end?.date;
  if (end) out.end = end;
  if (item.location) out.loc = item.location;
  const invitees = (item.attendees ?? []).map((a) => {
    const inv: NonNullable<CalendarData["invitees"]>[number] = {};
    if (a.displayName) inv.name = a.displayName;
    if (a.email) inv.email = a.email;
    const s = a.responseStatus;
    if (s === "needsAction" || s === "accepted" || s === "declined" || s === "tentative") {
      inv.status = s;
    }
    return inv;
  }).filter((inv) => Object.keys(inv).length > 0);
  if (invitees.length) out.invitees = invitees;
  return out;
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
  const res = await fetchApi(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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
    const res = await fetchApi(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
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

/* ── local entry: `deno task run:google` — every google grant, on a metronome ─────── */

export function runIngest(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "calendar",
    async (root) => (await (await import("./config.ts")).googleConfig(root)).calendars,
    (deps: PollIngestDeps) => createGoogleWebhook(deps),
  );
}

if (import.meta.main) await entry(runIngest);
