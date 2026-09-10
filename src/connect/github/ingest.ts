/**
 * src/connect/github/ingest.ts — the GitHub ingest as a portable webhook FUNCTION (open-bsp shape).
 *
 * ONE handler, `(Request) => Response`, built from Web-standard APIs only
 * (`Request`/`Response`/`crypto.subtle`). Everything it needs is INJECTED — the log `publish`,
 * the HMAC secret, identity/config — via `createGithubWebhook(deps)`. That injection is the
 * point: the SAME verify → dedupe → map pipeline publishes to the local SQLite log and to
 * Postgres on edge, just by swapping `publish` (the edge substrate really is different). The
 * runnable local server lives at the bottom under `import.meta.main`; an edge function is the
 * same three lines (Supabase `Deno.serve(handler)`), with `publish` writing to Postgres.
 *
 * It is the ingest HALF of a connection (§4, §7): receive → verify → dedupe → map → publish.
 * Dispatch (posting back to GitHub) is a separate concern — the agent driving `gh`, or a
 * credential broker (§4, §9) — never this function.
 *
 * Security (§9): the secret is verified here, at the boundary; the delivery id dedupes GitHub's
 * retries; and every payload is treated as untrusted input. This function holds NO credential
 * that can write to GitHub — it only reads the shared webhook secret and writes to the log.
 */

import { DEFAULT_EVENTS } from "./config.ts";
import type { Appender, Draft, MessageEvent, Part } from "../../connector.ts";
import { findRoot, orgFlag } from "../../connector.ts";
import { entry } from "../../entry.ts";

export interface GithubWebhookDeps {
  /** → the EventLog (the connection's only write). Bind liquen's `log.publish`. */
  publish: Appender["publish"];
  /** HMAC secret. If set, `X-Hub-Signature-256` is REQUIRED and verified; if absent, unsigned
   *  deliveries are accepted (dev only — `gh webhook forward` without `--secret`). */
  secret?: string;
  /** Connection address on the envelope (the installation/owner). Default `"github"`. */
  connection?: string;
  /** Event-type allowlist (the `X-GitHub-Event` header). Default: the PR/issue set below. */
  events?: string[];
  now?: () => string; // ts source — injectable for tests
}

export type WebhookHandler = (req: Request) => Promise<Response>;

/** Build the ingest handler. Pure over its deps — call once, serve the result anywhere. */
export function createGithubWebhook(deps: GithubWebhookDeps): WebhookHandler {
  const connection = deps.connection ?? "github";
  const allow = new Set(deps.events ?? DEFAULT_EVENTS);
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req) => {
    if (req.method !== "POST") return text(405, "method not allowed");
    const event = req.headers.get("x-github-event") ?? "";
    const delivery = req.headers.get("x-github-delivery") ?? "";
    const sig = req.headers.get("x-hub-signature-256");
    const body = await req.text(); // the RAW bytes GitHub signed — verify BEFORE parsing

    // 1. verify (boundary check) — a missing/bad signature never reaches the log
    if (deps.secret) {
      if (!sig || !(await verify(deps.secret, body, sig))) return text(401, "bad signature");
    }
    // 2. cheap acks that never touch the log: the setup ping, and out-of-scope events
    if (event === "ping") return text(200, "pong");
    if (!allow.has(event)) return text(202, `ignored event: ${event}`);

    let payload: GhPayload;
    try {
      payload = JSON.parse(body) as GhPayload;
    } catch {
      return text(400, "invalid json");
    }

    // 3. map → a liquen `message`, stamped with `envelope.external_id` (null = a loopback or an
    //    uninteresting action). Dedupe is the STORE's job: `publish` upserts on external_id,
    //    so a retried delivery, an edit, or our own dispatched comment echoing back all MERGE
    //    into the existing row — no new event, no wake (§4, §9).
    const msg = mapEvent(event, payload, { connection, now, delivery });
    if (!msg) return text(202, "ignored");
    try {
      await deps.publish(msg);
    } catch {
      return text(500, "publish failed");
    }
    return text(202, "accepted");
  };
}

