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
 *            `calendar:<cal>:<id>` (the event's identity across versions).
 *   edit     its own event, `action:"edit"` + `ref_external_id` at the create, new content;
 *            the create row stays sealed (a `:<ts>`-versioned external_id dedupes replays).
 *   delete   its own event, `action:"delete"` + ref, its part the bare `{gid}` handle (the
 *            action is the meaning; the gid keeps the gone event fetchable), plus a
 *            merge-only `status.deleted_at` on the create row.
 * An edit or delete of an event from before the poller's window is a dangling ref — the soft
 * reference the log already tolerates for out-of-order revokes. Every row is harness-derived:
 * `sender` is the event's organizer (the line's `from`), NO `agent` (the transcriber's trick
 * to keep a broker-authored row off the wire — dispatch wants `agent` — and out of fan-in, §4).
 *
 * The conversation is `calendar:<calendar>`, kind `broadcast`: a calendar is fan-out, not a
 * room anyone is in, so render wears no voice on a senderless line (a tombstone has no
 * organizer). `<calendar>` is the calendar's TRUE id — the service's alias for the account's
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
  CalendarPart,
  Conversation,
  Draft,
  MessageEvent,
  Service,
} from "../types.ts";

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
  /** The pruned resource; a delete carries none. */
  data?: CalendarData;
  /** The organizer's prose (the description) — the part's `text`, never a data field. */
  text?: string;
}

/** The conversation a calendar's changes land in. `calendar` is the TRUE id. */
export function calendarConversation(calendar: string): Conversation {
  return { address: `calendar:${calendar}`, kind: "broadcast" };
}

/** One change → the rows it means, in the action language (§3). */
export function calendarRows(
  base: { service: Service; connection_address: string; conversation: Conversation },
  c: CalendarChange,
): Draft<MessageEvent>[] {
  const ref = `${base.conversation.address}:${c.id}`;
  const { ts } = c;
  if (c.change === "delete") {
    return [
      {
        ts,
        type: "message",
        payload: { action: "delete", ref_external_id: ref },
        envelope: { ...base, external_id: `${ref}:cancelled` },
        // `{gid}` is the delete's whole content: the service-side id that keeps the event
        // fetchable after the `re` referent scrolls out of the window
        parts: [{ type: "data", kind: "calendar", data: { gid: c.id } } satisfies CalendarPart],
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
  const parts: MessageEvent["parts"] = [
    {
      type: "data",
      kind: "calendar",
      data: c.data ?? { gid: c.id },
      ...(c.text ? { text: c.text } : {}),
    } satisfies CalendarPart,
  ];
  if (c.change === "edit") {
    return [{
      ts,
      type: "message",
      payload: { action: "edit", ref_external_id: ref },
      envelope: { ...withSender, external_id: `${ref}:${ts}` },
      parts,
    }];
  }
  return [{ ts, type: "message", envelope: { ...withSender, external_id: ref }, parts }];
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
