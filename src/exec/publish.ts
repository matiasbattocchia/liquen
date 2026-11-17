/**
 * exec/publish.ts — the `publish` tool: an agent publishes a folder as a page, for the
 * WhatsApp conversations it can read (pages.ts); and the pages port, the agent's pages as
 * the anchor lists them and as `cancel` takes them down.
 *
 * The folder is read whole through the session's files port, below the agent's own folder
 * or the shared one. A folder is one page: publishing it again replaces its files and
 * keeps its link. The page opens on `index.html`, and is served in its box until its days
 * run out (`pages.days`).
 *
 * The answer is the link, and one more for each direct chat, carrying its person's token,
 * which logs them in once; everyone else logs in with a code sent to their number.
 */

import type { ExecTool } from "../xi.ts";
import type { Reader } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import type { Files } from "../store/media.ts";
import type { Storage } from "../store/storage.ts";
import type { Event } from "../types.ts";
import { pageAddress } from "../edge.ts";
import {
  listPages,
  type Page,
  PAGE_BYTES_MOST,
  PAGE_FILES_MOST,
  PAGE_INDEX,
  PAGE_WITH_MOST,
  pageAt,
  pageId,
  pageMime,
  type Party,
  plainPath,
  readPage,
  removePage,
  titleOf,
  writePage,
} from "../pages.ts";

export const PUBLISH_SPEC = {
  name: "publish",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      with: { type: "array", items: { type: "string" }, maxItems: PAGE_WITH_MOST },
      title: { type: "string" },
    },
    required: ["path"],
  },
};

type Edge = { publicUrl: string | null; port: number };

export interface PublishDeps {
  agentId: string;
  /** The agent's view of the log: a page is for conversations it can read. */
  log: Pick<Reader, "read">;
  /** The session's files port, where its shell stands; null when the session has none. */
  files: () => Files | null;
  creds: Credentials;
  storage: Storage;
  edge: () => Edge;
  /** `pages.days` as the org stands. */
  days: () => number;
  /** A deadline as the agent reads a date, in the org's zone. */
  day: (ms: number) => string;
  now?: () => number;
}

/** The conversation `to` names, among the WhatsApp ones the agent can read. */
async function conversationOf(log: Pick<Reader, "read">, to: string): Promise<Party> {
  const wa = (e: Event) => e.envelope.service === "whatsapp";
  let rows = (await log.read({ conversation: to, limit: 1 })).filter(wa);
  if (!rows.length) {
    const named = await log.read({ conversationName: to, limit: 50 });
    const direct = await log.read({
      senderName: to,
      limit: 50,
      filter: (e) => e.envelope.conversation.kind === "direct",
    });
    const seen = new Map<string, Event>();
    for (const e of [...named, ...direct].filter(wa)) {
      seen.set(e.envelope.conversation.address, e);
    }
    if (seen.size > 1) {
      throw new Error(
        `"${to}" names ${seen.size} WhatsApp conversations: say one by its address ` +
          `(${[...seen.keys()].join(", ")})`,
      );
    }
    rows = [...seen.values()];
  }
  const [e] = rows;
  if (!e) {
    const [other] = await log.read({ conversation: to, limit: 1 });
    throw new Error(
      other
        ? `${to} is on ${other.envelope.service}: a page is for WhatsApp conversations, whose ` +
          "people log in with their number"
        : `no WhatsApp conversation "${to}" that you can read`,
    );
  }
  const c = e.envelope.conversation;
  const kind = c.kind ?? (/^\d+$/.test(c.address) ? "direct" : "group");
  if (kind !== "direct" && kind !== "group") {
    throw new Error(`${to} is a ${kind}: a page is for direct chats and groups`);
  }
  const name = c.name ??
    (kind === "direct" && e.envelope.sender?.address === c.address
      ? e.envelope.sender?.name
      : undefined);
  return {
    address: c.address,
    connection: e.envelope.connection_address,
    kind,
    ...(name ? { name } : {}),
  };
}

/** A conversation as the agent reads it named. */
const nameOf = (p: Party) => p.name ?? p.address;

/** The folder as the agent names it: its own from its folder, the shared one headed so. */
function shownOf(folder: string, agentId: string): string {
  const own = `agents/${agentId}/`;
  return folder.startsWith(own) ? folder.slice(own.length) : folder;
}

/** Whether an agent reaches a page's folder: its own, or the shared one. */
const reaches = (page: Page, agentId: string) =>
  page.folder.startsWith(`agents/${agentId}/`) || page.folder.startsWith("shared/");

