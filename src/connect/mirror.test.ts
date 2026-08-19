import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMirror } from "./mirror.ts";
import { openLog } from "../store/log.ts";
import type { Draft, Event, MessageEvent, ToolUseEvent } from "../types.ts";

/** A live org with two alias surfaces bound to `ana`: the Slack self-DM `D1` (grant
 *  `T1:U1`) and the WA self-chat `549` (paired own number). The mirror under test rides a
 *  REAL log — the upsert/absorb machinery is half the contract. */
async function withMirror(
  fn: (t: {
    publish: (e: Draft<Event>) => Promise<Event>;
    inConv: (conversation: string) => Promise<MessageEvent[]>;
    setDelivery: (id: string, patch: { external_id: string }) => Promise<void>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  }) => Promise<void>,
  opts: { settleMs?: number } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  log.upsertConnections([
    { service: "slack", address: "T1" }, // the workspace anchor inbounds carry (§4)
    { service: "slack", address: "T1:U1", agentId: "ana", extra: { self_conversation: "D1" } },
    { service: "whatsapp", address: "549", agentId: "ana" }, // WA binding is DERIVED (§4)
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    settleMs: opts.settleMs ?? 30,
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
      publish: (e) => log.publish(e) as Promise<Event>, // mirror drafts always store
      inConv: async (conversation) =>
        (await log.read({ conversation, types: ["message"] })) as MessageEvent[],
      setDelivery: (id, patch) => log.setDelivery(id, patch),
      waitFor,
    });
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const aliasInbound = (
  text: string,
  over: Partial<{ external_id: string; extra: Record<string, unknown> }> = {},
): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  envelope: {
    service: "slack",
    connection_address: "T1", // events anchor to the workspace, the binding is the grant (§4)
    conversation: { address: "D1", kind: "direct" },
    sender: { address: "U1", name: "ana" },
    ...(over.external_id ? { external_id: over.external_id } : {}),
  },
  parts: [{ type: "text", kind: "text", text }],
  ...(over.extra ? { extra: over.extra } : {}),
});

const mindMsg = (
  text: string,
  over: Partial<MessageEvent> = {},
): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: "mind:ana" },
    sender: { address: "ana", name: "ana" },
  },
  parts: [{ type: "text", kind: "text", text }],
  ...over,
});

const textOf = (e: MessageEvent) =>
  (e.parts ?? []).filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
    .join("\n");

Deno.test("mirror fan-in: an alias inbound copies to the mind and cross-CCs the other surface", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const origin = await publish(aliasInbound("pick up milk", {
      external_id: "slack:T1:D1:111.1",
    }));

    // the mind copy: wakes like a REPL line — sender kept, provenance in `via`, cause home
    await waitFor(async () => (await inConv("mind:ana")).length === 1);
    const [copy] = await inConv("mind:ana");
    // the principal's stamp (§3): whose mind + through the harness — and no turn_id,
    // which is what keeps the copy input rather than voice
    assertEquals(copy.agent, { id: "ana", session_id: "ana" });
    assertEquals(copy.payload?.turn_id, undefined);
    assertEquals(copy.envelope.sender?.address, "U1");
    assertEquals(textOf(copy), "pick up milk");
    assertEquals(copy.payload?.ref_id, origin.id);
    assertEquals(copy.extra?.via, {
      event: origin.id,
      service: "slack",
      connection: "T1",
      conversation: "D1",
      external_id: "slack:T1:D1:111.1",
    });

    // the cross-broadcast: fan-out over the copy reaches WA — tagged, agent-legged
    await waitFor(async () => (await inConv("549")).length === 1);
    const [cc] = await inConv("549");
    assertEquals(cc.agent?.id, "ana");
    assertEquals(textOf(cc), "`[you via slack]` pick up milk");
    // …and never back to the origin surface
    await new Promise((r) => setTimeout(r, 150));
    assertEquals((await inConv("D1")).length, 1);
  });
});

