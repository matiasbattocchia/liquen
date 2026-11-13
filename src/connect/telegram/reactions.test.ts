import { assertEquals } from "@std/assert";
import { reactionDiff, reactionId, SETTLE_MS, standingOn } from "./reactions.ts";
import { SELF, SOL } from "./testing.ts";
import type { Event } from "../../types.ts";
import type { ReadQuery } from "../../store/log.ts";
import { newId } from "../../store/id.ts";

const TARGET = "telegram:700100.41";
const CHAT = { address: "700200", kind: "direct" as const, name: "Sol Ruiz" };
const NOW = "2026-11-13T16:00:00.000Z";

function row(
  over: {
    by?: string;
    emoji: string;
    action: "add" | "remove";
    ext?: string;
    ts?: string;
    ref?: string;
  },
): Event {
  return {
    id: newId(),
    ts: over.ts ?? "2026-11-13T15:00:00.000Z",
    type: "message",
    payload: { action: over.action, ref_external_id: over.ref ?? TARGET },
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "700200" },
      ...(over.by ? { sender: { address: over.by } } : {}),
      ...(over.ext ? { external_id: over.ext } : {}),
    },
    parts: [{ type: "data", kind: "reaction", data: { name: over.emoji, unicode: over.emoji } }],
  } as Event;
}

const reader = (rows: Event[]) => (q?: ReadQuery) =>
  Promise.resolve(rows.filter((e) => !q?.filter || q.filter(e)));

Deno.test("telegram reactions: an add's id carries its time, so a glyph put back is a new line", () => {
  assertEquals(
    reactionId("700100", "700200", 41, "700200", "👍", "2026-11-13T15:05:00.000Z"),
    "telegram:700100.41.react.700200.👍.1794582300",
  );
  assertEquals(
    reactionId("700100", "-1009000", 41, "700200", "👍", "2026-11-13T15:05:00.000Z"),
    "telegram:700100.-1009000.41.react.700200.👍.1794582300",
  );
});

Deno.test("telegram reactions: what stands is each add not followed by its remove, the account's own unsigned", async () => {
  const standing = await standingOn(
    reader([
      row({ by: "700200", emoji: "👍", action: "add" }),
      row({ by: "700200", emoji: "👍", action: "remove" }),
      row({ by: "700200", emoji: "❤️", action: "add" }),
      row({ emoji: "🔥", action: "add" }), // the agent's send before its stamp lands
      row({ by: "700200", emoji: "😂", action: "add", ref: "telegram:700100.40" }),
    ]),
    "700100",
    "700200",
    TARGET,
  );
  assertEquals([...standing.keys()], ["700200 ❤️", "700100 🔥"]);
});

Deno.test("telegram reactions: a new glyph is an add from its person, at its time", () => {
  const drafts = reactionDiff({
    account: SELF,
    chat: CHAT,
    id: 41,
    set: [{ by: SOL, emoji: "👍", date: "2026-11-13T15:05:00.000Z" }],
    standing: new Map(),
    now: NOW,
  });
  assertEquals(drafts, [{
    ts: "2026-11-13T15:05:00.000Z",
    type: "message",
    payload: { action: "add", ref_external_id: TARGET },
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: CHAT,
      sender: { address: "700200", name: "Sol Ruiz" },
      external_id: "telegram:700100.41.react.700200.👍.1794582300",
    },
    parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
  }]);
});

Deno.test("telegram reactions: a set that still holds a glyph changes nothing; one that dropped it removes it", async () => {
  const added = row({
    by: "700200",
    emoji: "👍",
    action: "add",
    ext: "telegram:700100.41.react.700200.👍.1794582300",
  });
  const standing = await standingOn(reader([added]), "700100", "700200", TARGET);
  const same = reactionDiff({
    account: SELF,
    chat: CHAT,
    id: 41,
    set: [{ by: SOL, emoji: "👍", date: "2026-11-13T15:05:00.000Z" }],
    standing,
    now: NOW,
  });
  assertEquals(same, []);
  const [gone] = reactionDiff({ account: SELF, chat: CHAT, id: 41, set: [], standing, now: NOW });
  assertEquals(gone.payload, { action: "remove", ref_external_id: TARGET });
  assertEquals(gone.envelope.external_id, "telegram:700100.41.react.700200.👍.1794582300.removed");
  assertEquals(gone.envelope.sender, { address: "700200" });
  assertEquals(gone.ts, NOW);
});

Deno.test("telegram reactions: the account's own reaction is its own line, and a fresh one is not taken back", async () => {
  const [mine] = reactionDiff({
    account: SELF,
    chat: CHAT,
    id: 41,
    set: [{ by: SELF, emoji: "🔥", date: "2026-11-13T15:05:00.000Z" }],
    standing: new Map(),
    now: NOW,
  });
  assertEquals(mine.envelope.sender, { address: "700100", name: "Ana Paz" });

  const fresh = row({
    emoji: "👍",
    action: "add",
    ts: new Date(Date.parse(NOW) - SETTLE_MS / 2).toISOString(),
  });
  const standing = await standingOn(reader([fresh]), "700100", "700200", TARGET);
  assertEquals(
    reactionDiff({ account: SELF, chat: CHAT, id: 41, set: [], standing, now: NOW }),
    [],
  );
});

Deno.test("telegram reactions: a custom emoji is named, with no glyph to show", () => {
  const [d] = reactionDiff({
    account: SELF,
    chat: CHAT,
    id: 41,
    set: [{ by: SOL, emoji: "custom:5368324170671202286", date: NOW }],
    standing: new Map(),
    now: NOW,
  });
  assertEquals(d.parts, [{
    type: "data",
    kind: "reaction",
    data: { name: "custom:5368324170671202286" },
  }]);
});
