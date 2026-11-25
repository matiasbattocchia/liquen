import { assertEquals } from "@std/assert";
import { encodeSlackText, whatsappMentions } from "./mentions.ts";

const SAID = [
  { address: "5492605550108", name: "Euge" },
  { address: "5492615550110", name: "Ana María" },
  { address: "U0BKTGTB65C", name: "matias" },
];

Deno.test("mentions: encodeSlackText — the line's mentions → <@id>, specials, bare ids; rest literal", () => {
  assertEquals(
    encodeSlackText("@matias mirá esto con @here", SAID),
    "<@U0BKTGTB65C> mirá esto con <!here>",
  );
  assertEquals(encodeSlackText("ping @U0AAAAAAAA9", []), "ping <@U0AAAAAAAA9>");
  assertEquals(encodeSlackText("hola @Nadie", SAID), "hola @Nadie");
});

Deno.test("mentions: whatsappMentions — the ones this text writes, each once", () => {
  assertEquals(whatsappMentions("@Euge y @Euge, nada más", SAID), [
    { address: "5492605550108", name: "Euge" },
  ]);
});

Deno.test("mentions: #channel and bare channel ids encode on Slack; WhatsApp skips channels", () => {
  const said = [...SAID, { address: "C061EG9T25", name: "general", type: "#" as const }];
  assertEquals(
    encodeSlackText("avisen en #general o #C0AAAAAAAA1, gracias @matias", said),
    "avisen en <#C061EG9T25> o <#C0AAAAAAAA1>, gracias <@U0BKTGTB65C>",
  );
  assertEquals(encodeSlackText("nada que ver: #hashtag", said), "nada que ver: #hashtag");
  assertEquals(whatsappMentions("mirá #general @Euge", said), [
    { address: "5492605550108", name: "Euge" },
  ]);
});

Deno.test("mentions: a sigil inside a word is not a mention — emails keep their @", () => {
  assertEquals(
    encodeSlackText("write to foo@here.com or bob@channel.io", SAID),
    "write to foo@here.com or bob@channel.io",
  );
  assertEquals(encodeSlackText("cc ana@U0AAAAAAAA9 please", []), "cc ana@U0AAAAAAAA9 please");
});

Deno.test("mentions: an uppercase word is a name, not an id — unless the line names its address", () => {
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
