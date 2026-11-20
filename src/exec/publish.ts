/**
 * exec/publish.ts — the `publish` tool: an agent publishes a folder as an artifact, for the
 * WhatsApp conversations it can read and for its principals (artifacts.ts); and the
 * artifacts port, the agent's artifacts as the anchor lists them and as `cancel` takes them
 * down.
 *
 * The folder is found through the session's files port, below the agent's own folder or
 * the shared one, and what it holds says what it is: `public/`, read whole, is what it
 * shows; `server.ts` is its server, started from the folder (artifact-servers.ts). A folder
 * is one artifact: publishing it again replaces its files, starts its server anew, and
 * keeps its link. Its principals are always on its list, the people the agent answers to,
 * by the phone the roster holds for each.
 *
 * The answer is the link, and one more for each direct chat and principal, carrying their
 * token, which logs them in once; everyone else logs in with a code sent to their number.
 * The card a person approves it on names who it is for by name and number, what it shows,
 * and what its server reaches (`card`).
 */

import type { ExecTool } from "../xi.ts";
import type { Reader } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import type { Files } from "../store/media.ts";
import type { Storage } from "../store/storage.ts";
import type { ArtifactPreview, Event, Json } from "../types.ts";
import type { Servers } from "../artifact-servers.ts";
import { artifactAddress } from "../edge.ts";
import { digits } from "../store/roster.ts";
import {
  type Artifact,
  ARTIFACT_BYTES_MOST,
  ARTIFACT_FILES_MOST,
  ARTIFACT_INDEX,
  ARTIFACT_WITH_MOST,
  artifactAt,
  type ArtifactFile,
  type ArtifactServer,
  fileMime,
  hashOf,
  kindOf,
  listArtifacts,
  newId,
  type Party,
  plainPath,
  PUBLIC_DIR,
  readArtifact,
  removeArtifact,
  SERVER_FILE,
  slugOf,
  titleOf,
  writeArtifact,
} from "../artifacts.ts";

export const PUBLISH_SPEC = {
  name: "publish",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      with: { type: "array", items: { type: "string" }, maxItems: ARTIFACT_WITH_MOST },
      title: { type: "string" },
      hosts: { type: "array", items: { type: "string" } },
      native: { type: "boolean" },
    },
    required: ["path"],
  },
};

type Edge = { publicUrl: string | null; port: number };

/** One of the agent's principals, as the roster holds them. */
export interface Principal {
  name: string;
  phone?: string;
}

export interface PublishDeps {
  agentId: string;
  /** The agent's view of the log: an artifact is for conversations it can read. */
  log: Pick<Reader, "read">;
  /** The session's files port, where its shell stands; null when the session has none. */
  files: () => Files | null;
  creds: Credentials;
  storage: Storage;
  edge: () => Edge;
  /** `artifacts.days` as the org stands. */
  days: () => number;
  /** A deadline as the agent reads a date, in the org's zone. */
  day: (ms: number) => string;
  /** Who the agent answers to: always on its artifacts' lists. */
  principals: () => Promise<Principal[]>;
  /** Where the artifacts' servers run. */
  servers: Pick<Servers, "start" | "stop">;
  /** Whether the agent's shells run in a bubble, which holds a native server too. */
  bubbled: () => boolean;
  now?: () => number;
}

