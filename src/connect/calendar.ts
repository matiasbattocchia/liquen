/**
 * connect/calendar.ts — the row grammar every calendar poller publishes in. The cursor,
 * the sweep and the resident loop are the poller's (`poll.ts`); this is what a calendar
 * change MEANS in the log.
 *
 * A calendar service's connector (`google/calendar.ts`, `microsoft/calendar.ts`) owns its
 * WIRE — how a delta is asked for, what a resource looks like, how it is pruned onto the
 * canonical `CalendarData` (types.ts) — and hands the result here as a `CalendarChange`.
 * Everything from that point is one code path, so an edit or a cancellation reads the same
 * whichever service it came from, and render, search and the anchor never learn a service.
 *
 * A change speaks the SAME action language WhatsApp/Slack ingests do (§3):
 *   create   a plain message carrying the resource; `external_id` = the STABLE referent
 *            `calendar:<cal>:<id>` (the event's identity across versions — the
 *            address bare, the key wearing the service word every external id does).
 *   edit     its own event, `action:"edit"` + `ref_external_id` at the create, the whole
 *            event again and, beside it, a `diff` in the data's shape of what moved since
 *            the event's last row in the log (`lastState`, `calendarDiff`); the create row
 *            stays sealed (a `:<ts>`-versioned external_id dedupes replays). An edit that
 *            moves nothing the shape maps (an attachment, a reminder) publishes nothing;
 *            one whose event has no earlier row carries the whole event alone.
 *   delete   its own event, `action:"delete"` + ref, its part the bare `{gid}` handle (the
 *            action is the meaning; the gid keeps the gone event fetchable) — a cancelled
 *            occurrence's handle also says which series and which date (`series`, `was`) —
 *            plus a merge-only `status.deleted_at` on the create row.
 * A series is one event, its master; an occurrence that departs from the rule is an event of
 * its own whose referent has no create (the master's stands for the series), so its rows ref
 * it dangling. An edit or delete of an event from before the poller's window dangles the same
 * way — the soft reference the log already tolerates for out-of-order revokes. Every row is harness-derived:
 * `sender` is the event's organizer (the line's `from`), NO `agent` (the transcriber's trick
 * to keep a broker-authored row off the wire — dispatch wants `agent` — and out of fan-in, §4).
 *
 * The conversation is the calendar's id, named by the calendar's display name, kind
 * `broadcast`: a calendar is fan-out, not a room anyone is in, so render wears no voice on a
 * senderless line (a tombstone has no organizer). `<calendar>` is the calendar's TRUE id — the service's alias for the account's
 * own calendar (`primary`) resolves to the grant's address, because meeting ids COPY across
 * attendee calendars (the organizer's id lands in every copy) and `external_id` is globally
 * unique in the log: a grant-relative referent would collapse two grants' views of one
 * meeting into whichever row landed first.
 *
 * The cursor's namespace on the grant is `extra.calendar_sync`, keyed by the CONFIGURED
 * calendar id (`poll.ts`).
 */

import type {
  CalendarData,
  CalendarDiff,
  CalendarInvitee,
  CalendarPart,
  Conversation,
  Draft,
  MessageEvent,
  Moved,
  Service,
} from "../types.ts";
import type { Reader } from "../store/log.ts";

/** Where a grant keeps its calendar cursors (`cursorFor`/`storeCursor`, poll.ts). */
export const CALENDAR_SYNC = "calendar_sync";

/** One changed event, the way a service hands it over once its wire is read. */
export interface CalendarChange {
  /** The service-side id: the `gid` of the part, the tail of the referent. */
  id: string;
  change: "create" | "edit" | "delete";
  /** The version this row is: the resource's last-modified stamp, or the poll's now. */
  ts: string;
  /** The organizer — the line's voice. A delete carries none. */
  sender?: { address: string; name?: string };
  /** The pruned resource; a delete carries at most the handle (`gid`, and `series`/`was`
   *  on a cancelled occurrence). */
  data?: CalendarData;
  /** The organizer's prose (the description) — the part's `text`, never a data field. */
  text?: string;
}

/** The conversation a calendar's changes land in. `calendar` is the TRUE id; `name` is the
 *  calendar's display name, when the service gave one. */
export function calendarConversation(calendar: string, name?: string): Conversation {
  return { address: calendar, kind: "broadcast", ...(name ? { name } : {}) };
}

/** The event as its last row holds it: the pruned shape and the description. */
export interface CalendarState {
  data: CalendarData;
  text?: string;
}

/** The calendar a change lands in: the row envelope every row of it shares. */
export interface CalendarBase {
  service: Service;
  connection_address: string;
  conversation: Conversation;
}

/** The merge key of an event's rows (§3): the service word every external id wears, the
 *  calendar's id, the event's — the address bare. An edit's own key is this and its stamp. */
export function referentOf(base: CalendarBase, id: string): string {
  return `calendar:${base.conversation.address}:${id}`;
}

/** The event as the log last saw it — its create, or the latest edit of it — read back off
 *  the calendar's conversation; `undefined` when the log holds no row of it (an event from
 *  before the poller's window, a delete's handle being no state). */
