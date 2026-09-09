import { assert, assertEquals } from "@std/assert";
import { type EgressAudit, proxyRequest, startProxy } from "./proxy.ts";
import { openCA } from "./ca.ts";
import type { GrantBroker } from "./grants.ts";

/** A broker stub: one handle → one canned token. */
function fakeBroker(over: Partial<GrantBroker> = {}): GrantBroker {
  return {
    issue: () => "mu-grant-x",
    resolve: (h) => (h === "mu-grant-x" ? { credentialKey: "google:ana", agentId: "ana" } : null),
    accessTokenFor: (h) => Promise.resolve(h === "mu-grant-x" ? "ya29.REAL" : null),
    ...over,
  };
}

/** Read the headers off an origin call the way proxyRequest makes it (string url + init). */
function headersOf(input: string | URL | Request, init?: RequestInit): Headers {
  return new Request(String(input), init).headers;
}

Deno.test("proxyRequest: swaps the placeholder for the real token, drops hop-by-hop + host", async () => {
  const seen: { url: string; auth: string | null; host: string | null } = {
    url: "",
    auth: null,
    host: null,
  };
  const audits: EgressAudit[] = [];
  const res = await proxyRequest(
    "www.googleapis.com",
    new Request("https://www.googleapis.com/calendar/v3/x?a=1", {
      headers: {
        authorization: "Bearer mu-grant-x",
        host: "stale",
        connection: "keep-alive",
        "x-keep": "yes",
      },
    }),
    {
      ca: {} as never,
      broker: fakeBroker(),
      audit: (a) => audits.push(a),
      originFetch: (input, init) => {
        const h = headersOf(input, init);
        seen.url = String(input);
        seen.auth = h.get("authorization");
        seen.host = h.get("host");
        assertEquals(h.get("connection"), null); // hop-by-hop gone
        assertEquals(h.get("x-keep"), "yes"); // ordinary header kept
        return Promise.resolve(new Response("ok", { status: 200 }));
      },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(seen.url, "https://www.googleapis.com/calendar/v3/x?a=1"); // rebuilt from host+path
  assertEquals(seen.auth, "Bearer ya29.REAL"); // the swap
  assertEquals(seen.host, null); // the stale tunnel host is dropped; fetch sets its own
  assertEquals(audits[0], {
    method: "GET",
    host: "www.googleapis.com",
    path: "/calendar/v3/x",
    status: 200,
    agentId: "ana",
    swapped: true,
  });
});

Deno.test("proxyRequest: an unhonorable placeholder 401s here — it never leaves the box", async () => {
  let originCalled = false;
  const res = await proxyRequest(
    "www.googleapis.com",
    new Request("https://www.googleapis.com/x", {
      headers: { authorization: "Bearer mu-grant-x" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker({ accessTokenFor: () => Promise.resolve(null) }),
      originFetch: () => {
        originCalled = true;
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  assertEquals(res.status, 401);
  assert(!originCalled, "the request must not be re-originated with a dead placeholder");
});

Deno.test("proxyRequest: gh's `token` scheme swaps too — and keeps its scheme", async () => {
  let sentAuth: string | null = null;
  const audits: EgressAudit[] = [];
  await proxyRequest(
    "api.github.com",
    new Request("https://api.github.com/repos/a/b/issues", {
      headers: { authorization: "token mu-grant-x" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker(),
      audit: (a) => audits.push(a),
      originFetch: (input, init) => {
        sentAuth = headersOf(input, init).get("authorization");
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  assertEquals(sentAuth, "token ya29.REAL"); // gh insists on `token`; the swap respects it
  assertEquals(audits[0].swapped, true);
});

Deno.test("proxyRequest: the handle is the marker, not the header — any value substitutes in place", async () => {
  const sent: Record<string, string | null> = {};
  await proxyRequest(
    "api.example.com",
    new Request("https://api.example.com/v1", {
      headers: { "x-api-key": "mu-grant-x", "x-auth": "key=mu-grant-x;v=1" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker(),
      audit: () => {},
      originFetch: (input, init) => {
        const h = headersOf(input, init);
        sent.key = h.get("x-api-key");
        sent.combo = h.get("x-auth");
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  assertEquals(sent.key, "ya29.REAL"); // a custom tool's own header, no proxy change needed
  assertEquals(sent.combo, "key=ya29.REAL;v=1"); // the surroundings survive the substitution
});

Deno.test("proxyRequest: the grant's host binding refuses the swap — the origin is never dialed", async () => {
  const asked: (string | undefined)[] = [];
  let originCalled = false;
  const res = await proxyRequest(
    "httpbin.org",
    new Request("https://httpbin.org/headers", {
      headers: { authorization: "Bearer mu-grant-x" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker({
        // the real broker's hostAllowed, in miniature: this grant spends only toward github
        accessTokenFor: (_h, host) => {
          asked.push(host);
          return Promise.resolve(host === "api.github.com" ? "ya29.REAL" : null);
        },
      }),
      audit: () => {},
      originFetch: () => {
        originCalled = true;
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  assertEquals(res.status, 401);
  assertEquals(asked, ["httpbin.org"]); // the dialed authority reaches the broker's check
  assert(!originCalled, "a refused handle must not leave the box toward the echo endpoint");
});

Deno.test("proxyRequest: a request with no placeholder passes through untouched", async () => {
  let sentAuth: string | null = "unset";
  await proxyRequest(
    "www.googleapis.com",
    new Request("https://www.googleapis.com/x", {
      headers: { authorization: "Bearer real-oauth" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker(),
      originFetch: (input, init) => {
        sentAuth = headersOf(input, init).get("authorization");
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  assertEquals(sentAuth, "Bearer real-oauth"); // not our handle → not our business
});

Deno.test("startProxy: a real TLS tunnel terminates and the swap reaches the origin", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ca = await openCA();
    let originAuth: string | null = null;
    const originUrls: string[] = [];
    const proxy = startProxy({
      ca,
      broker: fakeBroker(),
      audit: () => {},
      // stand in for Google: capture what actually arrived after TLS termination
      originFetch: (input, init) => {
        originAuth = headersOf(input, init).get("authorization");
        originUrls.push(String(input));
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    });
    try {
      // a client that trusts ONLY the liquen CA (what SSL_CERT_FILE does for the child), dialing
      // through the CONNECT proxy — i.e. the whole chain, minus the tool binary
      const caCert = await Deno.readTextFile(ca.caPath);
      const client = Deno.createHttpClient({
        caCerts: [caCert],
        proxy: { url: `http://127.0.0.1:${proxy.port}` },
      });
      const res = await fetch("https://www.googleapis.com/calendar/v3/x", {
        headers: { authorization: "Bearer mu-grant-x" },
        client,
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).ok, true);
      assertEquals(originAuth, "Bearer ya29.REAL"); // the credential was injected at the last hop
      assertEquals(originUrls[0], "https://www.googleapis.com/calendar/v3/x");

      // a non-443 dial keeps its port all the way to the origin
      const odd = await fetch("https://www.googleapis.com:8443/calendar/v3/x", { client });
      assertEquals(odd.status, 200);
      await odd.body?.cancel();
      assertEquals(originUrls[1], "https://www.googleapis.com:8443/calendar/v3/x");
      client.close();
    } finally {
      await proxy.shutdown();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: a tunnel that can't be stood up answers 502 — it never hangs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ca = await openCA();
    const proxy = startProxy({ ca, broker: fakeBroker(), audit: () => {} });
    try {
      // `bad_host` fails the CA's host check, so no leaf can be minted for the tunnel
      const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
      await conn.write(new TextEncoder().encode("CONNECT bad_host:443 HTTP/1.1\r\n\r\n"));
      const buf = new Uint8Array(64);
      const n = await conn.read(buf);
      assert(
        new TextDecoder().decode(buf.subarray(0, n ?? 0)).startsWith("HTTP/1.1 502"),
        "the client must get an answer, not a hang",
      );
      conn.close();
    } finally {
      await proxy.shutdown();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: an authority no grant fronts is tunneled blind — the origin's own bytes", async () => {
  const ca = await openCA();
  // the origin: a plain listener that echoes — blind means it never sees a liquen leaf
  const origin = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const echoing = (async () => {
    for await (const c of origin) {
      c.readable.pipeTo(c.writable).catch(() => {});
    }
  })();
  const originPort = (origin.addr as Deno.NetAddr).port;
  const seen: EgressAudit[] = [];
  const proxy = startProxy({
    ca,
    broker: fakeBroker(),
    audit: (a) => seen.push(a),
    terminates: (authority) => authority === "www.googleapis.com",
  });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await conn.write(
      new TextEncoder().encode(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n\r\n`),
    );
    const buf = new Uint8Array(256);
    let n = await conn.read(buf);
    assert(new TextDecoder().decode(buf.subarray(0, n ?? 0)).startsWith("HTTP/1.1 200"));
    await conn.write(new TextEncoder().encode("hello origin"));
    n = await conn.read(buf);
    assertEquals(new TextDecoder().decode(buf.subarray(0, n ?? 0)), "hello origin");
    conn.close();
    assertEquals(seen.map((a) => [a.method, a.host, a.swapped]), [
      ["CONNECT", `127.0.0.1:${originPort}`, false],
    ]);
  } finally {
    await proxy.shutdown();
    origin.close();
    await echoing.catch(() => {});
  }
});
