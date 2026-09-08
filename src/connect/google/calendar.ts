/**
 * connect/google/calendar.ts — the Google ingest as a standalone service (open-bsp shape).
 *
 * Sibling of `slack.ts`/`github.ts`/`whatsapp.ts`: world → log, its own process, publishing
 * into `the org log (./data)`. The name follows the ingest family (the `*-webhook` convention the
 * others wear) even though the CARRIER here is a poll, not a webhook — Calendar's push door
 * (`events.watch`) needs a verified public endpoint, so on a laptop the only carrier is a
 * clock. This is the same split slack.ts names: "Socket Mode is a carrier, not an
 * architecture" — the mapping is the architecture, the transport is swappable. Swap the
 * ticker for a `(Request)=>Response` on the edge tier and the map/publish below is unchanged.
 *
 * What it watches: each google GRANT the org holds (`google:<email>`, minus the `google:app:`
 * client rows), across a set of calendars (config `connections.google.calendars`). What it
 * emits: a `message` per changed calendar event, in a `broadcast` conversation
 * `calendar:<calendar>` on service `google` — where `<calendar>` is the calendar's TRUE id
 * (`primary` resolves to the grant's email; see `pollCalendar`) — with the PRUNED resource in
 * a `CalendarPart` (`pruned` maps the wire onto the canonical shape in types.ts, the same one
 * any other calendar service's connector targets; it is what render shows and search indexes)
 * and the event's description as that part's `text` — structure and prose, never both.
 * `sender` is the event's CREATOR (the line's `from`); NO `agent` (the transcriber's trick to
 * keep a broker-authored row off the wire — dispatch wants `agent` — and out of fan-in, §4).
 *
 * A change speaks the SAME action language WhatsApp/Slack ingests do (§3), so an edit or a
 * cancellation reads as what it is, not as another opaque row:
 *   create   a plain message carrying the resource; `external_id` = the STABLE referent
 *            `calendar:<cal>:<id>` (the event's identity across versions).
 *   edit     its own event, `action:"edit"` + `ref_external_id` at the create, new content;
 *            the create row stays sealed (a `:<updated>`-versioned external_id dedupes replays).
 *   delete   its own event, `action:"delete"` + ref, its part the bare `{gid}` handle (the
 *            action is the meaning; the gid keeps the gone event fetchable), plus a
 *            merge-only `status.deleted_at` on the create row.
 * Calendar's sync doesn't LABEL the change (no `message_changed`), so `classify` reads it off
 * the resource: `cancelled` ⇒ delete, `updated` past `created` ⇒ edit, else create. An edit or
 * delete of an event from before our window is a dangling ref — the soft reference the log
 * already tolerates for out-of-order revokes. Two more shapes land as dangling-but-tolerated:
 * a cancelled INSTANCE of a recurring event (`<masterId>_<ts>` — the master was the create),
 * and a re-cancellation after a restore (the restore is an edit that leaves `deleted_at`
 * standing; the second delete dedupes on `:cancelled` — un-delete has no verb here, same as
 * the wire services).
 *
 * The cursor is a syncToken, and it lives ON THE GRANT: `extra.calendar_sync[<calendarId>]`
 * in the vault (`put` shallow-merges `extra`, so it sits beside `client_id`/`expiry` without
 * disturbing them). It must ADVANCE every poll or the same changes replay forever, so it is
 * written back even on an empty delta. A first run with no token BOOTSTRAPS from now forward
 * (`timeMin = now`): only future changes ever become events, no history flood. A `410 Gone`
 * (token aged out) drops the cursor → the next tick re-bootstraps.
 *
 * Credentials (§9): the access token is fetched BROKER-side — `broker.accessTokenFor(
 * broker.issue(key))` — reusing the proxy's refresh+writeback. This process holds the grant;
 * the agent never does. The Calendar API is called directly (no proxy, no placeholder): the
 * broker is already the one code path that touches the secret, and this runs beside it.
 */