Deno.test("mirror fan-out: the agent's voice CCs tagged to every alias, and CCs never re-enter", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "ana" }, payload: { turn_id: "t9" } }),
    );

    await waitFor(async () =>
      (await inConv("D1")).length === 1 && (await inConv("549")).length === 1
    );
    for (const conv of ["D1", "549"]) {
      const [cc] = await inConv(conv);
      // tagged: on a self-conversation surface both speakers render as the principal —
      // the tag is what tells the agent's output from the principal's input there
      assertEquals(textOf(cc), "`[agent]` done!");
      assertEquals(cc.agent?.id, "ana");
      assertEquals(cc.extra?.via, {
        event: cc.payload?.ref_id,
        service: "local",
        conversation: "mind:ana",
      });
    }
    // the loop guard: the CCs are copies (agent + via) — nothing fans back in or out again
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("mind:ana")).length, 1);
    assertEquals((await inConv("D1")).length, 1);
    assertEquals((await inConv("549")).length, 1);
  });
});

Deno.test("mirror fan-out: a REPL-typed principal line CCs tagged with where it was typed", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish(mindMsg("hola"));
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(textOf((await inConv("D1"))[0]), "`[you via repl]` hola");
    assertEquals(textOf((await inConv("549"))[0]), "`[you via repl]` hola");
  });
});

Deno.test("mirror fan-out: a tool call crosses as one redacted line", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const use: Draft<ToolUseEvent> = {
      ts: new Date().toISOString(),
      type: "tool_use",
      payload: { turn_id: "t1" },
      agent: { id: "ana", session_id: "ana" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:ana" },
      },
      parts: [{
        type: "data",
        kind: "tool_use",
        data: { name: "bash", input: { command: "git status\n# extra" } },
      }],
    };
    await publish(use);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(textOf((await inConv("D1"))[0]), "`[agent tool]` **bash**(git status # extra)");
  });
});

Deno.test("mirror fan-out: the approval card crosses, arguments and reply syntax included", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    // a gate is only a gate if the approver can see it: on a surface there are no key
    // bindings, so the card carries what will be said AND how to answer
    await publish({
      ts: new Date().toISOString(),
      type: "permission_request",
      payload: { ref_id: "01a0-use" },
      agent: { id: "ana", session_id: "ana" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_request",
        data: {
          tool: "send",
          call: "send(to: Vivian)",
          detail: "send(to: Vivian, text: hola)",
        },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    const line = textOf((await inConv("D1"))[0]);
    // the FULL rendering, not the short one: what the anchor lists and what a person
    // approves are different questions (§9)
    assertStringIncludes(line, "`[agent asks]` approve **send**(to: Vivian, text: hola)");
    assertStringIncludes(line, "/y");
    assertStringIncludes(line, "/n");
  });
});

Deno.test("mirror fan-in: a quoted CC is TRANSLATED — the copy's ref_id names the mind event (§9)", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    // a card crosses to the self-DM and its CC gets claimed by the dispatcher
    await publish({
      ts: new Date().toISOString(),
      type: "permission_request",
      payload: { ref_id: "01a0-use" },
      agent: { id: "ana", session_id: "ana" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_request",
        data: { tool: "send", call: "send(to: V)", detail: "send(to: V, text: hola)" },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");
    await setDelivery(cc.id, { external_id: "slack:T1:D1:666.6" });

    // the principal quotes the card and answers — the surface reply names the CC's id
    await publish(aliasInbound("/y", { external_id: "slack:T1:D1:777.7" }));
    const reply = (await inConv("D1")).find((e) => textOf(e) === "/y")!;
    await publish({
      ...aliasInbound("/y", { external_id: "slack:T1:D1:888.8" }),
      payload: { ref_external_id: "slack:T1:D1:666.6" },
    } as Draft<Event>);

    // the mind copy of the QUOTED /y joins the card itself: xi's port never sees the alias
    // conversation (policy §6), so the mirror is where the quote becomes a mu-side ref
    await waitFor(async () =>
      (await inConv("mind:ana")).some((e) => e.payload?.ref_external_id !== undefined)
    );
    const copy = (await inConv("mind:ana")).find((e) => e.payload?.ref_external_id)!;
    assertEquals(copy.payload?.ref_id, (cc.extra?.via as { event: string }).event);
    assertEquals(copy.payload?.ref_external_id, "slack:T1:D1:666.6");
    // …while the unquoted /y keeps plain provenance
    const bare = (await inConv("mind:ana")).find((e) => !e.payload?.ref_external_id)!;
    assertEquals(bare.payload?.ref_id, reply.id);
  });
});

