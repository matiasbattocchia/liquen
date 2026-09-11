/**
 * main: boot the org over a temp dir with a scripted mu — the tail, the per-principal
 * fan-out, the boot poke, and a clean stop. (xi's behavior itself: integration.test.ts.)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { TextLineStream } from "@std/streams";
import { start } from "./main.ts";
import { openLog } from "./store/log.ts";
import type { AgentConfig } from "./xi.ts";
import type { Policy } from "./policy.ts";
import type { ControlEvent, Draft, Event, MessageEvent, ToolResultEvent } from "./types.ts";
import { isCancelled } from "./render.ts";
import type { ModelTransport } from "./mu.ts";
import { canned, scripted } from "./testing.ts";
import { type OrgConfig, readConfig } from "./config.ts";

type Principal = AgentConfig & Policy;

const agent = (n: string, over: Partial<Principal> = {}): Principal => ({
  agentId: `a${n}`,
  sessionId: "mind",
  model: "claude-x",
  maxTokens: 1024,
  gate: () => "allow",
  retryDelaysMs: [0, 0],
  ...over,
});

const reply = (text: string) => canned([{ kind: "assistant", text }]);

function principalMsg(mind: string, text: string): Draft<MessageEvent> {
  return {
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: mind },
      sender: { address: "ana", name: "Ana" },
    },
    parts: [{ type: "text", kind: "text", text }],
  };
}

/** A derived-mode org: the catalog's roster declares the agents (the framework way, §9). */
async function orgDir(
  agents: Record<string, unknown>,
): Promise<{ root: string; dir: string; catalog: OrgConfig }> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ agents }));
  return { root, dir: `${root}/data`, catalog: await readConfig(root) };
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}

