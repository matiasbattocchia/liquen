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

Deno.test("toSlack: the three control characters escape everywhere, code included", () => {
  assertEquals(toSlack("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assertEquals(toSlack("`x < y`"), "`x &lt; y`");
});

Deno.test("toSlack: a link with `&` in its url escapes inside the angle form", () => {
  assertEquals(
    toSlack("[docs](https://a.io/p?x=1&y=2)"),
    "<https://a.io/p?x=1&amp;y=2|docs>",
  );
});

Deno.test("fromSlack: entities unescape after the link forms are consumed", () => {
  assertEquals(fromSlack("a &lt; b &amp; c"), "a < b & c");
  // a literal `<foo>` in a message is text, never a wire form — it survives the round trip
  assertEquals(fromSlack(toSlack("<foo> and <https://a.io>")), "<foo> and <https://a.io>");
  assertEquals(
    fromSlack("&lt;https://a.io|docs&gt; <https://a.io|docs>"),
    "<https://a.io|docs> [docs](https://a.io)",
  );
});
