/**
 * End-to-end scenarios over the real SQLite log: a main-shaped fan-out (subscribe → invoke
 * `handle` per event, serialized per agent, boot alarm at start), scripted mu, everything
 * else live — verdicts, lock, acts, gates, recovery. The log is the continuation engine.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AgentConfig, xi, type XiPorts } from "./xi.ts";
import { type Log, openLog } from "./store/log.ts";
import { openFileDocs } from "./store/docs.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { Emission, ModelTransport } from "./mu.ts";
import { canned, scripted } from "./testing.ts";
import { shortId } from "./render.ts";
import type { Draft, Event, Json, MessageEvent, ToolResultEvent, ToolUseEvent } from "./types.ts";

const CONFIG: AgentConfig = {
  agentId: "a1",
  sessionId: "s1",
  home: "home",
  model: "claude-x",
  maxTokens: 1024,
  gate: () => "allow", // gating off unless a test opts in
  digestAfterMessages: 1, // attention off: one ambient message is already due (xi.test owns §2)
  retryDelaysMs: [0, 0],
};

/** A scripted model edge: each turn consumes the next response; when empty, closes quietly. */
const ok = (emissions: Emission[], stop: Anthropic.StopReason = "end_turn") =>
  canned(emissions, stop);

/** The exec-plane tool the scenarios use — injected via ports (bash's stand-in). */
const echoTool = {
  spec: {
    name: "echo",
    description: "echoes its input",
    input_schema: { type: "object" as const },
  },
  execute: (input: unknown) => Promise.resolve({ echoed: input } as never),
};

function principalMsg(text: string): Draft<MessageEvent> {
  return {
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "home" },
      sender: { address: "ana", name: "Ana" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}

/** main's shape, miniature: one tail, one invocation per change, a boot invoke. No filter and
 *  no queue — the turn lock is the concurrency control (§2); `outstanding` is only so stop()
 *  can await what's in flight. */
function fanOut(config: AgentConfig, log: Log, ports: XiPorts): { stop(): Promise<void> } {
  let stopped = false;
  const outstanding = new Set<Promise<void>>();
  const invoke = (trigger?: Event) => {
    if (stopped) return;
    const run = xi(config, ports, trigger).catch(() => {}).finally(() => outstanding.delete(run));
    outstanding.add(run);
  };
  const unsubscribe = log.subscribe(invoke); // the event goes straight through to xi
  invoke(); // boot: no trigger ⇒ look at whatever the log already owes
  return {
    async stop() {
      stopped = true;
      unsubscribe();
      await Promise.all([...outstanding]);
    },
  };
}

async function scenario(
  script: Anthropic.Message[],
  fn: (t: {
    calls: () => number;
    read: (type?: Event["type"]) => Promise<Event[]>;
    publish: (e: Draft<Event>) => Promise<Event>;
    preloaded: Event[]; // as STORED — the store minted their ids (§3)
  }) => Promise<void>,
  config: Partial<AgentConfig> = {},
  preload: Draft<Event>[] = [], // events in the log before the fan-out starts (recovery)
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const preloaded: Event[] = [];
  for (const e of preload) preloaded.push((await log.publish(e))!);
  const { transport, calls } = scripted(script);
  const main = fanOut({ ...CONFIG, ...config }, log, {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    exec: { echo: echoTool },
  });
  try {
    await fn({
      calls,
      read: (type?: Event["type"]) => log.read(type ? { types: [type] } : undefined),
      publish: (e) => log.publish(e) as Promise<Event>, // scenario drafts always store
      preloaded,
    });
  } finally {
    await main.stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a principal message spawns a turn; stamped events are published", async () => {
  await scenario(
    [ok([
      { kind: "thinking", thinking: "easy one", signature: "sig" },
      { kind: "assistant", text: "¡Hola Ana!" },
    ], "end_turn")],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("hola"));
      await waitFor(async () => (await read("thinking")).length === 1);

      const replies = (await read("message")).filter((e) => e.agent?.session_id === "s1");
      assertEquals(replies.length, 1);
      assertEquals(replies[0].envelope.conversation.address, "home");
      assertEquals(typeof replies[0].payload?.turn_id, "string");
      assertEquals(calls(), 1);
    },
  );
});