import { DEFAULT_CALENDARS } from "./config.ts";
import type { Appender } from "../../store/log.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Connections } from "../../store/connections.ts";
import type { GrantBroker } from "../../proxy/grants.ts";
import type { CalendarData, CalendarPart, Conversation, Draft, MessageEvent } from "../../types.ts";
import { findRoot, orgFlag } from "../../config.ts";

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
  /** The connections map (§4): a grant's state is written on the transition — `failing`
   *  when a sweep cannot read it (a refresh refused, the API unreachable), `connected`
   *  when it reads again — so the anchor can say a surface is down (§5). */
  store?: Pick<Connections, "upsertConnections">;
  /** Which calendars to watch on each grant. Default `DEFAULT_CALENDARS`. */
  calendars?: string[];
  /** Injectable for tests; defaults to global `fetch` against the Calendar API. */
  fetchApi?: typeof fetch;
  now?: () => string;
  onError?: (key: string, err: unknown) => void;
  /** Per-poll accounting (a grant, a calendar, how many changes published — a cancellation
   *  publishes two rows but is one change). */
  onPolled?: (key: string, calendarId: string, published: number) => void;
}

/** A poller bound to the vault + broker. `tick()` sweeps every grant once; callers drive the
 *  cadence (the entry runs it on a `setInterval`). Ticks never overlap: one that lands while
 *  a sweep runs JOINS it — two sweeps reading one cursor would each publish the same delta
 *  and race the write-back, and a stalled poll must not pile intervals behind it. */
