import { assertEquals } from "@std/assert";
import { calendarDiff, calendarRows, lastState } from "./calendar.ts";
import type { Reader } from "../store/log.ts";
import type { CalendarPart, Draft, Event, MessageEvent } from "../types.ts";

const BASE = {
  service: "google" as const,
  connection_address: "ana@example.com",
  conversation: { address: "ana@example.com", kind: "broadcast" as const },
};

/** A log of the drafts given, read the way the store reads: a merge-only patch (no `parts`)
 *  is no row of its own, the predicate runs over every row, the newest `limit` are kept. */
function readerOf(rows: Draft<MessageEvent>[]): Reader["read"] {
  return (q = {}) => {
    const hits = rows.filter((r) => r.parts !== undefined).filter((r) =>
      q.filter?.(r as Event) ?? true
    );
    return Promise.resolve((q.limit ? hits.slice(-q.limit) : hits) as Event[]);
  };
}

Deno.test("a plain field's move is {old,new}; one that appeared or went has one side", () => {
  const was = { data: { gid: "ev1", title: "Natación", start: "2026-08-24T18:00:00Z" } };
  const now = {
    data: { gid: "ev1", title: "Natación", start: "2026-08-24T19:00:00Z", loc: "Club" },
  };
  assertEquals(calendarDiff(was, now), {
    start: { old: "2026-08-24T18:00:00Z", new: "2026-08-24T19:00:00Z" },
    loc: { new: "Club" },
  });
  assertEquals(calendarDiff(now, was), {
    start: { old: "2026-08-24T19:00:00Z", new: "2026-08-24T18:00:00Z" },
    loc: { old: "Club" },
  });
});

Deno.test("an exdate added or removed goes whole under new or old; the ones that stand are silent", () => {
  const was = { data: { gid: "s1", exdates: ["2026-10-03", "2026-10-10"] } };
  const now = { data: { gid: "s1", exdates: ["2026-10-10", "2026-10-17"] } };
  assertEquals(calendarDiff(was, now), {
    exdates: [{ old: "2026-10-03" }, { new: "2026-10-17" }],
  });
});

Deno.test("an invitee that stayed keeps its identity plain and wears the move on what changed; one added or gone goes whole", () => {
  const was = {
    data: {
      gid: "ev1",
      invitees: [
        { email: "luis@example.com", status: "needsAction" as const },
        { name: "Eva", status: "needsAction" as const },
        { email: "bo@example.com", status: "accepted" as const },
      ],
    },
  };
  const now = {
    data: {
      gid: "ev1",
      invitees: [
        { name: "Luis", email: "luis@example.com", status: "accepted" as const },
        { name: "Eva", status: "declined" as const },
        { email: "cy@example.com", status: "needsAction" as const },
      ],
    },
  };
  assertEquals(calendarDiff(was, now), {
    invitees: [
      // the reply, by address; the name the wire learned rides as its own move
      {
        email: "luis@example.com",
        name: { new: "Luis" },
        status: { old: "needsAction", new: "accepted" },
      },
      // no address: the name is the identity, so it stays plain
      { name: "Eva", status: { old: "needsAction", new: "declined" } },
      { new: { email: "cy@example.com", status: "needsAction" } },
      { old: { email: "bo@example.com", status: "accepted" } },
    ],
  });
});

Deno.test("the description's move carries only what it was — the new words are the line's text", () => {
  const was = { data: { gid: "ev1" }, text: "traer antiparras" };
  assertEquals(calendarDiff(was, { data: { gid: "ev1" }, text: "traer toalla" }), {
    text: { old: "traer antiparras" },
  });
  assertEquals(calendarDiff({ data: { gid: "ev1" } }, { data: { gid: "ev1" }, text: "hola" }), {
    text: { old: "" },
  });
  assertEquals(calendarDiff(was, was), undefined);
});

Deno.test("an edit against a known state wears its diff; one that moves nothing mapped is no row; one with no known state is the whole event alone", () => {
  const change = {
    id: "ev1",
    change: "edit" as const,
    ts: "2026-08-24T12:00:00Z",
    data: { gid: "ev1", title: "Natación (movida)" },
  };
  const [row] = calendarRows(BASE, change, { data: { gid: "ev1", title: "Natación" } });
  const part = row.parts[0] as CalendarPart;
  assertEquals(part.diff, { title: { old: "Natación", new: "Natación (movida)" } });
  assertEquals(part.data, { gid: "ev1", title: "Natación (movida)" });
  assertEquals(
    calendarRows(BASE, change, { data: { gid: "ev1", title: "Natación (movida)" } }),
    [],
  );
  const [alone] = calendarRows(BASE, change);
  assertEquals((alone.parts[0] as CalendarPart).diff, undefined);
});

Deno.test("the last state is the event's latest create or edit row in its calendar — a delete's handle is no state, and no row is no state", async () => {
  const create = calendarRows(BASE, {
    id: "ev1",
    change: "create",
    ts: "2026-08-24T10:00:00Z",
    data: { gid: "ev1", title: "Natación" },
    text: "traer antiparras",
  });
  const edit = calendarRows(BASE, {
    id: "ev1",
    change: "edit",
    ts: "2026-08-24T12:00:00Z",
    data: { gid: "ev1", title: "Natación (movida)" },
  });
  const gone = calendarRows(BASE, { id: "ev1", change: "delete", ts: "2026-08-24T13:00:00Z" });
  const read = readerOf([...create, ...edit, ...gone]);
  assertEquals(await lastState(read, BASE, "ev1"), {
    data: { gid: "ev1", title: "Natación (movida)" },
  });
  assertEquals(await lastState(readerOf(create), BASE, "ev1"), {
    data: { gid: "ev1", title: "Natación" },
    text: "traer antiparras",
  });
  assertEquals(await lastState(read, BASE, "ev2"), undefined);
});
