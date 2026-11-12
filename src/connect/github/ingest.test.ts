import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEFAULT_EVENTS } from "./config.ts";
import { createGithubWebhook, type WebhookHandler } from "./ingest.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../connector.ts";
import { newId } from "../../connector.ts";
import type { RoomChange } from "../../types.ts";

const SECRET = "s3cr3t";
const enc = new TextEncoder();

/** Sign a body the way GitHub does — so the handler's verify() sees a real signature. */
async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function req(
  event: string,
  payload: unknown,
  opts: { sig?: string; delivery?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
  });
  if (opts.sig !== undefined) headers.set("x-hub-signature-256", opts.sig);
  return new Request("http://localhost/", { method: "POST", body, headers });
}

/** A handler + a capture of everything it publishes. */
function harness() {
  const published: Event[] = [];
  const handler: WebhookHandler = createGithubWebhook({
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    secret: SECRET,
  });
  return { handler, published };
}

const issueComment = (over: Record<string, unknown> = {}) => ({
  action: "created",
  repository: { full_name: "ana/widgets" },
  issue: { number: 42, title: "Broken build", pull_request: {} },
  comment: {
    body: "can you look at this?",
    html_url: "https://github.com/ana/widgets/issues/42#c1",
  },
  sender: { login: "ana" },
  ...over,
});

Deno.test("github: a signed issue_comment maps to a message in owner/repo#N", async () => {
  const { handler, published } = harness();
  const body = JSON.stringify(issueComment());
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "d1",
        "x-hub-signature-256": await sign(body),
      },
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 1);
  const m = published[0] as MessageEvent;
  assertEquals(m.type, "message");
  assertEquals(m.envelope.service, "github");
  assertEquals(m.envelope.conversation.address, "ana/widgets#42");
  assertEquals(m.envelope.sender?.name, "ana");
  assertStringIncludes((m.parts[0] as { text: string }).text, "look at this");
  assertEquals((m.extra?.github as { event: string }).event, "issue_comment");
  assertEquals((m.extra?.github as { delivery: string }).delivery, "d1");
});

Deno.test("github: structure rides `data`, the human's words ride `text` (§5)", async () => {
  const { handler, published } = harness();
  const post = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    await handler(
      new Request("http://localhost/", {
        method: "POST",
        body,
        headers: {
          "x-github-event": event,
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": await sign(body),
        },
      }),
    );
    return (published.at(-1) as MessageEvent).parts[0];
  };
  const repo = { full_name: "ana/widgets" };

  // a plain comment is prose all the way down — a text part, rendering as a bare <msg>
  assertEquals(await post("issue_comment", issueComment()), {
    type: "text",
    kind: "text",
    text: "can you look at this?",
  });

  // a review: the verdict is structure, the words are the reviewer's
  assertEquals(
    await post("pull_request_review", {
      action: "submitted",
      repository: repo,
      pull_request: { number: 5 },
      review: { id: 9, state: "approved", body: "LGTM" },
      sender: { login: "ana" },
    }),
    { type: "data", kind: "review", data: { state: "approved" }, text: "LGTM" },
  );

  // an approval with NO words is still a whole event: data only, no empty text
  assertEquals(
    await post("pull_request_review", {
      action: "submitted",
      repository: repo,
      pull_request: { number: 5 },
      review: { id: 10, state: "approved" },
      sender: { login: "ana" },
    }),
    { type: "data", kind: "review", data: { state: "approved" } },
  );

  // a code comment: where it hangs is structure, the remark is prose
  assertEquals(
    await post("pull_request_review_comment", {
      action: "created",
      repository: repo,
      pull_request: { number: 5 },
      comment: { id: 11, path: "src/render.ts", line: 88, body: "why not X?" },
      sender: { login: "ana" },
    }),
    {
      type: "data",
      kind: "review_comment",
      data: { path: "src/render.ts", line: 88 },
      text: "why not X?",
    },
  );

  // a PR's opening: only what the conversation can't say, that it is the opening. The number
  // and title are the conversation's address and name; repeating them would say them twice.
  const pr = await post("pull_request", {
    action: "opened",
    repository: repo,
    pull_request: { number: 5, title: "Fix login", body: "the description" },
    sender: { login: "ana" },
  });
  assertEquals(pr, {
    type: "data",
    kind: "pr",
    data: { state: "opened" },
    text: "the description",
  });
  assertEquals((published.at(-1) as MessageEvent).envelope.conversation, {
    address: "ana/widgets#5",
    name: "Fix login",
  });
});