export async function lastState(
  read: Reader["read"],
  base: CalendarBase,
  id: string,
): Promise<CalendarState | undefined> {
  const ref = referentOf(base, id);
  const [row] = await read({
    service: base.service,
    connection: base.connection_address,
    conversation: base.conversation.address,
    types: ["message"],
    limit: 1,
    filter: (e) => {
      const { envelope, payload } = e as MessageEvent;
      return payload?.action === undefined
        ? envelope.external_id === ref
        : payload.action === "edit" && payload.ref_external_id === ref;
    },
  }) as MessageEvent[];
  const part = row?.parts.find((p): p is CalendarPart =>
    p.type === "data" && p.kind === "calendar"
  );
  if (!part) return undefined;
  return { data: part.data, ...(part.text ? { text: part.text } : {}) };
}

/** A field's move, or nothing when it stands. */
function moved<T>(old: T | undefined, now: T | undefined): Moved<T> | undefined {
  if (old === now) return undefined;
  return { ...(old !== undefined ? { old } : {}), ...(now !== undefined ? { new: now } : {}) };
}

/** An invitee's identity across versions: the address, or the name where there is none. */
function identity(inv: CalendarInvitee): string | undefined {
  return inv.email ?? inv.name;
}

/** What `now` changed since `was`, in the data's shape (`CalendarDiff`, types.ts); nothing
 *  when every mapped field stands. */
export function calendarDiff(was: CalendarState, now: CalendarState): CalendarDiff | undefined {
  const diff: CalendarDiff = {};
  for (const k of ["title", "start", "end", "loc", "rrule", "series", "was"] as const) {
    const m = moved(was.data[k], now.data[k]);
    if (m) diff[k] = m;
  }
  const before = was.data.exdates ?? [];
  const after = now.data.exdates ?? [];
  const exdates = [
    ...before.filter((d) => !after.includes(d)).map((d) => ({ old: d })),
    ...after.filter((d) => !before.includes(d)).map((d) => ({ new: d })),
  ];
  if (exdates.length) diff.exdates = exdates;
  const invitees: NonNullable<CalendarDiff["invitees"]> = [];
  const kept = new Map((was.data.invitees ?? []).map((inv) => [identity(inv), inv]));
  for (const inv of now.data.invitees ?? []) {
    const old = kept.get(identity(inv));
    if (!old) {
      invitees.push({ new: inv });
      continue;
    }
    kept.delete(identity(inv));
    const name = moved(old.name, inv.name);
    const status = moved(old.status, inv.status);
    if (!name && !status) continue;
    invitees.push({
      ...(inv.email ? { email: inv.email } : {}),
      ...(name ? { name } : inv.email ? {} : { name: inv.name }),
      ...(status ? { status } : {}),
    });
  }
  for (const old of kept.values()) invitees.push({ old });
  if (invitees.length) diff.invitees = invitees;
  if ((was.text ?? "") !== (now.text ?? "")) diff.text = { old: was.text ?? "" };
  return Object.keys(diff).length ? diff : undefined;
}

/** One change → the rows it means, in the action language (§3). `was` is the event as the
 *  log last saw it, which an edit diffs against; absent, the edit carries the whole event
 *  alone. */
export function calendarRows(
  base: CalendarBase,
  c: CalendarChange,
  was?: CalendarState,
): Draft<MessageEvent>[] {
  const ref = referentOf(base, c.id);
  const { ts } = c;
  if (c.change === "delete") {
    return [
      {
        ts,
        type: "message",
        payload: { action: "delete", ref_external_id: ref },
        envelope: { ...base, external_id: `${ref}:cancelled` },
        // the handle is the delete's whole content: the service-side id that keeps the event
        // fetchable after the `re` referent scrolls out of the window, and on an occurrence
        // the series and the date it stood on
        parts: [
          { type: "data", kind: "calendar", data: c.data ?? { gid: c.id } } satisfies CalendarPart,
        ],
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
  const withSender = { ...base, sender: c.sender };
  // structure in `data`, the organizer's prose in `text` — never the same words twice
  const now: CalendarState = { data: c.data ?? { gid: c.id }, ...(c.text ? { text: c.text } : {}) };
  const part: CalendarPart = { type: "data", kind: "calendar", ...now };
  if (c.change === "edit") {
    if (was) {
      const diff = calendarDiff(was, now);
      if (!diff) return [];
      part.diff = diff;
    }
    return [{
      ts,
      type: "message",
      payload: { action: "edit", ref_external_id: ref },
      envelope: { ...withSender, external_id: `${ref}:${ts}` },
      parts: [part],
    }];
  }
  return [{ ts, type: "message", envelope: { ...withSender, external_id: ref }, parts: [part] }];
}

/** A resource whose last-modified stamp trails its creation by more than this was edited —
 *  a service stamps the two equal on insert (± server jitter), so a wider gap is a real
 *  edit. Calendar deltas don't LABEL the change the way a Slack `message_changed` does. */
const EDIT_EPSILON_MS = 2000;

/** create or edit, read off the resource's two stamps. */
export function createOrEdit(created?: string, updated?: string): "create" | "edit" {
  const c = created ? Date.parse(created) : NaN;
  const u = updated ? Date.parse(updated) : NaN;
  return Number.isFinite(c) && Number.isFinite(u) && u - c > EDIT_EPSILON_MS ? "edit" : "create";
}