export function createGoogleWebhook(deps: GoogleWebhookDeps): { tick(): Promise<void> } {
  const calendars = deps.calendars?.length ? deps.calendars : DEFAULT_CALENDARS;
  const now = deps.now ?? (() => new Date().toISOString());
  // one state per grant, written only when it changes: a sweep that reads is `connected`,
  // one that cannot is `failing` — the row carries the reason
  const known = new Map<string, string>();
  const mark = (key: string, state: string, error?: string) => {
    if (!deps.store || known.get(key) === state) return;
    known.set(key, state);
    deps.store.upsertConnections([{
      service: "google",
      address: key.slice(GRANT_PREFIX.length),
      extra: { state, [`${state}_at`]: now(), ...(error !== undefined ? { error } : {}) },
    }]);
  };
  const sweep = async (): Promise<void> => {
    const grants = (await deps.creds.list(GRANT_PREFIX))
      .filter((r) => !r.key.startsWith(APP_PREFIX));
    for (const grant of grants) {
      let failure: string | undefined;
      for (const calendarId of calendars) {
        try {
          const n = await pollCalendar(deps, grant.key, grant.agentId, calendarId);
          deps.onPolled?.(grant.key, calendarId, n);
        } catch (err) {
          failure ??= err instanceof Error ? err.message : String(err);
          deps.onError?.(grant.key, err);
        }
      }
      if (failure === undefined) mark(grant.key, "connected");
      else mark(grant.key, "failing", failure);
    }
  };
  let inflight: Promise<void> | null = null;
  return {
    tick(): Promise<void> {
      inflight ??= sweep().finally(() => (inflight = null));
      return inflight;
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
  // `primary` is an ALIAS, not an identity — its true calendarId is the grant's email. The
  // published address and referent must carry the true id: meeting ids COPY across attendee
  // calendars (the organizer's id lands in every copy) and `external_id` is globally unique
  // in the log, so a grant-relative `calendar:primary:<id>` would collapse two grants' views
  // of one meeting into whichever row landed first. (A genuinely shared calendar collapsing
  // by its one true id is the same rule doing its job.) The API is still called by the
  // configured alias; only what we publish resolves.
  const calendar = calendarId === "primary" ? email : calendarId;
  // broadcast: a calendar is fan-out, not a room anyone is in — render wears no voice on a
  // senderless line here (a tombstone has no creator)
  const conversation: Conversation = { address: `calendar:${calendar}`, kind: "broadcast" };
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
  // the creator is the line's voice — `from` in render, findable by name in search. A
  // tombstone carries none: its delete row stays senderless (a world fact, no voice).
  const sender = item.creator?.email
    ? {
      address: item.creator.email,
      ...(item.creator.displayName ? { name: item.creator.displayName } : {}),
    }
    : undefined;
  const base = { service: SERVICE, connection_address: email, conversation, sender };
  const change = classify(item);

  if (change === "delete") {
    return [
      {
        ts,
        type: "message",
        payload: { action: "delete", ref_external_id: ref },
        envelope: { ...base, external_id: `${ref}:cancelled` },
        // `{gid}` is the delete's whole content: the service-side id that keeps the event
        // fetchable (`events get`) after the `re` referent scrolls out of the window
        parts: [{ type: "data", kind: "calendar", data: { gid: id } } satisfies CalendarPart],
      },
      // merge-only: no `parts` key, so the upsert leaves the sealed original untouched and
      // only the lifecycle stamp lands (a create from before our window has no row — the
      // log stores nothing for a patch with no referent, the same dangling tolerance)
      {
        ts,
        type: "message",
        envelope: { ...base, external_id: ref },
        status: { state: "deleted", deleted_at: ts },
      } as unknown as Draft<MessageEvent>,
    ];
  }

  // structure in `data`, the organizer's prose in `text` — never the same words twice
  const parts: MessageEvent["parts"] = [
    {
      type: "data",
      kind: "calendar",
      data: pruned(item),
      ...(item.description ? { text: item.description } : {}),
    } satisfies CalendarPart,
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
  // put shallow-merges extra, so this sits beside client_id/expiry untouched. The broker's
  // expiry write-back (another process) does the same read-merge-write on this row; a stale
  // read can regress the other's field, and both losses self-heal — a regressed expiry just
  // re-refreshes, a regressed cursor replays a delta into the external_id dedupe.
  await deps.creds.put({ key, value: {}, extra: { calendar_sync } });
}

/* ── the Calendar API (direct fetch; the broker already holds the secret) ─────────── */

// a socket that hangs without closing would stall its grant's polling FOREVER (the tick
// join above holds every later tick behind it) — bound every call, fail into onError
const FETCH_TIMEOUT_MS = 30_000;

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

/* ── local entry: a standalone poll service into the org log (./data) ───────────────────────
 *
 *   deno task run:google        # sweeps every google grant on a metronome
 *
 * The harness (`deno task cli`) on the SAME data root turns each calendar change into a poke.
 * Env: none — the data root is `./data`; the calendars come from config
 * (`connections.google.calendars`), the cadence is a constant. The store imports are
 * dynamic so importing `createGoogleWebhook` (e.g. from an edge function) never pulls in
 * file I/O. */
/** Wire the poller over the org's log — resident once it returns (interval armed).
 *  Returns stop: disarm the metronome, finish the sweep in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const POLL_MS = 60_000;
  const { openLog } = await import("../../store/log.ts");
  const { openCredentials } = await import("../../store/credentials.ts");
  const { createGrantBroker } = await import("../../proxy/grants.ts");
  const { googleConfig } = await import("./config.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const { calendars } = await googleConfig(root);

  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });
  const poller = createGoogleWebhook({
    publish: log.publish,
    creds,
    broker,
    store: log,
    calendars,
    onError: (key, err) => console.error(`[ingest] poll FAILED on ${key}:`, err),
    onPolled: (key, cal, n) => n && console.error(`[ingest] ${key} ${cal}: +${n} changes`),
  });
  console.error(
    `[ingest] calendar poll every ${POLL_MS}ms → ${dir}/log  (calendars: ${calendars.join(", ")})`,
  );
  let sweep = poller.tick(); // once at boot: seed cursors / catch up
  await sweep;
  const timer = setInterval(() => {
    sweep = poller.tick();
  }, POLL_MS);
  return async () => {
    clearInterval(timer);
    await sweep.catch(() => {/* onError already said it */});
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await runIngest();