Deno.test("github: a bad signature is rejected before the log (401, nothing published)", async () => {
  const { handler, published } = harness();
  const res = await handler(req("issue_comment", issueComment(), { sig: "sha256=deadbeef" }));
  assertEquals(res.status, 401);
  assertEquals(published.length, 0);
});

Deno.test("github: a missing signature is rejected when a secret is set", async () => {
  const { handler, published } = harness();
  const res = await handler(req("issue_comment", issueComment())); // no sig header
  assertEquals(res.status, 401);
  assertEquals(published.length, 0);
});

Deno.test("github: ping is acked, never published", async () => {
  const { handler, published } = harness();
  const body = JSON.stringify({ zen: "Keep it logically awesome." });
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: { "x-github-event": "ping", "x-hub-signature-256": await sign(body) },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(published.length, 0);
});

Deno.test("github: external_id is stamped — artifact id for comments, the address for an opening, delivery guid otherwise", async () => {
  const { handler, published } = harness();
  // a comment: the artifact id (the store upserts on it — retries/edits/echo all merge)
  const withId = JSON.stringify(issueComment({
    comment: { id: 777, body: "hi", html_url: "https://x" },
  }));
  await handler(
    new Request("http://localhost/", {
      method: "POST",
      body: withId,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "deliv-9",
        "x-hub-signature-256": await sign(withId),
      },
    }),
  );
  assertEquals(published[0].envelope.external_id, "gh:777");
  // an opening: the conversation's address, which a later body edit names
  const opened = JSON.stringify({
    action: "opened",
    repository: { full_name: "ana/widgets" },
    pull_request: { number: 5, title: "t", body: "b" },
    sender: { login: "ana" },
  });
  await handler(
    new Request("http://localhost/", {
      method: "POST",
      body: opened,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "deliv-10",
        "x-hub-signature-256": await sign(opened),
      },
    }),
  );
  assertEquals(published[1].envelope.external_id, "gh:ana/widgets#5");
  // a room line (PR closed — not an artifact): the delivery guid still retry-dedupes
  const pr = JSON.stringify({
    action: "closed",
    repository: { full_name: "ana/widgets" },
    pull_request: { number: 5, title: "t", body: "b" },
    sender: { login: "ana" },
  });
  await handler(
    new Request("http://localhost/", {
      method: "POST",
      body: pr,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "deliv-11",
        "x-hub-signature-256": await sign(pr),
      },
    }),
  );
  assertEquals(published[2].envelope.external_id, "ghd:deliv-11");
});

Deno.test("github: no author-based self-skip — the echo is published and reconciles by external_id", async () => {
  // the bot's own comment echoing back is NOT filtered here: it carries the artifact id, and
  // the store's upsert merges it into the row dispatch backfilled (store/log.test.ts covers
  // both orders of the race). The ingest stays authorship-blind.
  const { handler, published } = harness();
  const body = JSON.stringify(issueComment({
    sender: { login: "mu-bot" },
    comment: { id: 555, body: "on it", html_url: "https://x" },
  }));
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": await sign(body) },
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 1);
  assertEquals(published[0].envelope.external_id, "gh:555"); // the merge key
});

Deno.test("github: an out-of-scope event is acked but not mapped", async () => {
  const { handler, published } = harness();
  const body = JSON.stringify({
    repository: { full_name: "ana/widgets" },
    sender: { login: "ana" },
  });
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: { "x-github-event": "star", "x-hub-signature-256": await sign(body) },
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 0);
});

