/**
 * End-to-end scenarios over the real SQLite log: a main-shaped fan-out (subscribe → invoke
 * `handle` per event, serialized per agent, boot alarm at start), scripted mu, everything
 * else live — verdicts, lock, acts, gates, recovery. The log is the continuation engine.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { type AgentConfig, xi, type XiPorts } from "./xi.ts";
import { type Log, openLog } from "./store/log.ts";
import { LOCK_TTL_MS } from "./store/lock.ts";
import type { AgentRow } from "./store/agents.ts";
import { openFileDocs } from "./store/docs.ts";
import { localFiles } from "./store/media.ts";
import { onFiles, seedOrg } from "./store/seed.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { Emission, ModelTransport } from "./mu.ts";
import { canned, scripted } from "./testing.ts";
import { shortId } from "./render.ts";
import type { Draft, Event, Json, MessageEvent, ToolResultEvent, ToolUseEvent } from "./types.ts";

const CONFIG: AgentConfig = {
  agentId: "a1",
  sessionId: "mind",
  model: "claude-x",
  maxTokens: 1024,
  gate: () => "allow", // gating off unless a test opts in
  digestAfterMessages: 1, // attention off: one ambient message is already due (xi.test owns §2)
  sleepHours: null, // …and the night never falls here: these scenarios assert what a turn
  //                   DOES, and the default span would idle them between 23 and 8 UTC
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
      conversation: { address: "mind@a1" },
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

/** The liveness floor at test scale (§10): main's tick, minus the minute. A wake that bounces
 *  off the lease while its holder ends in `ignore` has nothing to re-fire it — the holder
 *  published nothing, and the tail's cursor is already past the event. Production recovers
 *  that with the periodic poke; a harness without one strands the turn forever. */
const FLOOR_MS = 250;

/** main's shape, miniature: one tail, one invocation per change, a boot invoke, the floor.
 *  No filter and no queue — the turn lock is the concurrency control (§2); `outstanding` is
 *  only so stop() can await what's in flight. */
function fanOut(config: AgentConfig, log: Log, ports: XiPorts): { stop(): Promise<void> } {
  let stopped = false;
  const outstanding = new Set<Promise<unknown>>();
  const invoke = (trigger?: Event) => {
    if (stopped) return;
    const run = xi(config, ports, trigger).catch(() => {}).finally(() => outstanding.delete(run));
    outstanding.add(run);
  };
  const unsubscribe = log.subscribe(invoke); // the event goes straight through to xi
  invoke(); // boot: no trigger ⇒ look at whatever the log already owes
  const floor = setInterval(() => invoke(), FLOOR_MS);
  return {
    async stop() {
      stopped = true;
      clearInterval(floor);
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
  ports: Partial<XiPorts> = {}, // what a scenario adds to the agent's ports (a tool, a scope)
  roster: AgentRow[] = [], // the registry as the org declared it — handles included
  connections: Parameters<Log["upsertConnections"]>[0] = [], // the accounts the roster speaks through
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await seedOrg(onFiles(`${dir}/docs`)); // the docs root as every org boots on it: the checkpoint instruction included
  if (roster.length > 0) await log.syncAgents(roster);
  if (connections.length > 0) await log.upsertConnections(connections);
  const preloaded: Event[] = [];
  for (const e of preload) preloaded.push((await log.publish(e))!);
  const { transport, calls } = scripted(script);
  const main = fanOut({ ...CONFIG, ...config }, log, {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    exec: { echo: echoTool },
    ...ports,
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

      const replies = (await read("message")).filter((e) => e.agent?.session_id === "mind");
      assertEquals(replies.length, 1);
      assertEquals(replies[0].envelope.conversation.address, "mind@a1");
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
          e.agent?.session_id === "mind" &&
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
          e.agent?.session_id === "mind" && JSON.stringify(e.parts).includes("done: 42")
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

Deno.test("send: directed message + sent result, both cause-linked", async () => {
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

/** The log keys on addresses and the model reads names — `search` hands it both and the
 *  card prints the name — so `to` takes either. */
const namedChat = (
  address: string,
  name: string,
  text: string,
): Draft<MessageEvent> => ({
  ts: new Date(Date.now() - 3_600_000).toISOString(),
  type: "message",
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address, kind: "direct", name },
    sender: { address, name },
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("send: a name no conversation is addressed by lands on the one it names", async () => {
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "Verónica Sesto", text: "hola!" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "le escribí" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(namedChat("5492616104507", "Verónica Sesto", "¡Hola! Quiero más información"));
      await publish(principalMsg("saludá a verónica"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const directed = (await read("message")).filter((e) =>
        e.envelope.conversation.address === "5492616104507" &&
        JSON.stringify(e.parts).includes("hola!")
      );
      assertEquals(directed.length, 1); // the NAME reached the address, not a stranger
    },
  );
});

Deno.test("send: a name reaches its conversation by the name rule — case, accents and word order aside", async () => {
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "SESTO VERONICA", text: "hola!" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "le escribí" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(namedChat("5492616104507", "Verónica Sesto", "¡Hola! Quiero más información"));
      await publish(principalMsg("recordale el turno a verónica"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const directed = (await read("message")).filter((e) =>
        e.envelope.conversation.address === "5492616104507" &&
        JSON.stringify(e.parts).includes("hola!")
      );
      assertEquals(directed.length, 1); // the calendar's `APELLIDO NOMBRE` reached the phone's `Nombre Apellido`
    },
  );
});

Deno.test("send: a name the log never saw is asked of the address books, and rides the account that keeps them", async () => {
  const asked: string[] = [];
  const contact = {
    whatsapp: {
      write: () => Promise.resolve({}),
      lookup: ({ query }: { query: string }) => {
        asked.push(query);
        return Promise.resolve(
          query.toLowerCase().includes("reveco")
            ? [{ name: "Edgardo Reveco", address: "5492615550000" }]
            : [],
        );
      },
    },
  };
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "REVECO EDGARDO", text: "recordatorio" } }],
        "tool_use",
      ),
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "Nadie Conocido", text: "hola" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandá los recordatorios"));
      await waitFor(async () => (await read("tool_result")).length === 2);

      // the gate scoped the call and the act resolved it: each asked the book once
      assertEquals([...new Set(asked)], ["REVECO EDGARDO", "Nadie Conocido"]);
      // the book's entry became the address, on the account whose book holds him — never
      // a local room wearing his name
      const [sent] = (await read("message")).filter((e) =>
        JSON.stringify(e.parts).includes('"text":"recordatorio"')
      );
      assertEquals(sent.envelope.conversation.address, "5492615550000");
      assertEquals(sent.envelope.service, "whatsapp");
      assertEquals(sent.envelope.connection_address, "5491100000000");
      // a full name nobody answers to is an error, not first contact with a stranger
      const [, miss] = await read("tool_result");
      assertStringIncludes(JSON.stringify(miss.parts), 'nobody named \\"Nadie Conocido\\"');
      const strayed = (await read("message")).filter((e) =>
        JSON.stringify(e.parts).includes('"hola"')
      );
      assertEquals(strayed.length, 0);
    },
    {},
    [],
    { contact },
    [{ agentId: "a1", mind: "mind@a1" }],
    [{ service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } }],
  );
});

Deno.test("send: the name proper wins over a relation's parenthesis", async () => {
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "YAÑEZ MARCOS", text: "recordatorio" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "le escribí" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(
        namedChat("5492604306049", "Isabel (Mamá De Yañez Marcos)", "hola, soy la mamá"),
      );
      await publish(namedChat("5492604383998", "Marcos Alberto Yañez", "buenas"));
      await publish(principalMsg("recordale el turno a marcos"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const directed = (await read("message")).filter((e) =>
        JSON.stringify(e.parts).includes('"text":"recordatorio"')
      );
      assertEquals(directed.map((e) => e.envelope.conversation.address), ["5492604383998"]);
    },
  );
});

Deno.test("send: a name two conversations answer to is handed back, never guessed", async () => {
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "Verónica", text: "hola!" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "¿cuál de las dos?" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(namedChat("5492616104507", "Verónica Sesto", "quiero información"));
      await publish(namedChat("5492614696945", "Verónica Mori", "buenas"));
      await publish(principalMsg("saludá a verónica"));
      await waitFor(async () => (await read("tool_result")).length === 1);

      const [result] = await read("tool_result");
      const said = JSON.stringify(result.parts);
      assert(said.includes("names 2 conversations"), said);
      assert(said.includes("5492616104507") && said.includes("5492614696945"), said);
      // the wrong recipient is the one send that cannot be taken back: nothing went out
      const sent = (await read("message")).filter((e) => JSON.stringify(e.parts).includes("hola!"));
      assertEquals(sent.length, 0);
    },
  );
});

