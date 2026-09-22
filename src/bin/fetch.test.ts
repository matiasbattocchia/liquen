import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseArgs, present, render, run } from "./fetch.ts";

/** A fetch stub answering one canned response, recording what it was asked. */
function fake(status: number, body: string, headers: Record<string, string> = {}) {
  const seen: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init);
    seen.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: init?.body === undefined ? null : await req.text(),
    });
    return new Response(body, { status, headers });
  }) as typeof fetch;
  return { impl, seen };
}

/** `run` with stdout captured: what the shim prints is the whole of what the model sees. */
async function captured(
  argv: string[],
  impl: typeof fetch,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const code = await run(argv, impl);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

Deno.test("parseArgs: curl's flags, aread's numbers, -d implies POST", () => {
  const a = parseArgs(["-H", "Authorization: Bearer x", "-d", "{}", "https://h/p", "10", "500"]);
  assertEquals(a.method, "POST");
  assertEquals(a.headers, [["Authorization", "Bearer x"]]);
  assertEquals(a.limit, 10);
  assertEquals(a.maxBytes, 500);
  assertEquals(parseArgs(["https://h/"]).method, "GET");
  assertEquals(parseArgs(["-X", "delete", "https://h/"]).method, "DELETE");
  for (
    const bad of [[], ["nota url"], ["-H", "novalue", "https://h/"], ["https://h/", "x"], [
      "-Z",
      "https://h/",
    ]]
  ) {
    let threw = false;
    try {
      parseArgs(bad);
    } catch {
      threw = true;
    }
    assert(threw, `should refuse ${JSON.stringify(bad)}`);
  }
});

Deno.test("present: JSON pretty when it parses, verbatim otherwise", () => {
  assertEquals(present('{"a":1}', "application/json"), '{\n  "a": 1\n}');
  assertEquals(present("not json", "application/json"), "not json");
  assertEquals(present('{"a":1}', "text/plain"), '{"a":1}');
});

Deno.test("render: an empty body says the status; bytes are named, not dumped", () => {
  const args = parseArgs(["https://h/x"]);
  const empty = { status: 204, headers: new Headers(), bytes: new Uint8Array() };
  assertEquals(render(args, empty), "[HTTP 204 — no body]");
  const png = {
    status: 200,
    headers: new Headers({ "content-type": "image/png" }),
    bytes: new Uint8Array(3),
  };
  assertStringIncludes(
    render(args, png),
    "[image/png · 3 bytes — save it: fetch -o <path> https://h/x]",
  );
});

Deno.test("render: head truncation carries the footer; -i puts the status and headers first", () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const args = parseArgs(["https://h/x", "5"]);
  const out = render(args, {
    status: 200,
    headers: new Headers({ "content-type": "text/plain" }),
    bytes: new TextEncoder().encode(body),
  });
  assert(out.startsWith("line 1\nline 2\nline 3\nline 4\nline 5\n\n[showing lines 1-5 of 50"));
  assertStringIncludes(out, "fetch -o <path> https://h/x, then aread <path>]");
  const withHead = render(parseArgs(["-i", "https://h/x"]), {
    status: 200,
    headers: new Headers({ "content-type": "text/plain" }),
    bytes: new TextEncoder().encode("hi"),
  });
  assertEquals(withHead, "HTTP 200\ncontent-type: text/plain\n\nhi");
});

Deno.test("run: 2xx prints the body and exits 0; a JSON body gets a JSON content-type", async () => {
  const { impl, seen } = fake(200, '{"ok":true}', { "content-type": "application/json" });
  const { code, out } = await captured(["-d", '{"a":1}', "https://h/api"], impl);
  assertEquals(code, 0);
  assertEquals(out, '{\n  "ok": true\n}');
  assertEquals(seen[0].method, "POST");
  assertEquals(seen[0].body, '{"a":1}');
  assertEquals(seen[0].headers.get("content-type"), "application/json");
});

Deno.test("run: a status outside 2xx is a failure carrying the body", async () => {
  const { impl } = fake(500, "boom", { "content-type": "text/plain" });
  const { code, out } = await captured(["https://h/api"], impl);
  assertEquals(code, 1);
  assertEquals(out, "HTTP 500\nboom");
});

Deno.test("run: -o saves the whole body and says so; a transport failure is one sentence", async () => {
  const dir = await Deno.makeTempDir();
  const big = "x".repeat(200_000);
  const { impl } = fake(200, big, { "content-type": "text/plain" });
  const { code, out } = await captured(["-o", `${dir}/deep/out.txt`, "https://h/big"], impl);
  assertEquals(code, 0);
  assertEquals(out, `saved 200000 bytes to ${dir}/deep/out.txt (HTTP 200)`);
  assertEquals((await Deno.readTextFile(`${dir}/deep/out.txt`)).length, 200_000);

  const down = (() => {
    throw new Error("cannot reach h — connection refused");
  }) as unknown as typeof fetch;
  const errs: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    assertEquals((await captured(["https://h/"], down)).code, 1);
  } finally {
    console.error = error;
  }
  assertEquals(errs, ["cannot reach h — connection refused"]);
  await Deno.remove(dir, { recursive: true });
});
