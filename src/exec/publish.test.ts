import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openCredentials } from "../store/credentials.ts";
import { fileStorage } from "../store/storage.ts";
import { localFiles } from "../store/media.ts";
import type { Event } from "../types.ts";
import type { Reader } from "../store/log.ts";
import { pagesPort, publishTool } from "./publish.ts";
import { listPages, readPage } from "../pages.ts";
import { membersAt } from "../testing.ts";

const ACCOUNT = "5491199999999";
const ANA = "5491100000001";
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
  await Deno.mkdir(`${app}/lib`, { recursive: true });
  await Deno.mkdir(`${app}/.git`, { recursive: true });
  await Deno.writeTextFile(`${app}/index.html`, "<title> The plan </title>");
  await Deno.writeTextFile(`${app}/lib/chart.js`, "draw()");
  await Deno.writeTextFile(`${app}/.env`, "SECRET=1");
  await Deno.writeTextFile(`${app}/.git/HEAD`, "ref");
  await Deno.mkdir(`${data}/shared/site`, { recursive: true });
  await Deno.writeTextFile(`${data}/shared/site/index.html`, "<title>Site</title>");
  await membersAt(data, "cy", "dee");
  const creds = await openCredentials(data);
  const storage = fileStorage(data);
  let publicUrl: string | null = "https://acme.example.com";
  const now = () => Date.parse("2026-11-16T12:00:00Z");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const edge = () => ({ publicUrl, port: 8787 });
  const call = (input: Record<string, unknown>, agentId = "cy", sees?: string[]) => {
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
      now,
    }).execute(input as never, new AbortController().signal) as Promise<string>;
  };
  const port = (agentId: string) => pagesPort({ agentId, creds, storage, edge, day, now });
  return {
    root,
    creds,
    storage,
    call,
    port,
    offline: () => publicUrl = null,
    async close() {
      await creds.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("publish: a folder for a chat and a group answers the link and the chat's own, and keeps the folder whole but its dot-named files", async () => {
  const b = await bed();
  try {
    const out = await b.call({ path: "app", with: ["Ana", "Ops"] });
    const [page] = await listPages(b.creds);
    const base = `https://acme.example.com/pages/${page.id}`;
    assertStringIncludes(out, `Published "The plan" (app): ${base}\n`);
    assertStringIncludes(
      out,
      `For Ana, sent in your chat with them, a link that logs them in once: ${base}?t=${
        page.tokens[ANA]
      }`,
    );
    assertStringIncludes(out, "Anyone in Ops opens it with a code");
    assertStringIncludes(out, "good until 2026-12-16");
    assertEquals(page.folder, "agents/cy/app");
    assertEquals(page.agentId, "cy");
    assertEquals(page.with.map((p) => [p.address, p.kind, p.connection]), [
      [ANA, "direct", ACCOUNT],
      [GROUP, "group", ACCOUNT],
    ]);
    assertEquals(Object.keys(page.files).sort(), ["index.html", "lib/chart.js"]);
    const kept = await b.storage.get(`pages/${page.id}/lib/chart.js`);
    assertEquals(new TextDecoder().decode(kept!), "draw()");
  } finally {
    await b.close();
  }
});

Deno.test("publish: again, a folder keeps its link, its list unless `with` replaces it, and a token not spent", async () => {
  const b = await bed();
  try {
    await b.call({ path: "app", with: ["Ana"] });
    const [first] = await listPages(b.creds);
    await Deno.remove(`${b.root}/data/agents/cy/app/lib`, { recursive: true });

    const again = await b.call({ path: "./app/", title: "v2" });
    assertStringIncludes(again, `Republished "v2" (app)`);
    let pages = await listPages(b.creds);
    assertEquals(pages.length, 1);
    assertEquals(pages[0].id, first.id);
    assertEquals(pages[0].with.map((p) => p.address), [ANA]);
    assertEquals(pages[0].tokens, first.tokens);
    assertEquals(Object.keys(pages[0].files), ["index.html"]);
    assertEquals(await b.storage.get(`pages/${first.id}/lib/chart.js`), null);

    await b.call({ path: "app", with: [GROUP] });
    pages = await listPages(b.creds);
    assertEquals(pages[0].with.map((p) => p.address), [GROUP]);
    assertEquals(pages[0].tokens, {});

    b.offline();
    assertStringIncludes(await b.call({ path: "app" }), "opens only on the org's machine");
  } finally {
    await b.close();
  }
});

Deno.test("publish: refused without `with` the first time, off WhatsApp, without index.html, at a root, outside the folders, or with odd paths", async () => {
  const b = await bed();
  try {
    await assertRejects(() => b.call({ path: "app" }), Error, "say `with`");
    await assertRejects(() => b.call({ path: "app", with: [] }), Error, "cancel it");
    await assertRejects(() => b.call({ path: "app", with: ["C1"] }), Error, "C1 is on slack");
    await assertRejects(() => b.call({ path: "app", with: ["nobody"] }), Error, "no WhatsApp");
    await assertRejects(() => b.call({ path: "app/lib", with: ["Ops"] }), Error, "no index.html");
    await assertRejects(() => b.call({ path: ".", with: ["Ops"] }), Error, "not either one");
    await assertRejects(() => b.call({ path: "../..", with: ["Ops"] }), Error, "not either one");
    await assertRejects(() => b.call({ path: "gone", with: ["Ops"] }), Error, "no such folder");
    await Deno.writeTextFile(`${b.root}/data/agents/cy/app/a b.js`, "x");
    await assertRejects(() => b.call({ path: "app", with: ["Ops"] }), Error, "plain segments");
    assertEquals(await listPages(b.creds), []);
  } finally {
    await b.close();
  }
});

Deno.test("publish: a shared folder is one page any agent publishes again, checked against what that agent reads", async () => {
  const b = await bed();
  try {
    await b.call({ path: "../../shared/site", with: ["Ops"] }, "cy");
    const [page] = await listPages(b.creds);
    assertEquals(page.folder, "shared/site");

    // dee reads no Ops: the list it would keep is not its to vouch for
    await assertRejects(
      () => b.call({ path: "../../shared/site" }, "dee", [ANA]),
      Error,
      "Ops is on the page's list but not a conversation you can read",
    );
    const out = await b.call({ path: "../../shared/site", with: ["Ana"] }, "dee", [ANA]);
    assertStringIncludes(out, `Republished "Site" (shared/site)`);
    const [again] = await listPages(b.creds);
    assertEquals([again.id, again.agentId], [page.id, "dee"]);
  } finally {
    await b.close();
  }
});

Deno.test("pages port: the anchor lists the pages an agent reaches, and cancel takes one down by its folder or its link", async () => {
  const b = await bed();
  try {
    await b.call({ path: "app", with: ["Ana", "Ops"] });
    await b.call({ path: "../../shared/site", with: ["Ops"] });
    const pages = await listPages(b.creds);
    const mine = pages.find((p) => p.folder === "agents/cy/app")!;
    const shared = pages.find((p) => p.folder === "shared/site")!;
    assertEquals(await b.port("cy").standing(), [
      "pages — 2 pages:",
      `· app — "The plan" · https://acme.example.com/pages/${mine.id} · with Ana, Ops · until 2026-12-16`,
      `· shared/site — "Site" · https://acme.example.com/pages/${shared.id} · with Ops · until 2026-12-16`,
    ]);
    // another agent reaches the shared page alone
    assertEquals((await b.port("dee").standing()).length, 2);
    assertEquals(await b.port("dee").cancel(`https://acme.example.com/pages/${mine.id}`), null);
    assertEquals(await b.port("dee").cancel("app"), null);

    assertStringIncludes((await b.port("cy").cancel("app/"))!, `"The plan" (app) is down`);
    assertEquals(await readPage(b.creds, mine.id), null);
    assertStringIncludes(
      (await b.port("dee").cancel(`https://acme.example.com/pages/${shared.id}?t=x`))!,
      "(shared/site) is down",
    );
    assertEquals(await b.port("cy").standing(), []);
    assert((await Array.fromAsync(b.storage.keys("pages/"))).length === 0);
  } finally {
    await b.close();
  }
});