Deno.test("a live message flows tail → fan-out → xi → reply; stop is clean", async () => {
  const dir = await Deno.makeTempDir();
  const { transport, calls } = scripted([reply("¡Hola!")]);
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  try {
    await main.log.publish(principalMsg("mind@a1", "hola"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) => e.agent?.id === "a1")
    );
    const [r] = (await main.log.read({ types: ["message"] }))
      .filter((e) => e.agent?.id === "a1");
    assertEquals(r.envelope.conversation.address, "mind@a1");
    assertEquals(calls(), 1);
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop is bounded: a turn wedged on a hung model call cannot block teardown", async () => {
  const dir = await Deno.makeTempDir();
  // a model call that never resolves — the connection is hung (the network-outage case)
  let released!: () => void;
  const wedged = new Promise<void>((r) => (released = r));
  const transport: ModelTransport = () => wedged.then(() => reply("late"));
  const main = await start(
    { dir, principals: [agent("1")], stopTimeoutMs: 200 },
    { transport },
  );
  try {
    await main.log.publish(principalMsg("mind@a1", "hola")); // pokes a turn that will wedge
    await new Promise((r) => setTimeout(r, 100)); // let the turn enter the hung step
    const t0 = Date.now();
    await main.stop(); // must return within ~stopTimeoutMs, not wait on `wedged`
    assert(Date.now() - t0 < 2000, "stop() hung on the in-flight turn");
  } finally {
    released(); // let the orphaned turn unwind (its publish is swallowed post-close)
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("boot poke: work already in the log is answered at start", async () => {
  const dir = await Deno.makeTempDir();
  const pre = await openLog(`${dir}/log`);
  await pre.publish(principalMsg("mind@a1", "seguís ahí?"));
  await pre.close();

  const { transport } = scripted([reply("acá estoy")]);
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  try {
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) => e.agent?.id === "a1")
    );
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the settle: a burst that arrives BETWEEN turns is one turn, not three", async () => {
  const dir = await Deno.makeTempDir();
  let calls = 0;
  let saw = "";
  const transport: ModelTransport = (params) => {
    calls++;
    saw = JSON.stringify(params.messages);
    return Promise.resolve(reply("los tres"));
  };
  // spaced wider than a canned turn takes, so without the settle each line gets its own
  const main = await start({ dir, debounceMs: 300, principals: [agent("1")] }, { transport });
  const pause = () => new Promise((r) => setTimeout(r, 60));
  try {
    await main.log.publish(principalMsg("mind@a1", "una"));
    await pause();
    await main.log.publish(principalMsg("mind@a1", "cosa"));
    await pause();
    await main.log.publish(principalMsg("mind@a1", "sola"));
    await waitFor(() => calls > 0);
    await new Promise((r) => setTimeout(r, 300)); // let any second turn show itself
    assertEquals(calls, 1);
    // and the one turn read the whole thought, not just its first line
    for (const line of ["una", "cosa", "sola"]) assert(saw.includes(line), line);
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("three messages during a turn cause ONE follow-up turn, not three", async () => {
  const dir = await Deno.makeTempDir();
  let entered!: () => void;
  const inStep = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let n = 0;
  const transport: ModelTransport = () => {
    n++;
    if (n === 1) {
      entered();
      return held.then(() => reply("uno"));
    }
    return Promise.resolve(reply("y el resto"));
  };
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  try {
    await main.log.publish(principalMsg("mind@a1", "1"));
    await inStep; // turn 1 is inside the model call
    for (const t of ["2", "3", "4"]) await main.log.publish(principalMsg("mind@a1", t));
    await new Promise((r) => setTimeout(r, 400)); // all three delivered while the run is busy
    release();
    await waitFor(() => n >= 2);
    await new Promise((r) => setTimeout(r, 500)); // any extra invocation would land here
    // The three invocations they triggered all bounced off the turn lock; the closing
    // message's own invocation then found all three unanswered and answered them together.
    // Coalescing needs no mechanism — the lock plus one window read IS the mechanism (§2).
    assertEquals(n, 2);
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every model call is metered: spend lands in the usage table, per agent (§2)", async () => {
  const dir = await Deno.makeTempDir();
  const { transport } = scripted([reply("¡Hola!")]);
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  let turn: string | undefined;
  try {
    await main.log.publish(principalMsg("mind@a1", "hola"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) => e.agent?.id === "a1")
    );
    const said = (await main.log.read({ types: ["message"] }))
      .find((e) => e.agent?.id === "a1");
    turn = said?.payload?.turn_id as string;
  } finally {
    await main.stop();
  }
  // telemetry is a TABLE, not events: read it as one (the log API never serves it)
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(`${dir}/log/log.db`);
  const rows = db.prepare("SELECT agent_id, turn_id, kind, model, output_tokens FROM usage").all();
  db.close();
  await Deno.remove(dir, { recursive: true });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].agent_id, "a1");
  assertEquals(rows[0].model, "claude-x");
  assertEquals(rows[0].kind, "think"); // what it paid for — maintenance is a WHERE away
  // and the spend JOINS the log: the row names the turn whose events it paid for
  assertEquals(rows[0].turn_id, turn);
});

Deno.test("the framework way: the catalog's roster declares the org; the table mirrors it", async () => {
  const { root, dir, catalog } = await orgDir({ ana: {}, bo: {} });
  const { transport } = scripted([reply("hola"), reply("hola")]);
  // no `principals`: the catalog's roster IS the org — a blank entry is a blank agent (§9)
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    await Deno.stat(`${dir}/agents/ana`); // config → folders: boot derived the home
    assertEquals(main.log.agents(), [ // the registry mirrors the roster (the RLS substrate)
      { agentId: "ana", mind: "mind@ana", model: "claude-x" },
      { agentId: "bo", mind: "mind@bo", model: "claude-x" },
    ]);
    await main.log.publish(principalMsg("mind@ana", "hola ana"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) =>
        e.agent?.id === "ana" && e.agent?.session_id === "mind"
      )
    );
    const [r] = (await main.log.read({ types: ["message"] }))
      .filter((e) => e.agent?.id === "ana" && e.agent?.session_id === "mind");
    assertEquals(r.envelope.conversation.address, "mind@ana"); // entry name → mind@<name> (§4)
  } finally {
    await main.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("config.jsonc declares the agent: settings override defaults, handles mirror in (§9)", async () => {
  const { root, dir, catalog } = await orgDir({
    // org.agent's keys, overridden per agent — plus the handles a human knows it by
    ana: { model: "claude-y", effort: "low", identity: { email: "ana@org.example" } },
  });
  const { transport } = scripted([reply("hola")]);
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    assertEquals(main.log.agents(), [{
      agentId: "ana",
      mind: "mind@ana",
      model: "claude-y", // config wins over the MainConfig default
      effort: "low",
      email: "ana@org.example",
    }]);
    await main.log.publish(principalMsg("mind@ana", "hola ana"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) =>
        e.agent?.id === "ana" && e.agent?.session_id === "mind"
      )
    );
  } finally {
    await main.stop();
  }
  // the override reached the transport, not just the mirror: usage metered claude-y
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(`${dir}/log/log.db`);
  const rows = db.prepare("SELECT model FROM usage").all();
  db.close();
  await Deno.remove(root, { recursive: true });
  assertEquals(rows, [{ model: "claude-y" }]);
});

Deno.test("derived policy: another agent's mind is invisible — no spurious turn (§6)", async () => {
  const { root, dir, catalog } = await orgDir({ ana: {}, bo: {} });
  const { transport, calls } = scripted([reply("hola")]);
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    await main.log.publish(principalMsg("mind@ana", "hola ana"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) =>
        e.agent?.id === "ana" && e.agent?.session_id === "mind"
      )
    );
    await new Promise((r) => setTimeout(r, 300)); // room for any spurious bo turn
    assertEquals(calls(), 1); // bo's tail never delivered ana's mind; bo's boot read saw nothing
  } finally {
    await main.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("team chat: sending to a peer's NAME canonicalizes to a DM and enrolls both (§6)", async () => {
  const { root, dir, catalog } = await orgDir({ ana: {}, bo: {} });
  // ana's first think emits a send to "bo"; every later think closes tersely (empty script)
  const { transport } = scripted([
    canned([{ kind: "tool_use", name: "send", input: { to: "bo", text: "hola bo" } }], "tool_use"),
  ]);
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    await main.log.publish(principalMsg("mind@ana", "decile hola a bo"));
    // `send` is gated by default: approve the card, as the principal would (§9)
    await waitFor(async () => (await main.log.read({ types: ["permission_request"] })).length > 0);
    const [req] = await main.log.read({ types: ["permission_request"] });
    await main.log.publish({
      ts: new Date().toISOString(),
      type: "permission_response",
      payload: { ref_id: (req as { payload: { ref_id: string } }).payload.ref_id },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_response",
        data: { behavior: "allow", scope: "once" },
      }],
    } as Draft<Event>);
    await waitFor(async () =>
      (await main.log.read({ conversation: "dm:mind@ana:mind@bo" })).length > 0
    );
    // the executor canonicalized the name and enrolled the pair — visibility is membership
    assert(main.log.isMember("local", "agent", "dm:mind@ana:mind@bo", "ana", "mind"));
    assert(main.log.isMember("local", "agent", "dm:mind@ana:mind@bo", "bo", "mind"));
    const [dm] = await main.log.read({ conversation: "dm:mind@ana:mind@bo" });
    assertEquals(dm.agent, { id: "ana", session_id: "mind" });
  } finally {
    await main.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("send anchors to the conversation's own connection — a reply lands where it came from (§4)", async () => {
  const { root, dir, catalog } = await orgDir({ ana: {} });
  const { transport } = scripted([
    canned([{
      kind: "tool_use",
      name: "send",
      input: { to: "C1", text: "on it" },
    }], "tool_use"),
  ]);
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    // the world speaks first: the inbound stamps the conversation's anchor + kind
    main.log.upsertConnections([{ service: "slack", address: "T1", agentId: "ana" }]);
    main.log.upsertMemberships([
      { service: "slack", connection: "T1", conversation: "C1", agentId: "ana" },
    ]);
    await main.log.publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "slack",
        connection_address: "T1",
        conversation: { address: "C1", kind: "channel" },
        sender: { address: "U7" },
      },
      parts: [{ type: "text", kind: "text", text: "@ana ping" }],
    } as Draft<Event>);
    // …and the principal sends the agent in. A channel line — even one saying its name — is
    // ambient now (§2 attention: the summons is the mind alias), so the poke comes from
    // the session's own room
    await main.log.publish(principalMsg("mind@ana", "contestá en C1"));
    await waitFor(async () => (await main.log.read({ types: ["permission_request"] })).length > 0);
    const [req] = await main.log.read({ types: ["permission_request"] });
    await main.log.publish({
      ts: new Date().toISOString(),
      type: "permission_response",
      payload: { ref_id: (req as { payload: { ref_id: string } }).payload.ref_id },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_response",
        data: { behavior: "allow", scope: "once" },
      }],
    } as Draft<Event>);
    await waitFor(async () =>
      (await main.log.read({ conversation: "C1" })).some((e) => e.agent !== undefined)
    );
    const out = (await main.log.read({ conversation: "C1" }))
      .find((e) => e.agent !== undefined)!;
    // NOT local/agent: the dispatcher's filter and the policy both key on this envelope
    assertEquals(out.envelope.service, "slack");
    assertEquals(out.envelope.connection_address, "T1");
    assertEquals(out.envelope.conversation.kind, "channel");
  } finally {
    await main.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("policy partitions the fan-out: each agent's subscription delivers only its view (§6)", async () => {
  const dir = await Deno.makeTempDir();
  const scope = (n: string) => (e: Event) => e.envelope.conversation.address === `mind@a${n}`;
  const { transport, calls } = scripted([reply("para vos")]);
  const main = await start({
    dir,
    debounceMs: 0,
    principals: [
      agent("1", { readable: scope("1") }),
      agent("2", { readable: scope("2") }),
    ],
  }, { transport });
  try {
    await main.log.publish(principalMsg("mind@a1", "hola a1"));
    await waitFor(async () =>
      (await main.log.read({ types: ["message"] })).some((e) => e.agent?.id === "a1")
    );
    await new Promise((r) => setTimeout(r, 300)); // let any spurious a2 turn surface
    assertEquals(calls(), 1); // a2's tail never even delivered — a1's mind isn't in its view
    const agentMsgs = (await main.log.read({ types: ["message"] }))
      .filter((e) => e.agent !== undefined);
    assertEquals(agentMsgs.length, 1);
    assert(agentMsgs[0].agent?.id === "a1");
    assertEquals(agentMsgs[0].envelope.conversation.address, "mind@a1");
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a named session wakes on its dm and answers in its own room (§4)", async () => {
  const dir = await Deno.makeTempDir();
  const { transport } = scripted([reply("en eso estoy")]);
  // the mind's view is pinned to its own room so the dm line is the named session's alone
  const main = await start({
    dir,
    debounceMs: 0,
    principals: [agent("1", { readable: (e) => e.envelope.conversation.address === "mind@a1" })],
  }, { transport });
  try {
    const dm = "dm:build@a1:mind@a1";
    // what the mind's send would have written: the room, both ends enrolled (§4)
    main.log.upsertMemberships([
      { service: "local", connection: "agent", conversation: dm, agentId: "a1", sessionId: "mind" },
      {
        service: "local",
        connection: "agent",
        conversation: dm,
        agentId: "a1",
        sessionId: "build",
      },
    ]);
    await main.log.publish({
      ts: new Date().toISOString(),
      type: "message",
      agent: { id: "a1", session_id: "mind" },
      payload: { turn_id: "T9" },
      envelope: { service: "local", connection_address: "agent", conversation: { address: dm } },
      parts: [{ type: "text", kind: "text", text: "seguí con el refactor" }],
    } as Draft<Event>);
    // the dm's address names the session (§4): main built a runner on first contact, the
    // session woke REACTIVELY (no digest), and its closing landed in its own room
    await waitFor(async () => (await main.log.read({ conversation: "build@a1" })).length > 0);
    const [r] = await main.log.read({ conversation: "build@a1" });
    assertEquals(r.agent, { id: "a1", session_id: "build" });
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the mirror is main's own subscription: an alias inbound reaches the mind (§4)", async () => {
  const dir = await Deno.makeTempDir();
  const { transport } = scripted([reply("dale")]);
  // the mirror copies into the MIND session's room — the pair names it (§4)
  const ana = agent("1", { agentId: "ana", sessionId: "mind" });
  const main = await start({
    dir,
    debounceMs: 0,
    principals: [ana],
    // an owned WhatsApp grant: its self-chat IS the alias, derived from the number (§4)
    connections: [{ service: "whatsapp", address: "549", agentId: "ana" }],
  }, { transport });
  const words = (e: Event) =>
    ((e as MessageEvent).parts ?? []).filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text).join("");
  try {
    await main.log.publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "549",
        conversation: { address: "549", kind: "direct" },
        external_id: "wa:1",
      },
      parts: [{ type: "text", kind: "text", text: "che" }],
    } as Draft<Event>);
    // nothing but `start` is running — no standalone process copies this
    await waitFor(async () =>
      (await main.log.read({ conversation: "mind@ana", types: ["message"] })).length >= 2
    );
    const mind = await main.log.read({ conversation: "mind@ana", types: ["message"] });
    // the copy is the one carrying provenance — `extra.via` is the mirror's signature
    const copy = mind.find((e) => e.extra?.via !== undefined);
    assert(copy, "no mirrored copy reached the mind");
    assertEquals(words(copy), "che");
    // …and the mind is live in the same process: the agent answered into it
    assert(
      mind.some((e) =>
        e.agent?.id === "ana" && e.agent?.session_id === "mind" && e.payload?.turn_id !== undefined
      ),
    );
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "the door discloses the turn's edges: busy at the decision, idle with the cursor",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const { transport } = scripted([reply("hecho")]);
    const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
    try {
      const conn = await Deno.connect({ transport: "unix", path: `${dir}/agents/a1/door.sock` });
      const statuses: { status: string; after?: string }[] = [];
      const replies: ((r: Record<string, unknown>) => void)[] = [];
      (async () => {
        const lines = conn.readable
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        for await (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.event !== undefined || msg.delta !== undefined) continue;
          else if (msg.ok !== undefined) replies.shift()?.(msg);
          else if (msg.status !== undefined) statuses.push(msg as { status: string });
        }
      })().catch(() => {/* hang-up */});
      const request = async (req: Record<string, unknown>) => {
        const p = new Promise<Record<string, unknown>>((r) => replies.push(r));
        await conn.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));
        return await p;
      };
      await request({ op: "tail" });
      const r = await request({ op: "message", text: "hola", sender: { address: "ana" } });
      const id = r.id as string;
      // the ending an attach client waits for: idle whose cursor covers its own write
      await waitFor(() => statuses.some((s) => s.status === "idle" && (s.after ?? "") >= id));
      // …and the turn's opening edge came through first
      assertEquals(statuses[0]?.status, "busy");
      conn.close();
    } finally {
      await main.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** The principal's cancel, as the door lands it: a control row in the session's room. */
function cancel(mind: string): Draft<Event> {
  return {
    ts: new Date().toISOString(),
    type: "control",
    payload: { control: "cancel" },
    agent: { id: mind.split("@")[1], session_id: mind.split("@")[0] },
    envelope: { service: "local", connection_address: "agent", conversation: { address: mind } },
    parts: [{ type: "text", kind: "text", text: "/cancel" }],
  } as Draft<Event>;
}

Deno.test("a cancel mid-act kills the running tool: its result says so and the turn stops", async () => {
  const dir = await Deno.makeTempDir();
  const { transport, calls } = scripted([
    canned(
      [{ kind: "tool_use", name: "bash", input: { command: "echo started; sleep 10" } }],
      "tool_use",
    ),
    reply("never"),
  ]);
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  try {
    await main.log.publish(principalMsg("mind@a1", "hacé algo largo"));
    await waitFor(async () => (await main.log.read({ types: ["tool_use"] })).length === 1);
    await new Promise((r) => setTimeout(r, 200)); // the shell is in its sleep
    await main.log.publish(cancel("mind@a1"));
    const closing = async () => (await main.log.read({ types: ["control"] })).filter(isCancelled);
    await waitFor(async () => (await closing()).length === 1);
    const [result] = await main.log.read({ types: ["tool_result"] }) as ToolResultEvent[];
    assertEquals(result.parts[0].data.cancelled, true);
    assertEquals(result.parts[0].data.is_error, true);
    assert(String(result.parts[0].data.output).includes("started")); // what ran, kept
    const [stop] = await closing() as ControlEvent[];
    assertEquals(stop.agent, undefined); // the harness's word, not the principal's
    assertEquals(stop.payload.turn_id, undefined); // unstamped: the turn ends here
    assertEquals(await main.log.read({ types: ["error"] }), []); // nothing failed
    await new Promise((r) => setTimeout(r, 300)); // the agent idles on it: no further step
    assertEquals(calls(), 1);
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cancel mid-think aborts the model call: no reply, the turn closes on the cancel", async () => {
  const dir = await Deno.makeTempDir();
  let entered!: () => void;
  const calling = new Promise<void>((r) => (entered = r));
  let calls = 0;
  // a model call that runs until its signal says otherwise — the SDK's own abort shape
  const transport: ModelTransport = (_params, _emit, _meta, signal) => {
    calls++;
    entered();
    return new Promise((_, reject) =>
      signal!.addEventListener("abort", () => reject(new Error("Request was aborted.")))
    );
  };
  const main = await start({ dir, debounceMs: 0, principals: [agent("1")] }, { transport });
  try {
    await main.log.publish(principalMsg("mind@a1", "pensá mucho"));
    await calling;
    await main.log.publish(cancel("mind@a1"));
    const closing = async () => (await main.log.read({ types: ["control"] })).filter(isCancelled);
    await waitFor(async () => (await closing()).length === 1);
    assertEquals(await main.log.read({ types: ["error"] }), []); // nothing failed
    assertEquals((await main.log.read({ types: ["message"] })).filter((e) => e.agent).length, 0);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(calls, 1); // no retry: the principal spoke, not the weather
  } finally {
    await main.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a person alone (mind: false, §4): a registry row, no session, no home", async () => {
  const { root, dir, catalog } = await orgDir({
    ventas: { identity: { name: "Ventas", phone: "549117770000" } },
    sol: { identity: { name: "Sol", phone: "549115550002" }, mind: false },
  });
  const { transport } = scripted([reply("hola")]);
  const main = await start({ dir, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 }, {
    transport,
  });
  try {
    assertEquals(main.log.agents(), [
      {
        agentId: "sol",
        mind: "mind@sol",
        model: "claude-x",
        name: "Sol",
        phone: "549115550002",
        runs: false,
      },
      {
        agentId: "ventas",
        mind: "mind@ventas",
        model: "claude-x",
        name: "Ventas",
        phone: "549117770000",
      },
    ]);
    await Deno.stat(`${dir}/agents/ventas`);
    await assertRejects(() => Deno.stat(`${dir}/agents/sol`), Deno.errors.NotFound);
    // the org number, paired to nobody: ventas speaks through it and the roster steers it
    main.log.upsertConnections([
      { service: "whatsapp", address: "549117770000", credentialKey: "whatsapp:549117770000" },
    ]);
    assertEquals(main.log.principalsOf("ventas"), ["sol", "ventas"]);
  } finally {
    await main.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "presence: a turn over a fresh word says [agent thinking...] on the mirror's surface only",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    // the scripted model, plus the one delta a script never emits on its own
    const { transport: base } = scripted([reply("dale")]);
    const transport: ModelTransport = (params, emit) => {
      emit?.({ kind: "thinking" });
      return base(params, emit);
    };
    // a wire conversation is the AMBIENT class, so the night would decide this test's
    // outcome by the hour it ran at: `sleepHours: null` makes the turn happen at 3am and
    // at noon alike
    const main = await start(
      { dir, debounceMs: 0, principals: [agent("1", { sleepHours: null })] },
      { transport },
    );
    try {
      // the number is a1's own: its self-chat is the mirror's surface (§4), and the wire
      // message is theirs to answer (§6)
      main.log.upsertConnections([
        { service: "whatsapp", address: "5491133585694", agentId: "a1" },
      ]);
      await main.log.publish({
        ts: new Date().toISOString(),
        type: "message",
        envelope: {
          service: "whatsapp",
          connection_address: "5491133585694",
          conversation: { address: "5492614694650" },
          sender: { address: "5492614694650", name: "Luciano" },
        },
        parts: [{ type: "text", kind: "text", text: "¿estás?" }],
      } as Draft<MessageEvent>);

      // the fact lands in the mind's room, and the mirror carries it to the self-chat as
      // the tagged line — the whole path, main → presence → mirror → the surface's row
      const surface = async () =>
        (await main.log.read({ conversation: "5491133585694" }))
          .filter((e) => e.extra?.delta === true);
      await waitFor(async () => (await surface()).length > 0);
      const [said] = await surface();
      assertEquals(said.type, "message");
      assertEquals(said.agent, { id: "a1", session_id: "mind" });
      assertEquals(said.envelope.service, "whatsapp");
      assertEquals(said.envelope.connection_address, "5491133585694");
      assertEquals((said as MessageEvent).parts, [
        { type: "text", kind: "text", text: "`[agent thinking...]`" },
      ]);
      const [fact] = await main.log.read({ conversation: "mind@a1", types: ["delta"] });
      assertEquals(said.payload?.ref_id, fact.id);

      // and nowhere else: the turn ends, and the sender's conversation holds no presence —
      // only the mirror's surface heard it
      await waitFor(async () =>
        (await main.log.read({ types: ["message"] })).some((e) =>
          e.agent !== undefined && e.extra?.delta !== true
        )
      );
      const spoken = (await main.log.read({ types: ["message"] }))
        .filter((e) => e.extra?.delta === true)
        .map((e) => e.envelope.conversation.address);
      assertEquals(spoken, ["5491133585694"]);
    } finally {
      await main.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