/* ── mapping: GitHub event → a liquen message in `owner/repo#N` ────────────── */

interface MapCtx {
  connection: string;
  now: () => string;
  delivery: string;
}

/** Turn a delivery into a `message` addressed to the PR/issue thread, or null to ignore.
 *  No author-based self-skip: our own actions echoing back reconcile STRUCTURALLY — the
 *  external_id upsert merges them into the row dispatch backfilled (and `setDelivery`
 *  absorbs the echo if it wins the race), so no new event, no wake (§4). Out-of-band
 *  actions by the bot account (posted outside our dispatch) flow in as ordinary messages —
 *  the agent seeing what its own account did elsewhere is correct, not a loop. */
function mapEvent(event: string, p: GhPayload, ctx: MapCtx): Draft<MessageEvent> | null {
  const login = p.sender?.login;
  const repo = p.repository?.full_name;
  if (!repo) return null;

  const built = describe(event, p);
  if (!built || built.number === undefined) return null;
  const { number, part, title, url } = built;

  return {
    ts: ctx.now(),
    type: "message",
    envelope: {
      service: "github",
      connection_address: ctx.connection,
      conversation: { address: `${repo}#${number}`, ...(title ? { name: title } : {}) },
      sender: login ? { address: login, name: login } : undefined,
      // the upsert/merge key (§3, §4): the platform ARTIFACT id where one exists (a comment,
      // a review — retries and edits merge into the same row, and our own dispatched comment
      // loops back onto the row dispatch backfilled); the DELIVERY guid for lifecycle events
      // (opened/reopened are not artifacts — the guid still retry-dedupes, and each action is
      // a distinct delivery so it correctly stays a distinct row).
      external_id: built.externalId !== undefined
        ? `gh:${built.externalId}`
        : `ghd:${ctx.delivery}`,
    },
    parts: [part],
    extra: {
      // the dispatch side reads extra.github to know WHERE and HOW to reply (§4)
      github: {
        event,
        action: p.action,
        delivery: ctx.delivery,
        repo,
        number,
        ...(url ? { url } : {}),
      },
    },
  };
}

interface Built {
  number?: number;
  part: Part;
  title?: string;
  url?: string;
  externalId?: number; // the platform artifact id (comment/review), when the event maps to one
}

/** Per-event action filter + the PART the delivery becomes. Only the actions worth waking on.
 *
 *  The split every connector makes (§5): what a machine keys on is `data`, what a human wrote
 *  is `text` — never the same words in both. A comment is pure prose, so it stays a text part
 *  and renders as a plain `<msg>`; the rest carry a scrap of structure their prose can't say —
 *  a review's verdict, the file a code comment hangs on, whether a PR was opened or reopened —
 *  and render as their kind: `<review data="{state:'approved'}">LGTM</review>`.
 *
 *  What the ENVELOPE already carries is never repeated here: the repo and number are the
 *  conversation's address (`ana/widgets#42`), the PR/issue title is its name, and the url and
 *  wire action ride `extra.github` for dispatch. */