Deno.test("github: an edited comment (uninteresting action) is ignored", async () => {
  const { handler, published } = harness();
  const body = JSON.stringify(issueComment({ action: "edited" }));
  const res = await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": await sign(body) },
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(published.length, 0);
});

Deno.test("github: with no secret configured, unsigned deliveries are accepted (dev mode)", async () => {
  const published: Event[] = [];
  const handler = createGithubWebhook({
    // the store's `publish` in miniature: it mints the id (§3). Cast because the fake only
    // implements the single-draft overload — a connection never publishes a batch.
    publish: ((e: Draft) => {
      const stored = { ...e, id: e.id ?? newId() } as Event;
      published.push(stored);
      return Promise.resolve(stored);
    }) as Appender["publish"],
    // no secret
  });
  const res = await handler(req("issue_comment", issueComment()));
  assertEquals(res.status, 202);
  assertEquals(published.length, 1);
});

/* ── room lines: everything said ABOUT the conversation (§3) ─────────────────────────── */

/** Post one signed delivery; what it published. */
async function deliver(
  handler: WebhookHandler,
  event: string,
  payload: unknown,
  delivery: string = crypto.randomUUID(),
): Promise<Response> {
  const body = JSON.stringify(payload);
  return await handler(
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers: {
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": await sign(body),
      },
    }),
  );
}

const repository = { full_name: "acme/api" };
const sender = { login: "bo" };
const issue = {
  number: 7,
  title: "Crash on save",
  html_url: "https://github.com/acme/api/issues/7",
};
const pr = { number: 9, title: "Fix save", html_url: "https://github.com/acme/api/pull/9" };
const discussion = { number: 11, title: "How to save?", category: { name: "Q&A" } };
const other = (number: number, title: string) => ({
  number,
  title,
  repository_url: "https://api.github.com/repos/acme/web",
});

