import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openCredentials } from "../store/credentials.ts";
import { fileStorage } from "../store/storage.ts";
import { localFiles } from "../store/media.ts";
import type { Event } from "../types.ts";
import type { Reader } from "../store/log.ts";
import { artifactsPort, type Principal, publishTool } from "./publish.ts";
import { type Artifact, listArtifacts, readArtifact } from "../artifacts.ts";
import { membersAt } from "../testing.ts";

const ACCOUNT = "5491199999999";
const ANA = "5491100000001";
const MATI = "5491100000003";
const GROUP = "120363000000000001@g.us";

const rows = [
  {
    envelope: {
      service: "whatsapp",
      connection_address: ACCOUNT,
      conversation: { address: ANA, kind: "direct" },
      sender: { address: ANA, name: "Ana" },
    },
  },
  {
    envelope: {
      service: "whatsapp",
      connection_address: ACCOUNT,
      conversation: { address: GROUP, kind: "group", name: "Ops" },
      sender: { address: ANA, name: "Ana" },
    },
  },
  {
    envelope: {
      service: "slack",
      connection_address: "T1",
      conversation: { address: "C1", kind: "group", name: "general" },
    },
  },
] as unknown as Event[];

/** A view of the log over `rows`, holding only the addresses `sees`, when given. */
const logOf = (sees?: string[]): Pick<Reader, "read"> => ({
  read: (q = {}) => {
    const fold = (s?: string) => (s ?? "").toLowerCase();
    const out = rows.filter((e) =>
      (!sees || sees.includes(e.envelope.conversation.address)) &&
      (q.conversation === undefined || e.envelope.conversation.address === q.conversation) &&
      (q.conversationName === undefined ||
        fold(e.envelope.conversation.name).includes(fold(q.conversationName))) &&
      (q.senderName === undefined ||
        fold(e.envelope.sender?.name).includes(fold(q.senderName))) &&
      (!q.filter || q.filter(e))
    );
    return Promise.resolve(out.slice(0, q.limit ?? out.length));
  },
});

