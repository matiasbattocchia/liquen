import { assertEquals, assertStringIncludes } from "@std/assert";
import { createGithubWebhook, type WebhookHandler } from "./ingest.ts";
import type { Appender, Draft, Event, MessageEvent } from "../../src/connector.ts";
import { newId } from "../../src/connector.ts";

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

  // a PR: only what the conversation can't say — opened ≠ reopened. The number and title are
  // the conversation's address and name; repeating them here would say them twice.
  const pr = await post("pull_request", {
    action: "reopened",
    repository: repo,
    pull_request: { number: 5, title: "Fix login", body: "the description" },
    sender: { login: "ana" },
  });
  assertEquals(pr, {
    type: "data",
    kind: "pr",
    data: { state: "reopened" },
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

Deno.test("github: external_id is stamped — artifact id for comments, delivery guid otherwise", async () => {
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
  // a lifecycle event (PR opened — not an artifact): the delivery guid still retry-dedupes
  const pr = JSON.stringify({
    action: "opened",
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
        "x-github-delivery": "deliv-10",
        "x-hub-signature-256": await sign(pr),
      },
    }),
  );
  assertEquals(published[1].envelope.external_id, "ghd:deliv-10");
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
