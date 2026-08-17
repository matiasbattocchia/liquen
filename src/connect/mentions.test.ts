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

Deno.test("mentions: logDirectory — the conversation's senders, freshest fact wins", async () => {
  const rows = [
    { sender: { address: "111", name: "Vieja" } },
    { sender: { address: "222" } },
    { sender: { address: "111", name: "Nueva" } }, // renamed — newest name wins
  ].map((e, i) => ({
    id: `e${i}`,
    ts: `2026-08-0${i + 1}T00:00:00Z`,
    type: "message",
    envelope: { service: "whatsapp", conversation: { address: "g1" }, ...e },
    parts: [],
  } as unknown as Event));
  const dir = logDirectory((q) => {
    assertEquals(q.conversation, "g1");
    return Promise.resolve(rows);
  });
  assertEquals(await dir("whatsapp", "g1"), [
    { address: "111", name: "Nueva" },
    { address: "222" },
  ]);
});