async function bed() {
  const root = await Deno.makeTempDir();
  const data = `${root}/data`;
  for (const agent of ["cy", "dee"]) {
    await Deno.mkdir(`${data}/agents/${agent}`, { recursive: true });
  }
  const app = `${data}/agents/cy/app`;
  await Deno.mkdir(`${app}/public/lib`, { recursive: true });
  await Deno.mkdir(`${app}/public/.git`, { recursive: true });
  await Deno.writeTextFile(`${app}/public/index.html`, "<title> The plan </title>");
  await Deno.writeTextFile(`${app}/public/lib/chart.js`, "draw()");
  await Deno.writeTextFile(`${app}/public/.env`, "SECRET=1");
  await Deno.writeTextFile(`${app}/public/.git/HEAD`, "ref");
  await Deno.writeTextFile(`${app}/notes.db`, "not shown");
  await Deno.mkdir(`${data}/shared/site/public`, { recursive: true });
  await Deno.writeTextFile(`${data}/shared/site/public/index.html`, "<title>Site</title>");
  await membersAt(data, "cy", "dee");
  const creds = await openCredentials(data);
  const storage = fileStorage(data);
  let publicUrl: string | null = "https://acme.example.com";
  let principals: Principal[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  let failing: string | null = null;
  const servers = {
    start: (a: Artifact) => {
      if (failing) return Promise.reject(new Error(failing));
      started.push(`${a.slug}:${a.server?.hosts.join(",")}:${a.server?.native}`);
      return Promise.resolve();
    },
    stop: (slug: string) => {
      stopped.push(slug);
      return Promise.resolve();
    },
  };
  const now = () => Date.parse("2026-11-16T12:00:00Z");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const edge = () => ({ publicUrl, port: 8787 });
  const tool = (agentId = "cy", sees?: string[]) => {
    const home = `${data}/agents/${agentId}`;
    return publishTool({
      agentId,
      log: logOf(sees),
      files: () =>
        localFiles({ home, roots: [home, `${data}/shared`], shared: `${data}/shared` }, storage),
      creds,
      storage,
      edge,
      days: () => 30,
      day,
      principals: () => Promise.resolve(principals),
      servers,
      bubbled: () => false,
      now,
    });
  };
  const call = (input: Record<string, unknown>, agentId = "cy", sees?: string[]) =>
    tool(agentId, sees).execute(input as never, new AbortController().signal) as Promise<string>;
  const port = (agentId: string) =>
    artifactsPort({ agentId, creds, storage, edge, day, now, servers });
  return {
    root,
    app,
    creds,
    storage,
    call,
    tool,
    port,
    started,
    stopped,
    principals: (p: Principal[]) => principals = p,
    failing: (why: string | null) => failing = why,
    offline: () => publicUrl = null,
    async close() {
      await creds.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("publish: a folder's public/ for a chat and a group answers the link and the chat's own, and keeps public/ whole but its dot-named files", async () => {
  const b = await bed();
  try {
    const out = await b.call({ path: "app", with: ["Ana", "Ops"] });
    const [a] = await listArtifacts(b.creds);
    const base = "https://acme.example.com/artifacts/the-plan";
    assertEquals(a.slug, "the-plan");
    assertStringIncludes(out, `Published "The plan" (app), a page: ${base}\n`);
    assertStringIncludes(
      out,
      `For Ana, a link to send in your chat with them, which logs them in once: ${base}?t=${
        a.tokens[ANA]
      }`,
    );
    assertStringIncludes(out, "Anyone in Ops opens it with a code");
    assertStringIncludes(out, "good until 2026-12-16");
    assertEquals(a.folder, "agents/cy/app");
    assertEquals(a.agentId, "cy");
    assertEquals(a.server, undefined);
    assertEquals(a.with.map((p) => [p.address, p.kind, p.connection]), [
      [ANA, "direct", ACCOUNT],
      [GROUP, "group", ACCOUNT],
    ]);
    assertEquals(Object.keys(a.files).sort(), ["index.html", "lib/chart.js"]);
    const kept = await b.storage.get(`artifacts/${a.id}/${a.files["lib/chart.js"].hash}`);
    assertEquals(new TextDecoder().decode(kept!), "draw()");
    assertEquals(b.started, []);
  } finally {
    await b.close();
  }
});

Deno.test("publish: the principals are always on the list, by their phone, each with a link; a code to one goes out only from an account not their own", async () => {
  const b = await bed();
  try {
    b.principals([{ name: "Mati", phone: `+${MATI}` }, { name: "Ana", phone: ANA }, {
      name: "Nadie",
    }]);
    const out = await b.call({ path: "app", with: ["Ana"] });
    const [a] = await listArtifacts(b.creds);
    // Ana is on the list as her chat already
    assertEquals(a.with.map((p) => [p.address, p.kind, p.connection]), [
      [ANA, "direct", ACCOUNT],
      [MATI, "principal", ACCOUNT],
    ]);
    assertStringIncludes(out, `For Mati, whom you answer to, a link that logs them in once: `);
    assertStringIncludes(out, `?t=${a.tokens[MATI]}`);
    assertStringIncludes(out, "Nadie has no phone on the roster, so it is not theirs.");

    // for the principals alone: no account of the list reaches them but their own
    b.principals([{ name: "Mati", phone: ACCOUNT }]);
    const alone = await b.call({ path: "shared/site" });
    const site = (await listArtifacts(b.creds)).find((x) => x.folder === "shared/site")!;
    assertEquals(site.with, [{
      address: ACCOUNT,
      connection: "",
      kind: "principal",
      name: "Mati",
    }]);
    assertStringIncludes(alone, "except Mati: no account but their own reaches them");
  } finally {
    await b.close();
  }
});

Deno.test("publish: a server.ts makes an API or, with public/, an app; it starts with the hosts and native it was published with, kept the next time", async () => {
  const b = await bed();
  try {
    await Deno.writeTextFile(`${b.app}/server.ts`, "serve(() => new Response())");
    const out = await b.call({
      path: "app",
      with: ["Ana"],
      hosts: ["api.voyageai.com"],
      native: true,
    });
    assertStringIncludes(out, `Published "The plan" (app), an app:`);
    assertStringIncludes(
      out,
      "Its server runs from server.ts, reaching api.voyageai.com, with native code",
    );
    let [a] = await listArtifacts(b.creds);
    assertEquals(a.server, { hosts: ["api.voyageai.com"], native: true });
    assertEquals(b.started, ["the-plan:api.voyageai.com:true"]);

    // republished: the server starts anew, its hosts and native kept
    await b.call({ path: "app" });
    assertEquals(b.started.at(-1), "the-plan:api.voyageai.com:true");
    await b.call({ path: "app", native: false, hosts: [] });
    [a] = await listArtifacts(b.creds);
    assertEquals(a.server, { hosts: [], native: false });

    // a server that can't start is said, and the artifact stands
    b.failing("the ground is remote");
    assertStringIncludes(
      await b.call({ path: "app" }),
      "Its server could not start: the ground is remote",
    );
    b.failing(null);

    // the server gone, the page stays and the server stops
    await Deno.remove(`${b.app}/server.ts`);
    await b.call({ path: "app" });
    [a] = await listArtifacts(b.creds);
    assertEquals(a.server, undefined);
    assertEquals(b.stopped, ["the-plan"]);

    // a server alone is an API
    await Deno.mkdir(`${b.root}/data/agents/cy/api`);
    await Deno.writeTextFile(`${b.root}/data/agents/cy/api/server.ts`, "x");
    assertStringIncludes(
      await b.call({ path: "api", with: ["Ana"], title: "Datos" }),
      "an API: https://acme.example.com/artifacts/datos",
    );
  } finally {
    await b.close();
  }
});

Deno.test("publish: a title another artifact's link took is refused, and a folder keeps its link whatever its title", async () => {
  const b = await bed();
  try {
    await b.call({ path: "app", with: ["Ana"] });
    await assertRejects(
      () => b.call({ path: "shared/site", with: ["Ana"], title: "The Plan!" }),
      Error,
      `the link /artifacts/the-plan is app's ("The plan"): give this one another title`,
    );
    // the same folder again keeps its link whatever the title
    await b.call({ path: "app", title: "Another" });
    assertEquals((await readArtifact(b.creds, "the-plan"))?.title, "Another");
  } finally {
    await b.close();
  }
});

Deno.test("publish: refused without anyone, off WhatsApp, with neither public/ nor server.ts, without index.html, at a root, outside the folders, with odd paths, or with a server's knobs and no server", async () => {
  const b = await bed();
  try {
    await assertRejects(() => b.call({ path: "app" }), Error, "say `with`");
    b.principals([{ name: "Nadie" }]);
    await assertRejects(() => b.call({ path: "app" }), Error, "Nadie has no phone on the roster");
    await assertRejects(() => b.call({ path: "app", with: ["C1"] }), Error, "C1 is on slack");
    await assertRejects(() => b.call({ path: "app", with: ["nobody"] }), Error, "no WhatsApp");
    await assertRejects(
      () => b.call({ path: "app/public", with: ["Ops"] }),
      Error,
      "holds neither public/",
    );
    await Deno.remove(`${b.app}/public/index.html`);
    await assertRejects(() => b.call({ path: "app", with: ["Ops"] }), Error, "holds no index.html");
    await Deno.writeTextFile(`${b.app}/public/index.html`, "<title>x</title>");
    await assertRejects(() => b.call({ path: ".", with: ["Ops"] }), Error, "not either one");
    await assertRejects(() => b.call({ path: "../..", with: ["Ops"] }), Error, "not either one");
    await assertRejects(() => b.call({ path: "gone", with: ["Ops"] }), Error, "no such folder");
    await assertRejects(
      () => b.call({ path: "app", with: ["Ops"], hosts: ["api.example.com"] }),
      Error,
      "`hosts` and `native` are a server's",
    );
    await Deno.writeTextFile(`${b.app}/server.ts`, "x");
    await assertRejects(
      () => b.call({ path: "app", with: ["Ops"], hosts: ["https://api.example.com/v1"] }),
      Error,
      "a host is a name",
    );
    await Deno.writeTextFile(`${b.app}/public/a b.js`, "x");
    await assertRejects(() => b.call({ path: "app", with: ["Ops"] }), Error, "plain segments");
    assertEquals(await listArtifacts(b.creds), []);
  } finally {
    await b.close();
  }
});

Deno.test("publish: a shared folder is one artifact any agent publishes again, checked against what that agent reads", async () => {
  const b = await bed();
  try {
    await b.call({ path: "shared/site", with: ["Ops"] }, "cy");
    const [a] = await listArtifacts(b.creds);
    assertEquals(a.folder, "shared/site");

    // dee reads no Ops: the list it would keep is not its to vouch for
    await assertRejects(
      () => b.call({ path: "shared/site" }, "dee", [ANA]),
      Error,
      "Ops is on the artifact's list but not a conversation you can read",
    );
    const out = await b.call({ path: "shared/site", with: ["Ana"] }, "dee", [ANA]);
    assertStringIncludes(out, `Republished "Site" (shared/site)`);
    const [again] = await listArtifacts(b.creds);
    assertEquals([again.slug, again.id, again.agentId], [a.slug, a.id, "dee"]);
  } finally {
    await b.close();
  }
});

Deno.test("publish card: who it is for by name and number, what it shows and what its server reaches, and nothing written", async () => {
  const b = await bed();
  try {
    b.principals([{ name: "Mati", phone: MATI }]);
    await Deno.writeTextFile(`${b.app}/server.ts`, "x");
    const card = await b.tool().card({
      path: "app",
      with: ["Ana", "Ops"],
      hosts: ["api.voyageai.com"],
      native: true,
    });
    assertEquals(card?.artifact, {
      title: "The plan",
      kind: "app",
      link: "https://acme.example.com/artifacts/the-plan",
      folder: "app",
      again: false,
      files: 2,
      bytes: 31,
      server: { hosts: ["api.voyageai.com"], native: true, bubbled: false },
      with: [
        { name: "Ana", address: ANA, kind: "direct" },
        { name: "Ops", address: GROUP, kind: "group" },
        { name: "Mati", address: MATI, kind: "principal" },
      ],
      until: "2026-12-16",
    });
    assertEquals(await listArtifacts(b.creds), []);
    // a call that can't run has no card: its error answers it before anyone is asked
    await assertRejects(() => b.tool().card({ path: "gone" }), Error, "no such folder");
  } finally {
    await b.close();
  }
});

Deno.test("artifacts port: the anchor lists the artifacts an agent reaches, and cancel takes one down by its folder or its link, its server stopped", async () => {
  const b = await bed();
  try {
    await b.call({ path: "app", with: ["Ana", "Ops"] });
    await b.call({ path: "shared/site", with: ["Ops"] });
    assertEquals(await b.port("cy").standing(), [
      "artifacts — 2 artifacts:",
      `· app — "The plan" · page · https://acme.example.com/artifacts/the-plan · with Ana, Ops · until 2026-12-16`,
      `· shared/site — "Site" · page · https://acme.example.com/artifacts/site · with Ops · until 2026-12-16`,
    ]);
    // another agent reaches the shared one alone
    assertEquals((await b.port("dee").standing()).length, 2);
    assertEquals(await b.port("dee").cancel("https://acme.example.com/artifacts/the-plan"), null);
    assertEquals(await b.port("dee").cancel("app"), null);

    assertStringIncludes((await b.port("cy").cancel("app/"))!, `"The plan" (app) is down`);
    assertEquals(await readArtifact(b.creds, "the-plan"), null);
    assertStringIncludes(
      (await b.port("dee").cancel("https://acme.example.com/artifacts/site?t=x"))!,
      "(shared/site) is down",
    );
    assertEquals(b.stopped, ["the-plan", "site"]);
    assertEquals(await b.port("cy").standing(), []);
    assert((await Array.fromAsync(b.storage.keys("artifacts/"))).length === 0);
  } finally {
    await b.close();
  }
});