/** [what, event, payload, the room line's data, the conversation, the message it names] */
const ROOM_LINES: [string, string, Record<string, unknown>, RoomChange, string, string?][] = [
  // issues
  ["issue reopened", "issues", { action: "reopened", issue }, { state: "reopened" }, "acme/api#7"],
  [
    "issue closed, with its reason",
    "issues",
    { action: "closed", issue: { ...issue, state_reason: "not_planned" } },
    { state: "closed", fields: { state_reason: "not_planned" } },
    "acme/api#7",
  ],
  [
    "issue retitled",
    "issues",
    {
      action: "edited",
      issue: { ...issue, title: "Crash on save (Windows)" },
      changes: { title: { from: "Crash on save" } },
    },
    { name: "Crash on save (Windows)", was: "Crash on save" },
    "acme/api#7",
  ],
  ["issue locked", "issues", { action: "locked", issue }, { state: "locked" }, "acme/api#7"],
  ["issue unlocked", "issues", { action: "unlocked", issue }, { state: "unlocked" }, "acme/api#7"],
  [
    "issue transferred",
    "issues",
    {
      action: "transferred",
      issue,
      changes: { new_issue: { number: 88 }, new_repository: { full_name: "acme/web" } },
    },
    { moved: { to: "acme/web#88" } },
    "acme/api#7",
  ],
  ["issue deleted", "issues", { action: "deleted", issue }, { state: "deleted" }, "acme/api#7"],
  ["issue pinned", "issues", { action: "pinned", issue }, { pinned: true }, "acme/api#7"],
  ["issue unpinned", "issues", { action: "unpinned", issue }, { pinned: false }, "acme/api#7"],
  [
    "issue assigned",
    "issues",
    { action: "assigned", issue, assignee: { login: "ana" } },
    { assigned: [{ address: "ana", name: "ana" }] },
    "acme/api#7",
  ],
  [
    "issue unassigned",
    "issues",
    { action: "unassigned", issue, assignee: { login: "ana" } },
    { unassigned: [{ address: "ana", name: "ana" }] },
    "acme/api#7",
  ],
  [
    "issue labeled",
    "issues",
    { action: "labeled", issue, label: { name: "bug" } },
    { labels: { added: ["bug"] } },
    "acme/api#7",
  ],
  [
    "issue unlabeled",
    "issues",
    { action: "unlabeled", issue, label: { name: "bug" } },
    { labels: { removed: ["bug"] } },
    "acme/api#7",
  ],
  [
    "issue milestoned",
    "issues",
    { action: "milestoned", issue, milestone: { title: "v1.4" } },
    { milestone: "v1.4" },
    "acme/api#7",
  ],
  [
    "issue demilestoned",
    "issues",
    { action: "demilestoned", issue, milestone: { title: "v1.4" } },
    { milestone: "" },
    "acme/api#7",
  ],
  [
    "issue typed",
    "issues",
    { action: "typed", issue, type: { name: "Bug" } },
    { type: "Bug" },
    "acme/api#7",
  ],
  ["issue untyped", "issues", { action: "untyped", issue, type: null }, { type: "" }, "acme/api#7"],
  [
    "issue field set",
    "issues",
    {
      action: "field_added",
      issue,
      issue_field: { name: "Priority" },
      issue_field_value: { value: "High" },
    },
    { fields: { Priority: "High" } },
    "acme/api#7",
  ],
  [
    "issue field cleared",
    "issues",
    { action: "field_removed", issue, issue_field: { name: "Priority" } },
    { fields: { Priority: "" } },
    "acme/api#7",
  ],
  [
    "a comment pinned",
    "issue_comment",
    { action: "pinned", issue, comment: { id: 501, body: "the fix" } },
    { pinned: true },
    "acme/api#7",
    "gh:501",
  ],
  [
    "a comment unpinned",
    "issue_comment",
    { action: "unpinned", issue, comment: { id: 501, body: "the fix" } },
    { pinned: false },
    "acme/api#7",
    "gh:501",
  ],
  // pull requests
  [
    "pull request merged",
    "pull_request",
    { action: "closed", pull_request: { ...pr, merged: true } },
    { state: "merged" },
    "acme/api#9",
  ],
  [
    "pull request closed unmerged",
    "pull_request",
    { action: "closed", pull_request: { ...pr, merged: false } },
    { state: "closed" },
    "acme/api#9",
  ],
  ["pull request reopened", "pull_request", { action: "reopened", pull_request: pr }, {
    state: "reopened",
  }, "acme/api#9"],
  ["pull request to draft", "pull_request", { action: "converted_to_draft", pull_request: pr }, {
    state: "draft",
  }, "acme/api#9"],
  ["pull request ready", "pull_request", { action: "ready_for_review", pull_request: pr }, {
    state: "ready",
  }, "acme/api#9"],
  [
    "pull request retitled",
    "pull_request",
    { action: "edited", pull_request: pr, changes: { title: { from: "Fix it" } } },
    { name: "Fix save", was: "Fix it" },
    "acme/api#9",
  ],
  [
    "pull request retargeted",
    "pull_request",
    { action: "edited", pull_request: pr, changes: { base: { ref: { from: "dev" } } } },
    { changed: ["base"] },
    "acme/api#9",
  ],
  ["pull request locked", "pull_request", { action: "locked", pull_request: pr }, {
    state: "locked",
  }, "acme/api#9"],
  [
    "pull request assigned",
    "pull_request",
    { action: "assigned", pull_request: pr, assignee: { login: "ana" } },
    { assigned: [{ address: "ana", name: "ana" }] },
    "acme/api#9",
  ],
  [
    "pull request labeled",
    "pull_request",
    { action: "labeled", pull_request: pr, label: { name: "ready" } },
    { labels: { added: ["ready"] } },
    "acme/api#9",
  ],
  [
    "pull request milestoned",
    "pull_request",
    { action: "milestoned", pull_request: pr, milestone: { title: "v1.4" } },
    { milestone: "v1.4" },
    "acme/api#9",
  ],
  [
    "a reviewer asked",
    "pull_request",
    { action: "review_requested", pull_request: pr, requested_reviewer: { login: "bo" } },
    { review: { requested: [{ address: "bo", name: "bo" }] } },
    "acme/api#9",
  ],
  [
    "a team's review asked",
    "pull_request",
    {
      action: "review_requested",
      pull_request: pr,
      requested_team: { name: "Core", slug: "core" },
    },
    { review: { requested: [{ address: "core", name: "Core" }] } },
    "acme/api#9",
  ],
  [
    "a review ask withdrawn",
    "pull_request",
    { action: "review_request_removed", pull_request: pr, requested_reviewer: { login: "bo" } },
    { review: { removed: [{ address: "bo", name: "bo" }] } },
    "acme/api#9",
  ],
  [
    "a review dismissed",
    "pull_request_review",
    { action: "dismissed", pull_request: pr, review: { id: 61, state: "dismissed" } },
    { review: { dismissed: true } },
    "acme/api#9",
    "gh:61",
  ],
  [
    "auto-merge on",
    "pull_request",
    { action: "auto_merge_enabled", pull_request: pr },
    { settings: { auto_merge: true } },
    "acme/api#9",
  ],
  [
    "auto-merge off",
    "pull_request",
    { action: "auto_merge_disabled", pull_request: pr, reason: "x" },
    { settings: { auto_merge: false } },
    "acme/api#9",
  ],
  ["into the merge queue", "pull_request", { action: "enqueued", pull_request: pr }, {
    state: "queued",
  }, "acme/api#9"],
  [
    "out of the merge queue",
    "pull_request",
    { action: "dequeued", pull_request: pr, reason: "CI_FAILURE" },
    { state: "dequeued" },
    "acme/api#9",
  ],
  [
    "new commits",
    "pull_request",
    {
      action: "synchronize",
      pull_request: { ...pr, commits: 3 },
      before: "0000000000",
      after: "a1b2c3d4e5f6",
    },
    { pushed: { commits: 3, head: "a1b2c3d" } },
    "acme/api#9",
  ],
  // an action this does not name still says itself
  ["joined a stack", "pull_request", { action: "stacked", pull_request: pr }, {
    changed: ["stacked"],
  }, "acme/api#9"],
  [
    "a review thread resolved",
    "pull_request_review_thread",
    { action: "resolved", pull_request: pr, thread: { comments: [{ id: 71 }, { id: 72 }] } },
    { resolved: true },
    "acme/api#9",
    "gh:71",
  ],
  [
    "a review thread reopened",
    "pull_request_review_thread",
    { action: "unresolved", pull_request: pr, thread: { comments: [{ id: 71 }] } },
    { resolved: false },
    "acme/api#9",
    "gh:71",
  ],
  // discussions
  [
    "discussion recategorized",
    "discussion",
    {
      action: "category_changed",
      discussion: { ...discussion, category: { name: "Ideas" } },
      changes: { category: { from: { name: "Q&A" } } },
    },
    { category: "Ideas" },
    "acme/api#11",
  ],
  [
    "discussion answered",
    "discussion",
    { action: "answered", discussion, answer: { id: 81 } },
    { answered: true },
    "acme/api#11",
    "gh:81",
  ],
  [
    "discussion unanswered",
    "discussion",
    { action: "unanswered", discussion, old_answer: { id: 81 } },
    { answered: false },
    "acme/api#11",
    "gh:81",
  ],
  [
    "discussion closed, with its reason",
    "discussion",
    { action: "closed", discussion: { ...discussion, state_reason: "outdated" } },
    { state: "closed", fields: { state_reason: "outdated" } },
    "acme/api#11",
  ],
  [
    "discussion reopened",
    "discussion",
    { action: "reopened", discussion },
    { state: "reopened" },
    "acme/api#11",
  ],
  [
    "discussion locked",
    "discussion",
    { action: "locked", discussion },
    { state: "locked" },
    "acme/api#11",
  ],
  [
    "discussion labeled",
    "discussion",
    { action: "labeled", discussion, label: { name: "faq" } },
    { labels: { added: ["faq"] } },
    "acme/api#11",
  ],
  [
    "discussion pinned",
    "discussion",
    { action: "pinned", discussion },
    { pinned: true },
    "acme/api#11",
  ],
  [
    "discussion transferred",
    "discussion",
    {
      action: "transferred",
      discussion,
      changes: { new_discussion: { number: 3 }, new_repository: { full_name: "acme/web" } },
    },
    { moved: { to: "acme/web#3" } },
    "acme/api#11",
  ],
  [
    "discussion retitled",
    "discussion",
    { action: "edited", discussion, changes: { title: { from: "Saving?" } } },
    { name: "How to save?", was: "Saving?" },
    "acme/api#11",
  ],
  [
    "discussion deleted",
    "discussion",
    { action: "deleted", discussion },
    { state: "deleted" },
    "acme/api#11",
  ],
  // ties between issues, each said in the issue the delivery is for
  [
    "a sub-issue added, in the parent",
    "sub_issues",
    {
      action: "sub_issue_added",
      parent_issue: issue,
      sub_issue: other(42, "Save dialog"),
      sub_issue_repo: { full_name: "acme/web" },
    },
    { linked: [{ address: "acme/web#42", name: "Save dialog", as: "sub" }] },
    "acme/api#7",
  ],
  [
    "a parent added, in the sub-issue",
    "sub_issues",
    {
      action: "parent_issue_added",
      sub_issue: issue,
      parent_issue: other(1, "Epic"),
      parent_issue_repo: { full_name: "acme/web" },
    },
    { linked: [{ address: "acme/web#1", name: "Epic", as: "parent" }] },
    "acme/api#7",
  ],
  [
    "a sub-issue removed",
    "sub_issues",
    { action: "sub_issue_removed", parent_issue: issue, sub_issue: other(42, "Save dialog") },
    { unlinked: [{ address: "acme/web#42", name: "Save dialog", as: "sub" }] },
    "acme/api#7",
  ],
  [
    "a blocker added, in the blocked issue",
    "issue_dependencies",
    {
      action: "blocked_by_added",
      blocked_issue: issue,
      blocking_issue: other(42, "Save dialog"),
      blocking_issue_repo: { full_name: "acme/web" },
    },
    { linked: [{ address: "acme/web#42", name: "Save dialog", as: "blocked_by" }] },
    "acme/api#7",
  ],
  [
    "a blocked issue added, in the blocker",
    "issue_dependencies",
    {
      action: "blocking_added",
      blocking_issue: issue,
      blocked_issue: other(43, "Release"),
      blocked_issue_repo: { full_name: "acme/web" },
    },
    { linked: [{ address: "acme/web#43", name: "Release", as: "blocks" }] },
    "acme/api#7",
  ],
  [
    "a blocker removed",
    "issue_dependencies",
    {
      action: "blocked_by_removed",
      blocked_issue: issue,
      blocking_issue: other(42, "Save dialog"),
    },
    { unlinked: [{ address: "acme/web#42", name: "Save dialog", as: "blocked_by" }] },
    "acme/api#7",
  ],
  [
    "a relation added",
    "issue_relates_to",
    { action: "relates_to_added", issue, related_issue: other(5, "Autosave") },
    { linked: [{ address: "acme/web#5", name: "Autosave", as: "related" }] },
    "acme/api#7",
  ],
  // across repositories the delivery leaves the other side out: the line still says itself
  [
    "a relation removed, the other side unnamed",
    "issue_relates_to",
    { action: "relates_to_removed", issue },
    { changed: ["relates_to_removed"] },
    "acme/api#7",
  ],
];

