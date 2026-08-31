import { assertEquals } from "@std/assert";
import {
  createSlackDispatch,
  type SlackDispatchDeps,
  slackEmojiName,
  slackErrorCode,
  type SlackTarget,
} from "./dispatch.ts";
import { DispatchError } from "../errors.ts";
import { type DeliveryPatch, openLog } from "../../store/log.ts";
import type { FilePart, MessageEvent } from "../../types.ts";

/** An agent reply as the anchor produces it: BARE address, service/connection on the
 *  envelope (routing is the service field now — no prefix, §3). */
function agentMsg(
  id: string,
  text: string,
  env: { service?: "local" | "slack" | "github"; connection?: string; address?: string } = {},
): MessageEvent {
  return {
    id,
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "s1" },
    envelope: {
      service: env.service ?? "slack",
      connection_address: env.connection ?? "T1", // the workspace anchor (§4)
      conversation: { address: env.address ?? "C1" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

function worldMsg(id: string, conversation: string, text: string): MessageEvent {
  return {
    id,
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "slack",
      connection_address: "T1",
      conversation: { address: conversation },
      sender: { address: "U7" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

interface Post {
  target: SlackTarget;
  text: string;
  author?: string;
  files?: FilePart[];
  threadTs?: string;
}
interface Reaction {
  target: SlackTarget;
  ts: string;
  glyph: string;
  remove: boolean;
}
interface Amend {
  target: SlackTarget;
  ts: string;
  action: "edit" | "delete";
  text: string;
}

async function withDispatch(
  fn: (t: {
    publish: (e: MessageEvent) => Promise<unknown>;
    posts: Post[];
    reactions: Reaction[];
    amends: Amend[];
    patches: DeliveryPatch[];
    read: () => Promise<MessageEvent[]>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  }) => Promise<void>,
  opts: {
    failWith?: Error;
    directory?: SlackDispatchDeps["directory"];
    /** a deployment with no reaction leg — the send must stamp failed, not vanish */
    noReact?: boolean;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  // the publish gate wants grants for every non-local anchor the fixtures use
  log.upsertConnections([
    { service: "slack", address: "T1:U7" },
    { service: "slack", address: "T1" },
    { service: "github", address: "gh-app" },
  ]);
  const posts: Post[] = [];
  const reactions: Reaction[] = [];
  const amends: Amend[] = [];
  const patches: DeliveryPatch[] = [];
  const stop = createSlackDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    post: (target, text, author, files, threadTs) => {
      posts.push({ target, text, author, files, threadTs });
      if (opts.failWith) return Promise.reject(opts.failWith);
      return Promise.resolve({ ts: "999.111", user: "UBOT1" });
    },
    ...(opts.noReact ? {} : {
      react: (target, react) => {
        reactions.push({ target, ...react });
        return opts.failWith ? Promise.reject(opts.failWith) : Promise.resolve();
      },
      amend: (target, a) => {
        amends.push({ target, ...a });
        return opts.failWith ? Promise.reject(opts.failWith) : Promise.resolve();
      },
    }),
    setDelivery: (id, patch) => {
      patches.push(patch);
      return log.setDelivery(id, patch);
    },
    directory: opts.directory,
  });
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
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
      reactions,
      amends,
      patches,
      read: async () => (await log.read({ types: ["message"] })) as MessageEvent[],
      waitFor,
    });
  } finally {
    await stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("slack dispatch: a classifier-stamped inbound never re-dispatches (§3)", async () => {
  await withDispatch(async ({ publish, posts, waitFor }) => {
    // the principal's echo: agent.id stamped by the classifier, external_id from the wire
    const echo = worldMsg("10", "C1", "typed on my phone");
    echo.agent = { id: "a1" };
    echo.envelope.external_id = "slack:T1:C1:777.1";
    await publish(echo);
    await publish(agentMsg("11", "and this one ships"));
    await waitFor(() => posts.length === 1); // only the agent's send posted
    assertEquals(posts[0].text, "and this one ships");
  });
});

Deno.test("slack dispatch: the send response stamps sender beside dispatched_at (§4)", async () => {
  await withDispatch(async ({ publish, patches, waitFor }) => {
    await publish(agentMsg("12", "hola"));
    await waitFor(() => patches.length === 1);
    assertEquals(patches[0].sender, { address: "UBOT1" }); // chat.postMessage's message.user
    assertEquals(typeof patches[0].status?.dispatched_at, "string");
  });
});

Deno.test("slack dispatch: outbound send is posted, parsed, ts backfilled as external_id", async () => {
  await withDispatch(async ({ publish, posts, read, waitFor }) => {
    await publish(agentMsg("01", "on it"));
    await waitFor(() => posts.length === 1);
    assertEquals(posts[0].target, { connection: "T1", channel: "C1" });
    assertEquals(posts[0].text, "on it");
    assertEquals(posts[0].author, "a1"); // the token resolver's key (§4: alter-ego pick)
    // the echo key: our posted ts — the ingest's echo merges into this row (§4)
    await waitFor(async () => (await read())[0]?.envelope.external_id === "slack:T1:C1:999.111");
  });
});

Deno.test("slack dispatch: a permanent failure stamps failed + its 4xx error_code (§5)", async () => {
  await withDispatch(async ({ publish, posts, patches, read, waitFor }) => {
    await publish(agentMsg("01", "on it"));
    await waitFor(() => posts.length === 1);
    // the stamp is what render shows the agent: <msg … status="failed">
    await waitFor(async () => (await read())[0]?.envelope.status === "failed");
    assertEquals((await read())[0].envelope.external_id, undefined); // no ts — never arrived
    assertEquals(patches[0].status?.state, "failed");
    assertEquals(patches[0].status?.error_code, 400); // named refusal — permanent class
  }, {
    failWith: new DispatchError(
      "chat.postMessage: channel_not_found",
      slackErrorCode("channel_not_found"),
    ),
  });
});

Deno.test("slack dispatch: a transient failure carries its class in error_code", async () => {
  await withDispatch(async ({ publish, posts, patches, waitFor }) => {
    await publish(agentMsg("01", "on it"));
    await waitFor(() => posts.length === 1);
    await waitFor(() => patches.length === 1);
    assertEquals(patches[0].status?.error_code, 429); // rate limited — retry later
  }, {
    failWith: new DispatchError("chat.postMessage: ratelimited", slackErrorCode("ratelimited")),
  });
});

Deno.test("slackErrorCode assigns the class from the error name", () => {
  assertEquals(slackErrorCode("ratelimited"), 429);
  assertEquals(slackErrorCode("internal_error"), 503); // Slack's self-declared retryables
  assertEquals(slackErrorCode("fatal_error"), 503);
  assertEquals(slackErrorCode("service_unavailable"), 503);
  assertEquals(slackErrorCode("channel_not_found"), 400); // every named refusal
  assertEquals(slackErrorCode("invalid_auth"), 400);
  assertEquals(slackErrorCode(undefined), 400);
});

Deno.test("slack dispatch: inbound (world) messages are never re-sent", async () => {
  await withDispatch(async ({ publish, posts }) => {
    await publish(worldMsg("01", "C1", "a human message"));
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(posts.length, 0);
  });
});

Deno.test("slack dispatch: agent messages on other services (local, github) are ignored", async () => {
  await withDispatch(async ({ publish, posts }) => {
    await publish(
      agentMsg("01", "hi principal", { service: "local", connection: "agent", address: "home" }),
    );
    await publish(
      agentMsg("02", "a github reply", {
        service: "github",
        connection: "gh-app",
        address: "a/w#1",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(posts.length, 0);
  });
});

Deno.test("slack dispatch: attachments ride the post — text as the share comment (§5 media)", async () => {
  await withDispatch(async ({ publish, posts, waitFor }) => {
    const msg = agentMsg("01", "el reporte");
    msg.parts.push({
      type: "file",
      kind: "document",
      file: { mime_type: "application/pdf", uri: "/m/r.pdf", name: "r.pdf", size: 9 },
    });
    await publish(msg);
    await waitFor(() => posts.length === 1);
    assertEquals(posts[0].text, "el reporte");
    assertEquals(posts[0].files?.length, 1);
    assertEquals(posts[0].files?.[0].file.uri, "/m/r.pdf");
  });
});

Deno.test("slack dispatch: a file-only send (no text) still dispatches", async () => {
  await withDispatch(async ({ publish, posts, waitFor }) => {
    const msg = agentMsg("01", "");
    msg.parts = [{
      type: "file",
      kind: "image",
      file: { mime_type: "image/png", uri: "/m/a.png", size: 3 },
    }];
    await publish(msg);
    await waitFor(() => posts.length === 1);
    assertEquals(posts[0].files?.length, 1);
  });
});

Deno.test("slack dispatch: @Name and @here encode at the frontier; unclaimed stays literal", async () => {
  await withDispatch(async ({ publish, posts, waitFor }) => {
    await publish(agentMsg("01", "@matias dale, aviso con @here — y @Nadie queda como está"));
    await waitFor(() => posts.length === 1);
    assertEquals(
      posts[0].text,
      "<@U0BKTGTB65C> dale, aviso con <!here> — y @Nadie queda como está",
    );
  }, {
    directory: (service, conversation) => {
      assertEquals([service, conversation], ["slack", "C1"]);
      return Promise.resolve([{ address: "U0BKTGTB65C", name: "matias" }]);
    },
  });
});

Deno.test("slack dispatch: `re` posts into the referent's thread (§5)", async () => {
  await withDispatch(async ({ publish, posts, waitFor }) => {
    const reply: MessageEvent = {
      ...agentMsg("e1", "voy yo"),
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "reply" },
    };
    await publish(reply);
    await waitFor(() => posts.length === 1);
    assertEquals(posts[0].threadTs, "111.222"); // the ts, dug out of the external id
  });
});

Deno.test("slack dispatch: a reaction lands as reactions.add — no ts to backfill", async () => {
  await withDispatch(async ({ publish, posts, reactions, patches, waitFor }) => {
    const react: MessageEvent = {
      ...agentMsg("e1", ""),
      parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "add" },
    };
    await publish(react);
    await waitFor(() => reactions.length === 1);
    assertEquals(posts.length, 0); // a reaction is not a message
    assertEquals(reactions[0], {
      target: { connection: "T1", channel: "C1" },
      ts: "111.222",
      glyph: "👍",
      remove: false,
    });
    // dispatched, but nothing to converge on: a reaction has no id of its own
    assertEquals(patches[0].external_id, undefined);
    assertEquals(typeof patches[0].status?.dispatched_at, "string");
  });
});

Deno.test("slack dispatch: a reaction with no reaction leg FAILS — it never just vanishes", async () => {
  await withDispatch(async ({ publish, patches, waitFor }) => {
    const react: MessageEvent = {
      ...agentMsg("e1", ""),
      parts: [{ type: "data", kind: "reaction", data: { name: "👍", unicode: "👍" } }],
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "add" },
    };
    await publish(react);
    await waitFor(() => patches.length === 1);
    assertEquals(patches[0].status?.state, "failed");
  }, { noReact: true });
});

Deno.test("slackEmojiName: glyphs translate, names pass, the unknown gets no guess", () => {
  assertEquals(slackEmojiName("👍"), "thumbsup");
  assertEquals(slackEmojiName("❤️"), "heart"); // the presentation selector is dropped
  assertEquals(slackEmojiName(":tada:"), "tada");
  assertEquals(slackEmojiName("party_parrot"), "party_parrot"); // custom workspace emoji
  assertEquals(slackEmojiName("🫥"), undefined);
});

Deno.test("slack dispatch: an edit updates the message, a delete takes it back", async () => {
  await withDispatch(async ({ publish, posts, amends, patches, waitFor }) => {
    await publish({
      ...agentMsg("e1", "mejor a las 10"),
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "edit" },
    });
    await publish({
      ...agentMsg("e2", ""),
      parts: [],
      payload: { ref_external_id: "slack:T1:C1:111.222", action: "delete" },
    });
    await waitFor(() => amends.length === 2);
    assertEquals(posts.length, 0); // neither is a new message
    assertEquals(amends[0], {
      target: { connection: "T1", channel: "C1" },
      ts: "111.222",
      action: "edit",
      text: "mejor a las 10",
    });
    assertEquals(amends[1].action, "delete");
    // chat.update keeps the original ts — nothing to converge on, so no external_id
    assertEquals(patches[0].external_id, undefined);
    assertEquals(typeof patches[0].status?.dispatched_at, "string");
  });
});
