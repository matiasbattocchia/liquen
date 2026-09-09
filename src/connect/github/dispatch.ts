/**
 * src/connect/github/dispatch.ts — the DISPATCH half of the GitHub connection (open-bsp).
 *
 * The mirror of the ingest (github.ts): where ingest is world → log, dispatch is log → world.
 * It subscribes to the log, picks the agent's OUTBOUND sends on the github service
 * (conversation address `owner/repo#N`), and posts them to GitHub. Like the ingest, the substrate-specific action is
 * INJECTED — `post` shells `gh` locally (see below) and would be a `fetch` to the REST API on
 * edge — so the subscribe/parse/route logic is portable and testable.
 *
 * Credentials (§9): WHICH identity posts is dispatcher-internal (the slack resolver's
 * policy, §4): the author's own grant (`github:<author>` — the alter-ego leg) when the
 * vault holds one, else the org's (`github:org` — a token the broker mints from the App
 * installation hourly, or a pasted PAT). The token meets `gh` only in this process's spawn
 * env; the agent emits a `send` and holds no GitHub credential.
 *
 * Outbound = a `message` with an `agent` (authored by a handler, not the world) on the
 * github service. Inbound messages (from ingest) carry no `agent`, so they're never re-sent.
 *
 * Echo-reconciliation (§4): `post` returns the created comment id; dispatch backfills it onto
 * the published row (`setDelivery` → `external_id` + `status.dispatched_at`). When GitHub loops
 * our own comment back through the webhook, the ingest's publish carries the SAME external_id →
 * the store's upsert MERGES into that row instead of inserting — no new event, no wake. If the
 * echo WINS the race (webhook lands before the backfill), `setDelivery` absorbs the echo row
 * into ours — the log converges to one row per artifact either way, so no author-based skip
 * (`selfLogin`) is needed anywhere.
 */

import type {
  DeliveryPatch,
  Event,
  EventId,
  MessageEvent,
  Reader,
  Subscriber,
} from "../../connector.ts";
import { createDispatcher, DispatchError, findRoot, orgFlag } from "../../connector.ts";

/** How long one post to GitHub may take, spawn to exit. */
const API_TIMEOUT_MS = 30_000;

export interface GhTarget {
  owner: string;
  repo: string;
  number: number;
}

/** Post `text` to a PR/issue thread; returns the created comment id (→ external_id, §4).
 *  `author` is the sending agent's registry name — the token resolver's key. */
export type GhPost = (
  target: GhTarget,
  text: string,
  author?: string,
) => Promise<string | undefined>;

/** Replace or take back a comment we posted — `PATCH`/`DELETE` on the comment by its id.
 *  Neither mints a new id: the edit IS the original comment, so nothing backfills. */
export type GhAmend = (
  target: GhTarget,
  amend: { id: string; action: "edit" | "delete"; text: string },
  author?: string,
) => Promise<void>;

export interface GithubDispatchDeps {
  subscribe: Subscriber["subscribe"];
  post: GhPost;
  /** Absent = this deployment cannot edit or delete: the send stamps `failed`, so the
   *  agent learns its correction never landed. */
  amend?: GhAmend;
  /** Delivery bookkeeping — bind the log's `setDelivery`. Backfills `external_id` (the echo
   *  key, prefixed like the ingest stamps it) + `status.dispatched_at` after a post. */
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  read: Reader["read"];
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, externalId: string | undefined) => void;
}

/** Wire dispatch to the log — the shared loop (`dispatcher.ts` via the connector seam)
 *  over two legs: a comment posts and its id backfills `external_id`; an edit/delete
 *  amends the comment it refers to. Returns stop. */
export function createGithubDispatch(deps: GithubDispatchDeps): () => Promise<void> {
  return createDispatcher<Outbound>({
    subscribe: deps.subscribe,
    service: "github",
    select: outbound,
    read: deps.read,
    setDelivery: deps.setDelivery,
    onError: deps.onError,
    onSent: deps.onSent,
    post: async ({ target, text, re }, event) => {
      const action = event.payload?.action;
      if (action === "edit" || action === "delete") {
        if (!re) throw new DispatchError(`a ${action} needs the comment it acts on`, 400);
        if (!deps.amend) throw new DispatchError("this connection cannot edit", 400);
        await deps.amend(target, { id: re, action, text }, event.agent?.id);
        // the edit keeps the original comment id: there is no new artifact to converge on
        return {};
      }
      const externalId = await deps.post(target, text, event.agent?.id);
      return {
        id: externalId,
        ...(externalId !== undefined ? { external_id: `gh:${externalId}` } : {}),
      };
    },
  });
}

