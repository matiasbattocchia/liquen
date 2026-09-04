/**
 * connectors/github/dispatch.ts — the DISPATCH half of the GitHub connection (open-bsp).
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
  Subscriber,
} from "../../src/connector.ts";
import { createDispatcher, findRoot } from "../../src/connector.ts";

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

export interface GithubDispatchDeps {
  subscribe: Subscriber["subscribe"];
  post: GhPost;
  /** Delivery bookkeeping — bind the log's `setDelivery`. Backfills `external_id` (the echo
   *  key, prefixed like the ingest stamps it) + `status.dispatched_at` after a post. */
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  from?: EventId; // catch up after this id; omit ⇒ live only
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, externalId: string | undefined) => void;
}

/** Wire dispatch to the log — the shared loop (`dispatcher.ts` via the connector seam)
 *  over one leg: a comment posts, its id backfills `external_id`. Returns stop. */
export function createGithubDispatch(deps: GithubDispatchDeps): () => Promise<void> {
  return createDispatcher<Outbound>({
    subscribe: deps.subscribe,
    service: "github",
    select: outbound,
    from: deps.from,
    setDelivery: deps.setDelivery,
    onError: deps.onError,
    onSent: deps.onSent,
    post: async ({ target, text }, event) => {
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
}

/** Parse `owner/repo#N` + gather the text; null if unaddressable or empty. */
function outbound(e: MessageEvent): Outbound | null {
  const m = e.envelope.conversation.address.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  const text = textOf(e);
  if (!text) return null;
  return { target: { owner: m[1], repo: m[2], number: Number(m[3]) }, text };
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

/** Wire the outbound half over the org's log — resident once it returns (subscribed).
 *  Returns stop: unsubscribe, settle the posts in flight, release the handles. */
export async function runDispatch(): Promise<() => Promise<void>> {
  const { openLog, openCredentials, createGrantBroker } = await import("../../src/connector.ts");
  const root = findRoot();
  const dir = `${root}/data`;
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const broker = createGrantBroker({ creds });

  // the token resolver (§4, dispatcher-internal): the author's own grant (alter-ego)
  // → the org's — through the broker, which returns a static PAT as-is and mints the
  // App's hourly installation token when that is what `github:org` records
  const tokenFor = async (author?: string): Promise<string> => {
    const user = author ? await creds.get(`github:${author}`) : null;
    const key = user?.value.token ? `github:${author}` : "github:org";
    const token = await broker.accessTokenFor(broker.issue(key, user?.agentId));
    if (!token) throw new Error(`no github credential for ${key} — \`mu connect github\``);
    return token;
  };

  const ghPost: GhPost = async ({ owner, repo, number }, text, author) => {
    const out = await new Deno.Command("gh", {
      args: [
        "api",
        "--method",
        "POST",
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "-f",
        `body=${text}`,
      ],
      env: { GH_TOKEN: await tokenFor(author) }, // gh's env, this spawn only — never exported
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(API_TIMEOUT_MS), // a stalled gh fails like a refused post
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim());
    const created = JSON.parse(new TextDecoder().decode(out.stdout)) as { id?: number };
    return created.id !== undefined ? String(created.id) : undefined;
  };

  const stop = createGithubDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post: ghPost,
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (comment ${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  if (!(await creds.get("github:org"))) {
    console.error(
      "[dispatch] WARNING: no github:org in the vault (`mu connect github bot`) — " +
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
