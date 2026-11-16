import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openCredentials } from "../store/credentials.ts";
import { fileStorage } from "../store/storage.ts";
import { localFiles } from "../store/media.ts";
import type { Event } from "../types.ts";
import type { Reader } from "../store/log.ts";
import { pageTool } from "./page.ts";
import { listPages, readPage } from "../pages.ts";

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

const log: Pick<Reader, "read"> = {
  read: (q = {}) => {
    const fold = (s?: string) => (s ?? "").toLowerCase();
    const out = rows.filter((e) =>
      (q.conversation === undefined || e.envelope.conversation.address === q.conversation) &&
      (q.conversationName === undefined ||
        fold(e.envelope.conversation.name).includes(fold(q.conversationName))) &&
      (q.senderName === undefined ||
        fold(e.envelope.sender?.name).includes(fold(q.senderName))) &&
      (!q.filter || q.filter(e))
    );
    return Promise.resolve(out.slice(0, q.limit ?? out.length));
  },
};

async function bed() {
  const root = await Deno.makeTempDir();
  const home = `${root}/data/agents/cy`;
  await Deno.mkdir(`${home}/app/lib`, { recursive: true });
  await Deno.writeTextFile(`${home}/app/index.html`, "<title> The plan </title>");
  await Deno.writeTextFile(`${home}/app/lib/chart.js`, "draw()");
  await Deno.writeTextFile(`${root}/index.html`, "outside");
  const creds = await openCredentials(`${root}/data`);
  const storage = fileStorage(`${root}/data`);
  let publicUrl: string | null = "https://acme.example.com";
  const tool = (agentId = "") =>
    pageTool({
      agentId,
      log,
      files: () => localFiles({ home, roots: [home] }, storage),
      creds,
      storage,
      edge: () => ({ publicUrl, port: 8787 }),
      days: () => 30,
      day: (ms) => new Date(ms).toISOString().slice(0, 10),
      now: () => Date.parse("2026-11-16T12:00:00Z"),
    });
  const call = (input: Record<string, unknown>, agentId?: string) =>
    tool(agentId).execute(input as never, new AbortController().signal) as Promise<string>;
  return {
    root,
    creds,
    storage,
    call,
    offline: () => publicUrl = null,
    async close() {
      await creds.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("page: a folder for a direct chat answers its person's link, and is kept under the page", async () => {
  const b = await bed();
  try {
    const out = await b.call({ to: "Ana", dir: "app", files: ["index.html", "lib/chart.js"] });
    const [page] = await listPages(b.creds);
    assertStringIncludes(
      out,
      `Published "The plan": https://acme.example.com/pages/${page.id}?t=${page.token}`,
    );
    assertStringIncludes(out, "good until 2026-12-16");
    assertStringIncludes(out, "logs Ana in once");
    assertEquals(page.kind, "direct");
    assertEquals(page.conversation, ANA);
    assertEquals(page.connection, ACCOUNT);
    assertEquals(page.files["lib/chart.js"], { mime: "text/javascript; charset=utf-8", size: 6 });
    const kept = await b.storage.get(`pages/${page.id}/lib/chart.js`);
    assertEquals(new TextDecoder().decode(kept!), "draw()");
  } finally {
    await b.close();
  }
});

Deno.test("page: a group's link is bare, and publishing again keeps the link and lets go of what it dropped", async () => {
  const b = await bed();
  try {
    const out = await b.call({ to: GROUP, dir: "app", files: ["index.html", "lib/chart.js"] });
    const [first] = await listPages(b.creds);
    assertStringIncludes(out, `https://acme.example.com/pages/${first.id}\n`);
    assertStringIncludes(out, "Anyone in Ops opens it");
    assertEquals(first.token, undefined);

    const again = await b.call({
      to: "Ops",
      dir: "app",
      files: ["index.html"],
      id: first.id,
      title: "v2",
    });
    assertStringIncludes(again, `Republished "v2"`);
    const pages = await listPages(b.creds);
    assertEquals(pages.length, 1);
    assertEquals(Object.keys(pages[0].files), ["index.html"]);
    assertEquals(await b.storage.get(`pages/${first.id}/lib/chart.js`), null);

    b.offline();
    assertStringIncludes(
      await b.call({ to: "Ops", dir: "app", files: ["index.html"] }),
      "opens only on the org's machine",
    );
  } finally {
    await b.close();
  }
});

Deno.test("page: refused off WhatsApp, without index.html, on a path that climbs, outside the folders, or on another's page", async () => {
  const b = await bed();
  try {
    await assertRejects(
      () => b.call({ to: "C1", dir: "app", files: ["index.html"] }),
      Error,
      "C1 is on slack",
    );
    await assertRejects(
      () => b.call({ to: "Ops", dir: "app", files: ["lib/chart.js"] }),
      Error,
      "index.html",
    );
    await assertRejects(
      () => b.call({ to: "Ops", dir: "app", files: ["index.html", "a b.js"] }),
      Error,
      "plain segments",
    );
    await assertRejects(
      () => b.call({ to: "Ops", files: ["index.html"], dir: "../../.." }),
      Error,
      "outside your files",
    );
    await assertRejects(
      () => b.call({ to: "nobody", dir: "app", files: ["index.html"] }),
      Error,
      "no WhatsApp conversation",
    );
    assertEquals(await listPages(b.creds), []);

    await b.call({ to: "Ops", dir: "app", files: ["index.html"] });
    const [page] = await listPages(b.creds);
    await assertRejects(() => b.call({ remove: page.id }, "cy"), Error, "no page of yours");
    const down = await b.call({ remove: `https://acme.example.com/pages/${page.id}` });
    assertStringIncludes(down, "is down");
    assertEquals(await readPage(b.creds, page.id), null);
    assert((await Array.fromAsync(b.storage.keys("pages/"))).length === 0);
  } finally {
    await b.close();
  }
});