for (const [what, event, payload, data, address, ref] of ROOM_LINES) {
  Deno.test(`github room line: ${what}`, async () => {
    const { handler, published } = harness();
    const res = await deliver(handler, event, { ...payload, repository, sender }, "dv-1");
    assertEquals(res.status, 202);
    assertEquals(published.length, 1);
    const m = published[0] as MessageEvent;
    assertEquals(m.parts, [{ type: "data", kind: "room", data }]);
    assertEquals(m.envelope.conversation.address, address);
    assertEquals(m.envelope.sender, { address: "bo", name: "bo" });
    // a line is no artifact: the delivery keys it, so a redelivery merges into it
    assertEquals(m.envelope.external_id, "ghd:dv-1");
    assertEquals(m.payload, ref ? { ref_external_id: ref } : undefined);
  });
}

Deno.test("github: a room line wears the conversation's name, the new one after a retitle", async () => {
  const { handler, published } = harness();
  await deliver(handler, "issues", {
    action: "edited",
    issue: { ...issue, title: "Crash on save (Windows)" },
    changes: { title: { from: "Crash on save" } },
    repository,
    sender,
  });
  assertEquals((published[0] as MessageEvent).envelope.conversation, {
    address: "acme/api#7",
    name: "Crash on save (Windows)",
  });
});

