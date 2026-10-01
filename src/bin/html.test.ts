import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decode, htmlToText } from "./html.ts";

const BASE = "https://example.com/guide/page";

Deno.test("htmlToText: title and description head the text; blocks are paragraphs", () => {
  const out = htmlToText(
    `<!doctype html><html><head><title>Docs &amp; Things</title>
    <meta name="description" content="All about things."></head>
    <body><h1>Hello <code>world</code></h1><p>One
    two.<p>Line<br>break.<div>After</div></body></html>`,
  );
  assertEquals(
    out,
    "# Docs & Things\n\nAll about things.\n\n# Hello `world`\n\nOne two.\n\nLine\nbreak.\n\nAfter",
  );
});

Deno.test("htmlToText: links and images resolve against the page; anchors read as text", () => {
  const out = htmlToText(
    `<p><a href="/docs/x?a=1&b=2">a link</a>, <a href="#top">top</a>, ` +
      `<a href="javascript:void 0">menu</a>, <img src="d.png" alt="A diagram">` +
      `<img src="data:image/png;base64,AAAA" alt="inline"><img src="x.png"></p>`,
    BASE,
  );
  assertEquals(
    out,
    "[a link](https://example.com/docs/x?a=1&b=2), top, menu, " +
      "![A diagram](https://example.com/guide/d.png)![inline]",
  );
});

Deno.test("htmlToText: lists nest under their item, ordered ones count from start", () => {
  const out = htmlToText(
    `<ul><li>one<li>two<ul><li>nested a<li>nested b</ul><li>three</ul><ol start=3><li>c<li>d</ol>`,
  );
  assertEquals(out, "- one\n- two\n  - nested a\n  - nested b\n- three\n\n3. c\n4. d");
});

Deno.test("htmlToText: pre keeps its whitespace in a fence named by its language", () => {
  const out = htmlToText(
    `<p>Run it:</p><pre class="language-ts"><code>const x = 1;
  if (x) {
    go();
  }</code></pre>`,
  );
  assertEquals(
    out,
    "Run it:\n\n```ts\nconst x = 1;\n  if (x) {\n    go();\n  }\n```",
  );
});

Deno.test("htmlToText: a data table is rows; a table of tables reads as blocks", () => {
  assertEquals(
    htmlToText(`<table><tr><th>Name<th>Value<tr><td>a|b<td>1<tr><td>c<td>2</table>`),
    "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c | 2 |",
  );
  assertEquals(
    htmlToText(
      `<table><tr><td>Header</td></tr><tr><td><table><tr><td>x<td>y</table></td></tr></table>`,
    ),
    "Header\n\n| x | y |",
  );
});

Deno.test("htmlToText: a quote is prefixed line by line", () => {
  assertEquals(
    htmlToText(`<blockquote><p>Quoted</p><p>twice</p></blockquote>`),
    "> Quoted\n>\n> twice",
  );
});

Deno.test("htmlToText: code, styles, svg and hidden elements are dropped; noscript reads", () => {
  const out = htmlToText(
    `<head><script>window.secret = 1</script><style>p{color:red}</style></head>
    <body><svg><title>icon</title><path d="M0"/></svg><p>Shown<script>track()</script> on.
    <div hidden>secret</div><div style="display: none">nope</div>
    <div hidden="until-found">findable</div>
    <select><option>Argentina<option>Chile</select>
    <noscript>You need to enable JavaScript to run this app.</noscript></body>`,
  );
  assertEquals(out, "Shown on.\n\nfindable\n\nYou need to enable JavaScript to run this app.");
});

Deno.test("htmlToText: data scripts follow the text, pretty, under their opening tag", () => {
  const out = htmlToText(
    `<head><title>App</title>
    <script type="application/ld+json">{"@type":"Article","name":"Things"}</script></head>
    <body><div id="root"></div>
    <div hidden><script type="application/json" id="__NEXT_DATA__">{"props":{"title":"Real"}}</script></div>
    <script type="importmap">{"imports":{}}</script>
    <script type="application/json">not json</script></body>`,
  );
  assertEquals(
    out,
    [
      "# App",
      '<script type="application/ld+json">\n{\n  "@type": "Article",\n  "name": "Things"\n}\n</script>',
      '<script type="application/json" id="__NEXT_DATA__">\n{\n  "props": {\n    "title": "Real"\n  }\n}\n</script>',
      '<script type="application/json">\nnot json\n</script>',
    ].join("\n\n"),
  );
});

Deno.test("htmlToText: an unclosed head ends where the body begins", () => {
  assertEquals(htmlToText(`<head><title>T</title><body><p>Body`), "# T\n\nBody");
  assertEquals(htmlToText(`<head><title>T</title><div>Body</div>`), "# T\n\nBody");
});

Deno.test("htmlToText: tags thousands deep flatten instead of overflowing", () => {
  const out = htmlToText("<div>".repeat(20_000) + "deep");
  assertEquals(out, "deep");
});

Deno.test("htmlToText: a self-closing slash counts only where it cannot be a URL's", () => {
  assertEquals(
    htmlToText(`<p><a href=/docs/>Docs</a> and <span/>more</p>`, BASE),
    "[Docs](https://example.com/docs/) and more",
  );
});

Deno.test("decode: numeric and common named references; unknown names stay", () => {
  assertEquals(decode("&lt;b&gt; &#65;&#x42; &mdash; &hellip;"), "<b> AB — …");
  assertEquals(decode("?a=1&b=2&copy2"), "?a=1&b=2&copy2");
  assert(!decode("a&nbsp;b").includes("&"));
  assertStringIncludes(decode("&rsquo;"), "’");
});
