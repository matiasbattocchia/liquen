import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { openCredentials } from "./store/credentials.ts";
import { fileStorage } from "./store/storage.ts";
import {
  BOX,
  CODE_TRIES,
  createPages,
  LOGIN_COOKIE,
  loginValue,
  type Page,
  pagesSecret,
  type Party,
  readPage,
  sweepPages,
  VIEW_MS,
  viewKey,
  writePage,
} from "./pages.ts";

const BASE = "https://acme.example.com";
const ANA = "5491100000001";
const BRUNO = "5491100000002";
const STRANGER = "5491100000009";
const ANAS: Party = { address: ANA, connection: "5491199999999", kind: "direct" };
const OPS: Party = {
  address: "120363000000000001@g.us",
  connection: "5491188888888",
  kind: "group",
  name: "Ops",
};

async function bed(opts: { roster?: () => Promise<string[]> } = {}) {
  const root = await Deno.makeTempDir();
  const creds = await openCredentials(`${root}/data`);
  const storage = fileStorage(`${root}/data`);
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const sent: { from: string; phone: string; text: string }[] = [];
  const said: string[] = [];
  const handler = createPages({
    creds,
    storage,
    secure: () => true,
    roster: opts.roster ?? (() => Promise.resolve([ANA, BRUNO])),
    send: (from, phone, text) => {
      sent.push({ from: from.connection, phone, text });
      return Promise.resolve();
    },
    say: (line) => said.push(line),
    now: () => clock,
  });
  const files = new Map<string, Uint8Array>([
    ["index.html", new TextEncoder().encode("<title>Plan</title><script src=app.js></script>")],
    ["app.js", new TextEncoder().encode("console.log(1)")],
  ]);
  const publish = async (page: Partial<Page> & { id: string }) => {
    const full: Page = {
      agentId: "",
      folder: `shared/${page.id}`,
      with: [ANAS],
      tokens: {},
      title: "Plan",
      files: {
        "index.html": { mime: "text/html; charset=utf-8", size: 1 },
        "app.js": { mime: "text/javascript; charset=utf-8", size: 1 },
      },
      created: clock,
      until: clock + 30 * 24 * 3_600_000,
      ...page,
    };
    await writePage(creds, storage, full, files);
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

Deno.test("pages: a direct chat's link logs its person in once, by a button, and the box serves the files closed in", async () => {
  const b = await bed();
  try {
    await b.publish({ id: "p1", tokens: { [ANA]: "tok" } });
    const button = await b.ask("/pages/p1?t=tok");
    assertEquals(button.status, 200);
    assertStringIncludes(await button.text(), 'name="t" value="tok"');
    // the fetch spent nothing: the token is still there
    assertEquals((await readPage(b.creds, "p1"))?.tokens, { [ANA]: "tok" });

    const enter = await b.post("/pages/p1", { t: "tok" });
    assertEquals(enter.status, 303);
    const cookie = enter.headers.get("set-cookie")!;
    assertStringIncludes(cookie, `${LOGIN_COOKIE}=${ANA}.`);
    assertStringIncludes(cookie, "HttpOnly; SameSite=Lax; Secure");
    assertStringIncludes(cookie, "Path=/pages");
    const box = enter.headers.get("location")!;
    assert(box.startsWith("/pages/p1/") && box.endsWith("/"));
    assertEquals((await readPage(b.creds, "p1"))?.tokens, {});

    const index = await b.ask(box);
    assertEquals(index.status, 200);
    assertEquals(index.headers.get("content-type"), "text/html; charset=utf-8");
    for (const [h, v] of Object.entries(BOX)) assertEquals(index.headers.get(h), v);
    assertStringIncludes(await index.text(), "<title>Plan</title>");
    assertEquals(await (await b.ask(`${box}app.js`)).text(), "console.log(1)");
    const missing = await b.ask(`${box}other.js`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    // spent: the same link falls back to the number
    const again = await b.post("/pages/p1", { t: "tok" });
    assertEquals(again.status, 400);
    assertStringIncludes(await again.text(), "used already");

    // the login opens the door straight into the box
    const back = await b.ask("/pages/p1", { headers: { cookie: cookieOf(enter) } });
    assertEquals(back.status, 303);
    assert(back.headers.get("location")!.startsWith("/pages/p1/"));
    assert(b.said.some((l) => l.includes("p1 opened by …0001")));
  } finally {
    await b.close();
  }
});

Deno.test("pages: a view key opens one page for a while, and a forged or stale one goes back to the door", async () => {
  const b = await bed();
  try {
    await b.publish({ id: "p1" });
    await b.publish({ id: "p2" });
    const secret = await pagesSecret(b.creds);
    const key = await viewKey(secret, "p1", b.now() + VIEW_MS);
    assertEquals((await b.ask(`/pages/p1/${key}/`)).status, 200);
    const other = await b.ask(`/pages/p2/${key}/`);
    assertEquals(other.status, 303);
    assertEquals(other.headers.get("location"), "/pages/p2");
    assertEquals((await b.ask(`/pages/p1/${key.split(".")[0]}.AAAA/`)).status, 303);
    b.tick(VIEW_MS + 1);
    assertEquals((await b.ask(`/pages/p1/${key}/`)).status, 303);
  } finally {
    await b.close();
  }
});

Deno.test("pages: a group's member gets a code by DM, a stranger gets the same answer and nothing is sent", async () => {
  const b = await bed();
  try {
    await b.publish({ id: "g1", with: [OPS] });
    const form = await b.ask("/pages/g1");
    assertEquals(form.status, 200);
    assertStringIncludes(await form.text(), "the people of Ops");

    const stranger = await b.post("/pages/g1", { phone: `+${STRANGER}` });
    const member = await b.post("/pages/g1", { phone: "+54 9 11 0000-0002" });
    assertEquals(stranger.status, 200);
    assertEquals(member.status, 200);
    const said = (t: string) => t.replace(/value="[^"]*"/g, "");
    assertEquals(said(await stranger.text()), said(await member.text()));
    assertEquals(b.sent.map((s) => s.phone), [BRUNO]);
    const code = /^(\d{6}) is your code to open "Plan"/.exec(b.sent[0].text)![1];

    const wrong = await b.post("/pages/g1", {
      phone: BRUNO,
      code: code === "000000" ? "111111" : "000000",
    });
    assertEquals(wrong.status, 400);
    assertStringIncludes(await wrong.text(), "not the one sent");
    const right = await b.post("/pages/g1", { phone: BRUNO, code });
    assertEquals(right.status, 303);
    assertStringIncludes(right.headers.get("set-cookie")!, `${LOGIN_COOKIE}=${BRUNO}.`);
    // a code is good once
    assertEquals((await b.post("/pages/g1", { phone: BRUNO, code })).status, 400);
  } finally {
    await b.close();
  }
});

Deno.test("pages: a page for a chat and a group admits both, each code from the account of the conversation that admits the number", async () => {
  const b = await bed({ roster: () => Promise.resolve([BRUNO]) });
  try {
    await b.publish({ id: "m1", with: [ANAS, OPS], tokens: { [ANA]: "tok" } });
    assertStringIncludes(await (await b.ask("/pages/m1")).text(), "the people it was shared with");
    await b.post("/pages/m1", { phone: ANA });
    await b.post("/pages/m1", { phone: BRUNO });
    await b.post("/pages/m1", { phone: STRANGER });
    assertEquals(b.sent.map((s) => [s.phone, s.from]), [
      [ANA, ANAS.connection],
      [BRUNO, OPS.connection],
    ]);
    const enter = await b.post("/pages/m1", { t: "tok" });
    assertStringIncludes(enter.headers.get("set-cookie")!, `${LOGIN_COOKIE}=${ANA}.`);
    assertEquals((await b.post("/pages/m1", { t: "tok" })).status, 400);
  } finally {
    await b.close();
  }
});

Deno.test("pages: a code takes so many tries, and a number gets one a minute and five an hour", async () => {
  const b = await bed();
  try {
    await b.publish({ id: "g1", with: [OPS] });
    await b.post("/pages/g1", { phone: BRUNO });
    await b.post("/pages/g1", { phone: BRUNO });
    assertEquals(b.sent.length, 1);
    const code = b.sent[0].text.slice(0, 6);
    const bad = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < CODE_TRIES; i++) await b.post("/pages/g1", { phone: BRUNO, code: bad });
    const out = await b.post("/pages/g1", { phone: BRUNO, code: bad });
    assertStringIncludes(await out.text(), "Too many tries");
    assertEquals((await b.post("/pages/g1", { phone: BRUNO, code })).status, 400);

    for (let i = 0; i < 6; i++) {
      b.tick(61_000);
      await b.post("/pages/g1", { phone: BRUNO });
    }
    assertEquals(b.sent.length, 5);
  } finally {
    await b.close();
  }
});

Deno.test("pages: a login opens a group's page only while its number is on the roster", async () => {
  let roster = [ANA, BRUNO];
  const b = await bed({ roster: () => Promise.resolve(roster) });
  try {
    await b.publish({ id: "g1", with: [OPS] });
    const secret = await pagesSecret(b.creds);
    const cookie = `${LOGIN_COOKIE}=${await loginValue(secret, BRUNO, b.now() + 3_600_000)}`;
    assertEquals((await b.ask("/pages/g1", { headers: { cookie } })).status, 303);
    roster = [ANA];
    const out = await b.ask("/pages/g1", { headers: { cookie } });
    assertEquals(out.status, 200);
    assertStringIncludes(await out.text(), "WhatsApp number");
    // a forged login is no login
    const forged = `${LOGIN_COOKIE}=${ANA}.${(b.now() + 3_600_000).toString(36)}.AAAA`;
    assertEquals((await b.ask("/pages/g1", { headers: { cookie: forged } })).status, 200);
  } finally {
    await b.close();
  }
});

Deno.test("pages: a roster that can't be read says to try again, and a page past its days is gone", async () => {
  const b = await bed({ roster: () => Promise.reject(new Error("bridge down")) });
  try {
    await b.publish({ id: "g1", with: [OPS] });
    const later = await b.post("/pages/g1", { phone: BRUNO });
    assertEquals(later.status, 503);
    assertEquals(b.sent.length, 0);
    assertEquals((await b.ask("/pages/nope")).status, 404);
    b.tick(31 * 24 * 3_600_000);
    assertEquals((await b.ask("/pages/g1")).status, 404);
  } finally {
    await b.close();
  }
});

Deno.test("sweepPages: a page past its days goes with its files, and so do the files of a row gone", async () => {
  const b = await bed();
  try {
    await b.publish({ id: "old", until: b.now() - 1 });
    await b.publish({ id: "new" });
    await b.storage.put("pages/orphan/index.html", new Uint8Array([1]), "text/html");
    assertEquals(await sweepPages(b.creds, b.storage, b.now()), 1);
    assertEquals(await readPage(b.creds, "old"), null);
    assert(await readPage(b.creds, "new"));
    const keys = (await Array.fromAsync(b.storage.keys("pages/"))).map((k) => k.key).sort();
    assertEquals(keys, ["pages/new/app.js", "pages/new/index.html"]);
  } finally {
    await b.close();
  }
});
