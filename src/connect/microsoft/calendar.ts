/**
 * connect/microsoft/calendar.ts — the Outlook Calendar wire, over the shared calendar poller
 * (connect/poll.ts: the cursor, the sweep, the resident loop) in the shared row grammar
 * (connect/calendar.ts).
 *
 * What it watches: each microsoft GRANT the org holds (`microsoft:<upn>`, minus the
 * `microsoft:app:` client rows), across a set of calendars (config
 * `connections.microsoft.calendars`). The CARRIER is a poll: Graph's change notifications
 * need a public endpoint, and Outlook's terms allow polling.
 *
 * The feed is Graph's events delta on a calendar — `/beta/me/calendar/events/delta` — the
 * one Graph change feed that runs from a point forward, unbounded, and lists series
 * MASTERS and single events (the `calendarView` delta of v1.0 is bound to a fixed window and
 * expands series into instances). It carries only `id`, `type`, `start`, `end` per event, so
 * each change is one more `GET /v1.0/me/events/<id>` for its content; a removal comes as
 * `{id, "@removed"}` and needs none. The `/beta` prefix is the feed's address and nothing
 * else about it is beta: the event resource read back is v1.0's.
 *
 * The cursor is the `@odata.deltaLink` — a complete URL, fetched as it is. A first run asks
 * `?startDateTime=now` and pages to the deltaLink publishing nothing; a `410 Gone` (the
 * token aged out) drops it. Graph doesn't LABEL a change, so `changeOf` reads it off the
 * resource: `@removed` or `isCancelled` ⇒ delete (an organizer's cancellation lands on every
 * attendee's copy as `isCancelled`, the copy itself staying until its owner removes it),
 * `lastModifiedDateTime` past `createdDateTime` ⇒ edit, else create. An attendee's reply
 * modifies the organizer's copy, so it reads as an edit — the same as on Google.
 *
 * Times are asked in UTC (`Prefer: outlook.timezone`) and published as instants (`…Z`); an
 * all-day event is published as its dates, the shape Google's `date` has. The body is asked
 * as text, so the part's `text` is the organizer's prose and never markup.
 */

import { APP_PREFIX } from "./connect.ts";
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

const SERVICE = "microsoft" as const;
const GRANT_PREFIX = "microsoft:";
const GRAPH = "https://graph.microsoft.com";

/** The slice of a Graph `event` we read — and all we KEEP (`pruned` below). */
export interface GraphEvent {
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: {
    emailAddress?: { name?: string; address?: string };
    status?: { response?: string };
  }[];
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  [k: string]: unknown;
}

/** What the delta feed lists per event: an id, or an id under `@removed`. */
interface DeltaItem {
  id?: string;
  "@removed"?: { reason?: string };
}

