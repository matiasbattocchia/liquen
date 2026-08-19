import { assertEquals } from "@std/assert";
import { fromSlack, toSlack, toWhatsApp } from "./flavor.ts";

Deno.test("toWhatsApp: only links translate — everything else WhatsApp reads natively", () => {
  assertEquals(
    toWhatsApp("**bold** *it* ~~s~~ `code` and [docs](https://a.io/p?x=1)"),
    "**bold** *it* ~~s~~ `code` and docs (https://a.io/p?x=1)",
  );
});

Deno.test("toWhatsApp: a link inside code is content, not formatting", () => {
  const text =
    "run `curl [x](https://a.io)` and see [x](https://a.io)\n```\n[y](https://b.io)\n```";
  assertEquals(
    toWhatsApp(text),
    "run `curl [x](https://a.io)` and see x (https://a.io)\n```\n[y](https://b.io)\n```",
  );
});

Deno.test("toSlack: common markdown → mrkdwn", () => {
  assertEquals(
    toSlack("# Title\n**bold** ~~gone~~ [docs](https://a.io) `**raw**`"),
    "*Title*\n*bold* ~gone~ <https://a.io|docs> `**raw**`",
  );
});

Deno.test("fromSlack: mrkdwn → common markdown, meaning kept (a Slack single star IS bold)", () => {
  assertEquals(
    fromSlack("*bold* ~gone~ <https://a.io|docs> <https://b.io> `*raw*`"),
    "**bold** ~~gone~~ [docs](https://a.io) https://b.io `*raw*`",
  );
});