Deno.test("send `connection`: a named account places first contact on its wire", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
    { service: "slack", address: "T1:U9", credentialKey: "slack:T1:org", extra: { name: "Acme" } },
  ]);
  const gated: { name: string; target?: { connection?: string; conversation?: string } }[] = [];
  const { transport } = scripted([
    // a number nobody here has written to: the account is the only thing that can place it
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "5491199999999", connection: "sole", text: "hola" },
    }], "tool_use"),
    // the same number, unplaced: the local channel — the log has no record to anchor to
    ok(
      [{ kind: "tool_use", name: "send", input: { to: "5491188888888", text: "hola" } }],
      "tool_use",
    ),
    // an account that is nobody's here
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "5491199999999", connection: "Zeta", text: "?" },
    }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const config: AgentConfig = {
    ...CONFIG,
    gate: (name, _input, target) => {
      gated.push({ name, target });
      return "allow";
    },
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("escribile a este número"));
    for (let i = 0; i < 12; i++) await xi(config, ports);
    const sent = (await log.read({ types: ["message"] })).filter((e) =>
      e.agent && e.payload?.turn_id
    );
    const placed = sent.find((e) => e.envelope.conversation.address === "5491199999999");
    assertEquals(placed?.envelope.service, "whatsapp");
    assertEquals(placed?.envelope.connection_address, "5491100000000");
    const unplaced = sent.find((e) => e.envelope.conversation.address === "5491188888888");
    assertEquals(unplaced?.envelope.service, "local");
    // the gate saw the account the send would ride — a rule pinned to it matches
    assertEquals(gated[0].target, { connection: "5491100000000", conversation: "5491199999999" });
    const results = await log.read({ types: ["tool_result"] });
    const refused = String((results[2].parts[0] as { data: { output: string } }).data.output);
    assertStringIncludes(refused, 'no account of yours is called "Zeta"');
    assertStringIncludes(refused, "Sole (5491100000000)");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a gated send carries its preview: where it lands, the other side's last word, the text", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
  ]);
  const { transport } = scripted([
    ok([{
      kind: "tool_use",
      name: "send",
      input: {
        to: "Carlos",
        text: "hola Carlos!\n\nlunes o miércoles",
        files: ["fachada.jpg", "portero.jpg"],
        location: { latitude: -32.9, longitude: -68.8, name: "Consultorio" },
      },
    }], "tool_use"),
    ok([{ kind: "assistant", text: "pedí permiso" }], "end_turn"),
  ]);
  const config: AgentConfig = {
    ...CONFIG,
    gate: (name) => name === "send" ? "ask" : "allow",
    timezone: "America/Argentina/Mendoza",
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  const patient = (text: string, ts: string, own = false): Draft<MessageEvent> => ({
    ts,
    type: "message",
    envelope: {
      service: "whatsapp",
      connection_address: "5491100000000",
      conversation: { address: "5492616560401", kind: "direct", name: "Carlos" },
      sender: own
        ? { address: "5491100000000", name: "Sole" }
        : { address: "5492616560401", name: "Carlos" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });
  try {
    await log.publish(patient("hola, tienen turno?", "2026-09-23T19:42:00Z"));
    // the account's own hand, typed on the phone after — not the other side
    await log.publish(patient("un momento", "2026-09-23T19:50:00Z", true));
    await log.publish(principalMsg("contestale a Carlos"));
    for (let i = 0; i < 6; i++) await xi(config, ports);
    const [req] = await log.read({ types: ["permission_request"] });
    assert(req.type === "permission_request");
    assertEquals(req.parts[0].data.send, {
      conversation: { name: "Carlos", address: "5492616560401" },
      last: { text: "hola, tienen turno?", at: "23 Sep 16:42" },
      text: "hola Carlos!\n\nlunes o miércoles",
      files: 2,
      location: "Consultorio",
    });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("send `location`: a pin is a part of its own on WhatsApp, and nowhere else", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
  ]);
  const pin = { latitude: -32.946186, longitude: -68.823082, name: "Consultorio" };
  const { transport } = scripted([
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "5491199999999", connection: "sole", text: "acá estamos", location: pin },
    }], "tool_use"),
    // a conversation on the local channel has no pin to send
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "5491188888888", location: pin },
    }], "tool_use"),
    // degrees off the globe are refused where the result can say so
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "5491199999999", location: { latitude: 91, longitude: 0 } },
    }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("mandale la ubicación"));
    for (let i = 0; i < 12; i++) await xi(CONFIG, ports);
    const sent = (await log.read({ types: ["message"] })).filter((e) =>
      e.agent && e.payload?.turn_id
    );
    const placed = sent.find((e) => e.envelope.conversation.address === "5491199999999");
    assertEquals(placed?.parts, [
      { type: "text", kind: "text", text: "acá estamos" },
      { type: "data", kind: "location", data: pin },
    ]);
    assertEquals(sent.some((e) => e.envelope.conversation.address === "5491188888888"), false);
    const results = await log.read({ types: ["tool_result"] });
    const outputOf = (i: number) =>
      String((results[i].parts[0] as { data: { output: string } }).data.output);
    assertStringIncludes(outputOf(1), "a location rides WhatsApp only");
    assertStringIncludes(outputOf(2), "`location.latitude` is degrees");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("send `subject`: a mail's thread rides the envelope; a reply inherits the referent's", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "google", address: "me@org.com", agentId: "a1", extra: { name: "Me" } },
  ]);
  // a mail from Ana already in the log: the wire's row, its thread and its id
  const theirs = await log.publish({
    ts: "2026-09-23T10:00:00Z",
    type: "message",
    envelope: {
      service: "google",
      connection_address: "me@org.com",
      conversation: { address: "ana@x.com", kind: "direct", name: "Ana", thread: "Invoice 42" },
      sender: { address: "ana@x.com", name: "Ana" },
      external_id: "mail:m1@x.com",
    },
    parts: [{ type: "text", kind: "text", text: "please pay" }],
  });
  const { transport } = scripted([
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "bob@y.com", connection: "me@org.com", subject: "Lunch", text: "Friday?" },
    }], "tool_use"),
    ok([{
      kind: "tool_use",
      name: "send",
      input: { to: "ana@x.com", text: "paid", re: shortId(theirs!.id) },
    }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("mandá los mails"));
    for (let i = 0; i < 12; i++) await xi(CONFIG, ports);
    const sent = (await log.read({ types: ["message"] })).filter((e) =>
      e.agent && e.payload?.turn_id
    );
    const fresh = sent.find((e) => e.envelope.conversation.address === "bob@y.com");
    assertEquals(fresh?.envelope.service, "google");
    assertEquals(fresh?.envelope.connection_address, "me@org.com");
    assertEquals(fresh?.envelope.conversation, { address: "bob@y.com", thread: "Lunch" });
    const reply = sent.find((e) => e.envelope.conversation.address === "ana@x.com");
    assertEquals(reply?.envelope.conversation, {
      address: "ana@x.com",
      kind: "direct",
      thread: "Invoice 42",
    });
    assertEquals(reply?.payload?.action, "reply");
    assertEquals(reply?.payload?.ref_external_id, "mail:m1@x.com");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contact: `who` resolves like a send, the write rides the person's own account", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
  ]);
  const wrote: Record<string, unknown>[] = [];
  const contact = {
    whatsapp: {
      write: (req: Record<string, unknown>) => {
        wrote.push(req);
        return Promise.resolve(req.name ? { name: String(req.name) } : { name: "vero 🌻" });
      },
    },
  };
  const gated: { name: string; target?: { connection?: string } }[] = [];
  const { transport } = scripted([
    // by the name she goes by here — saved under the model's name
    ok(
      [{ kind: "tool_use", name: "contact", input: { who: "vero", name: "Verónica Sesto" } }],
      "tool_use",
    ),
    // by a bare number nobody has heard from: the one whatsapp account saves them, under
    // the wire's own word (the port answers it)
    ok([{ kind: "tool_use", name: "contact", input: { who: "+54 9 11 7777-7777" } }], "tool_use"),
    // forget takes no name
    ok([{
      kind: "tool_use",
      name: "contact",
      input: { who: "5492616104507", action: "forget", name: "x" },
    }], "tool_use"),
    ok(
      [{ kind: "tool_use", name: "contact", input: { who: "5492616104507", action: "forget" } }],
      "tool_use",
    ),
    // a name nobody wears is not a number to save
    ok([{ kind: "tool_use", name: "contact", input: { who: "Nadie" } }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const config: AgentConfig = {
    ...CONFIG,
    gate: (name, _input, target) => {
      if (name === "contact") gated.push({ name, target });
      return "allow";
    },
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    await log.publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "5491100000000",
        external_id: "whatsapp:wmw.v1",
        conversation: { address: "5492616104507", kind: "direct", name: "vero 🌻" },
        sender: { address: "5492616104507", name: "vero 🌻" },
      },
      parts: [{ type: "text", kind: "text", text: "hola, quiero info" }],
    });
    await log.publish(principalMsg("agendá a verónica"));
    for (let i = 0; i < 16; i++) await xi(config, ports);
    assertEquals(wrote, [
      { connection: "5491100000000", address: "5492616104507", name: "Verónica Sesto" },
      { connection: "5491100000000", address: "5491177777777" },
      { connection: "5491100000000", address: "5492616104507", remove: true },
    ]);
    const results = (await log.read({ types: ["tool_result"] })).map((e) =>
      JSON.stringify(e.parts)
    );
    assertStringIncludes(results[0], '"saved":"5492616104507"');
    assertStringIncludes(results[0], '"as":"Verónica Sesto"');
    assertStringIncludes(results[1], '"as":"vero 🌻"');
    assertStringIncludes(results[2], "`forget` takes no `name`");
    assertStringIncludes(results[3], '"forgot":"5492616104507"');
    assertStringIncludes(results[4], 'nobody named \\"Nadie\\" has spoken here');
    // a rule pinned to the account matches: the gate saw which book the write goes in
    assertEquals(gated[0].target, undefined); // derived from the rows, not named — unscoped
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search `from` asks the address books too: someone saved and never heard from", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
    { service: "slack", address: "T1:U9", agentId: "a1" }, // keeps no book: never asked
  ]);
  const asked: Record<string, unknown>[] = [];
  const contact = {
    whatsapp: {
      write: () => Promise.resolve({}),
      lookup: (req: Record<string, unknown>) => {
        asked.push(req);
        return Promise.resolve(
          String(req.query).toLowerCase().includes("ver")
            ? [
              { name: "Verónica Sesto", address: "5492616104507" },
              { name: "Vera Halim", address: "5491133322211" },
            ]
            : [],
        );
      },
    },
  };
  const { transport } = scripted([
    ok([{ kind: "tool_use", name: "search", input: { from: "Verónica" } }], "tool_use"),
    ok([{ kind: "tool_use", name: "search", input: { from: "Nadie" } }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    // Verónica wrote once, back when nobody had named her: the row carries a number and
    // no name, so the LOG cannot find her by name and the book is what reaches the row
    await log.publish({
      ts: new Date(Date.now() - 40 * 3_600_000).toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "5491100000000",
        external_id: "whatsapp:wmw.v0",
        conversation: { address: "5492616104507", kind: "direct" },
        sender: { address: "5492616104507" },
      },
      parts: [{ type: "text", kind: "text", text: "hola, quiero info" }],
    });
    await log.publish(principalMsg("qué me dijo verónica"));
    for (let i = 0; i < 12; i++) await xi(CONFIG, ports);

    // one account keeps a book and one does not; only the one that does was asked
    assertEquals(asked, [{ connection: "5491100000000", query: "Verónica" }, {
      connection: "5491100000000",
      query: "Nadie",
    }]);

    const results = await log.read({ types: ["tool_result"] });
    const page = (results[0] as ToolResultEvent).parts[0].data.output as string;
    // both saved Verónicas come back FIRST, as `<contact>` lines under the `<conn>` of the
    // account whose book holds her — the window's own account element, named as the
    // window names it
    assertStringIncludes(
      page,
      '<conn service="whatsapp" name="Sole" address="5491100000000">\n' +
        '<contact name="Verónica Sesto" address="5492616104507"/>\n' +
        '<contact name="Vera Halim" address="5491133322211"/>\n' +
        "</conn>\n",
    );
    // and the book's address reached her one nameless row — a hit the log's own name
    // lookup could never have found; she is `external` by her number, having no name
    assertEquals(page.match(/<msg /g)?.length, 1);
    assertStringIncludes(page, '<conv kind="direct" address="5492616104507">');
    assertStringIncludes(page, ' external address="5492616104507" at="');
    assertStringIncludes(page, ">hola, quiero info</msg>");

    // a name in neither place is still an error, and says both places were asked
    assertStringIncludes(
      JSON.stringify(results[1].parts),
      "no address book of yours has them",
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search: a book that cannot be reached is named, never mistaken for an empty one", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
  ]);
  const contact = {
    whatsapp: {
      lookup: () => Promise.reject(new Error("cannot reach bridge.local — connection refused")),
    },
  };
  const { transport } = scripted([
    ok([{ kind: "tool_use", name: "search", input: { from: "vero 🌻" } }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    await log.publish({
      ts: new Date(Date.now() - 40 * 3_600_000).toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "5491100000000",
        external_id: "whatsapp:wmw.v1",
        conversation: { address: "5492616104507", kind: "direct", name: "vero 🌻" },
        sender: { address: "5492616104507", name: "vero 🌻" },
      },
      parts: [{ type: "text", kind: "text", text: "hola, quiero info" }],
    });
    await log.publish(principalMsg("qué me dijo vero"));
    for (let i = 0; i < 10; i++) await xi(CONFIG, ports);
    // the log is the answer being asked for: a dead bridge does not fail the search — the
    // book is named as not reached, in the harness's own voice, above the rows
    const page = ((await log.read({ types: ["tool_result"] }))[0] as ToolResultEvent)
      .parts[0].data.output as string;
    assertStringIncludes(page, '— whatsapp 5491100000000 "Sole": address book not reached —\n');
    assertEquals(page.match(/<msg /g)?.length, 1);
    assertEquals(page.includes("<contact "), false);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search: a port is per service, a book is per ACCOUNT — every one of them answers", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1", phone: "5491100000002" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
    { service: "whatsapp", address: "5491100000001", agentId: "a1", extra: { name: "Clínica" } },
    { service: "google", address: "sole@clinica.ar", agentId: "a1" },
    // org-wide, and claimed by no handle of a1's: not an account of this agent, never asked
    { service: "whatsapp", address: "5491100000009" },
  ]);
  const asked: string[] = [];
  const contact = {
    whatsapp: {
      lookup: ({ connection }: { connection: string }) => {
        asked.push(connection);
        // the clinic's book is the one behind a bridge that is down
        return connection === "5491100000001"
          ? Promise.reject(new Error("cannot reach bridge.local — connection refused"))
          : Promise.resolve([{ name: "Ana Vidal", address: "5491133322211" }]);
      },
    },
    google: {
      lookup: ({ connection }: { connection: string }) => {
        asked.push(connection);
        return Promise.resolve([{ name: "Ana V. (clínica)", address: "ana@vidal.ar" }]);
      },
    },
  };
  const { transport } = scripted([
    ok([{ kind: "tool_use", name: "search", input: { from: "Vidal" } }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    await log.publish(principalMsg("quién es vidal"));
    for (let i = 0; i < 10; i++) await xi(CONFIG, ports);
    // one call per ACCOUNT on a service that keeps a book — the port is shared, the
    // connection is not — and the org's row, which no handle of a1's claims, is not one
    assertEquals(asked.sort(), ["5491100000000", "5491100000001", "sole@clinica.ar"]);

    const page = ((await log.read({ types: ["tool_result"] }))[0] as ToolResultEvent)
      .parts[0].data.output as string;
    // assembled in ACCOUNT order — the connections' own `service, address` — whatever
    // order the books answered in, one `<conn>` per book, and the dead one hides neither
    // its neighbours: it is said, after them. Neither Ana has ever written, so no `<msg>`
    assertEquals(
      page,
      [
        '<conn service="google" address="sole@clinica.ar">',
        '<contact name="Ana V. (clínica)" address="ana@vidal.ar"/>',
        "</conn>",
        '<conn service="whatsapp" name="Sole" address="5491100000000">',
        '<contact name="Ana Vidal" address="5491133322211"/>',
        "</conn>",
        '— whatsapp 5491100000001 "Clínica": address book not reached —',
      ].join("\n"),
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contact: two accounts and a stranger — the model must say which book", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
    { service: "whatsapp", address: "5491100000001", agentId: "a1", extra: { name: "Clínica" } },
    { service: "slack", address: "T1:U9", agentId: "a1" },
  ]);
  const wrote: Record<string, unknown>[] = [];
  const contact = {
    whatsapp: {
      write: (req: Record<string, unknown>) => {
        wrote.push(req);
        return Promise.resolve({});
      },
    },
  };
  const gated: ({ connection?: string } | undefined)[] = [];
  const { transport } = scripted([
    ok(
      [{ kind: "tool_use", name: "contact", input: { who: "5491177777777", name: "Ana" } }],
      "tool_use",
    ),
    ok([{
      kind: "tool_use",
      name: "contact",
      input: { who: "5491177777777", name: "Ana", connection: "clínica" },
    }], "tool_use"),
    // slack keeps no address book
    ok([{
      kind: "tool_use",
      name: "contact",
      input: { who: "5491177777777", name: "Ana", connection: "T1:U9" },
    }], "tool_use"),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const config: AgentConfig = {
    ...CONFIG,
    gate: (name, _input, target) => {
      if (name === "contact") gated.push(target);
      return "allow";
    },
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    await log.publish(principalMsg("agendá a ana"));
    for (let i = 0; i < 12; i++) await xi(config, ports);
    const results = (await log.read({ types: ["tool_result"] })).map((e) =>
      JSON.stringify(e.parts)
    );
    assertStringIncludes(results[0], "say `connection`");
    assertStringIncludes(results[1], '"connection":"5491100000001"');
    assertStringIncludes(results[2], "keeps no address book");
    assertEquals(wrote, [{ connection: "5491100000001", address: "5491177777777", name: "Ana" }]);
    assertEquals(gated[1], { connection: "5491100000001" });
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contact: a person is in two places — a name saved on the book is reachable, a name two people wear is refused", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "a1", mind: "mind@a1" }]);
  await log.upsertConnections([
    { service: "whatsapp", address: "5491100000000", agentId: "a1", extra: { name: "Sole" } },
    { service: "whatsapp", address: "5491100000001", agentId: "a1", extra: { name: "Clínica" } },
  ]);
  const wrote: Record<string, unknown>[] = [];
  const contact = {
    whatsapp: {
      write: (req: Record<string, unknown>) => {
        wrote.push(req);
        return Promise.resolve({});
      },
      lookup: ({ connection, query }: { connection: string; query: string }) => {
        const q = query.toLowerCase();
        if (q === "ramona") return Promise.reject(new Error("cannot reach bridge.local"));
        // only the clinic's book holds Juan the plumber; Sole's holds a Juana
        if (connection === "5491100000001" && "juan pérez".includes(q)) {
          return Promise.resolve([{ name: "Juan Pérez", address: "5491155555555" }]);
        }
        if (connection === "5491100000000" && "juana".includes(q)) {
          return Promise.resolve([{ name: "Juana", address: "5491166666666" }]);
        }
        return Promise.resolve([]);
      },
    },
  };
  const { transport } = scripted([
    // saved on the clinic's book, never wrote: found there, and the clinic saves him —
    // no `connection` needed although two accounts keep a book
    ok(
      [{ kind: "tool_use", name: "contact", input: { who: "juan pérez", action: "forget" } }],
      "tool_use",
    ),
    // "juan" is worn by the saved Juan Pérez, the saved Juana, and the Juan who wrote:
    // three people, named and addressed
    ok([{ kind: "tool_use", name: "contact", input: { who: "juan", name: "Juan" } }], "tool_use"),
    // a book that cannot be asked stops a write
    ok(
      [{ kind: "tool_use", name: "contact", input: { who: "Ramona", name: "R" } }],
      "tool_use",
    ),
    ok([{ kind: "assistant", text: "listo" }], "end_turn"),
  ]);
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport, contact };
  try {
    await log.publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "5491100000000",
        external_id: "whatsapp:wmw.v1",
        conversation: { address: "5491177777777", kind: "direct", name: "Juan" },
        sender: { address: "5491177777777", name: "Juan" },
      },
      parts: [{ type: "text", kind: "text", text: "hola" }],
    });
    await log.publish(principalMsg("agendá a juan"));
    for (let i = 0; i < 12; i++) await xi(CONFIG, ports);
    const results = (await log.read({ types: ["tool_result"] })).map((e) =>
      JSON.stringify(e.parts)
    );
    assertStringIncludes(results[0], '"forgot":"5491155555555"');
    assertStringIncludes(results[0], '"connection":"5491100000001"');
    assertStringIncludes(results[1], '\\"juan\\" names 3 people');
    assertStringIncludes(results[1], "Juan (5491177777777)");
    assertStringIncludes(results[1], "Juan Pérez (5491155555555)");
    assertStringIncludes(results[1], "Juana (5491166666666)");
    assertStringIncludes(results[2], "address book not reached");
    assertEquals(wrote, [{ connection: "5491100000001", address: "5491155555555", remove: true }]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("send at the principal lands nowhere — refused before it is ever gated", async () => {
  // gating ON, so the test also proves no card is raised: the whole point is that the
  // principal is not asked to approve a message they were already going to receive
  for (const to of ["a1", "mind@a1"]) {
    await scenario(
      [
        ok([{ kind: "tool_use", name: "send", input: { to, text: "che, mirá esto" } }], "tool_use"),
        ok([{ kind: "assistant", text: "che, mirá esto" }], "end_turn"),
      ],
      async ({ publish, read }) => {
        await publish(principalMsg("contame"));
        await waitFor(async () => (await read("tool_result")).length === 1);
        const [answer] = await read("tool_result") as ToolResultEvent[];
        assertEquals(answer.parts[0].data.is_error, true);
        assertStringIncludes(
          JSON.stringify(answer.parts[0].data.output),
          "that address is your principal",
        );
        assertEquals((await read("permission_request")).length, 0);
        // and nothing was dispatched — no invented conversation under their own name
        assertEquals(
          (await read("message")).filter((e) =>
            e.envelope.conversation.address === to &&
            e.payload?.ref_id !== undefined
          ).length,
          0,
        );
      },
      { gate: () => "ask" },
    );
  }
});

Deno.test("send at the principal: their number however it was typed, not only as stored", async () => {
  // a handle is written the way a person writes one — `+54 9 11 6754-2610` is the number
  // the wire calls `5491167542610` — so the guard compares handles, never strings
  await scenario(
    [
      ok(
        [{ kind: "tool_use", name: "send", input: { to: "5491167542610", text: "hola" } }],
        "tool_use",
      ),
      ok([{ kind: "assistant", text: "hola" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("escribime"));
      await waitFor(async () => (await read("tool_result")).length === 1);
      const [answer] = await read("tool_result") as ToolResultEvent[];
      assertEquals(answer.parts[0].data.is_error, true);
      assertStringIncludes(
        JSON.stringify(answer.parts[0].data.output),
        "that address is your principal",
      );
    },
    {},
    [],
    {},
    [{ agentId: "a1", mind: "mind@a1", phone: "+54 9 11 6754-2610" }],
  );
});

Deno.test("gating: the ask is part of executing — the call is answered, then run or refused", async () => {
  const respond = (refId: string, behavior: "allow" | "deny"): Draft<Event> => ({
    ts: new Date().toISOString(),
    type: "permission_response",
    payload: { ref_id: refId },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
    },
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
      assertEquals(req.envelope.conversation.address, "mind@a1");
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
      assertStringIncludes(JSON.stringify(outcome.parts[0].data.output), "sent");
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

Deno.test("run and gated share no vocabulary: what ran says `sent`, and only that", async () => {
  // The model's report to its principal is built out of these words and nothing else — it
  // cannot see the gate. Let one word mean both states and it tells the principal a message
  // is awaiting their approval while the message is already read on the other end.
  const RAN = ["sent"];
  const WAITING = ["pending", "approval", "queue"];

  const outputOf = async (gate: AgentConfig["gate"]): Promise<string> => {
    let output = "";
    await scenario(
      [
        ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hola" } }], "tool_use"),
        ok([], "end_turn"),
      ],
      async ({ publish, read }) => {
        await publish(principalMsg("mandale"));
        await waitFor(async () => (await read("tool_result")).length === 1);
        const [r] = await read("tool_result") as ToolResultEvent[];
        output = JSON.stringify(r.parts[0].data.output).toLowerCase();
      },
      { gate },
    );
    return output;
  };

  const ran = await outputOf(() => "allow");
  const waiting = await outputOf((name) => name === "send" ? "ask" : "allow");

  for (const w of RAN) {
    assertStringIncludes(ran, w);
    assertEquals(waiting.includes(w), false, `a waiting call says "${w}": ${waiting}`);
  }
  for (const w of WAITING) {
    assertEquals(ran.includes(w), false, `a call that RAN says "${w}": ${ran}`);
  }
  assertStringIncludes(waiting, "pending_approval");
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
    assertStringIncludes(anchor, "waiting — 1 approval");
    assertStringIncludes(anchor, "send(to: wa:x, text: hola)");
    // and NOT in the transcript: what the model sees there is a closed call
    assertStringIncludes(JSON.stringify(last?.messages), "pending_approval");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the anchor states the approval state either way — silence is not a denial", async () => {
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
  const anchor = () => JSON.stringify(last?.messages.at(-1)?.content);
  try {
    await log.publish(principalMsg("mandale"));
    await xi(config, ports); // nothing has been asked yet: no section
    assertEquals(anchor().includes("waiting —"), false);

    await xi(config, ports); // act: the card goes up
    await xi(config, ports);
    assertStringIncludes(anchor(), "waiting — 1 approval");
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
          e.agent?.session_id === "mind" && String(JSON.stringify(e.parts)).includes("apenas")
        )
      );
      // the principal changes the subject rather than answering: that is answered too. The
      // old gate ignored EVERYTHING here (a turn would re-issue the unresolved tool_use).
      await publish(principalMsg("y lo otro?"));
      await waitFor(async () =>
        (await read("message")).some((e) =>
          e.agent?.session_id === "mind" && String(JSON.stringify(e.parts)).includes("pendiente")
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
  agent: { id: "a1", session_id: "mind" },
  envelope: { service: "local", connection_address: "agent", conversation: { address: "mind@a1" } },
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
      .filter((e) => e.agent?.session_id === "mind");
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
      agent: { id: "a1", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@a1" },
      },
      parts: [{ type: "data", kind: "thinking", data: { thinking: "…", signature: "s" } }],
    });
    // …but a `thinking` trigger never gets far enough to find out
    await xi(CONFIG, ports, thinking!);
    assertEquals(calls(), 0);
    assertEquals(await log.lock("turn-mind@a1").held(), false); // the lease was never taken
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("recovery: a stale lock (crashed holder) → pending uses swept, then the closing turn", async () => {
  const dir = await Deno.makeTempDir();
  // the lease reads a clock this test moves (§9): the TTL is aged, not waited out
  let skew = 0;
  const log = await openLog(dir, { now: () => Date.now() + skew });
  await log.publish(principalMsg("seguís ahí?"));
  const use = (await log.publish(orphanUse()))!;
  // a CRASHED holder: it took the lease and its process went away, so nothing re-stamps
  // the heartbeat. Closing a second handle is that exactly — the beats stop with it.
  const dead = await openLog(dir);
  assertEquals(await dead.lock("turn-mind@a1").acquire(), "acquired");
  await dead.close();
  skew = LOCK_TTL_MS + 1; // …and the org that boots next finds it a TTL stale

  const { transport, calls } = scripted([
    ok([{ kind: "assistant", text: "acá estoy" }], "end_turn"),
  ]);
  const main = fanOut(CONFIG, log, {
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

Deno.test("compaction: an over-budget window is checkpointed in the gap after the turn — never before a think (§5)", async () => {
  await scenario(
    [
      ok([{ kind: "assistant", text: "respuesta uno" }], "end_turn"),
      ok([{ kind: "assistant", text: "## checkpoint viejo" }], "end_turn"), // the checkpoint TURN
      ok([{ kind: "assistant", text: "respuesta dos" }], "end_turn"),
      ok([{ kind: "assistant", text: "## checkpoint nuevo" }], "end_turn"), // the next gap's
    ],
    async ({ publish, read, calls }) => {
      await publish(principalMsg("uno"));
      // the closing's own insert is the next look: nothing owed, the window over budget,
      // so the gap is spent on the checkpoint — no input asked for it, none waited on it
      await waitFor(async () => (await read("summary")).length === 1);
      const [sum] = await read("summary");
      assert(sum.type === "summary");
      assertEquals(JSON.stringify(sum.parts).includes("checkpoint viejo"), true);
      // covers exactly the closed exchange: [uno, respuesta uno]
      const msgs = await read("message");
      assertEquals(msgs.length, 2);
      assertEquals(sum.payload.covers[0], msgs[0].id);
      assertEquals(sum.payload.covers[1], msgs[1].id);
      await new Promise((r) => setTimeout(r, 300)); // quiescence: the summary's wake idles
      assertEquals(calls(), 2);

      await publish(principalMsg("dos"));
      await waitFor(async () =>
        (await read("message")).some((e) => JSON.stringify(e.parts).includes("respuesta dos"))
      );
      // the second exchange closes over budget too (every window is, at 1), so its gap
      // compacts again: reply, checkpoint, reply, checkpoint — each checkpoint between turns
      await waitFor(async () => (await read("summary")).length === 2);
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(calls(), 4);
      const [, next] = await read("summary");
      assert(next.type === "summary");
      assertEquals(next.payload.covers[0], msgs[0].id); // chained from the first's start
      assertEquals(next.payload.covers[1], (await read("message")).at(-1)!.id);
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
  await log.upsertConnections([{ service: "whatsapp", address: "org" }]); // the publish gate
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
  await log.upsertConnections([{ service: "whatsapp", address: "org" }]);
  try {
    const wa = (id: string, text: string, mine: boolean) => ({
      ts: new Date().toISOString(),
      type: "message" as const,
      ...(mine ? { agent: { id: "a1", session_id: "mind" } } : {}),
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
    // the defaults spelled out: a `create` that points somewhere is a reply, a named
    // `add` is the glyph's own meaning — and `add` without a glyph has nothing to add
    const reply: Record<string, Json> = { to: "wa:g1", text: "yo", action: "create" };
    const react: Record<string, Json> = { to: "wa:g1", react: "👍", action: "add" };
    const glyphless: Record<string, Json> = { to: "wa:g1", action: "add" };
    const { transport } = scripted([
      ok([{ kind: "tool_use", name: "send", input: edit }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: del }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: unreact }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: theirEdit }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: reply }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: react }], "tool_use"),
      ok([{ kind: "tool_use", name: "send", input: glyphless }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ]);
    Object.assign(edit, { re: shortId(mine.id), action: "edit" });
    Object.assign(del, { re: shortId(mine.id), action: "delete" });
    Object.assign(unreact, { re: shortId(theirs.id), action: "remove" });
    Object.assign(theirEdit, { re: shortId(theirs.id), action: "edit" });
    Object.assign(reply, { re: shortId(theirs.id) });
    Object.assign(react, { re: shortId(theirs.id) });
    Object.assign(glyphless, { re: shortId(theirs.id) });

    const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
    for (let i = 0; i < 16; i++) await xi(CONFIG, ports);

    const ours = (await log.read({ types: ["message"] }))
      .filter((e) => e.agent !== undefined && e.envelope.external_id === undefined);
    assertEquals(ours.map((e) => e.payload?.action), ["edit", "delete", "remove", "reply", "add"]);
    assertEquals(ours.every((e) => e.payload?.ref_external_id !== undefined), true);
    // the edit carries the replacement; the delete carries nothing — the referent's words
    // are the referent's, and the window still holds them
    assertStringIncludes(JSON.stringify(ours[0].parts), "nos vemos 10");
    assertEquals((ours[1] as MessageEvent).parts, []);
    assertEquals((ours[2] as MessageEvent).parts[0].kind, "reaction");
    assertStringIncludes(JSON.stringify(ours[3].parts), "yo");
    assertEquals((ours[4] as MessageEvent).parts[0].kind, "reaction");

    // editing someone else's words is refused HERE, in the model's own tool_result —
    // some wires would accept the stanza and silently ignore it
    const errors = (await log.read({ types: ["tool_result"] }))
      .filter((e) => JSON.stringify(e.parts).includes("is_error"));
    assertEquals(errors.length, 2);
    assertStringIncludes(
      JSON.stringify(errors[0].parts),
      "only this account's own messages can be edited",
    );
    assertStringIncludes(JSON.stringify(errors[1].parts), "`add` needs `react`");
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
      await waitFor(async () =>
        (await read("message")).some((e) => e.agent?.session_id === "mind")
      );
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

      // matched case-insensitively, and the page is the window's grammar: the room named
      // AND addressed (the address is what `in`/`send(to:)` take back), each line authored
      // the way the window authors it — sender-less is the account's own (`org`), the peer
      // is `external` with their address
      const page = (found as ToolResultEvent).parts[0].data.output as string;
      assertStringIncludes(page, '<conv kind="direct" name="Gianvito" address="15613518605">');
      assertEquals(page.match(/<msg /g)?.length, 2);
      assertStringIncludes(page, ' org at="');
      assertStringIncludes(page, 'external="Gianvito" address="15613518605" at="');

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

Deno.test("search bounds read the org's clock: a bare stamp means the wall the model saw", async () => {
  // two rows straddle 17:00 Buenos Aires (20:00Z). A `before` of "…T17:00" with no offset
  // has to cut between them — not where the harness's own zone would put 17:00.
  const at = (iso: string, text: string): Draft<MessageEvent> => ({
    ts: iso,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "15613518605", kind: "direct", name: "Gianvito" },
      sender: { address: "15613518605", name: "Gianvito" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });
  await scenario(
    [
      ok([{
        kind: "tool_use",
        name: "search",
        input: { in: "gianvito", before: "2026-09-01T17:00" },
      }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("qué dijo antes de las cinco"));
      await waitFor(async () => (await read("tool_result")).length === 1);
      const [found] = await read("tool_result");
      const page = (found as ToolResultEvent).parts[0].data.output as string;
      assertStringIncludes(page, ">antes</msg>");
      assertEquals(page.includes("después"), false);
    },
    { timezone: "America/Argentina/Buenos_Aires" },
    [at("2026-09-01T19:59:00Z", "antes"), at("2026-09-01T20:01:00Z", "después")],
  );
});

Deno.test("search hands back the line the window shows, and pages on the oldest hit", async () => {
  // a receipt lands as a bare photo, another under a caption: the hit is the window's own
  // line — the bare photo hoisted onto its `<image>` element, the captioned one a `<msg>`
  // with the marker inside — with the path bash takes, so what is found reads as what is
  // seen. `limit` cuts the page and the closing line names the moment the next page opens
  // on; a filename is searchable text.
  const row = (iso: string, parts: MessageEvent["parts"]): Draft<MessageEvent> => ({
    ts: iso,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "gira", kind: "group", name: "Gira Norte" },
      sender: { address: "german", name: "Germán" },
    },
    parts,
  });
  const photo = (name: string, caption?: string) => ({
    type: "file" as const,
    kind: "image" as const,
    file: { mime_type: "image/jpeg", uri: `file:///media/${name}`, name },
    ...(caption ? { text: caption } : {}),
  });
  await scenario(
    [
      ok([{ kind: "tool_use", name: "search", input: { in: "gira", limit: 2 } }], "tool_use"),
      ok([{
        kind: "tool_use",
        name: "search",
        input: { in: "gira", before: "2026-09-04T12:01:00Z" },
      }], "tool_use"),
      ok([{ kind: "tool_use", name: "search", input: { text: "a.jpg" } }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("qué gastamos"));
      await waitFor(async () => (await read("tool_result")).length === 3);
      const [page, rest, named] = (await read("tool_result"))
        .map((e) => (e as ToolResultEvent).parts[0].data.output as string);
      assertStringIncludes(page, '<conv kind="group" name="Gira Norte" address="gira">');
      assertMatch(
        page,
        /<image id="\w{6}" external="Germán" address="german" at="4 Sep 2026 12:01" name="a.jpg" path="\/media\/a.jpg"\/>/,
      );
      assertStringIncludes(page, '>nafta <image name="b.jpg" path="/media/b.jpg"/></msg>');
      assertEquals(page.includes("310.000"), false);
      // every stamp dated: a search reaches where a bare "4 Sep" is ambiguous
      assertMatch(
        page,
        /— older matches not shown — search again with before="2026-09-04T12:01:00(\.000)?Z" to read on —$/,
      );
      assertStringIncludes(rest, ">310.000</msg>");
      assertEquals(rest.includes("older matches"), false);
      assertStringIncludes(named, 'name="a.jpg"');
      assertEquals(named.includes("b.jpg"), false);
    },
    {},
    [
      row("2026-09-04T12:00:00Z", [{ type: "text", kind: "text", text: "310.000" }]),
      row("2026-09-04T12:01:00Z", [photo("a.jpg")]),
      row("2026-09-04T12:02:00Z", [photo("b.jpg", "nafta")]),
    ],
  );
});

Deno.test("search shows a sentence once: a mirror copy is not a hit, and a shared instant pages whole", async () => {
  // the CC of a turn into the principal's chat carries `extra.via` — the same words as the
  // mind row, on another surface. Search finds the original and stays quiet about the copy.
  // Paging: `before` is strict, so when the row past the cut shares the oldest hit's
  // instant, that instant moves whole to the next page rather than losing a row to the cut.
  const row = (
    id: string,
    iso: string,
    text: string,
    conv = "gira",
    extra?: Record<string, unknown>,
  ): Draft<MessageEvent> => ({
    ts: iso,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: conv, kind: "group", name: "Gira Norte" },
      sender: { address: "german", name: "Germán" },
      external_id: id,
    },
    parts: [{ type: "text", kind: "text", text }],
    ...(extra ? { extra } : {}),
  });
  await scenario(
    [
      ok([{ kind: "tool_use", name: "search", input: { text: "nafta" } }], "tool_use"),
      ok([{ kind: "tool_use", name: "search", input: { in: "gira", limit: 2 } }], "tool_use"),
      ok([{
        kind: "tool_use",
        name: "search",
        input: { in: "gira", before: "2026-09-04T12:02:00Z" },
      }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("qué gastamos"));
      await waitFor(async () => (await read("tool_result")).length === 3);
      const [once, first, second] = (await read("tool_result"))
        .map((e) => (e as ToolResultEvent).parts[0].data.output as string);
      assertEquals(once.match(/nafta/g)?.length, 1); // the copy did not match beside its original
      // three rows, two on one instant, a page of two: the page holds the one row that
      // stands alone above the cut, and the next page opens on the whole shared instant
      assertEquals(first.match(/<msg /g)?.length, 1);
      assertStringIncludes(first, ">peaje</msg>");
      assertMatch(first, /before="2026-09-04T12:02:00(\.000)?Z" to read on —$/);
      assertEquals(second.match(/<msg /g)?.length, 2);
      assertStringIncludes(second, ">nafta</msg>");
      assertStringIncludes(second, ">aceite</msg>");
    },
    {},
    [
      row("w1", "2026-09-04T12:01:00Z", "nafta"),
      row("w2", "2026-09-04T12:01:00Z", "aceite"),
      row("w3", "2026-09-04T12:02:00Z", "peaje"),
      row("w4", "2026-09-04T12:03:00Z", "nafta", "mind@agent", {
        via: { event: "w1", service: "local", conversation: "gira" },
      }),
    ],
  );
});

Deno.test("search around: a match among its neighbours, stretches merged, the gap between them said", async () => {
  // eight lines in one room, two of them matches three lines apart: `around: 1` reads the
  // line either side of each. The two stretches do not touch, so a `…` line stands
  // between them; a third match next to the second shares its stretch and adds no gap.
  // The first three rows share one SECOND — a burst as WhatsApp stamps it — and the context
  // still finds the neighbours, because the bounds are the log's order, not the clock's.
  const row = (m: number, text: string): Draft<MessageEvent> => ({
    ts: `2026-09-04T12:${String(Math.max(m, 3)).padStart(2, "0")}:00Z`,
    type: "message",
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "gira", kind: "group", name: "Gira Norte" },
      sender: { address: "german", name: "Germán" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });
  await scenario(
    [
      ok([{ kind: "tool_use", name: "search", input: { text: "nafta", around: 1 } }], "tool_use"),
      ok([{ kind: "tool_use", name: "search", input: { text: "nafta", around: 99 } }], "tool_use"),
      ok([{ kind: "assistant", text: "listo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("qué gastamos"));
      await waitFor(async () => (await read("tool_result")).length === 2);
      const [page, refused] = (await read("tool_result")).map((e) => e as ToolResultEvent);
      const text = page.parts[0].data.output as string;
      const shown = [...text.matchAll(/<msg [^>]*>([^<]*)<\/msg>|^(… .*)$/gm)]
        .map((m) => m[1] ?? m[2]);
      assertEquals(shown, [
        "salida",
        "nafta",
        "peaje",
        "… lines between, not shown",
        "vuelta",
        "nafta de nuevo",
        "aceite y nafta",
        "fin",
      ]);
      // the matches, and only they, wear the mark
      assertEquals(
        [...text.matchAll(/<msg [^>]* match>([^<]*)</g)].map((m) => m[1]),
        ["nafta", "nafta de nuevo", "aceite y nafta"],
      );
      assertStringIncludes(JSON.stringify(refused.parts), "around must be an integer from 0 to");
    },
    {},
    [
      row(1, "salida"),
      row(2, "nafta"),
      row(3, "peaje"),
      row(4, "mate"),
      row(5, "vuelta"),
      row(6, "nafta de nuevo"),
      row(7, "aceite y nafta"),
      row(8, "fin"),
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
    agent: { id: "a1", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
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
    agent: { id: "a1", session_id: "mind" },
    ...(quote
      ? {
        payload: { ref_id: quote, ref_external_id: "wa:card-2" },
        extra: { via: { conversation: "wa:self" } },
      }
      : {}),
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
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

Deno.test("the gate answers to a reaction: a thumb ON the card is /y, a thumb down is /n (§9)", async () => {
  // a reaction arrives as the mirror copies it: an `add` whose `ref_id` is already the card
  // event, the glyph riding a reaction part. A verdict without a keyboard — the bar a phone
  // offers on a long press.
  const reacts = (
    glyph: string,
    on: string,
    action: "add" | "remove" = "add",
  ): Draft<MessageEvent> => ({
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "mind" },
    payload: { ref_id: on, ref_external_id: `wa:${on}`, action },
    extra: { via: { conversation: "wa:self" } },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
      sender: { address: "matias", name: "Matías" },
    },
    parts: [{ type: "data", kind: "reaction", data: { name: glyph, unicode: glyph } }],
  });
  const says = (text: string): Draft<MessageEvent> => ({
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
      sender: { address: "matias", name: "Matías" },
    },
    parts: [{ type: "text", kind: "text", text }],
  });
  const ask = { gate: (name: string) => name === "send" ? "ask" as const : "allow" as const };
  const gated = () => [
    ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "hi" } }], "tool_use"),
    ok([], "end_turn"),
  ];

  // 👍🏻 on the card — the phone's spelling, skin tone and all — and the send goes out
  await scenario(gated(), async ({ publish, read }) => {
    await publish(says("mandale"));
    await waitFor(async () => (await read("permission_request")).length === 1);
    const [card] = await read("permission_request");
    await publish(reacts("👍🏻", card.id));
    await waitFor(async () =>
      (await read("message")).some((e) => e.envelope.conversation.address === "wa:x")
    );
    const [verdict] = await read("permission_response");
    assert(verdict.type === "permission_response");
    assertEquals(verdict.parts[0].data, { behavior: "allow", scope: "once" });
  }, ask);

  // 👎 on the card — refused, nothing sent
  await scenario(gated(), async ({ publish, read }) => {
    await publish(says("mandale"));
    await waitFor(async () => (await read("permission_request")).length === 1);
    const [card] = await read("permission_request");
    await publish(reacts("👎", card.id));
    await waitFor(async () => (await read("tool_result")).some((e) => e.payload?.deferred));
    const res = (await read("tool_result")).find((e) => e.payload?.deferred);
    assert(res?.type === "tool_result");
    assertEquals(res.parts[0].data.is_error, true);
    assertEquals(
      (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
      0,
    );
  }, ask);

  // a thumb on some OTHER row (their own earlier line) is conversation, not a verdict; so
  // is a glyph off the table on the card, and so is taking a thumb back — the gate waits
  await scenario(gated(), async ({ publish, read }) => {
    const line = await publish(says("mandale"));
    await waitFor(async () => (await read("permission_request")).length === 1);
    const [card] = await read("permission_request");
    await publish(reacts("👍", line.id));
    await publish(reacts("😂", card.id));
    await publish(reacts("👍", card.id, "remove"));
    await new Promise((r) => setTimeout(r, 250));
    assertEquals((await read("permission_response")).length, 0);
    assertEquals((await read("error")).length, 0);
    assertEquals(
      (await read("message")).filter((e) => e.envelope.conversation.address === "wa:x").length,
      0,
    );
  }, ask);
});

Deno.test("two cards open: `/y all` settles the whole pile in one line (§9)", async () => {
  const says = (text: string): Draft<MessageEvent> => ({
    ts: new Date().toISOString(),
    type: "message",
    agent: { id: "a1", session_id: "mind" },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@a1" },
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

      // no quote, no ambiguity: `all` IS the answer to "which one" — both, and both go out
      await publish(says("/y all"));
      await waitFor(async () => (await read("permission_response")).length === 2);
      const settled = await read("permission_response");
      assertEquals(
        settled.map((s) => s.payload?.ref_id),
        cards.map((c) => c.payload?.ref_id), // asked order, answered in order
      );
      await waitFor(async () => {
        const sent = new Set((await read("message")).map((e) => e.envelope.conversation.address));
        return sent.has("wa:a") && sent.has("wa:b");
      });
      // the pile cleared without the harness ever having to say it was ambiguous
      assertEquals((await read("error")).length, 0);

      // and it is spent: the same latest line re-read on a later wake settles nothing twice
      await new Promise((r) => setTimeout(r, 250)); // quiescence
      assertEquals((await read("permission_response")).length, 2);
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
          conversation: { address: "mind@a1" },
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

Deno.test("a standing verdict is PINNED: the ruled conversation runs, its neighbour asks", async () => {
  await scenario(
    [
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:x", text: "uno" } }], "tool_use"),
      ok([{ kind: "assistant", text: "pedido" }], "end_turn"),
      ok([{ kind: "assistant", text: "enviado" }], "end_turn"),
      ok([{ kind: "tool_use", name: "send", input: { to: "wa:y", text: "dos" } }], "tool_use"),
      ok([{ kind: "assistant", text: "pedido de nuevo" }], "end_turn"),
    ],
    async ({ publish, read }) => {
      await publish(principalMsg("mandale uno"));
      await waitFor(async () => (await read("permission_request")).length === 1);
      const [req] = await read("permission_request");
      assert(req.type === "permission_request");
      await publish({
        ts: new Date().toISOString(),
        type: "permission_response",
        payload: { ref_id: req.payload.ref_id },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: "mind@a1" },
        },
        parts: [{
          type: "data",
          kind: "permission_response",
          data: { behavior: "allow", scope: "conversation" },
        }],
      });
      await waitFor(async () =>
        (await read("message")).some((e) => e.envelope.conversation.address === "wa:x")
      );

      // a send to a DIFFERENT conversation: the remembered row names wa:x, so it does not
      // match, and the base `ask` decides again — one standing yes is not a general one
      await publish(principalMsg("mandale dos"));
      await waitFor(async () => (await read("permission_request")).length === 2);
      const [, second] = await read("permission_request");
      assert(second.type === "permission_request");
      assertEquals(second.parts[0].data.call, "send(to: wa:y, text: dos)");
      assertEquals(
        (await read("message")).filter((e) => e.envelope.conversation.address === "wa:y").length,
        0,
      );
    },
    { gate: undefined, rules: [{ tool: "send", action: "ask" }, { tool: "*", action: "allow" }] },
  );
});

Deno.test("cancel: the agent withdraws one of two asks — and a bare /y settles the other", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let last: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const script: Anthropic.Message[] = [
    ok([
      { kind: "tool_use", name: "send", input: { to: "wa:x", text: "uno" } },
      { kind: "tool_use", name: "send", input: { to: "wa:y", text: "dos" } },
    ], "tool_use"),
  ];
  const transport: ModelTransport = (params) => {
    last = params;
    return Promise.resolve(script.shift() ?? ok([]));
  };
  const says = (text: string): Draft<MessageEvent> => ({
    ...principalMsg(text),
    agent: { id: "a1", session_id: "mind" },
  });
  const config = { ...CONFIG, gate: (name: string) => name === "send" ? "ask" : "allow" };
  const ports = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(says("mandale a los dos"));
    await xi(config, ports); // the turn that calls both sends
    await xi(config, ports); // act: two cards up, both calls answered pending_approval
    const cards = await log.read({ types: ["permission_request"] });
    assertEquals(cards.length, 2);
    const [a, b] = cards;
    const id = shortId(a.payload!.ref_id as string);
    script.push(
      ok([{ kind: "tool_use", name: "cancel", input: { id } }], "tool_use"),
      ok([{ kind: "assistant", text: "retirado, queda el otro" }]),
    );
    await xi(config, ports); // the think that cancels — its anchor is where the id came from
    assertStringIncludes(JSON.stringify(last?.messages.at(-1)?.content), `id ${id}`);
    await xi(config, ports); // act: the withdrawal
    // the settlement is the model's own doing: turn-marked, naming the card's call
    const [resp] = await log.read({ types: ["permission_response"] });
    assert(resp.type === "permission_response");
    assertEquals(resp.payload.ref_id, a.payload!.ref_id);
    assert(resp.payload.turn_id !== undefined);
    assertStringIncludes(String(resp.parts[0].data.reason), "withdrawn");
    assertEquals(resp.parts[0].text, "send(to: wa:x, text: uno)");
    await xi(config, ports); // the closing turn — the cancel's own result is the record…
    // …so no errand ever follows it, and the withdrawn call never runs
    assertEquals(
      (await log.read({ types: ["tool_result"] })).filter((e) => e.payload?.deferred),
      [],
    );
    const to = async (addr: string) =>
      (await log.read({ types: ["message"] })).filter((e) =>
        e.envelope.conversation.address === addr
      );
    assertEquals(await to("wa:x"), []);
    // one card stands, so the principal's bare word is unambiguous again
    await log.publish(says("/y"));
    await xi(config, ports); // verdict lands and the errand runs, one invocation
    assertEquals((await to("wa:y")).length, 1);
    const outcome = (await log.read({ types: ["tool_result"] })).find((e) => e.payload?.deferred);
    assert(outcome?.type === "tool_result");
    assertEquals(outcome.payload.ref_id, b.payload!.ref_id);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("schedule: the wake is armed as a row, fires as an alarm, and cancel unsets it", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  // the model schedules, then (next turn) narrates; the clock is simulated by firing the
  // due rows exactly as main's ticker does (§10) — tests must not wait a real minute
  const transport = scripted([
    ok([{ kind: "tool_use", name: "schedule", input: { in: "1s", note: "llamar a la clínica" } }]),
    ok([{ kind: "assistant", text: "listo, te aviso" }]),
  ]).transport;
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  const config = { ...CONFIG, timezone: "UTC" };
  try {
    await log.publish(principalMsg("recordame llamar a la clínica"));
    await xi(config, ports); // the turn that calls `schedule`…
    await xi(config, ports); // …and the act that runs it
    const [res] = (await log.read({ types: ["tool_result"] })) as ToolResultEvent[];
    const armed = res.parts[0].data.output as { armed: string; at: string };
    assert(armed.armed.length > 0, "the result hands back the id cancel takes");
    // the row is the ONLY record of the future — nothing is in the log yet
    const [row] = await log.timers("a1", "mind"); // the SESSION's wakes (§4)
    assertEquals(row.note, "llamar a la clínica");
    assertEquals(row.sessionId, "mind"); // the session that armed it owns it
    assertEquals(row.conversation, "mind@a1"); // and is where the note comes back
    assertEquals(row.refId, res.payload.ref_id); // provenance: the scheduling use
    assertEquals(await log.read({ types: ["alarm"] }), []);
    await xi(config, ports); // …and the turn that closes on it

    // the clock: nothing is due a minute early, everything is due once it is
    assertEquals(await log.due(new Date(Date.parse(row.fireAt) - 1000).toISOString()), []);
    const now = new Date(Date.parse(row.fireAt) + 1000).toISOString();
    for (const t of await log.due(now)) {
      await log.publish(
        {
          ts: now,
          type: "alarm",
          payload: { ref_id: t.refId! },
          envelope: {
            service: "local",
            connection_address: "agent",
            conversation: { address: t.conversation },
          },
          extra: { timer: { id: t.id, session_id: t.sessionId, armed_at: t.armedAt } },
          parts: [{ type: "text", kind: "alarm", text: t.note }],
        } satisfies Draft<Event>,
      );
      await log.settle(t.id, now);
    }
    // one-shot: fired, consumed, gone — and the note is in the log for the mind to read
    assertEquals(await log.timers("a1", "mind"), []);
    const [fired] = await log.read({ types: ["alarm"] });
    assertEquals(fired.parts[0].text, "llamar a la clínica");
    assertEquals(fired.agent, undefined); // harness-authored, so it wakes (§2)
    // provenance (§10): the call that armed it, the row that fired, when it was armed
    assertEquals(fired.payload?.ref_id, res.payload.ref_id);
    assertEquals((fired.extra?.timer as { id: string }).id, row.id);

    // a second wake, unset by name through the SAME cancel the approvals use
    const second = await log.arm({
      agentId: "a1",
      sessionId: "mind",
      fireAt: "2030-01-01T09:00:00.000Z",
      note: "la otra cosa",
      conversation: "mind@a1",
    });
    const cancelling = scripted([
      ok([{ kind: "tool_use", name: "cancel", input: { id: shortId(second.id) } }]),
    ]).transport;
    await xi(config, { ...ports, transport: cancelling }); // the turn that calls `cancel`…
    await xi(config, { ...ports, transport: cancelling }); // …and the act that runs it
    const undone = (await log.read({ types: ["tool_result"] }))
      .map((e) => (e as ToolResultEvent).parts[0].data.output as Json)
      .find((o) => o && typeof o === "object" && "disarmed" in o);
    assertEquals((undone as { note: string }).note, "la otra cosa");
    assertEquals(await log.timers("a1", "mind"), []);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("schedule: a bare `at` reads the org's clock — 17:00 Buenos Aires is 20:00Z", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  // tomorrow's date in UTC: inside the horizon on any run day, and no DST in this zone
  const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const transport = scripted([
    ok([{ kind: "tool_use", name: "schedule", input: { at: `${day}T17:00`, note: "merienda" } }]),
  ]).transport;
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("a las cinco"));
    await xi({ ...CONFIG, timezone: "America/Argentina/Buenos_Aires" }, ports);
    await xi({ ...CONFIG, timezone: "America/Argentina/Buenos_Aires" }, ports);
    const [t] = await log.timers("a1", "mind");
    assertEquals(t.fireAt, `${day}T20:00:00.000Z`);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the roster: the prefix splits it into who steers this agent and everyone else", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let last: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const transport: ModelTransport = (params) => {
    last = params;
    return Promise.resolve(ok([{ kind: "assistant", text: "ok" }], "end_turn"));
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.syncAgents([
      { agentId: "a1", mind: "mind@a1", principals: ["matias"] },
      // the one who steers: a person alone, no session of their own (§4)
      { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "+549", runs: false },
      { agentId: "sol", mind: "mind@sol", name: "Sol", email: "sol@x.io" },
    ]);
    await log.publish(principalMsg("hola"));
    await xi(CONFIG, ports);
    const env = (last!.system as { text: string }[]).at(-1)!.text;
    assertStringIncludes(env, "## Principals\n\n- matias · name: Matías · phone: +549");
    assertStringIncludes(env, "## Agents\n\n- sol · name: Sol · email: sol@x.io");
    assertEquals(env.includes("- a1"), false, "self is the `self:` line, not a member of either");
  } finally {
    await log.close();
  }
});

Deno.test("the surfaces: the prefix names them, the anchor lists the ones that are down", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let last: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const transport: ModelTransport = (params) => {
    last = params;
    return Promise.resolve(ok([{ kind: "assistant", text: "ok" }], "end_turn"));
  };
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  const config = { ...CONFIG, timezone: "UTC" };
  try {
    await log.upsertConnections([
      // owned by a1 and down: the bridge said so, stamped
      {
        service: "whatsapp",
        address: "549",
        agentId: "a1",
        extra: { state: "logged_out", logged_out_at: "2026-09-07T14:02:00Z" },
      },
      // the org's, up — and named by its url, not its opaque id
      {
        service: "slack",
        address: "T1:U9",
        credentialKey: "slack:T1:org",
        extra: { url: "acme.slack.com" },
      },
      { service: "slack", address: "T1" }, // the stub: gates ingest, nobody's voice
      { service: "google", address: "other@x.io", agentId: "a2" }, // another agent's
    ]);
    await log.publish(principalMsg("hola"));
    await xi(config, ports);
    const env = (last!.system as { text: string }[]).at(-1)!.text; // the closing section
    assertStringIncludes(
      env,
      "## Connections\n\n- slack · acme.slack.com (org)\n- whatsapp · 549 (yours)",
    );
    assert(!env.includes("T1 ("), "the stub is not a surface");
    assert(!env.includes("other@x.io"), "another agent's grant is not this agent's surface");
    const anchor = JSON.stringify(last?.messages.at(-1)?.content);
    assertStringIncludes(anchor, "down — 1 connection:");
    assertStringIncludes(anchor, "· 549 — whatsapp, logged out since 7 Sep 14:02");
    assert(!anchor.includes("slack"), "an up surface is not listed — silence means up");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("schedule: the horizon — no wake in the past, none beyond a year, no half-read stamp", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const transport = scripted([
    ok([
      { kind: "tool_use", name: "schedule", input: { at: "2020-01-01T09:00", note: "tarde" } },
      {
        kind: "tool_use",
        name: "schedule",
        // a real moment, but past the horizon — offset form so it reads the same any run day
        input: { at: new Date(Date.now() + 400 * 864e5).toISOString(), note: "lejos" },
      },
      // trailing garbage after a valid date: refused whole, never truncated to its date part
      { kind: "tool_use", name: "schedule", input: { at: "2030-01-01T09:00 mañana", note: "x" } },
    ]),
  ]).transport;
  const ports: XiPorts = { log, docs: openFileDocs(`${dir}/docs`), transport };
  try {
    await log.publish(principalMsg("agendá cosas raras"));
    await xi({ ...CONFIG, timezone: "UTC" }, ports); // the turn that calls…
    await xi({ ...CONFIG, timezone: "UTC" }, ports); // …and the act that refuses, loudly
    assertEquals(await log.timers("a1", "mind"), [], "nothing armed — every call was refused");
    const errors = (await log.read({ types: ["tool_result"] }))
      .filter((e) => JSON.stringify(e.parts).includes("is_error"));
    assertEquals(errors.length, 3);
    const all = JSON.stringify(errors.map((e) => e.parts));
    assertStringIncludes(all, "already passed");
    assertStringIncludes(all, "more than a year out");
    assertStringIncludes(all, "not a moment");
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an armed wake lives in the ANCHOR too — beside the jobs and the open asks (§5)", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let last: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const transport: ModelTransport = (params) => {
    last = params;
    return Promise.resolve(ok([]));
  };
  const config = { ...CONFIG, timezone: "UTC" };
  const ports = {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    ambient: () => Promise.resolve(["cwd: /work"]), // the exec plane's lines (§9)
  };
  try {
    const armed = await log.arm({
      agentId: "a1",
      sessionId: "mind",
      fireAt: "2030-03-04T09:30:00.000Z",
      cron: "30 9 * * *",
      note: "mandar los recordatorios",
      name: "recordatorios",
      conversation: "mind@a1",
    });
    // another session's wake: armed on the same agent, and none of this session's business
    await log.arm({
      agentId: "a1",
      sessionId: "s2",
      fireAt: "2030-03-04T08:00:00.000Z",
      note: "lo de la otra sesión",
      conversation: "mind@a1",
    });
    await log.publish(principalMsg("hola"));
    await xi(config, ports);
    const anchor = JSON.stringify(last?.messages.at(-1)?.content);
    assertStringIncludes(anchor, "scheduled — 1 wake");
    assert(!anchor.includes("otra sesión"), "the anchor lists this session's wakes only (§4)");
    assertStringIncludes(anchor, "4 Mar 9:30"); // when, on the org's clock
    assertStringIncludes(anchor, "repeats `30 9 * * *`"); // and that it comes back
    assertStringIncludes(anchor, "mandar los recordatorios");
    assertStringIncludes(anchor, shortId(armed.id)); // the handle `cancel` takes
    // a wake the ORG armed says so, so the note reads as an instruction (§10)
    assertStringIncludes(anchor, "the org's `recordatorios`");
    assertStringIncludes(anchor, "cwd: /work"); // the other state facts still stand
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xi returns what it decided, and discloses it the moment it decides", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const { transport } = scripted([ok([{ kind: "assistant", text: "hola" }])]);
  const seen: [string, string | undefined][] = [];
  const ports: XiPorts = {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    onDecision: (v, cursor) => seen.push([v, cursor]),
  };
  try {
    // an empty log owes nothing — and the disclosure says so before the invocation ends
    assertEquals(await xi(CONFIG, ports), "ignore");
    assertEquals(seen, [["ignore", undefined]]);
    const m = (await log.publish(principalMsg("hola")))!;
    // the verdict comes back at the end; the disclosure carried the read's last event
    assertEquals(await xi(CONFIG, ports), "think");
    assertEquals(seen[1], ["think", m.id]);
    // quiescence again — the cursor now covers the turn's own closing
    assertEquals(await xi(CONFIG, ports), "ignore");
    const last = (await log.read()).at(-1)!;
    assertEquals(seen[2], ["ignore", last.id]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a turn that ends in a terminal error discloses the idle it leaves", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  // a 401 is not weather: nu writes it as the turn's terminal row without a retry
  const { transport } = scripted([Object.assign(new Error("401 invalid key"), { status: 401 })]);
  const seen: [string, string | undefined][] = [];
  const ports: XiPorts = {
    log,
    docs: openFileDocs(`${dir}/docs`),
    transport,
    onDecision: (v, cursor) => seen.push([v, cursor]),
  };
  try {
    const m = (await log.publish(principalMsg("hola")))!;
    assertEquals(await xi(CONFIG, ports), "think");
    const err = (await log.read()).at(-1)!;
    assertEquals(err.type, "error");
    // the error row wakes no invocation, so the turn's end is the one place this is said
    assertEquals(seen, [["think", m.id], ["ignore", err.id]]);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a tool's attachment outside the agent's ground is refused, and the result says so", async () => {
  const ground = await Deno.realPath(await Deno.makeTempDir());
  const home = `${ground}/agents/a1`;
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(`${ground}/log`, { recursive: true });
  await Deno.writeTextFile(`${home}/mine.png`, "\x89PNG");
  await Deno.writeTextFile(`${ground}/log/log.db`, "sqlite");
  const attach = {
    spec: { name: "attach", description: "", input_schema: { type: "object" as const } },
    // a bytes read as `aread` reports one: the output plus the paths it read
    execute: () =>
      Promise.resolve({ output: "read two", files: [`${home}/mine.png`, `${ground}/log/log.db`] }),
  };
  try {
    await scenario(
      [
        ok([{ kind: "tool_use", name: "attach", input: {} }], "tool_use"),
        ok([{ kind: "assistant", text: "ok" }], "end_turn"),
      ],
      async ({ publish, read }) => {
        await publish(principalMsg("look at both"));
        await waitFor(async () => (await read("tool_result")).length === 1);
        const [result] = await read("tool_result") as ToolResultEvent[];
        // the agent's own file rides; the substrate's does not, and the refusal is in the output
        assertEquals(result.parts.filter((p) => p.type === "file").length, 1);
        assertStringIncludes(String(result.parts[0].data.output), "attachment refused");
        assertStringIncludes(String(result.parts[0].data.output), "log.db");
      },
      {},
      [],
      { exec: { attach }, files: localFiles({ home, roots: [home] }) },
    );
  } finally {
    await Deno.remove(ground, { recursive: true });
  }
});