Deno.test("mirror fan-in settles: an echo absorbed by the dispatch backfill copies nothing", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    // the agent speaks → a CC to the self-DM lands (what a dispatcher would then post)
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "ana" }, payload: { turn_id: "t9" } }),
    );
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");

    // the 小-window: the platform echoes the post BEFORE the ts backfill — a fresh row
    const echo = await publish(aliasInbound("done!", { external_id: "slack:T1:D1:222.2" }));
    assert(echo.id !== cc.id);
    // …and the backfill lands within the settle window, absorbing the echo into the CC
    await setDelivery(cc.id, { external_id: "slack:T1:D1:222.2" });

    // past the settle: the echo is gone, so the mirror found nothing to copy — the mind
    // still holds only the original voice line
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await inConv("mind:ana")).length, 1);
    assertEquals((await inConv("D1")).length, 1);
  }, { settleMs: 150 });
});

Deno.test("mirror fan-in: an echo whose claim never lands is absorbed by the CC it came from", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    // the agent speaks → a CC to the self-DM, which a dispatcher posts and then dies on:
    // no `setDelivery`, so the row never gets the id its own post came back with
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "ana" }, payload: { turn_id: "t9" } }),
    );
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");
    assertEquals(cc.envelope.external_id, undefined);

    // the platform hands the post back: same words, a real id, nothing to merge into
    await publish(aliasInbound("`[agent]` done!", { external_id: "slack:T1:D1:333.3" }));

    // the guard: an inbound always carries an id, so a CC of these words holding none IS
    // this post — the mirror stamps it (absorbing the echo) instead of copying it home
    await waitFor(async () => (await inConv("D1"))[0].envelope.external_id !== undefined);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("D1")).length, 1); // the echo row is gone, absorbed
    assertEquals((await inConv("D1"))[0].envelope.external_id, "slack:T1:D1:333.3");
    assertEquals((await inConv("mind:ana")).length, 1); // the mind never heard itself
    assertEquals((await inConv("549")).length, 1); // …and nothing crossed to the other surface
  });
});

Deno.test("mirror fan-in: a CLAIMED CC never swallows the principal repeating its words", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "ana" }, payload: { turn_id: "t9" } }),
    );
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");
    await setDelivery(cc.id, { external_id: "slack:T1:D1:444.4" }); // a healthy dispatcher

    // the principal, typing the same words a moment later — a different id, and the CC is
    // claimed: the guard's whole safety is that an unstamped row is otherwise unobservable
    await publish(aliasInbound("`[agent]` done!", { external_id: "slack:T1:D1:555.5" }));
    await waitFor(async () => (await inConv("mind:ana")).length === 2);
    assertEquals(textOf((await inConv("mind:ana"))[1]), "`[agent]` done!");
  });
});

Deno.test("mirror: imported history never mirrors (no backfill — the REPL alone reads history)", async () => {
  await withMirror(async ({ publish, inConv }) => {
    await publish(aliasInbound("old news", { extra: { backfill: true } }));
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("mind:ana")).length, 0);
  });
});

Deno.test("mirror fan-out: a harness error crosses — the one voice left when a gate waits", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish({
      ts: new Date().toISOString(),
      type: "error",
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:ana" },
      },
      parts: [{
        type: "data",
        kind: "error",
        data: { error: "2 approvals are waiting — reply TO the one you mean" },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertStringIncludes(textOf((await inConv("D1"))[0]), "`[system]` 2 approvals are waiting");
  });
});

Deno.test("mirror fan-out: a withdrawal crosses, a verdict never does — turn_id is the bit", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const settle = (
      payload: { ref_id: string; turn_id?: string },
      text?: string,
    ): Draft<Event> => ({
      ts: new Date().toISOString(),
      type: "permission_response",
      payload,
      agent: { id: "ana", session_id: "ana" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_response",
        data: { behavior: "deny", scope: "once", reason: "withdrawn by the agent" },
        ...(text !== undefined ? { text } : {}),
      }],
    } as Draft<Event>);
    // the principal's own verdict: their /y line is already on their surface
    await publish(settle({ ref_id: "01a0-use" }));
    // the agent's cancel (turn-marked): the card went out, so the withdrawal follows it
    await publish(settle({ ref_id: "01a1-use", turn_id: "T1" }, "send(to: Vivian)"));
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertStringIncludes(
      textOf((await inConv("D1"))[0]),
      "`[system]` withdrawn: **send**(to: Vivian)",
    );
  });
});
