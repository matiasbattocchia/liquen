import { assertEquals } from "@std/assert";
import { createGithubDispatch, type GhTarget } from "./github_dispatch.ts";
import { openLog } from "../store/log.ts";
import type { MessageEvent } from "../types.ts";

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

async function withDispatch(
  fn: (t: {
    publish: (e: MessageEvent) => Promise<unknown>;
    posts: { target: GhTarget; text: string }[];
    read: () => Promise<MessageEvent[]>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  log.upsertConnections([{ service: "github", address: "github" }]); // the gate wants a grant
  const posts: { target: GhTarget; text: string }[] = [];
  const stop = createGithubDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post: (target, text) => {
      posts.push({ target, text });
      return Promise.resolve("c-100");
    },
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
