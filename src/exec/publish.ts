/**
 * exec/page.ts — the `page` tool: an agent publishes a folder as a page, for a WhatsApp
 * conversation it can read, or takes one of its own down (pages.ts).
 *
 * The files go through the session's files port, as `send`'s do: a path outside the
 * agent's folders is refused the same way, and each file is kept before it is copied
 * under the page. The page opens on `index.html`, and is served in its box until its
 * days run out (`pages.days`).
 *
 * The answer is the link. A direct chat's link carries its person's token, which logs
 * them in once; a group's is bare, and each member logs in with a code sent to them.
 */

import { posix } from "node:path";
import type { ExecTool } from "../xi.ts";
import type { Reader } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import type { Files } from "../store/media.ts";
import { keyOf, type Storage } from "../store/storage.ts";
import type { Event } from "../types.ts";
import { pageAddress } from "../edge.ts";
import {
  type Page,
  PAGE_BYTES_MOST,
  PAGE_FILES_MOST,
  PAGE_INDEX,
  pageId,
  pageMime,
  plainPath,
  readPage,
  removePage,
  titleOf,
  writePage,
} from "../pages.ts";

export const PAGE_SPEC = {
  name: "page",
  input_schema: {
    type: "object" as const,
    properties: {
      to: { type: "string" },
      files: { type: "array", items: { type: "string" }, maxItems: PAGE_FILES_MOST },
      dir: { type: "string" },
      title: { type: "string" },
      id: { type: "string" },
      remove: { type: "string" },
    },
  },
};

export interface PageDeps {
  agentId: string;
  /** The agent's view of the log: a page is for a conversation it can read. */
  log: Pick<Reader, "read">;
  /** The session's files port, where its shell stands; null when the session has none. */
  files: () => Files | null;
  creds: Credentials;
  storage: Storage;
  edge: () => { publicUrl: string | null; port: number };
  /** `pages.days` as the org stands. */
  days: () => number;
  /** A deadline as the agent reads a date, in the org's zone. */
  day: (ms: number) => string;
  now?: () => number;
}

/** The conversation `to` names, among the WhatsApp ones the agent can read. */
async function conversationOf(
  log: Pick<Reader, "read">,
  to: string,
): Promise<{ address: string; connection: string; kind: "direct" | "group"; name?: string }> {
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
        ? `${to} is on ${other.envelope.service}: a page is for a WhatsApp conversation, whose ` +
          "people log in with their number"
        : `no WhatsApp conversation "${to}" that you can read`,
    );
  }
  const c = e.envelope.conversation;
  const kind = c.kind ?? (/^\d+$/.test(c.address) ? "direct" : "group");
  if (kind !== "direct" && kind !== "group") {
    throw new Error(`${to} is a ${kind}: a page is for a direct chat or a group`);
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

/** The page a link or an id names. */
function idOf(ref: string): string {
  const m = /\/pages\/([^/?#]+)/.exec(ref);
  return m ? m[1] : ref.trim();
}

/** A page's link: a direct chat's carries its unspent token. */
function linkOf(page: Page, edge: { publicUrl: string | null; port: number }): string {
  const base = pageAddress(edge, page.id);
  return page.kind === "direct" && page.token ? `${base}?t=${page.token}` : base;
}

export function pageTool(deps: PageDeps): ExecTool {
  const now = deps.now ?? Date.now;
  return {
    spec: PAGE_SPEC,
    async execute(input) {
      const args = (input ?? {}) as Record<string, unknown>;
      const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

      const remove = text(args.remove);
      if (remove) {
        const page = await readPage(deps.creds, idOf(remove));
        if (!page || page.agentId !== deps.agentId) {
          throw new Error(`no page of yours "${remove}"`);
        }
        await removePage(deps.creds, deps.storage, page.id);
        return `"${page.title}" is down: its link opens nothing now`;
      }

      const to = text(args.to);
      if (!to) throw new Error("say `to`: the WhatsApp conversation the page is for");
      const list = Array.isArray(args.files) ? args.files.map(text).filter(Boolean) : [];
      const paths = [...new Set(list.map((p) => posix.normalize(p).replace(/^\.\//, "")))];
      if (!paths.includes(PAGE_INDEX)) {
        throw new Error(
          `\`files\` holds the app's files, and ${PAGE_INDEX} is one: it opens on it`,
        );
      }
      if (paths.length > PAGE_FILES_MOST) {
        throw new Error(`a page holds at most ${PAGE_FILES_MOST} files`);
      }
      const odd = paths.filter((p) => !plainPath(p));
      if (odd.length) {
        throw new Error(
          `${odd.join(", ")}: a page's paths are plain segments of letters, digits, dots, ` +
            "dashes and underscores, below the folder",
        );
      }
      const files = deps.files();
      if (!files) throw new Error("this session has no files to publish");

      const prior = text(args.id);
      const before = prior ? await readPage(deps.creds, idOf(prior)) : null;
      if (prior && (!before || before.agentId !== deps.agentId)) {
        throw new Error(`no page of yours "${prior}"`);
      }
      const where = await conversationOf(deps.log, to);

      const dir = text(args.dir);
      const bytes = new Map<string, Uint8Array>();
      let total = 0;
      for (const path of paths) {
        const { part } = await files.resolve(dir ? posix.join(dir, path) : path);
        const b = await deps.storage.get(keyOf(part.file.uri));
        if (!b) throw new Error(`${path}: its bytes could not be read back`);
        total += b.length;
        if (total > PAGE_BYTES_MOST) {
          throw new Error(`a page holds at most ${PAGE_BYTES_MOST / 1024 / 1024} MB in all`);
        }
        bytes.set(path, b);
      }
      const title = text(args.title) ||
        titleOf(new TextDecoder().decode(bytes.get(PAGE_INDEX))) || "A page";

      const t = now();
      const page: Page = {
        id: before?.id ?? pageId(),
        agentId: deps.agentId,
        connection: where.connection,
        conversation: where.address,
        ...(where.name ? { name: where.name } : {}),
        kind: where.kind,
        title,
        files: Object.fromEntries(
          paths.map((p) => [p, { mime: pageMime(p), size: bytes.get(p)!.length }]),
        ),
        created: t,
        until: t + deps.days() * 24 * 3_600_000,
        ...(where.kind === "direct"
          ? {
            token: before?.token && before.conversation === where.address ? before.token : pageId(),
          }
          : {}),
      };
      await writePage(deps.creds, deps.storage, page, bytes);

      const edge = deps.edge();
      const who = where.kind === "direct"
        ? `The link logs ${where.name ?? where.address} in once; send it to them there. ` +
          "Anyone else, or the same person on another device, logs in with a code sent to " +
          "that number"
        : `Anyone in ${where.name ?? where.address} opens it with a code sent to their number`;
      return [
        `${before ? "Republished" : "Published"} "${title}": ${linkOf(page, edge)}`,
        `It is good until ${deps.day(page.until)}. ${who}.` +
        (edge.publicUrl === null
          ? " The org has no public address, so it opens only on the org's machine."
          : ""),
      ].join("\n");
    },
  };
}
