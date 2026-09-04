import { assertEquals } from "@std/assert";
import { claimMentions, encodeSlackText, logDirectory, whatsappMentions } from "./mentions.ts";
import type { Event } from "../types.ts";

const DIR = [
  { address: "5492604560911", name: "Euge" },
  { address: "5492612156258", name: "Ana María" },
  { address: "U0BKTGTB65C", name: "matias" },
];

Deno.test("mentions: claims resolve names and bare addresses, longest first", () => {
  const c = claimMentions("che @Euge y @Ana María, avisen a @5492604560911", DIR);
  assertEquals(c.map((x) => [x.address, x.index]), [
    ["5492604560911", 4],
    ["5492612156258", 12],
    ["5492604560911", 33],
  ]);
  // "@Ana María" claimed whole — never half-claimed by a shorter key mid-word
  assertEquals(c[1].length, "@Ana María".length);
});

Deno.test("mentions: unclaimed and mid-word tokens stay unclaimed", () => {
  assertEquals(claimMentions("hola @Desconocido", DIR), []);
  assertEquals(claimMentions("mail: euge@Euges.com", DIR), []); // @Euge continues into a word
});

Deno.test("mentions: encodeSlackText — names → <@id>, specials, bare ids; rest literal", () => {
  assertEquals(
    encodeSlackText("@matias mirá esto con @here", DIR),
    "<@U0BKTGTB65C> mirá esto con <!here>",
  );
  assertEquals(encodeSlackText("ping @U0AAAAAAAA9", []), "ping <@U0AAAAAAAA9>");
  assertEquals(encodeSlackText("hola @Nadie", DIR), "hola @Nadie");
});

Deno.test("mentions: whatsappMentions — claims for the bridge encoder, deduped", () => {
  assertEquals(whatsappMentions("@Euge y @Euge, más @5492612156258", DIR), [
    { address: "5492604560911", name: "Euge" },
    { address: "5492612156258", name: "Ana María" },
  ]);
});

Deno.test("mentions: logDirectory — conversation senders + service-wide channels, freshest wins", async () => {
  const row = (i: number, e: Record<string, unknown>, payload?: Record<string, unknown>) => ({
    id: `e${i}`,
    ts: `2026-08-0${i + 1}T00:00:00Z`,
    type: "message",
    envelope: { service: "slack", conversation: { address: "C1" }, ...e },
    ...(payload ? { payload } : {}),
    parts: [],
  } as unknown as Event);
  const local = [
    row(1, { sender: { address: "111", name: "Vieja" } }),
    row(2, { sender: { address: "222" } }),
    row(3, { sender: { address: "111", name: "Nueva" } }), // renamed — newest name wins
  ];
  const wide = [
    row(4, {}, { mentions: [{ address: "C9", name: "old-name", type: "#" }] }),
    row(5, {}, { mentions: [{ address: "C9", name: "general", type: "#" }, { address: "U5" }] }),
  ];
  const dir = logDirectory((q) => Promise.resolve(q.conversation === "C1" ? local : wide));
  assertEquals(await dir("slack", "C1"), [
    { address: "111", name: "Nueva" },
    { address: "222" },
    { address: "C9", name: "general", type: "#" }, // person entries in payload never join
  ]);
});

Deno.test("mentions: #channel claims and bare channel ids encode; WhatsApp skips them", () => {
  const dir = [...DIR, { address: "C061EG9T25", name: "general", type: "#" as const }];
  assertEquals(
    encodeSlackText("avisen en #general o #C0AAAAAAAA1, gracias @matias", dir),
    "avisen en <#C061EG9T25> o <#C0AAAAAAAA1>, gracias <@U0BKTGTB65C>",
  );
  assertEquals(encodeSlackText("nada que ver: #hashtag", dir), "nada que ver: #hashtag");
  assertEquals(whatsappMentions("mirá #general @Euge", dir), [
    { address: "5492604560911", name: "Euge" },
  ]);
});

Deno.test("mentions: a sigil inside a word is not a mention — emails keep their @", () => {
  assertEquals(
    encodeSlackText("write to foo@here.com or bob@channel.io", DIR),
    "write to foo@here.com or bob@channel.io",
  );
  assertEquals(encodeSlackText("cc ana@U0AAAAAAAA9 please", []), "cc ana@U0AAAAAAAA9 please");
  assertEquals(claimMentions("mail euge@Euge now", DIR), []);
  assertEquals(claimMentions("che @Euge", DIR).length, 1); // the same key at a word start still claims
});

Deno.test("mentions: an uppercase word is a name, not an id — unless the directory knows the address", () => {
  assertEquals(
    encodeSlackText("see @UPDATES123 and #CHANGELOG2024", []),
    "see @UPDATES123 and #CHANGELOG2024",
  );
  assertEquals(
    encodeSlackText("ping @U0AAAAAAAA9 in #C0AAAAAAAA1", []),
    "ping <@U0AAAAAAAA9> in <#C0AAAAAAAA1>",
  );
  assertEquals(
    encodeSlackText("see @UPDATES123", [{ address: "UPDATES123", name: "updates bot" }]),
    "see <@UPDATES123>",
  );
});
