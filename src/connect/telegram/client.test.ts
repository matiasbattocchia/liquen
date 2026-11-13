import { assert, assertEquals } from "@std/assert";
import { Long, type tl } from "@mtcute/deno";
import { glyphOf, whole } from "./client.ts";

const said = (userId: number, emoticon: string): tl.RawMessagePeerReaction => ({
  _: "messagePeerReaction",
  peerId: { _: "peerUser", userId },
  date: 1794582300,
  reaction: { _: "reactionEmoji", emoticon },
});

const counted = (emoticon: string, count: number): tl.RawReactionCount => ({
  _: "reactionCount",
  reaction: { _: "reactionEmoji", emoticon },
  count,
});

Deno.test("telegram client: a glyph is the emoji, a custom one its id, and Stars none", () => {
  assertEquals(glyphOf({ _: "reactionEmoji", emoticon: "👍" }), "👍");
  assertEquals(
    glyphOf({ _: "reactionCustomEmoji", documentId: Long.fromString("5368324170671202286") }),
    "custom:5368324170671202286",
  );
  assertEquals(glyphOf({ _: "reactionPaid" }), undefined);
});

Deno.test("telegram client: a set is whole when it names everyone its counts count, Stars aside", () => {
  const base = { _: "messageReactions" as const };
  assert(
    whole({
      ...base,
      results: [counted("👍", 2)],
      recentReactions: [said(1, "👍"), said(2, "👍")],
    }),
  );
  assert(whole({ ...base, results: [], recentReactions: [] }));
  assert(
    whole({
      ...base,
      results: [counted("👍", 1), {
        _: "reactionCount",
        reaction: { _: "reactionPaid" },
        count: 50,
      }],
      recentReactions: [said(1, "👍")],
    }),
  );
  // a larger room names only the latest few
  assert(!whole({ ...base, results: [counted("👍", 40)], recentReactions: [said(1, "👍")] }));
  // a stub of the set is never whole
  assert(
    !whole({ ...base, min: true, results: [counted("👍", 1)], recentReactions: [said(1, "👍")] }),
  );
});