Deno.test("max_tokens: the cut-off turn CONTINUES (not a dead-end) and warns the model", async () => {
  const partial = ok([{ kind: "assistant", text: "here is the first half" }], "max_tokens");
  await scenario(
    [partial, ok([{ kind: "assistant", text: "…and the rest" }], "end_turn")],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("write me a long thing"));
      // the loop must re-enter after max_tokens → a SECOND step → the closing turn
      await waitFor(async () =>
        (await read("message")).some((e) =>
          e.agent?.session_id === "s1" &&
          (e as MessageEvent).parts.some((p) => p.type === "text" && p.text === "…and the rest")
        )
      );
      assertEquals(calls(), 2); // continued, did not stop at the ceiling
      // the advisory rode along so the model knows it was truncated
      const errs = await read("error");
      assert(errs.length === 1);
      assertStringIncludes(
        (errs[0] as { parts: [{ data: { error: string } }] }).parts[0].data.error,
        "output token limit",
      );
    },
  );
});

Deno.test("tool cycle: use → act → result → closing turn; then quiescence", async () => {
  await scenario(
    [
      ok([{ kind: "tool_use", name: "echo", input: { v: 42 } }], "tool_use"),
      ok([{ kind: "assistant", text: "done: 42" }], "end_turn"),
    ],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("run the tool"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const [use] = await read("tool_use") as ToolUseEvent[];
      const [result] = await read("tool_result");
      assert(result.type === "tool_result");
      assertEquals(result.payload.ref_id, use.id);
      assertEquals(result.parts[0].data.output, { echoed: { v: 42 } });

      await waitFor(async () =>
        (await read("message")).some((e) =>
          e.agent?.session_id === "s1" && JSON.stringify(e.parts).includes("done: 42")
        )
      );
      await new Promise((r) => setTimeout(r, 300)); // run-to-quiescence: no extra turns
      assertEquals(calls(), 2);
    },
  );
});

Deno.test("coalescing: messages landing mid-turn batch into ONE follow-up, not one each", async () => {
  await scenario(
    [
      ok([{ kind: "tool_use", name: "echo", input: {} }], "tool_use"),
      ok([{ kind: "assistant", text: "first" }], "end_turn"),
      ok([{ kind: "assistant", text: "SPURIOUS" }], "end_turn"), // must never be consumed
    ],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("uno"));
      await publish(principalMsg("dos")); // lands while the first turn is owed/in flight
      // one closing turn answers dos + the tool result together (the batch a turn consumes)
      await waitFor(async () =>
        (await read("message")).some((e) => JSON.stringify(e.parts).includes("first"))
      );
      await new Promise((r) => setTimeout(r, 400)); // quiescence: nothing respawns
      assertEquals(calls(), 2); // NOT three — dos never got its own spawn
      assertEquals(
        (await read("message")).some((e) => JSON.stringify(e.parts).includes("SPURIOUS")),
        false,
      );
    },
  );
});

Deno.test("send: directed message + queued result, both cause-linked", async () => {
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "wa:mariana", text: "hola!" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "le escribí" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("escribile a mariana"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const [use] = await read("tool_use") as ToolUseEvent[];
      const directed = (await read("message")).filter((e) =>
        e.envelope.conversation.address === "wa:mariana"
      );
      assertEquals(directed.length, 1);
      assertEquals((directed[0] as Event).payload?.ref_id, use.id);
    },
  );
});

