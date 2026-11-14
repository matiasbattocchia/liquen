import { assertEquals } from "@std/assert";
import { chatOf, externalId, messageIdOf, topicAddress } from "./wire.ts";

Deno.test("telegram wire: a topic's address names its supergroup and the topic", () => {
  assertEquals(topicAddress("-1009000", 45), "-1009000/45");
  assertEquals(chatOf("-1009000/45"), { chat: "-1009000", topic: 45 });
  assertEquals(chatOf("-1009000"), { chat: "-1009000" });
  assertEquals(chatOf("700200"), { chat: "700200" });
  assertEquals(chatOf("@solruiz"), { chat: "@solruiz" });
});

Deno.test("telegram wire: a topic's line is keyed by its supergroup's numbering", () => {
  assertEquals(externalId("700100", "-1009000/45", 77), "telegram:700100.-1009000.77");
  assertEquals(externalId("700100", "-1009000", 77), "telegram:700100.-1009000.77");
  assertEquals(externalId("700100", "700200", 77), "telegram:700100.77");
  assertEquals(messageIdOf(externalId("700100", "-1009000/45", 77)), 77);
});
