import { assertEquals, assertStringIncludes } from "@std/assert";
import { createGithubDispatch, type GhTarget, grantKeyFor } from "./dispatch.ts";
import type { MessageEvent } from "../../src/connector.ts";
import { DispatchError, openLog } from "../../src/connector.ts";

/** An agent-authored (outbound) message to `conversation`. */
function agentMsg(id: string, conversation: string, text: string): MessageEvent {
  return {
    id,
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "s1" },
    envelope: {
      service: "github",
      connection_address: "github",
      conversation: { address: conversation },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

/** A world (inbound) message — no `agent` — as the ingest would publish. */
function worldMsg(id: string, conversation: string, text: string): MessageEvent {
  return {
    id,
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "github",
      connection_address: "github",
      conversation: { address: conversation },
      sender: { address: "ana", name: "ana" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

interface Amend {
  target: GhTarget;
  id: string;
  action: "edit" | "delete";
  text: string;
}

async function withDispatch(
  fn: (t: {
    publish: (e: MessageEvent) => Promise<unknown>;
    posts: { target: GhTarget; text: string }[];
    amends: Amend[];
    read: () => Promise<MessageEvent[]>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  }) => Promise<void>,
  opts: {
    failWith?: Error;
    /** a deployment with no amend leg — an edit must stamp failed, not post anew */
    noAmend?: boolean;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  log.upsertConnections([{ service: "github", address: "github" }]); // the gate wants a grant
  const posts: { target: GhTarget; text: string }[] = [];
  const amends: Amend[] = [];
  const stop = createGithubDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post: (target, text) => {
      posts.push({ target, text });
      if (opts.failWith) return Promise.reject(opts.failWith);
      return Promise.resolve("c-100");
    },
    ...(opts.noAmend ? {} : {
      amend: (target, amend) => {
        amends.push({ target, ...amend });
        return Promise.resolve();
      },
    }),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
  });
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("waitFor timeout");
  };
  try {
    await new Promise((r) => setTimeout(r, 50)); // let the subscription arm
    await fn({
      publish: (e) => log.publish(e),
      posts,
      amends,
      read: async () => (await log.read({ types: ["message"] })) as MessageEvent[],
      waitFor,
    });
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("dispatch: the agent's outbound github send is posted, parsed, and backfilled", async () => {
  await withDispatch(async ({ publish, posts, read, waitFor }) => {
    await publish(agentMsg("01", "ana/widgets#42", "on it"));
    await waitFor(() => posts.length === 1);
    assertEquals(posts[0].target, { owner: "ana", repo: "widgets", number: 42 });
    assertEquals(posts[0].text, "on it");
    // the posted comment id came back → backfilled onto the row (the echo key, §4)
    await waitFor(async () => (await read())[0]?.envelope.external_id === "gh:c-100");
  });
});

Deno.test("dispatch: inbound (world) messages are never re-sent (no agent)", async () => {
  await withDispatch(async ({ publish, posts }) => {
    await publish(worldMsg("01", "ana/widgets#42", "a human comment"));
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(posts.length, 0);
  });
});

Deno.test("dispatch: agent messages to non-gh conversations are ignored", async () => {
  await withDispatch(async ({ publish, posts }) => {
    await publish(agentMsg("01", "home", "hi principal"));
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(posts.length, 0);
  });
});

Deno.test("dispatch: a failed post stamps the row failed with its class — the agent sees it (§5)", async () => {
  await withDispatch(async ({ publish, posts, read, waitFor }) => {
    await publish(agentMsg("01", "ana/widgets#42", "on it"));
    await waitFor(() => posts.length === 1);
    await waitFor(async () => (await read())[0]?.status?.state === "failed");
    const status = (await read())[0].status as Record<string, unknown>;
    assertEquals(status.error_code, 502);
    assertStringIncludes(String(status.error), "bad gateway");
    assertEquals(typeof status.failed_at, "string");
  }, { failWith: new DispatchError("gh api: bad gateway", 502) });
});

Deno.test("dispatch: an edit patches the referent comment — no new post, nothing to backfill", async () => {
  await withDispatch(async ({ publish, posts, amends, read, waitFor }) => {
    await publish({
      ...agentMsg("01", "ana/widgets#42", "on it (typo fixed)"),
      payload: { ref_external_id: "gh:777", action: "edit" },
    });
    await waitFor(() => amends.length === 1);
    assertEquals(posts.length, 0);
    assertEquals(amends[0], {
      target: { owner: "ana", repo: "widgets", number: 42 },
      id: "777",
      action: "edit",
      text: "on it (typo fixed)",
    });
    await waitFor(async () => {
      const status = (await read())[0]?.status as Record<string, unknown> | undefined;
      return typeof status?.dispatched_at === "string";
    });
    assertEquals((await read())[0].envelope.external_id, undefined);
  });
});

Deno.test("dispatch: a delete carries no text and still reaches the amend leg", async () => {
  await withDispatch(async ({ publish, posts, amends, waitFor }) => {
    await publish({
      ...agentMsg("01", "ana/widgets#42", ""),
      parts: [],
      payload: { ref_external_id: "gh:777", action: "delete" },
    });
    await waitFor(() => amends.length === 1);
    assertEquals(posts.length, 0);
    assertEquals(amends[0].action, "delete");
    assertEquals(amends[0].id, "777");
  });
});

Deno.test("dispatch: an edit with no amend leg stamps the row failed — it never posts anew", async () => {
  await withDispatch(async ({ publish, posts, read, waitFor }) => {
    await publish({
      ...agentMsg("01", "ana/widgets#42", "on it (typo fixed)"),
      payload: { ref_external_id: "gh:777", action: "edit" },
    });
    await waitFor(async () => (await read())[0]?.status?.state === "failed");
    assertEquals(posts.length, 0);
    const status = (await read())[0].status as Record<string, unknown>;
    assertEquals(status.error_code, 400);
    assertStringIncludes(String(status.error), "cannot edit");
  }, { noAmend: true });
});

Deno.test("dispatch: an edit whose reference names no github comment fails with 400", async () => {
  await withDispatch(async ({ publish, posts, amends, read, waitFor }) => {
    await publish({
      ...agentMsg("01", "ana/widgets#42", "on it"),
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "edit" },
    });
    await waitFor(async () => (await read())[0]?.status?.state === "failed");
    assertEquals(posts.length, 0);
    assertEquals(amends.length, 0);
    assertEquals(((await read())[0].status as Record<string, unknown>).error_code, 400);
  });
});

Deno.test("grantKeyFor: the author's own grant in either shape, else the org's", () => {
  // a static PAT rides `token`
  assertEquals(grantKeyFor("ana", { value: { token: "ghp_x", access_token: "" } }), "github:ana");
  // a device-flow grant rides `access_token`, `token` blank
  assertEquals(
    grantKeyFor("ana", { value: { token: "", access_token: "ghu_x", refresh_token: "ghr_x" } }),
    "github:ana",
  );
  // no grant, or an emptied one → the org
  assertEquals(grantKeyFor("ana", null), "github:org");
  assertEquals(grantKeyFor("ana", { value: { token: "", access_token: "" } }), "github:org");
  assertEquals(grantKeyFor(undefined, null), "github:org");
});