Deno.test("gating: the ask is part of executing — the call is answered, then run or refused", async () => {
  const respond = (refId: string, behavior: "allow" | "deny"): Draft<Event> => ({
    ts: new Date().toISOString(),
    type: "permission_response",
    payload: { ref_id: refId },
    envelope: { service: "local", connection_address: "agent", conversation: { address: "home" } },
    parts: [{
      type: "data",
      kind: "permission_response",
      data: {
        behavior,
        scope: "once",
        ...(behavior === "deny" ? { reason: "not now" } : {}),
      },
    }],
  });

  // allow
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      const [req] = await read("permission_request");
      assert(req.type === "permission_request");
      assertEquals(req.envelope.conversation.address, "home");
      // the card names the call the way a person reads it — not a slice of its JSON
      assertEquals(req.parts[0].data.call, "send(to: wa:x, text: hi)");
      assertEquals(req.parts[0].data.detail, "send(to: wa:x, text: hi)");
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
        0,
      );
      // …and the call was ANSWERED in the same breath: nothing is left hanging, which is
      // what lets the mind keep talking while the principal decides
      await waitFor(async () => (await read("tool_result")).length === 1);
      const [asked] = await read("tool_result");
      assert(asked.type === "tool_result");
      assertEquals(asked.payload.ref_id, req.payload.ref_id);
      assertStringIncludes(JSON.stringify(asked.parts[0].data.output), "pending_approval");

      await publish(respond(req.payload.ref_id, "allow"));
      await waitFor(async () =>
        (await read("message")).some((e) => e.envelope.conversation.address === "wa:x")
      );
      // the outcome comes back as a DEFERRED result — the record of what ran, narrated by
      // the harness because the tool_use it answers is long spent (§5)
      const outcome = (await read("tool_result")).find((e) => e.payload?.deferred);
      assert(outcome?.type === "tool_result");
      assertEquals(outcome.payload.ref_id, req.payload.ref_id);
      assertEquals(outcome.parts[0].text, "send(to: wa:x, text: hi)");
      assertStringIncludes(JSON.stringify(outcome.parts[0].data.output), "queued");
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );

  // deny
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      const [req] = await read("permission_request");
      assert(req.type === "permission_request");

      await publish(respond(req.payload.ref_id, "deny"));
      await waitFor(async () => (await read("tool_result")).some((e) => e.payload?.deferred));
      const res = (await read("tool_result")).find((e) => e.payload?.deferred);
      assert(res?.type === "tool_result");
      assertEquals(res.parts[0].data.is_error, true);
      assertEquals(String(res.parts[0].data.output).includes("not now"), true);
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
        0,
      );
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );
});

Deno.test("a pending ask lives in the ANCHOR — state, not transcript (§5)", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let last: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const script = [
    ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hola" } }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ];
  const transport: ModelTransport = (params) => {
    last = params;
    return Promise.resolve(script.shift() ?? ok([]));
  };
  const config = { ...CONFIG, gate: (name: string) => name === "send" ? "ask" : "allow" };
  const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("mandale"));
    await xi(config, ports); // the turn that calls send
    await xi(config, ports); // act: the card goes up, the call is answered
    await xi(config, ports); // the think that follows — this is the prompt we read
    const anchor = JSON.stringify(last?.messages.at(-1)?.content);
    assertStringIncludes(anchor, "waiting on your principal — 1 approval");
    assertStringIncludes(anchor, "send(to: wa:x, text: hola)");
    // and NOT in the transcript: what the model sees there is a closed call
    assertStringIncludes(JSON.stringify(last?.messages), "pending_approval");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a waiting gate does not mute the agent: it answers its principal meanwhile", async () => {
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([{ kind: "assistant", text: "le escribo apenas me des el ok" }], "end_turn"),
      ok([{ kind: "assistant", text: "sí, sigue pendiente" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      // the ask is up and unanswered — and the model still gets its turn
      await waitFor(async () =>
        (await read("message")).some((e) =>
          e.agent?.session_id === "s1" && String(JSON.stringify(e.parts)).includes("apenas")
        )
      );
      // the principal changes the subject rather than answering: that is answered too. The
      // old gate ignored EVERYTHING here (a turn would re-issue the unresolved tool_use).
      await publish(principalMsg("y lo otro?"));
      await waitFor(async () =>
        (await read("message")).some((e) =>
          e.agent?.session_id === "s1" && String(JSON.stringify(e.parts)).includes("pendiente")
        )
      );
      assertEquals((await read("permission_request")).length, 1); // and never re-asked
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
        0, // still nothing sent: the gate holds, it just doesn't hold the mind
      );
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );
});

/* ── recovery: the boot poke does whatever the log owes ───────────────── */