Deno.test("github: an opening is a message keyed on its conversation, and a body edit is its edit", async () => {
  const { handler, published } = harness();
  const opened = [
    ["issues", { action: "opened", issue: { ...issue, body: "it crashes" } }, "issue", {
      state: "opened",
    }],
    ["pull_request", { action: "opened", pull_request: { ...pr, body: "fixes #7" } }, "pr", {
      state: "opened",
    }],
    [
      "discussion",
      { action: "created", discussion: { ...discussion, body: "how?" } },
      "discussion",
      {
        state: "opened",
        category: "Q&A",
      },
    ],
  ] as const;
  for (const [event, payload, kind, data] of opened) {
    await deliver(handler, event, { ...payload, repository, sender });
    const m = published.at(-1) as MessageEvent;
    assertEquals(m.parts[0].type, "data");
    assertEquals((m.parts[0] as { kind: string }).kind, kind);
    assertEquals((m.parts[0] as { data: unknown }).data, data);
  }
  assertEquals(
    published.map((e) => e.envelope.external_id),
    ["gh:acme/api#7", "gh:acme/api#9", "gh:acme/api#11"],
  );

  // the body edited: the opening's words, replaced
  await deliver(handler, "issues", {
    action: "edited",
    issue: { ...issue, body: "it crashes on Windows" },
    changes: { body: { from: "it crashes" } },
    repository,
    sender,
  }, "dv-edit");
  const edit = published.at(-1) as MessageEvent;
  assertEquals(edit.payload, { action: "edit", ref_external_id: "gh:acme/api#7" });
  assertEquals(edit.envelope.external_id, "ghd:dv-edit");
  assertEquals(edit.parts, [{
    type: "data",
    kind: "issue",
    data: { state: "opened" },
    text: "it crashes on Windows",
  }]);
});

Deno.test("github: a title and a body edited at once are a room line and the opening's edit", async () => {
  const { handler, published } = harness();
  await deliver(handler, "pull_request", {
    action: "edited",
    pull_request: { ...pr, title: "Fix save on Windows", body: "fixes #7 and #8" },
    changes: { title: { from: "Fix save" }, body: { from: "fixes #7" } },
    repository,
    sender,
  }, "dv-2");
  assertEquals(published.length, 2);
  const [line, edit] = published as MessageEvent[];
  assertEquals(line.parts, [{
    type: "data",
    kind: "room",
    data: { name: "Fix save on Windows", was: "Fix save" },
  }]);
  assertEquals(line.envelope.external_id, "ghd:dv-2");
  assertEquals(edit.payload, { action: "edit", ref_external_id: "gh:acme/api#9" });
  assertEquals(edit.envelope.external_id, "ghd:dv-2:1");
});

Deno.test("github: the new events are in the default set the app subscribes to", () => {
  for (
    const e of [
      "discussion",
      "pull_request_review_thread",
      "sub_issues",
      "issue_dependencies",
      "issue_relates_to",
    ]
  ) assert(DEFAULT_EVENTS.includes(e), e);
});