export function publishTool(deps: PublishDeps): ExecTool {
  const now = deps.now ?? Date.now;
  return {
    spec: PUBLISH_SPEC,
    async execute(input) {
      const args = (input ?? {}) as Record<string, unknown>;
      const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

      const path = text(args.path);
      if (!path) throw new Error("say `path`: the folder the page is made of");
      const files = deps.files();
      if (!files) throw new Error("this session has no files to publish");
      const folder = await files.folder(path, { files: PAGE_FILES_MOST, bytes: PAGE_BYTES_MOST });
      if (!folder.files.has(PAGE_INDEX)) {
        throw new Error(`${path} holds no ${PAGE_INDEX}: the page opens on it`);
      }
      const odd = [...folder.files.keys()].filter((p) => !plainPath(p));
      if (odd.length) {
        throw new Error(
          `${odd.join(", ")}: a page's paths are plain segments of letters, digits, dots, ` +
            "dashes and underscores",
        );
      }
      const key = folder.root === "home"
        ? `agents/${deps.agentId}/${folder.path}`
        : `shared/${folder.path}`;
      const before = await pageAt(deps.creds, key, now());

      const asked = Array.isArray(args.with) ? args.with.map(text).filter(Boolean) : null;
      if (!before && !asked) {
        throw new Error("say `with`: the WhatsApp conversations the page is for");
      }
      if (asked && !asked.length) {
        throw new Error("`with` names no conversation: to take the page down, cancel it");
      }
      const parties = new Map<string, Party>();
      for (const to of asked ?? before!.with.map((p) => p.address)) {
        const p = await conversationOf(deps.log, to).catch((err) => {
          if (asked) throw err;
          const kept = before!.with.find((p) => p.address === to)!;
          throw new Error(
            `${nameOf(kept)} is on the page's list but not a conversation you can read: ` +
              "say `with`",
          );
        });
        parties.set(p.address, p);
      }
      const title = text(args.title) ||
        titleOf(new TextDecoder().decode(folder.files.get(PAGE_INDEX))) || "A page";

      const t = now();
      const chats = [...parties.values()];
      const page: Page = {
        id: before?.id ?? pageId(),
        agentId: deps.agentId,
        folder: key,
        with: chats,
        title,
        files: Object.fromEntries(
          [...folder.files].map(([p, b]) => [p, { mime: pageMime(p), size: b.length }]),
        ),
        created: t,
        until: t + deps.days() * 24 * 3_600_000,
        // a token not yet spent is kept, and a spent one minted anew
        tokens: Object.fromEntries(
          chats.filter((p) => p.kind === "direct")
            .map((p) => [p.address, before?.tokens[p.address] ?? pageId()]),
        ),
      };
      await writePage(deps.creds, deps.storage, page, folder.files);

      const edge = deps.edge();
      const base = pageAddress(edge, page.id);
      const groups = chats.filter((p) => p.kind === "group").map(nameOf);
      return [
        `${before ? "Republished" : "Published"} "${title}" (${
          shownOf(key, deps.agentId)
        }): ${base}`,
        ...chats.filter((p) => p.kind === "direct").map((p) =>
          `For ${nameOf(p)}, sent in your chat with them, a link that logs them in once: ` +
          `${base}?t=${page.tokens[p.address]}`
        ),
        ...(groups.length
          ? [`Anyone in ${groups.join(", ")} opens it with a code sent to their number.`]
          : []),
        `It is good until ${deps.day(page.until)}. On another device, anyone it is for logs ` +
        "in with a code sent to their number." +
        (edge.publicUrl === null
          ? " The org has no public address, so it opens only on the org's machine."
          : ""),
      ].join("\n");
    },
  };
}

/** The agent's pages, as the anchor lists them and `cancel` takes them down. */
export interface PagesPort {
  /** The anchor's `pages` section: the live pages in folders the agent reaches. */
  standing(): Promise<string[]>;
  /** Take a page the agent reaches down, by its folder or its link: what to answer, or
   *  null when the reference names no page. */
  cancel(ref: string): Promise<string | null>;
}

export function pagesPort(
  deps: Pick<PublishDeps, "agentId" | "creds" | "storage" | "edge" | "day" | "now">,
): PagesPort {
  const now = deps.now ?? Date.now;
  const live = async () =>
    (await listPages(deps.creds)).filter((p) => p.until > now() && reaches(p, deps.agentId))
      .sort((a, b) => a.folder.localeCompare(b.folder));
  return {
    async standing() {
      const pages = await live();
      if (!pages.length) return [];
      return [
        `pages — ${pages.length} page${pages.length === 1 ? "" : "s"}:`,
        ...pages.map((p) =>
          `· ${shownOf(p.folder, deps.agentId)} — "${p.title}" · ` +
          `${pageAddress(deps.edge(), p.id)} · with ${p.with.map(nameOf).join(", ")} · ` +
          `until ${deps.day(p.until)}`
        ),
      ];
    },
    async cancel(ref) {
      const link = /\/pages\/([^/?#]+)/.exec(ref);
      const folder = ref.trim().replace(/^\.\//, "").replace(/\/+$/, "");
      const page = link
        ? await readPage(deps.creds, link[1])
        : (await live()).find((p) => shownOf(p.folder, deps.agentId) === folder) ?? null;
      if (!page || page.until <= now() || !reaches(page, deps.agentId)) return null;
      await removePage(deps.creds, deps.storage, page.id);
      return `"${page.title}" (${shownOf(page.folder, deps.agentId)}) is down: its link opens ` +
        "nothing now";
    },
  };
}
