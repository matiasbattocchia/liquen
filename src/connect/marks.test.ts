import { assertEquals } from "@std/assert";
import { COUNT_MS, createMarks, type MarkDeps, marked } from "./marks.ts";
import { silenced } from "../render.ts";
import type { Draft, Event, MessageEvent } from "../types.ts";

const KNOBS = { crowd: 20, busy: 40, follow: [] as string[] };

function line(over: {
  members?: number;
  admin?: boolean;
  address?: string;
  extra?: Record<string, unknown>;
  payload?: MessageEvent["payload"];
} = {}): Draft<MessageEvent> {
  return {
    ts: "2026-11-14T12:00:00.000Z",
    type: "message",
    ...(over.payload ? { payload: over.payload } : {}),
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: {
        address: over.address ?? "-4100",
        kind: "group",
        ...(over.members !== undefined ? { members: over.members } : {}),
        ...(over.admin !== undefined ? { admin: over.admin } : {}),
      },
      sender: { address: "700200", name: "Sol" },
      external_id: "telegram:700100.41",
    },
    parts: [{ type: "text", kind: "text", text: "hola" }],
    ...(over.extra ? { extra: over.extra } : {}),
  } as Draft<MessageEvent>;
}

/** A log holding `lines` rows of the day in every room, and the rows `byId` names. */
function harness(lines: number, over: Partial<MarkDeps> = {}, byId: Record<string, Event> = {}) {
  const reads: unknown[] = [];
  const read = ((q: { externalId?: string; limit?: number }) => {
    reads.push(q);
    if (q?.externalId) return Promise.resolve(byId[q.externalId] ? [byId[q.externalId]] : []);
    return Promise.resolve(Array.from({ length: Math.min(lines, q?.limit ?? lines) }, () => ({})));
  }) as unknown as MarkDeps["read"];
  let at = Date.parse("2026-11-14T12:00:00.000Z");
  const marks = createMarks({ read, knobs: KNOBS, now: () => at, ...over });
  return { marks, reads, tick: (ms: number) => (at += ms) };
}

Deno.test("marks: a room is crowded when it is big, busy, and not the account's to run", async () => {
  const { marks } = harness(41);
  const [big] = await marks([line({ members: 21 })]);
  assertEquals(big.extra, { crowded: true });
  // the facts are read and dropped: no part of the row
  assertEquals(big.envelope.conversation, { address: "-4100", kind: "group" });

  const [small] = await marks([line({ members: 20, address: "-4200" })]);
  assertEquals(small.extra, undefined);
  const [mine] = await marks([line({ members: 500, admin: true, address: "-4300" })]);
  assertEquals(mine.extra, undefined);
  // a room that says no size is never counted
  const [unknown] = await marks([line({ address: "-4400" })]);
  assertEquals(unknown.extra, undefined);
});

Deno.test("marks: a big room that is calm is read, and one the connection follows too", async () => {
  const calm = harness(40);
  assertEquals((await calm.marks([line({ members: 300 })]))[0].extra, undefined);
  const followed = harness(400, { knobs: { ...KNOBS, follow: ["-4100"] } });
  assertEquals((await followed.marks([line({ members: 300 })]))[0].extra, undefined);
});

Deno.test("marks: the day's count is read once a minute and carried forward between reads", async () => {
  const { marks, reads, tick } = harness(40);
  // 40 lines stand: the 41st to land finds 40, the next finds 41
  assertEquals((await marks([line({ members: 300 })]))[0].extra, undefined);
  assertEquals((await marks([line({ members: 300 })]))[0].extra, { crowded: true });
  assertEquals(reads.length, 1);
  tick(COUNT_MS);
  await marks([line({ members: 300 })]);
  assertEquals(reads.length, 2);
});

Deno.test("marks: a line for the account lifts muted and crowded, never archived", async () => {
  const mine = {
    envelope: { sender: { address: "700100" } },
  } as unknown as Event;
  const theirs = { envelope: { sender: { address: "700300" } } } as unknown as Event;
  const { marks } = harness(0, {}, { "telegram:700100.7": mine, "telegram:700100.8": theirs });
  const mention = { mentions: [{ address: "700100", name: "Ana" }] };

  const [named] = await marks([line({ extra: { muted: true }, payload: mention })]);
  assertEquals(named.extra, { muted: true, addressed: true });
  assertEquals(silenced(named as unknown as Event), false);

  const [reply] = await marks([
    line({ extra: { muted: true }, payload: { ref_external_id: "telegram:700100.7" } }),
  ]);
  assertEquals(reply.extra, { muted: true, addressed: true });

  // a reply to someone else, a reaction to the account's line, and a plain line stay silent
  const [other] = await marks([
    line({ extra: { muted: true }, payload: { ref_external_id: "telegram:700100.8" } }),
  ]);
  assertEquals(other.extra, { muted: true });
  const [reaction] = await marks([
    line({
      extra: { muted: true },
      payload: { action: "add", ref_external_id: "telegram:700100.7" },
    }),
  ]);
  assertEquals(reaction.extra, { muted: true });
  assertEquals(silenced(reaction as unknown as Event), true);

  const [archived] = await marks([line({ extra: { archived: true }, payload: mention })]);
  assertEquals(archived.extra, { archived: true });
  assertEquals(silenced(archived as unknown as Event), true);
});

Deno.test("marks: a crowded room's line for the account is news; the account's other names count", async () => {
  const { marks } = harness(400, { self: () => ["U0BOT", "T1:B1"] });
  const [named] = await marks([
    line({ members: 300, payload: { mentions: [{ address: "U0BOT" }] } }),
  ]);
  assertEquals(named.extra, { crowded: true, addressed: true });
  assertEquals(silenced(named as unknown as Event), false);
  // an unmarked line is never asked whether it is for the account
  const quiet = harness(0);
  await quiet.marks([line({ payload: { ref_external_id: "telegram:700100.7" } })]);
  assertEquals(quiet.reads.length, 0);
});

Deno.test("marked: one draft or a list, marked before the publish, answered as the publish answers", async () => {
  const { marks } = harness(400);
  const got: unknown[] = [];
  const publish = (one: unknown) => {
    got.push(one);
    return Promise.resolve("answered");
  };
  const wrapped = marked(publish, marks);
  const single = line({ members: 300 });
  assertEquals(await wrapped(single), "answered");
  assertEquals((got[0] as Draft<MessageEvent>).extra, { crowded: true });
  const list = [line({ members: 300 })];
  await wrapped(list);
  assertEquals(got[1], list);
  assertEquals(list[0].extra, { crowded: true });
});
