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

Deno.test("proxyRequest: the broker judges the path the origin is sent — dot segments resolved", async () => {
  const asked: (string | undefined)[] = [];
  const sent: string[] = [];
  await proxyRequest(
    "api.turtle.xyz",
    new Request("https://api.turtle.xyz/organization/42/sonar/../../7/sonar/events?limit=1", {
      headers: { authorization: "Bearer mu-grant-x" },
    }),
    {
      ca: {} as never,
      broker: fakeBroker({
        accessTokenFor: (_h, _host, path) => {
          asked.push(path);
          return Promise.resolve("ya29.REAL");
        },
      }),
      audit: () => {},
      originFetch: (url) => {
        sent.push(String(url));
        return Promise.resolve(new Response("", { status: 200 }));
      },
    },
  );
  // the binding sees /organization/7/…, as the origin will: a prefix check on the raw
  // target would have passed it as the 42's
  assertEquals(asked, ["/organization/7/sonar/events"]);
  assertEquals(sent, ["https://api.turtle.xyz/organization/7/sonar/events?limit=1"]);
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
    const ca = await openCA(dir);
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
    const ca = await openCA(dir);
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
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
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
    await Deno.remove(dir, { recursive: true });
  }
});

// The bug this rule exists for: `fetch` hands back a DECODED body but headers that
// describe the ENCODED entity. Copying them through truncates every reader at the
// compressed length — which is how a 170 KB Google discovery document reached an agent
// as 23 KB of valid-prefix JSON and broke `gws` with a parse error.
Deno.test("proxyRequest: the answer is identity — no encoding headers survive a decoded body", async () => {
  const body = JSON.stringify({ padding: "x".repeat(50_000) }); // what fetch DECODED
  let sentAcceptEncoding: string | null = "unset";
  const res = await proxyRequest(
    "www.googleapis.com",
    new Request("https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest", {
      // a client that negotiates for itself: fetch would decode for ITS terms, not these
      headers: { "accept-encoding": "gzip, deflate, br" },
    }),
    {
      ca: null as never,
      broker: fakeBroker(),
      audit: () => {},
      originFetch: (input, init) => {
        sentAcceptEncoding = headersOf(input, init).get("accept-encoding");
        return Promise.resolve(
          new Response(body, {
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip", // true of the wire, false of `body`
              "content-length": "22828", // the compressed count — a reader would stop here
            },
          }),
        );
      },
    },
  );

  // the client's own negotiation never reaches the origin: fetch asks for what it decodes
  assertEquals(sentAcceptEncoding, null);
  assertEquals(res.headers.get("content-encoding"), null);
  assertEquals(res.headers.get("content-length"), null);
  assertEquals(res.headers.get("content-type"), "application/json"); // the rest rides through
  // and the whole body arrives, not the first 22828 bytes of it
  const got = await res.text();
  assertEquals(got.length, body.length);
  assertEquals(JSON.parse(got).padding.length, 50_000);
});

/** Send a CONNECT down `conn` and read the answer's head and body. */
async function connect(conn: Deno.Conn, authority: string): Promise<string> {
  await conn.write(new TextEncoder().encode(`CONNECT ${authority} HTTP/1.1\r\n\r\n`));
  const buf = new Uint8Array(1024);
  const n = await conn.read(buf);
  return new TextDecoder().decode(buf.subarray(0, n ?? 0));
}

Deno.test("startProxy: a dial that fails is answered 502, and the answer says why", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const seen: EgressAudit[] = [];
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (closed.addr as Deno.NetAddr).port;
  closed.close();
  const proxy = startProxy({
    ca,
    broker: fakeBroker(),
    audit: (a) => seen.push(a),
    terminates: () => false,
  });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    const answer = await connect(conn, `127.0.0.1:${port}`);
    assert(answer.startsWith(`HTTP/1.1 502 127.0.0.1:${port} did not answer\r\n`), answer);
    conn.close();
    assertEquals(seen.map((a) => [a.host, a.status]), [[`127.0.0.1:${port}`, 502]]);
  } finally {
    await proxy.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

/** A plain-HTTP origin on loopback that answers each request with `name`, the path it was
 *  asked and the Authorization it was sent. */
function plainOrigin(name: string) {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) =>
      new Response(
        `${name} ${new URL(req.url).pathname} ${req.headers.get("authorization") ?? "-"}`,
      ),
  );
  return { server, authority: `127.0.0.1:${server.addr.port}` };
}

