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
import type { Appender, Draft, Json, MessageEvent, Part } from "../../connector.ts";
import { findRoot, orgFlag } from "../../connector.ts";
import { entry } from "../../entry.ts";
import { roomPart } from "../../room.ts";
import type { Payload, RoomChange, RoomMember } from "../../types.ts";

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

    // 3. map → liquen `message`s, each stamped with `envelope.external_id` (none = an
    //    uninteresting action). Dedupe is the STORE's job: `publish` upserts on external_id,
    //    so a retried delivery, an edit, or our own dispatched comment echoing back all MERGE
    //    into the existing row — no new event, no wake (§4, §9).
    const msgs = mapEvent(event, payload, { connection, now, delivery });
    if (!msgs.length) return text(202, "ignored");
    try {
      for (const msg of msgs) await deps.publish(msg);
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

/** Turn a delivery into `message`s addressed to the issue, PR or discussion, or none to
 *  ignore. No author-based self-skip: our own actions echoing back reconcile STRUCTURALLY —
 *  the external_id upsert merges them into the row dispatch backfilled (and `setDelivery`
 *  absorbs the echo if it wins the race), so no new event, no wake (§4). Out-of-band
 *  actions by the bot account (posted outside our dispatch) flow in as ordinary messages —
 *  the agent seeing what its own account did elsewhere is correct, not a loop. */
function mapEvent(event: string, p: GhPayload, ctx: MapCtx): Draft<MessageEvent>[] {
  const login = p.sender?.login;
  const repo = p.repository?.full_name;
  if (!repo) return [];

  return describe(event, p, repo).flatMap((built, i) => {
    const { number, part, title, url, payload } = built;
    if (number === undefined) return [];
    return [{
      ts: ctx.now(),
      type: "message" as const,
      ...(payload ? { payload } : {}),
      envelope: {
        service: "github",
        connection_address: ctx.connection,
        conversation: { address: `${repo}#${number}`, ...(title ? { name: title } : {}) },
        sender: login ? { address: login, name: login } : undefined,
        // the upsert/merge key (§3, §4): the platform ARTIFACT id where one exists (a
        // comment, a review — retries and edits merge into the same row, and our own
        // dispatched comment loops back onto the row dispatch backfilled); the conversation's
        // own address for its opening, which a later body edit names; the DELIVERY guid for
        // everything else, a room line or an edit (each action is a distinct delivery, so it
        // stays a distinct row). One delivery saying two things — a title and a body edited
        // at once — keys the second on the guid and its place.
        external_id: built.externalId !== undefined
          ? `gh:${built.externalId}`
          : i === 0
          ? `ghd:${ctx.delivery}`
          : `ghd:${ctx.delivery}:${i}`,
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
    }];
  });
}

interface Built {
  number?: number;
  part: Part;
  title?: string;
  url?: string;
  /** The platform artifact id (comment, review), or the conversation's address for its
   *  opening, when the message is one; absent, the delivery keys it. */
  externalId?: number | string;
  /** An edit's or a room line's reference: the message it acts on or is said of. */
  payload?: Payload;
}

/** Per-event action filter + what the delivery becomes.
 *
 *  The split every connector makes (§5): what a machine keys on is `data`, what a human wrote
 *  is `text` — never the same words in both. A comment is pure prose, so it stays a text part
 *  and renders as a plain `<msg>`; the rest carry a scrap of structure their prose can't say —
 *  a review's verdict, the file a code comment hangs on, an opening's state — and render as
 *  their kind: `<review data="{state:'approved'}">LGTM</review>`.
 *
 *  Everything said ABOUT the conversation rather than in it — closed, merged, relabeled,
 *  retitled, linked to another issue — is a room line (`roomLine`): the change alone, from
 *  whoever made it, which informs and never wakes (§3). An edited body is the opening's
 *  edit, since the body is the opening's words.
 *
 *  What the ENVELOPE already carries is never repeated here: the repo and number are the
 *  conversation's address (`ana/widgets#42`), the PR/issue title is its name, and the url and
 *  wire action ride `extra.github` for dispatch. */
function describe(event: string, p: GhPayload, repo: string): Built[] {
  const action = p.action ?? "";
  switch (event) {
    case "issue_comment": // fires for PR comments too (a PR is an issue)
      if (action === "pinned" || action === "unpinned") {
        return [roomLine(p.issue, { pinned: action === "pinned" }, action, p.comment?.id)];
      }
      if (action !== "created") return [];
      return [{
        number: p.issue?.number,
        title: p.issue?.title,
        part: { type: "text", kind: "text", text: p.comment?.body ?? "" },
        url: p.comment?.html_url,
        externalId: p.comment?.id,
      }];
    case "pull_request_review_comment": {
      if (action !== "created") return [];
      // where it hangs is structure; the remark itself is prose
      const anchor: Record<string, string | number> = {};
      if (p.comment?.path) anchor.path = p.comment.path;
      if (p.comment?.line !== undefined) anchor.line = p.comment.line;
      return [{
        number: p.pull_request?.number,
        part: {
          type: "data",
          kind: "review_comment",
          data: anchor,
          text: p.comment?.body ?? "",
        },
        url: p.comment?.html_url,
        externalId: p.comment?.id,
      }];
    }
    case "pull_request_review":
      if (action === "dismissed") {
        return [roomLine(p.pull_request, { review: { dismissed: true } }, action, p.review?.id)];
      }
      if (action !== "submitted") return [];
      return [{
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
      }];
    case "pull_request_review_thread":
      // a thread is named by its first remark, the review comment that opened it
      if (action !== "resolved" && action !== "unresolved") return [];
      return [
        roomLine(
          p.pull_request,
          { resolved: action === "resolved" },
          action,
          p.thread?.comments?.[0]?.id,
        ),
      ];
    case "pull_request": {
      const pr = p.pull_request && { ...p.pull_request, number: p.pull_request.number ?? p.number };
      return conversation("pr", pr, p, repo);
    }
    case "issues":
      return conversation("issue", p.issue, p, repo);
    case "discussion":
      return conversation("discussion", p.discussion, p, repo);
    case "sub_issues":
    case "issue_dependencies":
    case "issue_relates_to":
      return [tie(event, p)];
    default:
      return [];
  }
}

/** An issue's, a pull request's or a discussion's own delivery. Its opening carries the
 *  body, words, so it is a message, keyed on the conversation's address; an edited body is
 *  that message's edit (§3); anything else is a room line. */
function conversation(
  kind: "issue" | "pr" | "discussion",
  on: GhThread | undefined,
  p: GhPayload,
  repo: string,
): Built[] {
  const action = p.action ?? "";
  if (action === "opened" || action === "created") return [opening(kind, on, repo)];
  if (action === "edited") {
    // `changes` holds each edited field's old value; a retitle is the room's, a new body
    // the opening's, and any other field (a pull request's base) says itself by name
    const { title, body, ...other } = p.changes ?? {};
    const lines = title || Object.keys(other).length
      ? [
        roomLine(on, {
          name: title ? on?.title : undefined,
          was: title?.from,
          changed: Object.keys(other),
        }, action),
      ]
      : [];
    if (!body) return lines;
    const { externalId, ...said } = opening(kind, on, repo);
    return [...lines, {
      ...said,
      payload: { action: "edit", ref_external_id: `gh:${externalId}` },
    }];
  }
  // answered names the answer; unanswered, the comment that was one
  return [roomLine(on, changeOf(action, p, on), action, (p.answer ?? p.old_answer)?.id)];
}

/** The opening: an issue or a pull request opened, a discussion created. The state says it
 *  is the opening; a discussion's category is structure its body cannot say. */
function opening(
  kind: "issue" | "pr" | "discussion",
  on: GhThread | undefined,
  repo: string,
): Built {
  return {
    number: on?.number,
    title: on?.title,
    part: {
      type: "data",
      kind,
      data: { state: "opened", ...(on?.category?.name ? { category: on.category.name } : {}) },
      ...(on?.body ? { text: on.body } : {}),
    },
    url: on?.html_url,
    externalId: `${repo}#${on?.number}`,
  };
}

/** What an action on an issue, a pull request or a discussion says, as the room's change.
 *  The three share most of their actions, so one table reads them all. */
function changeOf(action: string, p: GhPayload, on: GhThread | undefined): RoomChange {
  switch (action) {
    case "closed":
      // a pull request merges by closing; an issue or a discussion closes with a reason
      // (completed, not_planned, duplicate, resolved, outdated)
      if (p.pull_request?.merged) return { state: "merged" };
      return {
        state: "closed",
        fields: on?.state_reason ? { state_reason: on.state_reason } : undefined,
      };
    case "reopened":
    case "locked":
    case "unlocked":
    case "deleted":
      return { state: action };
    case "converted_to_draft":
      return { state: "draft" };
    case "ready_for_review":
      return { state: "ready" };
    case "enqueued":
      return { state: "queued" };
    case "dequeued":
      return { state: "dequeued" };
    case "pinned":
    case "unpinned":
      return { pinned: action === "pinned" };
    case "labeled":
      return { labels: { added: p.label?.name ? [p.label.name] : [] } };
    case "unlabeled":
      return { labels: { removed: p.label?.name ? [p.label.name] : [] } };
    case "assigned":
      return { assigned: members(p.assignee) };
    case "unassigned":
      return { unassigned: members(p.assignee) };
    case "milestoned":
      return { milestone: p.milestone?.title };
    case "demilestoned":
      return { milestone: "" };
    case "typed":
      return { type: p.type?.name };
    case "untyped":
      return { type: "" };
    case "field_added":
    case "field_removed":
      // the field's value as GitHub words it; `""` once cleared
      return p.issue_field?.name
        ? {
          fields: {
            [p.issue_field.name]: action === "field_added" ? p.issue_field_value?.value ?? "" : "",
          },
        }
        : {};
    case "review_requested":
    case "review_request_removed": {
      const who = [
        ...members(p.requested_reviewer),
        ...(p.requested_team?.slug
          ? [{ address: p.requested_team.slug, name: p.requested_team.name }]
          : []),
      ];
      return { review: action === "review_requested" ? { requested: who } : { removed: who } };
    }
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return { settings: { auto_merge: action === "auto_merge_enabled" } };
    case "synchronize":
      // the push names the head it moved to, not how many commits came with it:
      // `commits` is the pull request's count after it
      return { pushed: { commits: p.pull_request?.commits ?? 0, head: p.after?.slice(0, 7) } };
    case "transferred": {
      const to = p.changes?.new_issue ?? p.changes?.new_discussion;
      return to ? { moved: { to: addressOf(to, p.changes?.new_repository) } } : {};
    }
    case "category_changed":
      return { category: on?.category?.name };
    case "answered":
    case "unanswered":
      return { answered: action === "answered" };
    default:
      return {};
  }
}

/** A tie between two issues: a sub-issue and its parent, a dependency, a relation. Each
 *  delivery is for one side — the parent gaining a sub-issue, the sub-issue gaining a
 *  parent, the blocked issue and the blocking one — so the line stands in that side's
 *  issue and names the other, as GitHub says it. */
function tie(event: string, p: GhPayload): Built {
  const action = p.action ?? "";
  const [on, other, otherRepo, as]: [GhThread?, GhThread?, GhRepo?, string?] =
    event === "sub_issues"
      ? action.startsWith("sub_issue")
        ? [p.parent_issue, p.sub_issue, p.sub_issue_repo, "sub"]
        : [p.sub_issue, p.parent_issue, p.parent_issue_repo, "parent"]
      : event === "issue_dependencies"
      ? action.startsWith("blocked_by")
        ? [p.blocked_issue, p.blocking_issue, p.blocking_issue_repo, "blocked_by"]
        : [p.blocking_issue, p.blocked_issue, p.blocked_issue_repo, "blocks"]
      : [p.issue, p.related_issue, undefined, "related"];
  // a relation across repositories reaches each side without the other's details
  const links = other ? [{ address: addressOf(other, otherRepo), name: other.title, as }] : [];
  return roomLine(on, action.endsWith("_added") ? { linked: links } : { unlinked: links }, action);
}

/** A room line (§3): the change alone, in the conversation it happened to. `ref` is the
 *  message it is said of — a dismissed review, a pinned comment, a resolved thread's first
 *  remark, an answer. A change this cannot name, or one the payload leaves empty, still
 *  says itself in GitHub's word: never silent. */
function roomLine(
  on: GhThread | undefined,
  change: RoomChange,
  action: string,
  ref?: number,
): Built {
  const part = roomPart(change);
  return {
    number: on?.number,
    title: on?.title,
    url: on?.html_url,
    part: Object.keys(part.data).length ? part : roomPart({ changed: [action] }),
    ...(ref !== undefined ? { payload: { ref_external_id: `gh:${ref}` } } : {}),
  };
}

function members(u: GhUser | null | undefined): RoomMember[] {
  return u?.login ? [{ address: u.login, name: u.login }] : [];
}

/** Another issue's address, `owner/repo#N`: its repository as the payload names it, else
 *  as its API url does (`…/repos/owner/repo`). */
function addressOf(issue: GhThread, repo?: GhRepo): string {
  return `${repo?.full_name ?? issue.repository_url?.split("/repos/")[1]}#${issue.number}`;
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
interface GhRepo {
  full_name?: string;
}
/** An issue, a pull request or a discussion: the conversation. */
interface GhThread {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  repository_url?: string;
  state_reason?: string | null;
  merged?: boolean;
  commits?: number;
  category?: { name?: string };
}
interface GhPayload {
  action?: string;
  number?: number;
  repository?: GhRepo;
  sender?: GhUser;
  issue?: GhThread;
  pull_request?: GhThread;
  discussion?: GhThread;
  comment?: { id?: number; body?: string; path?: string; line?: number; html_url?: string };
  review?: { id?: number; body?: string; state?: string; html_url?: string };
  /** An edit's old values, field by field; a transfer's new home. */
  changes?: {
    title?: { from?: string };
    body?: { from?: string | null };
    new_issue?: GhThread;
    new_discussion?: GhThread;
    new_repository?: GhRepo;
    [field: string]: unknown;
  };
  label?: { name?: string };
  assignee?: GhUser | null;
  milestone?: { title?: string };
  type?: { name?: string } | null;
  issue_field?: { name?: string };
  issue_field_value?: { value?: Json };
  requested_reviewer?: GhUser | null;
  requested_team?: { name?: string; slug?: string };
  after?: string;
  thread?: { comments?: { id?: number }[] };
  answer?: { id?: number };
  old_answer?: { id?: number };
  parent_issue?: GhThread;
  parent_issue_repo?: GhRepo;
  sub_issue?: GhThread;
  sub_issue_repo?: GhRepo;
  blocked_issue?: GhThread;
  blocked_issue_repo?: GhRepo;
  blocking_issue?: GhThread;
  blocking_issue_repo?: GhRepo;
  related_issue?: GhThread;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/* ── local entry: the thin Deno server (the edge wrapper is the same shape) ────────────
 *
 *   deno task run:github        # serves data/run/github.sock, publishing into the org log
 *   gh webhook forward --repo=you/repo \
 *     --events=issue_comment,pull_request,pull_request_review_comment \
 *     --url=http://localhost:8787/github/ingest   # the edge; dev: add --secret (the app row's)
 *
 * The harness (`deno task cli`) on the SAME data root turns a PR comment into a poke.
 * The secret is the app row's (`liquen connect github app` → vault `github:app:<id>`); the
 * knobs are connections.github. Env: none. The store import is dynamic so importing
 * `createGithubWebhook` (e.g. from an edge function) never pulls in file I/O. */
/** Wire the inbound half over the org's log — resident once it returns (serving).
 *  Returns stop: refuse new deliveries, finish the ones in flight, release the handles. */
export async function runIngest(): Promise<() => Promise<void>> {
  const { openStore } = await import("../../connector.ts");
  const { githubConfig } = await import("./config.ts");
  const root = findRoot(orgFlag());
  const dir = `${root}/data`;
  const store = await openStore(root);
  const { events } = await githubConfig(root);
  const creds = await store.vault();
  const secret = (await creds.list("github:app:")).find((a) => a.value.webhook_secret)
    ?.value.webhook_secret;
  await creds.close(); // one read at boot — the ingest holds no vault handle while serving

  const log = await store.log();
  if (!secret) {
    console.error(
      "[ingest] WARNING: no webhook secret in the vault (`liquen connect github app`) — " +
        "accepting UNSIGNED deliveries (dev only)",
    );
  }
  const { serveIngest } = await import("../../connector.ts");
  // `log.publish` passed straight through — a wrapper lambda would flatten its overloads
  const server = await serveIngest(
    root,
    "github",
    createGithubWebhook({ publish: log.publish, secret, events }),
  );
  console.error(`[ingest] serving ${server.addr.path} → ${dir}/log`);
  return async () => {
    await server.shutdown(); // stop accepting, finish the requests already in
    await log.close();
  };
}

if (import.meta.main) await entry(runIngest);