interface Outbound {
  target: GhTarget;
  text: string;
  /** The referent's comment id — what an edit or delete acts on. */
  re?: string;
}

/** Parse `owner/repo#N` + gather the text; null if unaddressable, or empty on anything
 *  but a delete (which carries no text by construction). */
function outbound(e: MessageEvent): Outbound | null {
  const m = e.envelope.conversation.address.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  const target = { owner: m[1], repo: m[2], number: Number(m[3]) };
  const re = commentIdOf(e.payload?.ref_external_id);
  const text = textOf(e);
  if (e.payload?.action === "delete") return { target, text: "", re };
  if (!text) return null;
  return { target, text, re };
}

/** `gh:<comment id>` → the id the API takes. A reference minted anywhere else (another
 *  service, a delivery guid, a local row) names no comment here. */
function commentIdOf(externalId?: string): string | undefined {
  if (!externalId?.startsWith("gh:")) return undefined;
  const id = externalId.slice("gh:".length);
  return id.length > 0 ? id : undefined;
}

function textOf(e: Event): string {
  const parts = (e as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => (p as { type?: unknown }).type === "text")
    .map((p) => (p as { text?: unknown }).text)
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/* ── local entry: `post` shells `gh`, the resolved token issued into its spawn env ─────── */

/** The vault key that posts for `author` (§4): the author's own grant when `row` holds a
 *  credential in either shape — a static PAT rides `token`, a device-flow grant rides
 *  `access_token` (the broker refreshes it) — else the org's. */
export function grantKeyFor(
  author: string | undefined,
  row:
    | { value: { token?: string; access_token?: string; [slot: string]: string | undefined } }
    | null,
): string {
  const own = author !== undefined && !!(row?.value.token || row?.value.access_token);
  return own ? `github:${author}` : "github:org";
}

/** Wire the outbound half over the org's log — resident once it returns (subscribed).
 *  Returns stop: unsubscribe, settle the posts in flight, release the handles. */
export async function runDispatch(): Promise<() => Promise<void>> {
  const { openLog, openCredentials, createGrantBroker } = await import("../../connector.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });

  // the token resolver (§4, dispatcher-internal): the author's own grant (alter-ego)
  // → the org's — through the broker, which returns a static PAT as-is and mints the
  // App's hourly installation token when that is what `github:org` records
  const tokenFor = async (author?: string): Promise<string> => {
    const user = author ? await creds.get(`github:${author}`) : null;
    const key = grantKeyFor(author, user);
    const token = await broker.accessTokenFor(broker.issue(key, user?.agentId));
    if (!token) throw new Error(`no github credential for ${key} — \`liquen connect github\``);
    return token;
  };

  // one `gh api` call; returns its stdout (the JSON body, empty on a 204)
  const ghApi = async (args: string[], author?: string): Promise<string> => {
    const out = await new Deno.Command("gh", {
      args: ["api", ...args],
      env: { GH_TOKEN: await tokenFor(author) }, // gh's env, this spawn only — never exported
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(API_TIMEOUT_MS), // a stalled gh fails like a refused post
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim());
    return new TextDecoder().decode(out.stdout);
  };

  const ghPost: GhPost = async ({ owner, repo, number }, text, author) => {
    const body = await ghApi(
      [
        "--method",
        "POST",
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "-f",
        `body=${text}`,
      ],
      author,
    );
    const created = JSON.parse(body) as { id?: number };
    return created.id !== undefined ? String(created.id) : undefined;
  };

  // the amend leg addresses ISSUE comments — a PR is an issue, so the comments the post
  // leg creates on either thread live under this one endpoint
  const ghAmend: GhAmend = async ({ owner, repo }, { id, action, text }, author) => {
    const path = `repos/${owner}/${repo}/issues/comments/${id}`;
    await ghApi(
      action === "edit"
        ? ["--method", "PATCH", path, "-f", `body=${text}`]
        : ["--method", "DELETE", path],
      author,
    );
  };

  const stop = createGithubDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    post: ghPost,
    amend: ghAmend,
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (comment ${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  if (!(await creds.get("github:org"))) {
    console.error(
      "[dispatch] WARNING: no github:org in the vault (`liquen connect github bot`) — " +
        "posts fall back to authors' own grants",
    );
  }
  console.error(`[dispatch] watching ${dir}/log for outbound sends`);
  return async () => {
    await stop();
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) await runDispatch();