/** Read off `conn` until what arrived holds `want`. */
async function readUntil(conn: Deno.Conn, want: string): Promise<string> {
  const buf = new Uint8Array(4096);
  let got = "";
  while (!got.includes(want)) {
    const n = await conn.read(buf);
    if (n === null) break;
    got += new TextDecoder().decode(buf.subarray(0, n));
  }
  return got;
}

Deno.test("startProxy: a plain-HTTP request to a fronted local service is swapped", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const seen: EgressAudit[] = [];
  const origin = plainOrigin("api");
  const proxy = startProxy({
    ca,
    broker: fakeBroker(),
    audit: (a) => seen.push(a),
    plain: (authority) => authority === origin.authority,
  });
  const client = Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${proxy.port}` } });
  try {
    const res = await fetch(`http://${origin.authority}/organization/1/deals`, {
      client,
      headers: { authorization: "Bearer mu-grant-x" },
    });
    assertEquals(await res.text(), "api /organization/1/deals Bearer ya29.REAL");
    assertEquals(seen.map((a) => [a.method, a.host, a.path, a.status, a.swapped]), [
      ["GET", origin.authority, "/organization/1/deals", 200, true],
    ]);
  } finally {
    client.close();
    await proxy.shutdown();
    await origin.server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("proxyRequest: a credential never rides plain HTTP to a host named without its port", async () => {
  let dialed = 0;
  const seen: EgressAudit[] = [];
  const deps = {
    ca: null as never,
    broker: fakeBroker(),
    audit: (a: EgressAudit) => seen.push(a),
    plain: (authority: string) => authority === "localhost:8080",
    originFetch: () => {
      dialed++;
      return Promise.resolve(new Response("ok"));
    },
  };
  const req = (url: string) =>
    new Request(url, { headers: { authorization: "Bearer mu-grant-x" } });
  const clear = await proxyRequest("www.googleapis.com", req("http://www.googleapis.com/x"), deps);
  assertEquals(clear.status, 403);
  assertEquals(dialed, 0);
  // the same request over TLS, and one to the host named with its port, are spent
  const tls = await proxyRequest("www.googleapis.com", req("https://www.googleapis.com/x"), deps);
  const local = await proxyRequest("localhost:8080", req("http://localhost:8080/x"), deps);
  assertEquals([tls.status, local.status, dialed], [200, 200, 2]);
  // a plain request carrying no credential goes anywhere
  const none = await proxyRequest("example.com", new Request("http://example.com/"), deps);
  assertEquals([none.status, dialed], [200, 3]);
  assertEquals(seen.map((a) => [a.host, a.status, a.swapped]), [
    ["www.googleapis.com", 403, false],
    ["www.googleapis.com", 200, true],
    ["localhost:8080", 200, true],
    ["example.com", 200, false],
  ]);
});

Deno.test("startProxy: one plain-HTTP connection carries requests to two origins", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const one = plainOrigin("one");
  const two = plainOrigin("two");
  const proxy = startProxy({ ca, broker: fakeBroker(), audit: () => {} });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    const ask = (authority: string) =>
      conn.write(
        new TextEncoder().encode(
          `GET http://${authority}/x HTTP/1.1\r\nhost: ${authority}\r\n` +
            "proxy-connection: keep-alive\r\n\r\n",
        ),
      );
    await ask(one.authority);
    assert((await readUntil(conn, "one /x -")).includes("HTTP/1.1 200"));
    await ask(two.authority);
    assert((await readUntil(conn, "two /x -")).includes("HTTP/1.1 200"));
    conn.close();
  } finally {
    await proxy.shutdown();
    await one.server.shutdown();
    await two.server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: a plain-HTTP upgrade is bridged to its origin, in origin form", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  // the origin: reads the upgrade's head, switches, then echoes
  const origin = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const authority = `127.0.0.1:${(origin.addr as Deno.NetAddr).port}`;
  let head = "";
  const switching = (async () => {
    const c = await origin.accept();
    head = await readUntil(c, "\r\n\r\n");
    await c.write(
      new TextEncoder().encode(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
      ),
    );
    await c.readable.pipeTo(c.writable).catch(() => {});
  })();
  const seen: EgressAudit[] = [];
  const proxy = startProxy({ ca, broker: fakeBroker(), audit: (a) => seen.push(a) });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await conn.write(
      new TextEncoder().encode(
        `GET http://${authority}/hmr?t=1 HTTP/1.1\r\nhost: ${authority}\r\n` +
          "connection: Upgrade\r\nupgrade: websocket\r\nproxy-connection: keep-alive\r\n\r\n",
      ),
    );
    assert((await readUntil(conn, "\r\n\r\n")).startsWith("HTTP/1.1 101"));
    await conn.write(new TextEncoder().encode("ping"));
    assertEquals(await readUntil(conn, "ping"), "ping");
    assert(head.startsWith("GET /hmr?t=1 HTTP/1.1\r\n"), head);
    assert(!/proxy-connection/i.test(head), head);
    assertEquals(seen.map((a) => [a.method, a.host, a.path, a.status]), [
      ["GET", authority, "/hmr", 101],
    ]);
    conn.close();
  } finally {
    await proxy.shutdown();
    origin.close();
    await switching.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: a plain-HTTP request that names no origin is answered 400", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const proxy = startProxy({ ca, broker: fakeBroker(), audit: () => {} });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await conn.write(new TextEncoder().encode("GET /x HTTP/1.1\r\nhost: a\r\n\r\n"));
    const answer = await readUntil(conn, "CONNECT host:port");
    assert(answer.startsWith("HTTP/1.1 400"), answer);
    conn.close();
  } finally {
    await proxy.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: a decrypted tunnel carries a body up and every cookie down", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const proxy = startProxy({
    ca,
    broker: fakeBroker(),
    audit: () => {},
    originFetch: async (input, init) => {
      const got = await new Request(String(input), init).text();
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(`got ${got.length}`, { headers });
    },
  });
  try {
    const client = Deno.createHttpClient({
      caCerts: [await Deno.readTextFile(ca.caPath)],
      proxy: { url: `http://127.0.0.1:${proxy.port}` },
    });
    for (const size of [300_000, 0]) {
      const res = await fetch("https://api.example.com/upload", {
        method: "POST",
        body: "x".repeat(size),
        client,
      });
      assertEquals(res.headers.getSetCookie(), ["a=1", "b=2"]);
      assertEquals(await res.text(), `got ${size}`);
    }
    client.close();
  } finally {
    await proxy.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("startProxy: a decrypted tunnel stays open for the client's next request", async () => {
  const dir = await Deno.makeTempDir();
  const ca = await openCA(dir);
  const proxy = startProxy({
    ca,
    broker: fakeBroker(),
    audit: () => {},
    originFetch: () => Promise.resolve(new Response("ok")),
  });
  try {
    const raw = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    assert((await connect(raw, "api.example.com:443")).startsWith("HTTP/1.1 200"));
    const conn = await Deno.startTls(raw, {
      hostname: "api.example.com",
      caCerts: [await Deno.readTextFile(ca.caPath)],
    });
    // one answer, read to its last chunk; null once the proxy has closed the tunnel
    const answer = async (): Promise<string | null> => {
      const req = "GET /x HTTP/1.1\r\nhost: api.example.com\r\n\r\n";
      await conn.write(new TextEncoder().encode(req));
      const buf = new Uint8Array(4096);
      let text = "";
      while (!text.endsWith("\r\n0\r\n\r\n")) {
        const n = await conn.read(buf).catch(() => null);
        if (n === null) return null;
        text += new TextDecoder().decode(buf.subarray(0, n));
      }
      return text;
    };
    assert((await answer())?.startsWith("HTTP/1.1 200"));
    // the client's next request comes once the first is answered, on the same tunnel
    await new Promise((r) => setTimeout(r, 50));
    const second = await answer();
    assert(second?.startsWith("HTTP/1.1 200"), "the tunnel closed after its first answer");
    conn.close();
  } finally {
    await proxy.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
