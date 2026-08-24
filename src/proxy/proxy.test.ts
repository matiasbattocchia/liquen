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
    const proxy = startProxy({
      ca,
      broker: fakeBroker(),
      audit: () => {},
      // stand in for Google: capture what actually arrived after TLS termination
      originFetch: (input, init) => {
        originAuth = headersOf(input, init).get("authorization");
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    });
    try {
      // a client that trusts ONLY the mu CA (what SSL_CERT_FILE does for the child), dialing
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
      client.close();
    } finally {
      await proxy.shutdown();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