/** A host a server may reach: a name, a port after it when it says one. */
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

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
        ? `${to} is on ${other.envelope.service}: an artifact is for WhatsApp conversations, ` +
          "whose people log in with their number"
        : `no WhatsApp conversation "${to}" that you can read`,
    );
  }
  const c = e.envelope.conversation;
  const kind = c.kind ?? (/^\d+$/.test(c.address) ? "direct" : "group");
  if (kind !== "direct" && kind !== "group") {
    throw new Error(`${to} is a ${kind}: an artifact is for direct chats and groups`);
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

/** Someone on the list as the agent reads them named. */
const nameOf = (p: Party) => p.name ?? p.address;

/** The folder as the agent names it: its own from its folder, the shared one headed so. */
function shownOf(folder: string, agentId: string): string {
  const own = `agents/${agentId}/`;
  return folder.startsWith(own) ? folder.slice(own.length) : folder;
}

/** Whether an agent reaches an artifact's folder: its own, or the shared one. */
const reaches = (a: Artifact, agentId: string) =>
  a.folder.startsWith(`agents/${agentId}/`) || a.folder.startsWith("shared/");

/** What a kind is called in the agent's answer. */
const KIND_WORDS = { page: "a page", api: "an API", app: "an app" } as const;

/** A publish worked out and not yet written. */
interface Plan {
  artifact: Artifact;
  before: Artifact | null;
  /** A slug's last holder, past its days: let go before this one takes the slug. */
  lapsed: Artifact | null;
  bytes: Map<string, Uint8Array>;
  /** Principals the list leaves out, for want of a phone on the roster. */
  phoneless: string[];
}

export function publishTool(deps: PublishDeps): ExecTool & {
  card: (input: Json) => Promise<{ artifact: ArtifactPreview } | undefined>;
} {
  const now = deps.now ?? Date.now;
  const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

  /** The principals as parties: each by the phone the roster holds, a code to them going
   *  out from an account of the list that is not their own, since one to their own number
   *  would land in the chat with themselves, which may steer an agent. */
  const principalParties = async (chats: Party[]) => {
    const parties: Party[] = [];
    const phoneless: string[] = [];
    for (const p of await deps.principals()) {
      const phone = digits(p.phone ?? "");
      if (!phone) {
        phoneless.push(p.name);
        continue;
      }
      if (chats.some((c) => c.kind === "direct" && digits(c.address) === phone)) continue;
      const via = chats.find((c) => c.connection && digits(c.connection) !== phone)?.connection;
      parties.push({ address: phone, connection: via ?? "", kind: "principal", name: p.name });
    }
    return { parties, phoneless };
  };

  const plan = async (input: Json): Promise<Plan> => {
    const args = (input ?? {}) as Record<string, unknown>;
    const path = text(args.path);
    if (!path) throw new Error("say `path`: the folder the artifact is made of");
    const files = deps.files();
    if (!files) throw new Error("this session has no files to publish");
    const at = await files.locate(path, [PUBLIC_DIR, SERVER_FILE]);
    const serves = at.has.has(SERVER_FILE);
    if (!at.has.has(PUBLIC_DIR) && !serves) {
      throw new Error(
        `${path} holds neither ${PUBLIC_DIR}/, what an artifact shows, nor ${SERVER_FILE}, ` +
          "its server",
      );
    }
    const shown = at.has.has(PUBLIC_DIR)
      ? (await files.folder(`${path}/${PUBLIC_DIR}`, {
        files: ARTIFACT_FILES_MOST,
        bytes: ARTIFACT_BYTES_MOST,
      })).files
      : new Map<string, Uint8Array>();
    if (!serves && !shown.has(ARTIFACT_INDEX)) {
      throw new Error(
        `${path}/${PUBLIC_DIR} holds no ${ARTIFACT_INDEX}: a page opens on it, and with no ` +
          `${SERVER_FILE} nothing else answers`,
      );
    }
    const odd = [...shown.keys()].filter((p) => !plainPath(p));
    if (odd.length) {
      throw new Error(
        `${odd.join(", ")}: an artifact's paths are plain segments of letters, digits, dots, ` +
          "dashes and underscores",
      );
    }
    const folder = at.root === "home" ? `agents/${deps.agentId}/${at.path}` : `shared/${at.path}`;
    const before = await artifactAt(deps.creds, folder, now());

    const asked = Array.isArray(args.with) ? args.with.map(text).filter(Boolean) : null;
    const parties = new Map<string, Party>();
    const kept = asked ?? before?.with.filter((p) => p.kind !== "principal").map((p) => p.address);
    for (const to of kept ?? []) {
      const p = await conversationOf(deps.log, to).catch((err) => {
        if (asked) throw err;
        const was = before!.with.find((p) => p.address === to)!;
        throw new Error(
          `${nameOf(was)} is on the artifact's list but not a conversation you can read: ` +
            "say `with`",
        );
      });
      parties.set(p.address, p);
    }
    const chats = [...parties.values()];
    const { parties: principals, phoneless } = await principalParties(chats);
    const everyone = [...chats, ...principals];
    if (!everyone.length) {
      throw new Error(
        "say `with`: the WhatsApp conversations the artifact is for" +
          (phoneless.length
            ? ` (${phoneless.join(", ")} ${phoneless.length === 1 ? "has" : "have"} no phone on ` +
              "the roster, so the artifact can't be theirs)"
            : ""),
      );
    }

    const hostsAsked = Array.isArray(args.hosts) ? args.hosts.map(text).filter(Boolean) : null;
    const nativeAsked = typeof args.native === "boolean" ? args.native : null;
    let server: ArtifactServer | undefined;
    if (serves) {
      const hosts = hostsAsked ?? before?.server?.hosts ?? [];
      const bad = hosts.filter((h) => !HOST.test(h));
      if (bad.length) {
        throw new Error(
          `${bad.join(", ")}: a host is a name, with a port after it if it needs one`,
        );
      }
      if (folder.includes(",")) {
        throw new Error(`${path}: a folder with a server has no comma in its path`);
      }
      server = { hosts, native: nativeAsked ?? before?.server?.native ?? false };
    } else if (hostsAsked?.length || nativeAsked) {
      throw new Error(
        `\`hosts\` and \`native\` are a server's, and ${path} holds no ${SERVER_FILE}`,
      );
    }

    const index = shown.get(ARTIFACT_INDEX);
    const title = text(args.title) || (index && titleOf(new TextDecoder().decode(index))) ||
      before?.title || at.path.slice(at.path.lastIndexOf("/") + 1);
    let lapsed: Artifact | null = null;
    let slug = before?.slug;
    if (!slug) {
      slug = slugOf(title);
      const holder = await readArtifact(deps.creds, slug);
      if (holder && holder.until > now()) {
        throw new Error(
          `the link /artifacts/${slug} is ${shownOf(holder.folder, deps.agentId)}'s ` +
            `("${holder.title}"): give this one another title`,
        );
      }
      lapsed = holder;
    }

    const listed: Record<string, ArtifactFile> = {};
    for (const [p, b] of shown) {
      listed[p] = { mime: fileMime(p), size: b.length, hash: await hashOf(b) };
    }
    const t = now();
    const artifact: Artifact = {
      slug,
      id: before?.id ?? newId(),
      agentId: deps.agentId,
      folder,
      with: everyone,
      title,
      files: listed,
      ...(server ? { server } : {}),
      created: t,
      until: t + deps.days() * 24 * 3_600_000,
      // a token not yet spent is kept, and a spent one minted anew
      tokens: Object.fromEntries(
        everyone.filter((p) => p.kind !== "group")
          .map((p) => [p.address, before?.tokens[p.address] ?? newId()]),
      ),
    };
    return { artifact, before, lapsed, bytes: shown, phoneless };
  };

  return {
    spec: PUBLISH_SPEC,
    async execute(input) {
      const { artifact: a, before, lapsed, bytes, phoneless } = await plan(input);
      if (lapsed) await removeArtifact(deps.creds, deps.storage, lapsed);
      await writeArtifact(deps.creds, deps.storage, a, bytes);
      let serving = "";
      if (a.server) {
        serving = await deps.servers.start(a).then(
          () =>
            `Its server runs from ${SERVER_FILE}, reaching ${
              a.server!.hosts.join(", ") || "no host"
            }${a.server!.native ? ", with native code" : ""}; what it prints is in ` +
            ".artifact.log beside it.",
          (err) =>
            `Its server could not start: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else if (before?.server) await deps.servers.stop(a.slug);

      const edge = deps.edge();
      const base = artifactAddress(edge, a.slug);
      const groups = a.with.filter((p) => p.kind === "group").map(nameOf);
      const unreached = a.with.filter((p) => p.kind === "principal" && !p.connection).map(nameOf);
      return [
        `${before ? "Republished" : "Published"} "${a.title}" (${
          shownOf(a.folder, deps.agentId)
        }), ${KIND_WORDS[kindOf(a)]}: ${base}`,
        ...a.with.filter((p) => p.kind === "direct").map((p) =>
          `For ${nameOf(p)}, sent in your chat with them, a link that logs them in once: ` +
          `${base}?t=${a.tokens[p.address]}`
        ),
        ...a.with.filter((p) => p.kind === "principal").map((p) =>
          `For ${nameOf(p)}, whom you answer to, a link that logs them in once: ` +
          `${base}?t=${a.tokens[p.address]}`
        ),
        ...(groups.length
          ? [`Anyone in ${groups.join(", ")} opens it with a code sent to their number.`]
          : []),
        ...(serving ? [serving] : []),
        `It is good until ${deps.day(a.until)}. On another device, anyone it is for logs in ` +
        "with a code sent to their number" +
        (unreached.length
          ? `, except ${unreached.join(", ")}: no account but their own reaches them, so ` +
            "their link is the way in, and publishing again mints a new one once it is spent"
          : "") +
        "." +
        (phoneless.length
          ? ` ${phoneless.join(", ")} ${phoneless.length === 1 ? "has" : "have"} no phone on ` +
            "the roster, so it is not theirs."
          : "") +
        (edge.publicUrl === null
          ? " The org has no public address, so it opens only on the org's machine."
          : ""),
      ].join("\n");
    },
    async card(input) {
      const { artifact: a, before } = await plan(input).catch(() => ({
        artifact: null,
        before: null,
      }));
      if (!a) return undefined;
      const files = Object.values(a.files);
      return {
        artifact: {
          title: a.title,
          kind: kindOf(a),
          link: artifactAddress(deps.edge(), a.slug),
          folder: shownOf(a.folder, deps.agentId),
          again: before !== null,
          files: files.length,
          bytes: files.reduce((n, f) => n + f.size, 0),
          ...(a.server ? { server: { ...a.server, bubbled: deps.bubbled() } } : {}),
          with: a.with.map((p) => ({ name: nameOf(p), address: p.address, kind: p.kind })),
          until: deps.day(a.until),
        },
      };
    },
  };
}

/** The agent's artifacts, as the anchor lists them and `cancel` takes them down. */
export interface ArtifactsPort {
  /** The anchor's `artifacts` section: the live artifacts in folders the agent reaches. */
  standing(): Promise<string[]>;
  /** Take an artifact the agent reaches down, by its folder or its link: what to answer,
   *  or null when the reference names none. */
  cancel(ref: string): Promise<string | null>;
}

export function artifactsPort(
  deps: Pick<PublishDeps, "agentId" | "creds" | "storage" | "edge" | "day" | "now"> & {
    servers: Pick<Servers, "stop">;
  },
): ArtifactsPort {
  const now = deps.now ?? Date.now;
  const live = async () =>
    (await listArtifacts(deps.creds)).filter((a) => a.until > now() && reaches(a, deps.agentId))
      .sort((a, b) => a.folder.localeCompare(b.folder));
  return {
    async standing() {
      const all = await live();
      if (!all.length) return [];
      return [
        `artifacts — ${all.length} artifact${all.length === 1 ? "" : "s"}:`,
        ...all.map((a) =>
          `· ${shownOf(a.folder, deps.agentId)} — "${a.title}" · ${kindOf(a)} · ` +
          `${artifactAddress(deps.edge(), a.slug)} · with ${a.with.map(nameOf).join(", ")} · ` +
          `until ${deps.day(a.until)}`
        ),
      ];
    },
    async cancel(ref) {
      const link = /\/artifacts\/([a-z0-9-]+)/.exec(ref);
      const folder = ref.trim().replace(/^\.\//, "").replace(/\/+$/, "");
      const a = link
        ? await readArtifact(deps.creds, link[1])
        : (await live()).find((a) => shownOf(a.folder, deps.agentId) === folder) ?? null;
      if (!a || a.until <= now() || !reaches(a, deps.agentId)) return null;
      await deps.servers.stop(a.slug);
      await removeArtifact(deps.creds, deps.storage, a);
      return `"${a.title}" (${shownOf(a.folder, deps.agentId)}) is down: its link opens ` +
        "nothing now";
    },
  };
}