const orphanUse = (): Draft<Event> => ({
  ts: new Date().toISOString(),
  type: "tool_use",
  payload: { turn_id: "T-crashed" },
  agent: { id: "a1", session_id: "s1" },
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind:a1" } },
  parts: [{ type: "data", kind: "tool_use", data: { name: "echo", input: { v: 1 } } }],
});

Deno.test("no duplicate turn: the decision is re-derived under the lease, not before it", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const { transport, calls } = scripted([
    ok([{ kind: "assistant", text: "ya contesté" }], "end_turn"),
    ok([{ kind: "assistant", text: "DUPLICATE" }], "end_turn"), // must never be consumed
  ]);
  const ports = { log, docs: openFileDocs(`${dir}/docs`), transport, exec: { echo: echoTool } };
  try {
    await log.publish(principalMsg("hola"));
    // TWO invocations for the same event — both would have decided "think" before the lease
    // existed; the second must re-decide against a window that already holds the answer
    await xi(CONFIG, ports, undefined);
    await xi(CONFIG, ports, undefined);
    assertEquals(calls(), 1);
    const replies = (await log.read({ types: ["message"] }))
      .filter((e) => e.agent?.session_id === "s1");
    assertEquals(replies.length, 1);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the gate is free: a spectator event takes no lease and reads nothing", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const { transport, calls } = scripted([ok([{ kind: "assistant", text: "no" }], "end_turn")]);
  const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("hola")); // real work IS owed…
    const thinking = await log.publish({
      ts: new Date().toISOString(),
      type: "thinking",
      payload: { turn_id: "T" },
      agent: { id: "a1", session_id: "s1" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind:a1" },
      },
      parts: [{ type: "data", kind: "thinking", data: { thinking: "…", signature: "s" } }],
    });
    // …but a `thinking` trigger never gets far enough to find out
    await xi(CONFIG, ports, thinking!);
    assertEquals(calls(), 0);
    assertEquals(await log.lock("turn-a1").held(), false); // the lease was never taken
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("recovery: a stale lock (crashed holder) → pending uses swept, then the closing turn", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.publish(principalMsg("seguís ahí?"));
  const use = (await log.publish(orphanUse()))!;
  // the crashed holder left its lease in the store; age it past the TTL
  assertEquals(await log.lock("turn-a1", 50).acquire(), "acquired");
  await new Promise((r) => setTimeout(r, 80));

  const { transport, calls } = scripted([
    ok([{ kind: "assistant", text: "acá estoy" }], "end_turn"),
  ]);
  const main = fanOut({ ...CONFIG, lockTtlMs: 50 }, log, {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    exec: { echo: echoTool },
  });
  try {
    await waitFor(async () => (await log.read({ types: ["tool_result"] })).length === 1);
    const [swept] = await log.read({ types: ["tool_result"] });
    assert(swept.type === "tool_result");
    assertEquals(swept.payload.ref_id, use.id);
    assertEquals(swept.parts[0].data.cancelled, true); // swept, NOT re-run — state unknown
    await waitFor(() => calls() >= 1); // the completed barrier then owes the closing think
  } finally {
    await main.stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("recovery: a pending use with a cleanly released lock is simply run at boot", async () => {
  // no lock left behind ⇒ nothing crashed mid-flight — the act just never ran; execute it
  await scenario(
    [ok([{ kind: "assistant", text: "hecho" }], "end_turn")],
    async ({ read, calls, preloaded }) => {
      await waitFor(async () => (await read("tool_result")).length === 1);
      const [res] = await read("tool_result");
      assert(res.type === "tool_result");
      assertEquals(res.payload.ref_id, preloaded[1].id);
      assertEquals(res.parts[0].data.output, { echoed: { v: 1 } });
      assertEquals(res.parts[0].data.cancelled, undefined);
      await waitFor(() => calls() >= 1);
    },
    {},
    [principalMsg("seguís ahí?"), orphanUse()],
  );
});

Deno.test("compaction: an over-threshold window is checkpointed before the think (§5)", async () => {
  await scenario(
    [
      ok([{ kind: "assistant", text: "respuesta uno" }], "end_turn"),
      ok([{ kind: "assistant", text: "## checkpoint viejo" }], "end_turn"), // the checkpoint TURN
      ok([{ kind: "assistant", text: "respuesta dos" }], "end_turn"),
    ],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("uno"));
      await waitFor(async () => (await read("message")).some((e) => e.agent !== undefined));
      await publish(principalMsg("dos"));

      await waitFor(async () => (await read("summary")).length === 1);
      const [sum] = await read("summary");
      assert(sum.type === "summary");
      assertEquals(JSON.stringify(sum.parts).includes("checkpoint viejo"), true);
      // covers exactly the first closed exchange: [uno, respuesta uno]
      const msgs = await read("message");
      assertEquals(sum.payload.covers[0], msgs[0].id);
      assertEquals(sum.payload.covers[1], msgs[1].id);

      await waitFor(async () =>
        (await read("message")).some((e) => JSON.stringify(e.parts).includes("respuesta dos"))
      );
      await new Promise((r) => setTimeout(r, 300)); // quiescence
      // THREE model calls — the checkpoint being its own invocation didn't add any: reply,
      // checkpoint (displacing a turn; its insert wakes the think), the displaced think
      assertEquals(calls(), 3);
    },
    { compactAt: 1, keepRecent: 0 },
  );
});

Deno.test("coalescing race: a message landing between window-read and closing publish is still answered", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let n = 0;
  const transport: ModelTransport = async () => {
    n++;
    if (n === 1) {
      await hold; // keep turn 1 in flight — its window was already read
      return ok([{ kind: "assistant", text: "uno listo" }]);
    }
    return ok([{ kind: "assistant", text: "dos listo" }]);
  };
  const main = fanOut(CONFIG, log, { log, docs: openFileDocs(`${dir}/docs`), transport });
  try {
    await log.publish(principalMsg("uno"));
    await waitFor(() => n >= 1); // turn 1 read its window and is mid-flight
    await log.publish(principalMsg("dos")); // BEFORE the closing lands in the log
    release();
    // the closing's consumed-horizon exposes "dos" as unanswered → a second turn answers it
    await waitFor(async () =>
      (await log.read({ types: ["message"] })).some((e) =>
        JSON.stringify(e.parts).includes("dos listo")
      )
    );
    assertEquals(n, 2);
  } finally {
    await main.stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("send `re`: the window's id resolves to the wire's name — reply, react, and a miss", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  log.upsertConnections([{ service: "whatsapp", address: "org" }]); // the publish gate
  try {
    // what the model will point at: a peer message that already crossed a wire, so it has
    // the only name the platform will accept back — its external_id (§3)
    const peer = await log.publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "org",
        external_id: "whatsapp:wmw.abc",
        conversation: { address: "wa:g1", kind: "group" },
        sender: { address: "549:caro", name: "Caro" },
      },
      parts: [{ type: "text", kind: "text", text: "quién trae el proyector?" }],
    }) as Event;

    // the handles are filled in after the store minted the id — exactly what render would
    // have shown the model on that line
    const reply: Record<string, Json> = { to: "wa:g1", text: "yo lo llevo" };
    const react: Record<string, Json> = { to: "wa:g1", react: "👍" };
    const miss: Record<string, Json> = { to: "wa:g1", text: "?", re: "zzzzzz" };
    const { transport } = scripted([
      ok([{ kind: "tool_use", name: "send", input: reply }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: react }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: miss }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ]);
    reply.re = shortId(peer.id);
    react.re = shortId(peer.id);

    const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
    for (let i = 0; i < 6; i++) await xi(CONFIG, ports); // one turn per call; extras idle

    const ours = (await log.read({ types: ["message"] }))
      .filter((e) => e.agent !== undefined) as MessageEvent[];
    assertEquals(ours.length, 2); // the miss published nothing

    const [answered, reacted] = ours;
    // the reference travels as the WIRE's name, and the send says what it does to it
    assertEquals(answered.payload?.ref_external_id, "whatsapp:wmw.abc");
    assertEquals(answered.payload?.action, "reply");
    assertEquals(reacted.payload?.ref_external_id, "whatsapp:wmw.abc");
    assertEquals(reacted.payload?.action, "add");
    assertEquals(reacted.parts[0], {
      type: "data",
      kind: "reaction",
      data: { name: "👍", unicode: "👍" },
    });

    // an id that names nothing fails LOUDLY, in the model's own tool_result — a reply to
    // the wrong message would be silent
    const errors = (await log.read({ types: ["tool_result"] }))
      .filter((e) => JSON.stringify(e.parts).includes("is_error"));
    assertEquals(errors.length, 1);
    assertStringIncludes(JSON.stringify(errors[0].parts), 'no message \\"zzzzzz\\" in wa:g1');
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("send action: the account may unsay its own words, and lift its own reaction", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  log.upsertConnections([{ service: "whatsapp", address: "org" }]);
  try {
    const wa = (id: string, text: string, mine: boolean) => ({
      ts: new Date().toISOString(),
      type: "message" as const,
      ...(mine ? { agent: { id: "a1", session_id: "s1" } } : {}),
      envelope: {
        service: "whatsapp" as const,
        connection_address: "org",
        external_id: `whatsapp:wmw.${id}`,
        conversation: { address: "wa:g1", kind: "group" as const },
        ...(mine ? {} : { sender: { address: "549:caro", name: "Caro" } }),
      },
      parts: [{ type: "text" as const, kind: "text" as const, text }],
    });
    // one of ours (dispatched, so it has a wire name) and one of theirs
    const mine = await log.publish(wa("mine", "nos vemos 9", true)) as Event;
    const theirs = await log.publish(wa("theirs", "quién trae el proyector?", false)) as Event;

    const edit: Record<string, Json> = { to: "wa:g1", text: "nos vemos 10" };
    const del: Record<string, Json> = { to: "wa:g1" };
    const unreact: Record<string, Json> = { to: "wa:g1", react: "👍" };
    const theirEdit: Record<string, Json> = { to: "wa:g1", text: "no dijiste eso" };
    const { transport } = scripted([
      ok([{ kind: "tool_use", name: "send", input: edit }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: del }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: unreact }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: theirEdit }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ]);
    Object.assign(edit, { re: shortId(mine.id), action: "edit" });
    Object.assign(del, { re: shortId(mine.id), action: "delete" });
    Object.assign(unreact, { re: shortId(theirs.id), action: "remove" });
    Object.assign(theirEdit, { re: shortId(theirs.id), action: "edit" });

    const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
    for (let i = 0; i < 8; i++) await xi(CONFIG, ports);

    const ours = (await log.read({ types: ["message"] }))
      .filter((e) => e.agent !== undefined && e.envelope.external_id === undefined);
    assertEquals(ours.map((e) => e.payload?.action), ["edit", "delete", "remove"]);
    assertEquals(ours.every((e) => e.payload?.ref_external_id !== undefined), true);
    // the edit carries the replacement; the delete carries nothing — the referent's words
    // are the referent's, and the window still holds them
    assertStringIncludes(JSON.stringify(ours[0].parts), "nos vemos 10");
    assertEquals((ours[1] as MessageEvent).parts, []);
    assertEquals((ours[2] as MessageEvent).parts[0].kind, "reaction");

    // editing someone else's words is refused HERE, in the model's own tool_result —
    // some wires would accept the stanza and silently ignore it
    const errors = (await log.read({ types: ["tool_result"] }))
      .filter((e) => JSON.stringify(e.parts).includes("is_error"));
    assertEquals(errors.length, 1);
    assertStringIncludes(
      JSON.stringify(errors[0].parts),
      "only this account's own messages can be edited",
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the boot cutoff: an agent coming up after an absence owes only the recent hours", async () => {
  // A connector keeps ingesting while the agent is down, so the log fills with live rows
  // nobody answered. `since` — a FIXED instant, main sets it to start − `backlogHours` — is
  // what keeps that pile history rather than a mandate: the boot invocation sees past the
  // floor, finds nothing owed, and stays quiet. It does not follow the clock afterwards:
  // what the agent inherited is settled when it comes up, and the count cap does the rest.
  const stale = (hoursAgo: number, text: string): Draft<MessageEvent> => ({
    ts: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "room" },
      sender: { address: "vecino", name: "Vecino" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });

  await scenario(
    [ok([{ kind: "assistant", text: "ahora sí" }])],
    async ({ publish, read, calls }) => {
      // boot ran against a log holding only the old pile — and asked the model nothing
      await new Promise((r) => setTimeout(r, 150));
      assertEquals(calls(), 0);

      // one live message inside the bound, and the same log is work again
      await publish(stale(0, "¿estás?"));
      await waitFor(async () => (await read("message")).some((e) => e.agent?.session_id === "s1"));
      assertEquals(calls(), 1);
    },
    { since: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    [stale(50, "el sábado"), stale(30, "ayer a la tarde"), stale(3, "esta mañana")],
  );
});

Deno.test("search by name: the handle the window SHOWED resolves to addresses", async () => {
  // the log keys on addresses; what the model reads is a name. Old rows from a chat that
  // is out of window entirely — search is the only way back to them.
  const old = (text: string, from?: { address: string; name: string }): Draft<MessageEvent> => ({
    ts: new Date(Date.now() - 40 * 3_600_000).toISOString(),
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "15613518605", kind: "direct", name: "Gianvito" },
      ...(from ? { sender: { address: from.address, name: from.name } } : {}),
    },
    parts: [{ type: "text", kind: "text", text }],
  });

  await scenario(
    [
      ok([{ kind: "tool_use", name: "search", input: { in: "gianvito" } }], "tool_use"),
      ok([{ kind: "tool_use", name: "search", input: { from: "Nadie" } }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("qué me dijo Gianvito"));
      await waitFor(async () => (await read("tool_result")).length === 2);
      const [found, missed] = await read("tool_result");

      // matched case-insensitively, and the row hands back the address to point at
      const rows = (found as ToolResultEvent).parts[0].data.output as {
        address: string;
        conversation: string;
        sender: string;
      }[];
      assertEquals(rows.length, 2);
      assertEquals(rows[0].address, "15613518605");
      assertEquals(rows[0].conversation, "Gianvito"); // named, not numbered
      assertEquals(rows[1].sender, "Gianvito");

      // a name nobody wears is an ERROR, not an empty result: "I don't know who that is"
      // and "they never said that" are different answers
      assertStringIncludes(JSON.stringify((missed as ToolResultEvent).parts), "nobody named");
    },
    {},
    [
      old("te debo la respuesta"),
      old("dale, mañana", { address: "15613518605", name: "Gianvito" }),
    ],
  );
});

Deno.test("the gate answers from a surface: the principal's own /y and /n settle it", async () => {
  // the approval card crosses to wherever the principal is (mirror), and their reply comes
  // back as an ordinary message — so the verdict has to be readable from their own words,
  // in their own DM, with no terminal in the loop. Their rows carry the principal stamp:
  // agent.id, no turn_id (§3).
  const says = (text: string): Draft<MessageEvent> => ({
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "s1" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "home" },
      sender: { address: "matias", name: "Matías" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });

  // /y — the send goes out
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(says("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      await publish(says("/y"));
      await waitFor(async () =>
        (await read("message")).some((e) => e.envelope.conversation.address === "wa:x")
      );
      const [verdict] = await read("permission_response");
      assert(verdict.type === "permission_response");
      assertEquals(verdict.parts[0].data.behavior, "allow");
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );

  // /n <reason> — the refusal reaches the model with the principal's words in it
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(says("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      await publish(says("/n muy formal, reescribilo"));
      await waitFor(async () => (await read("tool_result")).some((e) => e.payload?.deferred));
      const res = (await read("tool_result")).find((e) => e.payload?.deferred);
      assert(res?.type === "tool_result");
      assertEquals(res.parts[0].data.is_error, true);
      assertStringIncludes(String(res.parts[0].data.output), "muy formal, reescribilo");
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
        0,
      );
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );

  // a word that is NOT a verdict settles nothing — the gate keeps waiting
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(says("mandale"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      await publish(says("dale pero esperá"));
      await new Promise((r) => setTimeout(r, 250));
      assertEquals((await read("permission_response")).length, 0);
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
        0,
      );
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );
});

Deno.test("two cards open: a bare /y settles nothing, the quoted one settles its own", async () => {
  // a quoted /y arrives as the mirror writes it: `ref_id` already TRANSLATED to the card
  // event (the join happens at fan-in, where visibility lives — the alias conversation is
  // hidden from xi's port), `ref_external_id` surviving as the they-quoted mark
  const says = (text: string, quote?: string): Draft<MessageEvent> => ({
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "s1" },
    ...(quote
      ? {
        payload: { ref_id: quote, ref_external_id: "wa:card-2" },
        extra: { via: { conversation: "wa:self" } },
      }
      : {}),
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "home" },
      sender: { address: "matias", name: "Matías" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });

  await scenario(
    [
      ok([
        { kind: "tool_use", name: "send", input: { to: "wa:a", text: "uno" } },
        { kind: "tool_use", name: "send", input: { to: "wa:b", text: "dos" } },
      ], "tool_use"),
      ok([], "end_turn"),
      ok([], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(says("mandá los dos"));
      await waitFor(async () => (await read("permission_request")).length === 2);
      const cards = await read("permission_request");

      // bare /y with two open: nothing settles, and the HARNESS says why — the model can't,
      // its own tool_use is still pending and a turn would only re-issue it
      await publish(says("/y"));
      await waitFor(async () => (await read("error")).length === 1);
      assertEquals((await read("permission_response")).length, 0);
      assertStringIncludes(JSON.stringify((await read("error"))[0].parts), "2 approvals");

      // quoting the card answers that one, and only that one
      await publish(says("/y", cards[1].id));
      await waitFor(async () =>
        (await read("message")).some((e) => e.envelope.conversation.address === "wa:b")
      );
      const settled = await read("permission_response");
      assertEquals(settled.length, 1);
      assertEquals(settled[0].payload?.ref_id, cards[1].payload?.ref_id);
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:a").length,
        0,
      );

      // quoting it AGAIN answers nothing — that card is spent. Silence here would read as
      // a broken gate, so the harness says so, and says it ONCE.
      await publish(says("/y", cards[1].id));
      await waitFor(async () => (await read("error")).length === 2);
      assertStringIncludes(JSON.stringify((await read("error"))[1].parts), "already answered");
      assertEquals((await read("permission_response")).length, 1);

      // and once is once: another wake re-reads that same latest line (card 1 is still open,
      // so no turn runs) and the harness stays quiet rather than repeating itself
      await publish({
        ts: new Date().toISOString(),
        type: "message",
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: "wa:a" },
          sender: { address: "wa:a" },
        },
        parts: [{ type: "text", kind: "text", text: "ping" }],
      } as Draft<Event>);
      await new Promise((r) => setTimeout(r, 250)); // quiescence
      assertEquals((await read("error")).length, 2);
    },
    { gate: (name) => name === "send" ? "ask" : "allow" },
  );
});

