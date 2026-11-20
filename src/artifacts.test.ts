import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { openCredentials } from "./store/credentials.ts";
import { fileStorage } from "./store/storage.ts";
import {
  type Artifact,
  artifactsSecret,
  BOX,
  CODE_TRIES,
  createArtifacts,
  hashOf,
  LOGIN_COOKIE,
  loginValue,
  type Party,
  readArtifact,
  removeArtifact,
  slugOf,
  sweepArtifacts,
  VIEW_MS,
  viewer,
  viewKey,
  VISITOR_HEADER,
  writeArtifact,
} from "./artifacts.ts";

const BASE = "https://acme.example.com";
const ANA = "5491100000001";
const BRUNO = "5491100000002";
const MATI = "5491100000003";
const STRANGER = "5491100000009";
const ANAS: Party = { address: ANA, connection: "5491199999999", kind: "direct" };
const OPS: Party = {
  address: "120363000000000001@g.us",
  connection: "5491188888888",
  kind: "group",
  name: "Ops",
};
const enc = (s: string) => new TextEncoder().encode(s);

async function bed(opts: { roster?: () => Promise<string[]> } = {}) {
  const root = await Deno.makeTempDir();
  const creds = await openCredentials(`${root}/data`);
  const storage = fileStorage(`${root}/data`);
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const sent: { from: string; phone: string; text: string }[] = [];
  const said: string[] = [];
  const handler = createArtifacts({
    creds,
    storage,
    secure: () => true,
    socket: (a) => `${root}/${a.slug}.sock`,
    roster: opts.roster ?? (() => Promise.resolve([ANA, BRUNO])),
    send: (from, phone, text) => {
      sent.push({ from: from.connection, phone, text });
      return Promise.resolve();
    },
    say: (line) => said.push(line),
    now: () => clock,
  });
  const shown = { "index.html": "<title>Plan</title><script src=app.js></script>", "app.js": "1" };
  const publish = async (
    a: Partial<Artifact> & { slug: string },
    files: Record<string, string> = shown,
  ) => {
    const bytes = new Map(Object.entries(files).map(([p, s]) => [p, enc(s)]));
    const listed: Artifact["files"] = {};
    for (const [p, b] of bytes) {
      listed[p] = {
        mime: p.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        size: b.length,
        hash: await hashOf(b),
      };
    }
    const full: Artifact = {
      id: `id-${a.slug}`,
      agentId: "",
      folder: `shared/${a.slug}`,
      with: [ANAS],
      tokens: {},
      title: "Plan",
      files: listed,
      created: clock,
      until: clock + 30 * 24 * 3_600_000,
      ...a,
    };
    await writeArtifact(creds, storage, full, bytes);
    return full;
  };
  const ask = (path: string, init: RequestInit = {}) =>
    handler(new Request(`${BASE}${path}`, init));
  const post = (path: string, fields: Record<string, string>, cookie?: string) =>
    ask(path, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
    });
  return {
    root,
    creds,
    storage,
    sent,
    said,
    publish,
    ask,
    post,
    tick: (ms: number) => clock += ms,
    now: () => clock,
    async close() {
      await creds.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

Deno.test("slugOf: a title's words, lowercase and plain, cut at a word", () => {
  assertEquals(slugOf("Buscador de Referencias"), "buscador-de-referencias");
  assertEquals(slugOf("  Lucas c/ la Jurisprudencia! "), "lucas-c-la-jurisprudencia");
  assertEquals(slugOf("Año ñandú — été"), "ano-nandu-ete");
  assertEquals(slugOf("¿?"), "artifact");
  const long = slugOf("the quick brown fox jumps over the lazy dog and keeps on running far away");
  assert(long.length <= 48 && !long.endsWith("-"));
  assertEquals(long, "the-quick-brown-fox-jumps-over-the-lazy-dog-and");
});

Deno.test("artifacts: a direct chat's link logs its person in once, by a button, and the box serves the files closed in", async () => {
  const b = await bed();
  try {
    await b.publish({ slug: "plan", tokens: { [ANA]: "tok" } });
    const button = await b.ask("/artifacts/plan?t=tok");
    assertEquals(button.status, 200);
    assertStringIncludes(await button.text(), 'name="t" value="tok"');
    // the fetch spent nothing: the token is still there
    assertEquals((await readArtifact(b.creds, "plan"))?.tokens, { [ANA]: "tok" });

    const enter = await b.post("/artifacts/plan", { t: "tok" });
    assertEquals(enter.status, 303);
    const cookie = enter.headers.get("set-cookie")!;
    assertStringIncludes(cookie, `${LOGIN_COOKIE}=${ANA}.`);
    assertStringIncludes(cookie, "HttpOnly; SameSite=Lax; Secure");
    assertStringIncludes(cookie, "Path=/artifacts");
    const box = enter.headers.get("location")!;
    assert(box.startsWith(`/artifacts/plan/${ANA}.`) && box.endsWith("/"));
    assertEquals((await readArtifact(b.creds, "plan"))?.tokens, {});

    const index = await b.ask(box);
    assertEquals(index.status, 200);
    assertEquals(index.headers.get("content-type"), "text/html; charset=utf-8");
    for (const [h, v] of Object.entries(BOX)) assertEquals(index.headers.get(h), v);
    assertStringIncludes(await index.text(), "<title>Plan</title>");
    assertEquals(await (await b.ask(`${box}app.js`)).text(), "1");
    const missing = await b.ask(`${box}other.js`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    // spent: the same link falls back to the number
    const again = await b.post("/artifacts/plan", { t: "tok" });
    assertEquals(again.status, 400);
    assertStringIncludes(await again.text(), "used already");

    // the login opens the door straight into the box
    const back = await b.ask("/artifacts/plan", { headers: { cookie: cookieOf(enter) } });
    assertEquals(back.status, 303);
    assert(back.headers.get("location")!.startsWith("/artifacts/plan/"));
    assert(b.said.some((l) => l.includes("plan opened by …0001")));
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a view key names its phone and opens one artifact for a while; a forged, stale or older one goes back to the door", async () => {
  const b = await bed();
  try {
    const one = await b.publish({ slug: "p1" });
    await b.publish({ slug: "p2" });
    const secret = await artifactsSecret(b.creds);
    const key = await viewKey(secret, one.id, ANA, b.now() + VIEW_MS);
    assertEquals(await viewer(secret, one.id, key, b.now()), ANA);
    assertEquals((await b.ask(`/artifacts/p1/${key}/`)).status, 200);
    const other = await b.ask(`/artifacts/p2/${key}/`);
    assertEquals(other.status, 303);
    assertEquals(other.headers.get("location"), "/artifacts/p2");
    // another phone under the same mac is no key
    assertEquals((await b.ask(`/artifacts/p1/${key.replace(ANA, BRUNO)}/`)).status, 303);
    assertEquals(
      (await b.ask(`/artifacts/p1/${key.split(".").slice(0, 2).join(".")}.AAAA/`)).status,
      303,
    );
    // the slug taken again after a cancel: the old artifact's keys open nothing
    await removeArtifact(b.creds, b.storage, one);
    await b.publish({ slug: "p1", id: "id-again" });
    assertEquals((await b.ask(`/artifacts/p1/${key}/`)).status, 303);
    const fresh = await viewKey(secret, "id-again", ANA, b.now() + VIEW_MS);
    assertEquals((await b.ask(`/artifacts/p1/${fresh}/`)).status, 200);
    b.tick(VIEW_MS + 1);
    assertEquals((await b.ask(`/artifacts/p1/${fresh}/`)).status, 303);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a group's member gets a code by DM, a stranger gets the same answer and nothing is sent", async () => {
  const b = await bed();
  try {
    await b.publish({ slug: "g1", with: [OPS] });
    const form = await b.ask("/artifacts/g1");
    assertEquals(form.status, 200);
    assertStringIncludes(await form.text(), "the people of Ops");

    const stranger = await b.post("/artifacts/g1", { phone: `+${STRANGER}` });
    const member = await b.post("/artifacts/g1", { phone: "+54 9 11 0000-0002" });
    assertEquals(stranger.status, 200);
    assertEquals(member.status, 200);
    const said = (t: string) => t.replace(/value="[^"]*"/g, "");
    assertEquals(said(await stranger.text()), said(await member.text()));
    assertEquals(b.sent.map((s) => s.phone), [BRUNO]);
    const code = /^(\d{6}) is your code to open "Plan"/.exec(b.sent[0].text)![1];

    const wrong = await b.post("/artifacts/g1", {
      phone: BRUNO,
      code: code === "000000" ? "111111" : "000000",
    });
    assertEquals(wrong.status, 400);
    assertStringIncludes(await wrong.text(), "not the one sent");
    const right = await b.post("/artifacts/g1", { phone: BRUNO, code });
    assertEquals(right.status, 303);
    assertStringIncludes(right.headers.get("set-cookie")!, `${LOGIN_COOKIE}=${BRUNO}.`);
    // a code is good once
    assertEquals((await b.post("/artifacts/g1", { phone: BRUNO, code })).status, 400);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: one for a chat and a group admits both, each code from the account of the conversation that admits the number", async () => {
  const b = await bed({ roster: () => Promise.resolve([BRUNO]) });
  try {
    await b.publish({ slug: "m1", with: [ANAS, OPS], tokens: { [ANA]: "tok" } });
    assertStringIncludes(
      await (await b.ask("/artifacts/m1")).text(),
      "the people it was shared with",
    );
    await b.post("/artifacts/m1", { phone: ANA });
    await b.post("/artifacts/m1", { phone: BRUNO });
    await b.post("/artifacts/m1", { phone: STRANGER });
    assertEquals(b.sent.map((s) => [s.phone, s.from]), [
      [ANA, ANAS.connection],
      [BRUNO, OPS.connection],
    ]);
    const enter = await b.post("/artifacts/m1", { t: "tok" });
    assertStringIncludes(enter.headers.get("set-cookie")!, `${LOGIN_COOKIE}=${ANA}.`);
    assertEquals((await b.post("/artifacts/m1", { t: "tok" })).status, 400);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a principal opens by their link and their login; a code reaches them only from an account that is not their own", async () => {
  const b = await bed();
  try {
    const own: Party = { address: MATI, connection: "", kind: "principal", name: "Mati" };
    await b.publish({ slug: "mine", with: [ANAS, own], tokens: { [MATI]: "mt" } });
    // no account but their own reaches them: the same answer, and nothing sent
    await b.post("/artifacts/mine", { phone: MATI });
    assertEquals(b.sent, []);
    const enter = await b.post("/artifacts/mine", { t: "mt" });
    assertEquals(enter.status, 303);
    assertStringIncludes(enter.headers.get("set-cookie")!, `${LOGIN_COOKIE}=${MATI}.`);
    assertEquals(
      (await b.ask("/artifacts/mine", { headers: { cookie: cookieOf(enter) } })).status,
      303,
    );

    await b.publish({ slug: "via", with: [{ ...own, connection: ANAS.connection }] });
    await b.post("/artifacts/via", { phone: MATI });
    assertEquals(b.sent.map((s) => [s.phone, s.from]), [[MATI, ANAS.connection]]);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a code takes so many tries, and a number gets one a minute and five an hour", async () => {
  const b = await bed();
  try {
    await b.publish({ slug: "g1", with: [OPS] });
    await b.post("/artifacts/g1", { phone: BRUNO });
    await b.post("/artifacts/g1", { phone: BRUNO });
    assertEquals(b.sent.length, 1);
    const code = b.sent[0].text.slice(0, 6);
    const bad = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < CODE_TRIES; i++) await b.post("/artifacts/g1", { phone: BRUNO, code: bad });
    const out = await b.post("/artifacts/g1", { phone: BRUNO, code: bad });
    assertStringIncludes(await out.text(), "Too many tries");
    assertEquals((await b.post("/artifacts/g1", { phone: BRUNO, code })).status, 400);

    for (let i = 0; i < 6; i++) {
      b.tick(61_000);
      await b.post("/artifacts/g1", { phone: BRUNO });
    }
    assertEquals(b.sent.length, 5);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a login opens a group's artifact only while its number is on the roster", async () => {
  let roster = [ANA, BRUNO];
  const b = await bed({ roster: () => Promise.resolve(roster) });
  try {
    await b.publish({ slug: "g1", with: [OPS] });
    const secret = await artifactsSecret(b.creds);
    const cookie = `${LOGIN_COOKIE}=${await loginValue(secret, BRUNO, b.now() + 3_600_000)}`;
    assertEquals((await b.ask("/artifacts/g1", { headers: { cookie } })).status, 303);
    roster = [ANA];
    const out = await b.ask("/artifacts/g1", { headers: { cookie } });
    assertEquals(out.status, 200);
    assertStringIncludes(await out.text(), "WhatsApp number");
    // a forged login is no login
    const forged = `${LOGIN_COOKIE}=${ANA}.${(b.now() + 3_600_000).toString(36)}.AAAA`;
    assertEquals((await b.ask("/artifacts/g1", { headers: { cookie: forged } })).status, 200);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: a roster that can't be read says to try again, and one past its days is gone", async () => {
  const b = await bed({ roster: () => Promise.reject(new Error("bridge down")) });
  try {
    await b.publish({ slug: "g1", with: [OPS] });
    const later = await b.post("/artifacts/g1", { phone: BRUNO });
    assertEquals(later.status, 503);
    assertEquals(b.sent.length, 0);
    assertEquals((await b.ask("/artifacts/nope")).status, 404);
    b.tick(31 * 24 * 3_600_000);
    assertEquals((await b.ask("/artifacts/g1")).status, 404);
  } finally {
    await b.close();
  }
});

Deno.test("artifacts: an app's files come from the store, and anything else goes to its server as the visitor's, closed in the box", async () => {
  const b = await bed();
  const seen: {
    url: string;
    method: string;
    visitor: string | null;
    cookie: string | null;
    body: string;
  }[] = [];
  const sock = `${b.root}/app.sock`;
  const server = Deno.serve({ path: sock, onListen: () => {} }, async (req) => {
    seen.push({
      url: req.url,
      method: req.method,
      visitor: req.headers.get(VISITOR_HEADER),
      cookie: req.headers.get("cookie"),
      body: await req.text(),
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": "s=1",
        "content-security-policy": "default-src *",
      },
    });
  });
  try {
    const a = await b.publish({ slug: "app", server: { hosts: [], native: false } });
    const secret = await artifactsSecret(b.creds);
    const box = `/artifacts/app/${await viewKey(secret, a.id, ANA, b.now() + VIEW_MS)}`;
    assertStringIncludes(await (await b.ask(`${box}/`)).text(), "<title>Plan</title>");
    const api = await b.ask(`${box}/api/buscar?q=da%C3%B1o`, {
      headers: { cookie: `${LOGIN_COOKIE}=x`, [VISITOR_HEADER]: STRANGER },
    });
    assertEquals(api.status, 200);
    assertEquals(await api.json(), { ok: true });
    assertEquals(api.headers.get("set-cookie"), null);
    for (const [h, v] of Object.entries(BOX)) assertEquals(api.headers.get(h), v);
    const posted = await b.ask(`${box}/api/notes`, { method: "POST", body: "hola" });
    assertEquals(posted.status, 200);
    await posted.body?.cancel();
    assertEquals(
      seen.map((
        s,
      ) => [
        new URL(s.url).pathname + new URL(s.url).search,
        s.method,
        s.visitor,
        s.cookie,
        s.body,
      ]),
      [
        ["/api/buscar?q=da%C3%B1o", "GET", ANA, null, ""],
        ["/api/notes", "POST", ANA, null, "hola"],
      ],
    );
  } finally {
    await server.shutdown();
    await b.close();
  }
});

Deno.test("artifacts: a server not running, or a link where its socket should be, is a 502 that reaches nothing", async () => {
  const b = await bed();
  const target = `${b.root}/main.sock`;
  let reached = false;
  const main = Deno.serve({ path: target, onListen: () => {} }, () => {
    reached = true;
    return new Response("main");
  });
  try {
    const a = await b.publish({ slug: "api", server: { hosts: [], native: false } }, {});
    const secret = await artifactsSecret(b.creds);
    const box = `/artifacts/api/${await viewKey(secret, a.id, ANA, b.now() + VIEW_MS)}/`;
    const down = await b.ask(box);
    assertEquals(down.status, 502);
    assertStringIncludes(await down.text(), "not running");
    await Deno.symlink(target, `${b.root}/api.sock`);
    const linked = await b.ask(box);
    assertEquals(linked.status, 502);
    await linked.body?.cancel();
    await Deno.remove(`${b.root}/api.sock`);
    await Deno.link(target, `${b.root}/api.sock`);
    const hard = await b.ask(box);
    assertEquals(hard.status, 502);
    await hard.body?.cancel();
    assertEquals(reached, false);
  } finally {
    await main.shutdown();
    await b.close();
  }
});

Deno.test("artifacts: a page without a server answers no method but reading", async () => {
  const b = await bed();
  try {
    const a = await b.publish({ slug: "page" });
    const secret = await artifactsSecret(b.creds);
    const box = `/artifacts/page/${await viewKey(secret, a.id, ANA, b.now() + VIEW_MS)}/`;
    const res = await b.ask(box, { method: "POST", body: "x" });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  } finally {
    await b.close();
  }
});

Deno.test("writeArtifact and sweepArtifacts: a changed file is kept anew and the old one let go; one past its days goes with its files, and so do files no artifact holds", async () => {
  const b = await bed();
  try {
    const first = await b.publish({ slug: "live" });
    const oldKey = `artifacts/${first.id}/${first.files["app.js"].hash}`;
    const again = await b.publish({ slug: "live" }, {
      "index.html": "<title>Plan</title>",
      "app.js": "2",
    });
    const secret = await artifactsSecret(b.creds);
    const box = `/artifacts/live/${await viewKey(secret, again.id, ANA, b.now() + VIEW_MS)}/`;
    assertEquals(await (await b.ask(`${box}app.js`)).text(), "2");
    assertEquals(await b.storage.get(oldKey), null);

    await b.publish({ slug: "old", until: b.now() - 1 });
    await b.storage.put("artifacts/orphan/abc", new Uint8Array([1]), "text/html");
    assertEquals(await sweepArtifacts(b.creds, b.storage, b.now()), 1);
    assertEquals(await readArtifact(b.creds, "old"), null);
    assert(await readArtifact(b.creds, "live"));
    const keys = (await Array.fromAsync(b.storage.keys("artifacts/"))).map((k) => k.key).sort();
    assertEquals(
      keys,
      Object.values(again.files).map((f) => `artifacts/${again.id}/${f.hash}`).sort(),
    );
  } finally {
    await b.close();
  }
});
