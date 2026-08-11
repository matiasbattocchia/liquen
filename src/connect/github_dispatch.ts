/**
 * connect/github_dispatch.ts — the DISPATCH half of the GitHub connection (open-bsp).
 *
 * The mirror of the ingest (github.ts): where ingest is world → log, dispatch is log → world.
 * It subscribes to the log, picks the agent's OUTBOUND sends on the github service
 * (conversation address `owner/repo#N`), and posts them to GitHub. Like the ingest, the substrate-specific action is
 * INJECTED — `post` shells `gh` locally (see below) and would be a `fetch` to the REST API on
 * edge — so the subscribe/parse/route logic is portable and testable.
 *
 * Credentials (§9): `post` (the `gh` process) holds the scoped write token — `pull_requests` /
 * `issues: write`, nothing more — and it lives in THIS process, never the agent's exec context.
 * The agent emits a `send`; it holds no GitHub credential.
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

import type { DeliveryPatch, Subscriber } from "../store/log.ts";
import type { Event, EventId, MessageEvent } from "../types.ts";

export interface GhTarget {
  owner: string;
  repo: string;
  number: number;
}

/** Post `text` to a PR/issue thread; returns the created comment id (→ external_id, §4). */
export type GhPost = (target: GhTarget, text: string) => Promise<string | undefined>;

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

/** Wire dispatch to the log. Returns unsubscribe. Posts are serialized to preserve order. */
export function createGithubDispatch(deps: GithubDispatchDeps): () => void {
  let chain: Promise<void> = Promise.resolve();
  return deps.subscribe(
    (e) => {
      const out = outbound(e);
      if (!out) return;
      const { target, text, event } = out;
      chain = chain.then(async () => {
        try {
          const externalId = await deps.post(target, text);
          await deps.setDelivery?.(event.id, {
            ...(externalId !== undefined ? { external_id: `gh:${externalId}` } : {}),
            status: { dispatched_at: new Date().toISOString() },
          });
          deps.onSent?.(event, externalId);
        } catch (err) {
          deps.onError?.(event, err);
        }
      });
    },
    { from: deps.from, filter: isOutboundGh },
  );
}

/** A `message` authored by a handler (`agent` present) on the github service — routing
 *  reads `envelope.service` (§3). */
function isOutboundGh(e: Event): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.service === "github";
}

interface Outbound {
  target: GhTarget;
  text: string;
  event: MessageEvent;
}

/** Parse `owner/repo#N` + gather the text; null if unaddressable or empty. */
function outbound(e: Event): Outbound | null {
  if (!isOutboundGh(e)) return null;
  const m = e.envelope.conversation.address.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  const text = textOf(e);
  if (!text) return null;
  return {
    target: { owner: m[1], repo: m[2], number: Number(m[3]) },
    text,
    event: e as MessageEvent,
  };
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

/* ── local entry: `post` shells `gh` (holds the scoped write token via GH_TOKEN) ──────── */

/** Post a comment via the `gh` CLI. `gh` reads GH_TOKEN/GITHUB_TOKEN from the env. */
const ghPost: GhPost = async ({ owner, repo, number }, text) => {
  const out = await new Deno.Command("gh", {
    args: [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${repo}/issues/${number}/comments`,
      "-f",
      `body=${text}`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim());
  const created = JSON.parse(new TextDecoder().decode(out.stdout)) as { id?: number };
  return created.id !== undefined ? String(created.id) : undefined;
};

if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const log = await openLog(`${dir}/log`);
  createGithubDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post: ghPost,
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onSent: (e, id) =>
      console.error(`[github-dispatch] sent → ${e.envelope.conversation.address} (comment ${id})`),
    onError: (e, err) =>
      console.error(`[github-dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  if (!(Deno.env.get("GH_TOKEN") || Deno.env.get("GITHUB_TOKEN"))) {
    console.error("[github-dispatch] WARNING: no GH_TOKEN/GITHUB_TOKEN — gh posts will fail");
  }
  console.error(`[github-dispatch] watching ${dir}/log for outbound github sends`);
}