Deno.test("a standing verdict is REMEMBERED: /y conv settles that conversation's gate (§9)", async () => {
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "uno" } }], "tool_use"),
      ok([{ kind: "assistant", text: "pedido" }], "end_turn"),
      ok([{ kind: "assistant", text: "enviado" }], "end_turn"),
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "dos" } }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandale uno"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      const [req] = await read("permission_request");
      assert(req.type === "permission_request");
      // the verdict, scoped: allow this CONVERSATION from now on (`/y conv` on a surface)
      await publish({
        ts: new Date().toISOString(),
        type: "permission_response",
        payload: { ref_id: req.payload.ref_id },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: "home" },
        },
        parts: [{
          type: "data",
          kind: "permission_response",
          data: { behavior: "allow", scope: "conversation" },
        }],
      });
      // the errand dispatches the queued send…
      await waitFor(async () =>
        (await read("message")).some((e) => e.envelope.conversation.address === "wa:x")
      );
      // …and the NEXT send to wa:x runs unasked: the remembered row outranks the base `ask`
      await publish(principalMsg("mandale dos"));
      await waitFor(async () =>
        (await read("message"))
          .filter((e) => e.envelope.conversation.address === "wa:x").length === 2
      );
      assertEquals((await read("permission_request")).length, 1); // asked once, ever
    },
    // the base table asks for send — no `gate` override: the COMPILED table is the subject
    { gate: undefined, rules: [{ tool: "send", action: "ask" }, { tool: "*", action: "allow" }] },
  );
});