interface DeltaPage {
  value?: DeltaItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** The event properties the detail read asks for — the wire's answer is bounded to what
 *  `pruned` keeps and the body. */
const SELECT = [
  "subject",
  "body",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "location",
  "organizer",
  "attendees",
  "createdDateTime",
  "lastModifiedDateTime",
].join(",");

export interface MicrosoftCalendarDeps {
  /** → the EventLog: a calendar change is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The vault: grants (the connections + the refresh_token) and the deltaLink cursor. */
  creds: Pick<Credentials, "get" | "put" | "list">;
  /** A live access token for a grant key, reusing the proxy's refresh machinery. */
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  store?: Pick<Connections, "upsertConnections">;
  /** Which calendars to watch on each grant. Default `DEFAULT_CALENDARS`. */
  calendars?: string[];
  /** Injectable for tests; defaults to global `fetch` against Graph. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  onPolled?: (key: string, calendarId: string, published: number) => void;
}

/** The Microsoft poller: the shared sweep over `microsoft:` grants, `pollCalendar` per
 *  calendar. */
export function createMicrosoftCalendar(deps: MicrosoftCalendarDeps): { tick(): Promise<void> } {
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

/** One grant, one calendar: read the delta since the stored deltaLink (or bootstrap from
 *  now), publish a row per change, advance the cursor. Returns the number published. */
async function pollCalendar(
  deps: MicrosoftCalendarDeps,
  key: string,
  agentId: string | undefined,
  calendarId: string,
): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchApi = deps.fetchApi ?? fetch;
  const token = await deps.broker.accessTokenFor(deps.broker.issue(key, agentId));
  if (!token) throw new Error(`no access token for ${key}`);
  const graph = (url: string, headers: Record<string, string> = {}) =>
    fetchApi(url, {
      headers: { authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  const cursor = await cursorFor(deps.creds, key, CALENDAR_SYNC, calendarId);
  if (!cursor) {
    const link = await round(graph, deltaStart(calendarId, now()));
    await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, link);
    return 0;
  }

  const upn = key.slice(GRANT_PREFIX.length);
  // `primary` is an ALIAS, not an identity — its true id is the grant's address. The API is
  // still called by the configured alias; only what we publish resolves.
  const conversation = calendarConversation(calendarId === "primary" ? upn : calendarId);
  const base = { service: SERVICE, connection_address: upn, conversation };
  let published = 0;
  let link: string | undefined;
  try {
    link = await round(graph, cursor, async (item) => {
      const change = item["@removed"]
        ? { id: item.id!, change: "delete" as const, ts: now() }
        : await changeOf(graph, item.id!, now);
      if (!change) return;
      for (const draft of calendarRows(base, change)) await deps.publish(draft);
      published++;
    });
  } catch (err) {
    if (err instanceof DeltaGone) {
      await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, undefined);
      return published;
    }
    throw err;
  }
  if (link) await storeCursor(deps.creds, key, CALENDAR_SYNC, calendarId, link);
  return published;
}

/** One listed id → the change it is, read off the event itself. An id the read cannot find
 *  is an event gone between the list and the read: the feed says so on its next round. */
async function changeOf(
  graph: (url: string, headers?: Record<string, string>) => Promise<Response>,
  id: string,
  now: () => string,
): Promise<CalendarChange | undefined> {
  const item = await getEvent(graph, id);
  if (!item) return undefined;
  const ts = item.lastModifiedDateTime ?? now();
  if (item.isCancelled) return { id, change: "delete", ts };
  const org = item.organizer?.emailAddress;
  const text = item.body?.content?.trim();
  return {
    id,
    change: createOrEdit(item.createdDateTime, item.lastModifiedDateTime),
    ts,
    // the organizer is the line's voice — `from` in render, findable by name in search
    sender: org?.address
      ? { address: org.address, ...(org.name ? { name: org.name } : {}) }
      : undefined,
    data: pruned(id, item),
    text: text || undefined,
  };
}

/** Graph's attendee vocabulary onto the canonical PARTSTAT set (types.ts). The organizer's
 *  own entry carries no status: they hold the meeting rather than answer it. */
const RESPONSE: Record<string, NonNullable<CalendarData["invitees"]>[number]["status"]> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  notResponded: "needsAction",
  none: "needsAction",
};

/** What of an event is WORTH the agent's tokens: the wire resource pruned to the canonical
 *  `CalendarData` (types.ts) — `data` verbatim is what render shows and what the search
 *  column indexes, so everything else — change keys, web links, reminder policy, online
 *  meeting blobs — stops here. */
function pruned(id: string, item: GraphEvent): CalendarData {
  const out: CalendarData = { gid: id };
  if (item.subject) out.title = item.subject;
  const start = instant(item.start, item.isAllDay);
  if (start) out.start = start;
  const end = instant(item.end, item.isAllDay);
  if (end) out.end = end;
  if (item.location?.displayName) out.loc = item.location.displayName;
  const invitees = (item.attendees ?? []).map((a) => {
    const inv: NonNullable<CalendarData["invitees"]>[number] = {};
    if (a.emailAddress?.name) inv.name = a.emailAddress.name;
    if (a.emailAddress?.address) inv.email = a.emailAddress.address;
    const s = RESPONSE[a.status?.response ?? ""];
    if (s) inv.status = s;
    return inv;
  }).filter((inv) => Object.keys(inv).length > 0);
  if (invitees.length) out.invitees = invitees;
  return out;
}

/** Graph's `{dateTime, timeZone}` — a wall clock with seven fractional digits and the zone
 *  beside it — as one string: the date alone for an all-day event, else an instant. The
 *  read asks for UTC, so the zone is `UTC` and the instant is the clock with a `Z`; any
 *  other zone the wire insists on stays a wall clock with that zone named. */
function instant(
  t: { dateTime?: string; timeZone?: string } | undefined,
  allDay: boolean | undefined,
): string | undefined {
  if (!t?.dateTime) return undefined;
  if (allDay) return t.dateTime.slice(0, 10);
  const clock = t.dateTime.replace(/\.\d+$/, "");
  return t.timeZone === "UTC" ? `${clock}Z` : `${clock} ${t.timeZone ?? ""}`.trimEnd();
}

/* ── the Graph wire (direct fetch; the broker already holds the secret) ────────────── */

/** Thrown on a 410 — the delta token is too old; the caller re-bootstraps. */
class DeltaGone extends Error {}

/** The first request of a first round: the calendar's events from `since` forward. */
function deltaStart(calendarId: string, since: string): string {
  const calendar = calendarId === "primary"
    ? "calendar"
    : `calendars/${encodeURIComponent(calendarId)}`;
  return `${GRAPH}/beta/me/${calendar}/events/delta?startDateTime=${encodeURIComponent(since)}`;
}

/** One round of the delta: from `url` through every `@odata.nextLink` to the
 *  `@odata.deltaLink` that ends it, `onItem` on each listed event. Returns the deltaLink. */
async function round(
  graph: (url: string, headers?: Record<string, string>) => Promise<Response>,
  url: string,
  onItem?: (item: DeltaItem) => Promise<void>,
): Promise<string | undefined> {
  let next: string | undefined = url;
  for (let i = 0; i < 100 && next; i++) { // a bound; a round is one page unless a lot changed
    const res = await graph(next);
    if (res.status === 410) {
      await res.body?.cancel();
      throw new DeltaGone();
    }
    if (!res.ok) {
      throw new Error(`calendar delta ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const page = await res.json() as DeltaPage;
    for (const item of page.value ?? []) {
      if (item.id && onItem) await onItem(item);
    }
    if (page["@odata.deltaLink"]) return page["@odata.deltaLink"];
    next = page["@odata.nextLink"];
  }
  return undefined;
}

/** The event behind a listed id, in UTC with a text body; `undefined` when it is gone. */
async function getEvent(
  graph: (url: string, headers?: Record<string, string>) => Promise<Response>,
  id: string,
): Promise<GraphEvent | undefined> {
  const res = await graph(`${GRAPH}/v1.0/me/events/${encodeURIComponent(id)}?$select=${SELECT}`, {
    prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`calendar event ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json() as GraphEvent;
}

/* ── local entry: `deno task run:microsoft` — every microsoft grant, on a metronome ── */

export function runIngest(): Promise<() => Promise<void>> {
  return runPollIngest(
    SERVICE,
    "calendar",
    async (root) => (await (await import("./config.ts")).microsoftConfig(root)).calendars,
    (deps: PollIngestDeps) => createMicrosoftCalendar(deps),
  );
}

if (import.meta.main) await entry(runIngest);