function describe(event: string, p: GhPayload): Built | null {
  switch (event) {
    case "issue_comment": // fires for PR comments too (a PR is an issue)
      if (p.action !== "created") return null;
      return {
        number: p.issue?.number,
        title: p.issue?.title,
        part: { type: "text", kind: "text", text: p.comment?.body ?? "" },
        url: p.comment?.html_url,
        externalId: p.comment?.id,
      };
    case "pull_request_review_comment": {
      if (p.action !== "created") return null;
      // where it hangs is structure; the remark itself is prose
      const anchor: Record<string, string | number> = {};
      if (p.comment?.path) anchor.path = p.comment.path;
      if (p.comment?.line !== undefined) anchor.line = p.comment.line;
      return {
        number: p.pull_request?.number,
        part: {
          type: "data",
          kind: "review_comment",
          data: anchor,
          text: p.comment?.body ?? "",
        },
        url: p.comment?.html_url,
        externalId: p.comment?.id,
      };
    }
    case "pull_request_review":
      if (p.action !== "submitted") return null;
      return {
        number: p.pull_request?.number,
        // the verdict is the point — an approval with no words is a whole event
        part: {
          type: "data",
          kind: "review",
          data: { state: p.review?.state ?? "commented" },
          ...(p.review?.body ? { text: p.review.body } : {}),
        },
        url: p.review?.html_url,
        externalId: p.review?.id,
      };
    case "pull_request":
      if (!["opened", "reopened", "ready_for_review"].includes(p.action ?? "")) return null;
      return {
        number: p.pull_request?.number ?? p.number,
        title: p.pull_request?.title,
        part: {
          type: "data",
          kind: "pr",
          data: { state: p.action! }, // opened ≠ reopened ≠ ready_for_review
          ...(p.pull_request?.body ? { text: p.pull_request.body } : {}),
        },
        url: p.pull_request?.html_url,
      };
    case "issues":
      if (!["opened", "reopened"].includes(p.action ?? "")) return null;
      return {
        number: p.issue?.number,
        title: p.issue?.title,
        part: {
          type: "data",
          kind: "issue",
          data: { state: p.action! },
          ...(p.issue?.body ? { text: p.issue.body } : {}),
        },
        url: p.issue?.html_url,
      };
    default:
      return null;
  }
}

/* ── HMAC verification (Web-standard, constant-time) ──────────────────── */

const encoder = new TextEncoder();

/** Verify GitHub's `sha256=…` HMAC over the raw body. crypto.subtle → runs on edge too. */
async function verify(secret: string, body: string, header: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`sha256=${hex}`, header);
}

/** Length-independent comparison — never leak where two hex digests diverge. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── the payload shape we read (loose; GitHub sends far more) ──────────── */

interface GhUser {
  login?: string;
  type?: string;
}
interface GhPayload {
  action?: string;
  number?: number;
  repository?: { full_name?: string };
  sender?: GhUser;
  issue?: { number?: number; title?: string; body?: string; html_url?: string };
  pull_request?: { number?: number; title?: string; body?: string; html_url?: string };
  comment?: { id?: number; body?: string; path?: string; line?: number; html_url?: string };
  review?: { id?: number; body?: string; state?: string; html_url?: string };
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── local entry: the thin Deno server (the edge wrapper is the same shape) ────────────
 *
 *   deno task run:github        # serves on :8788, publishing into the org log (./data)
 *   gh webhook forward --repo=you/repo \
 *     --events=issue_comment,pull_request,pull_request_review_comment \
 *     --url=http://localhost:8788/        # dev: add --secret matching the app row's
 *
 * The harness (`deno task cli`) on the SAME data root turns a PR comment into a poke.
 * The secret is the app row's (`liquen connect github app` → vault `github:app:<id>`); the
 * knobs are connections.github. Env: none. The store import is dynamic so importing
 * `createGithubWebhook` (e.g. from an edge function) never pulls in file I/O. */
/** Wire the inbound half over the org's log — resident once it returns (serving).
 *  Returns stop: refuse new deliveries, finish the ones in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openLog, openCredentials } = await import("../../connector.ts");
  const { githubConfig } = await import("./config.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const { ingestPort: port, events } = await githubConfig(root);
  const creds = await openCredentials(dir);
  const secret = (await creds.list("github:app:")).find((a) => a.value.webhook_secret)
    ?.value.webhook_secret;
  await creds.close(); // one read at boot — the ingest holds no vault handle while serving

  const log = await openLog(`${dir}/log`);
  if (!secret) {
    console.error(
      "[ingest] WARNING: no webhook secret in the vault (`liquen connect github app`) — " +
        "accepting UNSIGNED deliveries (dev only)",
    );
  }
  const { serveIngest } = await import("../../connector.ts");
  // `log.publish` passed straight through — a wrapper lambda would flatten its overloads
  const server = serveIngest(
    "connections.github.ingestPort",
    port,
    createGithubWebhook({ publish: log.publish, secret, events }),
    (bound) =>
      console.error(
        `[ingest] serving :${bound} → ${dir}/log  (gh webhook forward --url=http://localhost:${bound}/)`,
      ),
  );
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await log.close();
  };
}

if (import.meta.main) await entry(runIngest);
