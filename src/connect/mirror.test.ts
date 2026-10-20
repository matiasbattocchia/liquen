import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMirror } from "./mirror.ts";
import { words } from "../i18n.ts";
import { SILENCE } from "../render.ts";
import { answerLine, parseVerdict } from "../verdict.ts";
import { openLog } from "../store/log.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionResponseEvent,
  ToolUseEvent,
} from "../types.ts";
import type { Connections } from "../store/connections.ts";

/** A live org with two alias surfaces bound to `ana`: the Slack self-DM `D1` (grant
 *  `T1:U1`) and the WA self-chat `549` (paired own number). The mirror under test rides a
 *  REAL log — the upsert/absorb machinery is half the contract. */
async function withMirror(
  fn: (t: {
    publish: (e: Draft<Event>) => Promise<Event>;
    inConv: (conversation: string) => Promise<MessageEvent[]>;
    /** ana's mind, rows of one type — what a settlement or a harness word lands as. */
    inMind: (type: string) => Promise<Event[]>;
    setDelivery: (id: string, patch: { external_id: string }) => Promise<void>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
    log: Pick<Connections, "deleteConnections">;
  }) => Promise<void>,
  settleMs = 30, // the waited constant, shrunk (§9) — one test widens it to race the backfill
  locale?: string, // the org's tongue — unset, the harness speaks English
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.upsertConnections([
    { service: "slack", address: "T1" }, // the workspace anchor inbounds carry (§4)
    { service: "slack", address: "T1:U1", agentId: "ana", extra: { mirrors: { self: "D1" } } },
    { service: "whatsapp", address: "549", agentId: "ana" }, // WA binding is DERIVED (§4)
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    gates: (scope) => log.gates(scope),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    locale,
  }, settleMs);
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
      publish: (e) => log.publish(e) as Promise<Event>, // mirror drafts always store
      inConv: async (conversation) =>
        (await log.read({ conversation, types: ["message"] })) as MessageEvent[],
      inMind: (type) => log.read({ conversation: "mind@ana", types: [type as Event["type"]] }),
      setDelivery: (id, patch) => log.setDelivery(id, patch),
      waitFor,
      log,
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
    conversation: { address: "mind@ana" },
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

    // the mind copy: wakes like a REPL line — signed with the principal the binding
    // names (§4), provenance in `via`, cause home
    await waitFor(async () => (await inConv("mind@ana")).length === 1);
    const [copy] = await inConv("mind@ana");
    // the principal's stamp (§3): whose mind + through the harness — and no turn_id,
    // which is what keeps the copy input rather than voice
    assertEquals(copy.agent, { id: "ana", session_id: "mind" });
    assertEquals(copy.payload?.turn_id, undefined);
    assertEquals(copy.envelope.sender, { address: "ana", name: "ana" });
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
    assertEquals(textOf(cc), "`[via slack]` pick up milk"); // her own surface: no name
    // …and never back to the origin surface
    await new Promise((r) => setTimeout(r, 150));
    assertEquals((await inConv("D1")).length, 1);
  });
});

Deno.test("mirror fan-out: the agent's voice CCs tagged to every alias, and CCs never re-enter", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "mind" }, payload: { turn_id: "t9" } }),
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
        conversation: "mind@ana",
      });
    }
    // the loop guard: the CCs are copies (agent + via) — nothing fans back in or out again
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("mind@ana")).length, 1);
    assertEquals((await inConv("D1")).length, 1);
    assertEquals((await inConv("549")).length, 1);
  });
});

Deno.test("mirror fan-out: a logged-out surface gets no copy — the live bindings still do", async () => {
  await withMirror(async ({ publish, inConv, waitFor, log }) => {
    await log.deleteConnections([{ service: "slack", address: "T1:U1" }]);
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "mind" }, payload: { turn_id: "t9" } }),
    );
    await waitFor(async () => (await inConv("549")).length === 1);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("D1")).length, 0);
  });
});

Deno.test("mirror fan-out: a terminal-typed principal line CCs tagged with where it was typed", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish(mindMsg("hola"));
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(textOf((await inConv("D1"))[0]), "`[via terminal]` hola");
    assertEquals(textOf((await inConv("549"))[0]), "`[via terminal]` hola");
  });
});

/** A card in ana's mind, for the use whose handle is `bbc24a`. */
const sendCard = (): Draft<Event> => ({
  ts: new Date().toISOString(),
  type: "permission_request",
  payload: { ref_id: "01a0fd7f-cde6-7000-8000-412733bbc24a" },
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: "mind@ana" },
  },
  parts: [{
    type: "data",
    kind: "permission_request",
    data: { tool: "send", detail: "send(to: Lucas, text: dale)" },
  }],
} as Draft<Event>);

/** A principal's answer to `sendCard`, as the door or fan-in writes it: the settlement,
 *  signed, carrying the line that gave it. */
const answered = (
  line: string,
  data: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Draft<Event> => ({
  ts: new Date().toISOString(),
  type: "permission_response",
  payload: { ref_id: "01a0fd7f-cde6-7000-8000-412733bbc24a" },
  agent: { id: "ana", session_id: "mind" },
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: "mind@ana" },
    sender: { address: "ana", name: "ana" },
  },
  parts: [
    { type: "data", kind: "permission_response", data },
    { type: "text", kind: "text", text: line },
  ],
  ...(extra ? { extra } : {}),
} as unknown as Draft<Event>);

Deno.test("mirror fan-out: a line that answers a card quotes the card's crossing, its handle said by the quote", async () => {
  await withMirror(async ({ publish, inConv, waitFor, setDelivery }) => {
    await publish(sendCard());
    await waitFor(async () =>
      (await inConv("D1")).length === 1 && (await inConv("549")).length === 1
    );
    // the dispatchers stamp what they posted
    for (const [conv, id] of [["D1", "slack:T1:D1:200.1"], ["549", "whatsapp:wmw.card"]]) {
      const [cc] = await inConv(conv);
      await setDelivery(cc.id, { external_id: id });
    }
    await publish(
      answered("/n bbc24a not today", { behavior: "deny", scope: "once", reason: "not today" }),
    );
    await waitFor(async () =>
      (await inConv("D1")).length === 2 && (await inConv("549")).length === 2
    );
    const wa = (await inConv("549"))[1];
    assertEquals(textOf(wa), "`[via terminal]` /n not today");
    assertEquals(wa.payload?.ref_external_id, "whatsapp:wmw.card");
    assertEquals((await inConv("D1"))[1].payload?.ref_external_id, "slack:T1:D1:200.1");
  });
});

Deno.test("mirror fan-out: a thumb on a card crosses as its glyph, quoting the card", async () => {
  await withMirror(async ({ publish, inConv, waitFor, setDelivery }) => {
    const card = await publish(sendCard());
    await waitFor(async () => (await inConv("549")).length === 1);
    await setDelivery((await inConv("549"))[0].id, { external_id: "whatsapp:wmw.card" });
    // a thumb given on Slack, settled at fan-in: the settlement carries the glyph
    await publish(answered("👍", { behavior: "allow", scope: "once" }, {
      via: { event: "x", service: "slack", conversation: "D1" },
    }));
    await waitFor(async () => (await inConv("549")).length === 2);
    const wa = (await inConv("549"))[1];
    assertEquals(textOf(wa), "`[via slack]` 👍");
    assertEquals(wa.payload?.ref_external_id, "whatsapp:wmw.card");
    // an un-react says nothing
    await publish(mindMsg("", {
      payload: { ref_id: card.id, action: "remove" },
      parts: [{ type: "data", kind: "reaction", data: { unicode: "👍" } }],
      extra: { via: { event: "y", service: "slack", conversation: "D1" } },
    }));
    await new Promise((r) => setTimeout(r, 150));
    assertEquals((await inConv("549")).length, 2);
  });
});

Deno.test("mirror fan-out: a tool call crosses as one redacted line", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const use: Draft<ToolUseEvent> = {
      ts: new Date().toISOString(),
      type: "tool_use",
      payload: { turn_id: "t1" },
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
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

Deno.test("mirror fan-out: a tool line names the addresses it points at, off the log", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    // the group has to be IN the log for its name to be knowable — that is the directory
    await publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "whatsapp",
        connection_address: "549",
        external_id: "wa-g1",
        conversation: {
          address: "120363429869958481@g.us",
          name: "Sprinters Friends",
          kind: "group",
        },
        sender: { address: "5493", name: "Germán" },
      },
      parts: [{ type: "text", kind: "text", text: "salimos jueves" }],
    });
    await publish({
      ts: new Date().toISOString(),
      type: "tool_use",
      payload: { turn_id: "t2" },
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "tool_use",
        data: { name: "search", input: { in: "120363429869958481@g.us", text: "Catamarca" } },
      }],
    } as Draft<ToolUseEvent>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    // the principal reads the call on a surface: it must say WHERE, not a wire handle
    assertEquals(
      textOf((await inConv("D1"))[0]),
      "`[agent tool]` **search**(in: Sprinters Friends, text: Catamarca)",
    );
  });
});

Deno.test("mirror fan-out: a send's card is laid out in rows, in the surface's tongue", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish({
      ts: new Date().toISOString(),
      type: "permission_request",
      payload: { ref_id: "01a0-use" },
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_request",
        data: {
          tool: "send",
          call: "send(to: Vivian)",
          detail: "send(to: Vivian, text: hola! nos vemos)",
          send: {
            conversation: { name: "Vivian", address: "5492604586396" },
            last: { text: "llegás?", at: "23 Sep 16:42" },
            text: "hola!\nnos vemos",
            files: 1,
          },
        },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(
      textOf((await inConv("D1"))[0]),
      "`[agent asks]` approve **send**\n\n" +
        "**Conversation**: Vivian <5492604586396>\n\n" +
        "**Last message** (23 Sep 16:42):\nllegás?\n\n" +
        "**Reply**:\nhola!\nnos vemos\n\n" +
        "**Attachments**: 1\n\n" +
        "`reply /y to approve · /n <reason> to refuse · or react 👍 / 👎`",
    );
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
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
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

Deno.test("mirror fan-out: under a Spanish locale the harness speaks Spanish — the keys stay `/y` `/n`", async () => {
  await withMirror(
    async ({ publish, inConv, waitFor }) => {
      await publish({
        ts: new Date().toISOString(),
        type: "permission_request",
        payload: { ref_id: "01a0-use" },
        agent: { id: "ana", session_id: "mind" },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: "mind@ana" },
        },
        parts: [{
          type: "data",
          kind: "permission_request",
          data: { tool: "send", call: "send(to: Vivian)", detail: "send(to: Vivian, text: hola)" },
        }],
      } as Draft<Event>);
      await publish({
        ts: new Date().toISOString(),
        type: "delta",
        agent: { id: "ana", session_id: "mind" },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: "mind@ana" },
        },
        parts: [{ type: "data", kind: "delta", data: { kind: "thinking" } }],
      });
      await waitFor(async () => (await inConv("D1")).length === 2);
      const [card, presence] = (await inConv("D1")).map(textOf);
      // the frame translates; the tool detail (API surface) and the commands the verdict
      // parser reads do not — a principal typing off the hint still settles the card
      assertStringIncludes(
        card,
        "`[agente pregunta]` aprobar **send**(to: Vivian, text: hola)\n\n" +
          "`responder /y para aprobar · /n <motivo> para rechazar · o reaccionar 👍 / 👎`",
      );
      assertEquals(parseVerdict("/y"), { behavior: "allow", scope: "once" });
      assertEquals(presence, "`[agente pensando...]`");
    },
    30,
    "es_AR.UTF-8",
  );
});

Deno.test("words: the tongue is the locale's language subtag; one we don't speak is English", () => {
  assertEquals(words("es_AR.UTF-8").agent, "agente");
  assertEquals(words("es").agent, "agente");
  assertEquals(words("pt_BR.UTF-8").agent, "agent");
  assertEquals(words(null).agent, "agent");
  assertEquals(words(undefined).agent, "agent");
});

/** A card in ana's mind asking about `use` — gated, so the store counts it open. */
const cardOn = (use: string, to: string): Draft<Event> => ({
  ts: new Date().toISOString(),
  type: "permission_request",
  payload: { ref_id: use },
  agent: { id: "ana", session_id: "mind" },
  envelope: {
    service: "local",
    connection_address: "agent",
    conversation: { address: "mind@ana" },
  },
  parts: [{
    type: "data",
    kind: "permission_request",
    data: { tool: "send", call: `send(to: ${to})`, detail: `send(to: ${to}, text: hola)` },
  }],
} as Draft<Event>);

Deno.test("mirror fan-in: a line that answers a card is its settlement — no message, the quote translated (§9)", async () => {
  await withMirror(async ({ publish, inConv, inMind, setDelivery, waitFor }) => {
    // two cards cross to the self-DM, and the dispatcher claims each CC
    await publish(cardOn("01a0-use-a", "Vivian"));
    await publish(cardOn("01a0-use-b", "Lucas"));
    await waitFor(async () => (await inConv("D1")).length === 2);
    const [ccA, ccB] = await inConv("D1");
    await setDelivery(ccA.id, { external_id: "slack:T1:D1:666.6" });
    await setDelivery(ccB.id, { external_id: "slack:T1:D1:666.7" });
    const settled = async () => (await inMind("permission_response")) as PermissionResponseEvent[];

    // the principal replies to the OLDER card: the quote names a surface row, the mirror
    // joins it to the card, and the mind gets the settlement — signed, carrying the line
    // and where it came from — and no message the model would not read
    await publish({
      ...aliasInbound("/n muy formal", { external_id: "slack:T1:D1:777.7" }),
      payload: { ref_external_id: "slack:T1:D1:666.6" },
    } as Draft<Event>);
    await waitFor(async () => (await settled()).length === 1);
    const [first] = await settled();
    assertEquals(first.payload.ref_id, "01a0-use-a");
    assertEquals(first.parts[0].data, { behavior: "deny", scope: "once", reason: "muy formal" });
    assertEquals(answerLine(first), "/n muy formal");
    assertEquals(first.envelope.sender?.address, "ana"); // the binding's principal, by username
    assertEquals((first.extra?.via as { service: string }).service, "slack");
    assertEquals(await inConv("mind@ana"), []);

    // a bare word answers the newest card still open
    await publish(aliasInbound("/y", { external_id: "slack:T1:D1:888.8" }));
    await waitFor(async () => (await settled()).length === 2);
    assertEquals((await settled())[1].payload.ref_id, "01a0-use-b");

    // a reply to a card already answered settles nothing, and the harness says so
    await publish({
      ...aliasInbound("/y", { external_id: "slack:T1:D1:888.9" }),
      payload: { ref_external_id: "slack:T1:D1:666.6" },
    } as Draft<Event>);
    await waitFor(async () => (await inMind("error")).length === 1);
    assertStringIncludes(JSON.stringify((await inMind("error"))[0].parts), "already answered");
    assertEquals((await settled()).length, 2);

    // a reply to a card that is NOT a verdict is a line like any other: copied, its quote
    // joined to the card
    await publish({
      ...aliasInbound("esperá un toque", { external_id: "slack:T1:D1:889.0" }),
      payload: { ref_external_id: "slack:T1:D1:666.6" },
    } as Draft<Event>);
    await waitFor(async () => (await inConv("mind@ana")).length === 1);
    const [copy] = await inConv("mind@ana");
    assertEquals(copy.payload?.ref_id, (ccA.extra?.via as { event: string }).event);
    assertEquals(copy.payload?.ref_external_id, "slack:T1:D1:666.6");
  });
});

Deno.test("mirror fan-in: a thumb ON a card settles it; a thumb elsewhere, or taken back, is a line (§9)", async () => {
  await withMirror(async ({ publish, inConv, inMind, setDelivery, waitFor }) => {
    await publish(cardOn("01a0-use-c", "Vivian"));
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");
    await setDelivery(cc.id, { external_id: "slack:T1:D1:666.6" });
    const react = (name: string, on: string, action: "add" | "remove", id: string) =>
      publish({
        ...aliasInbound("", { external_id: id }),
        payload: { ref_external_id: on, action },
        parts: [{ type: "data", kind: "reaction", data: { name } }],
      } as Draft<Event>);

    // a glyph off the table on the card, and an un-react: lines, copied with their action
    await react("joy", "slack:T1:D1:666.6", "add", "slack:T1:D1:700.1");
    await react("+1", "slack:T1:D1:666.6", "remove", "slack:T1:D1:700.2");
    await waitFor(async () => (await inConv("mind@ana")).length === 2);
    assertEquals(
      (await inConv("mind@ana")).map((e) => e.payload?.action),
      ["add", "remove"],
    );
    assertEquals(await inMind("permission_response"), []);

    // Slack's `+1` on the card: the settlement, carrying the glyph as its line
    await react("+1", "slack:T1:D1:666.6", "add", "slack:T1:D1:700.3");
    await waitFor(async () => (await inMind("permission_response")).length === 1);
    const [thumb] = (await inMind("permission_response")) as PermissionResponseEvent[];
    assertEquals(thumb.payload.ref_id, "01a0-use-c");
    assertEquals(thumb.parts[0].data, { behavior: "allow", scope: "once" });
    assertEquals(answerLine(thumb), "+1");
    assertEquals((await inConv("mind@ana")).length, 2);
  });
});

Deno.test("mirror fan-in: a /y with nothing waiting is answered by the harness", async () => {
  await withMirror(async ({ publish, inConv, inMind, waitFor }) => {
    await publish(aliasInbound("/y", { external_id: "slack:T1:D1:500.1" }));
    await waitFor(async () => (await inMind("error")).length === 1);
    assertStringIncludes(
      JSON.stringify((await inMind("error"))[0].parts),
      "no approval is waiting",
    );
    assertEquals(await inConv("mind@ana"), []);
  });
});

Deno.test("mirror fan-in: a transcript lands on the mind's COPY of the audio it names (§5)", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    // the voice note arrives on the surface and crosses to the mind
    await publish(aliasInbound("", { external_id: "slack:T1:D1:111.1" }));
    await waitFor(async () => (await inConv("mind@ana")).length === 1);
    const [audioCopy] = await inConv("mind@ana");

    // the transcriber publishes the words into the AUDIO's conversation — an `add` naming
    // the surface row, which is the only id it has
    await publish({
      ...aliasInbound("hola, esto es una prueba", { external_id: "transcript:slack:T1:D1:111.1" }),
      payload: { action: "add", ref_external_id: "slack:T1:D1:111.1" },
    } as Draft<Event>);

    // in the mind that id names nothing — the copy has its own. The mirror joins from the
    // other end (`extra.via.external_id`), so the words land on the note they came from
    await waitFor(async () => (await inConv("mind@ana")).length === 2);
    const words = (await inConv("mind@ana")).find((e) => textOf(e).startsWith("hola"))!;
    assertEquals(words.payload?.ref_id, audioCopy.id);
    assertEquals(words.payload?.ref_external_id, "slack:T1:D1:111.1");
  });
});

Deno.test("mirror fan-in settles: an echo absorbed by the dispatch backfill copies nothing", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    // the agent speaks → a CC to the self-DM lands (what a dispatcher would then post)
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "mind" }, payload: { turn_id: "t9" } }),
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
    assertEquals((await inConv("mind@ana")).length, 1);
    assertEquals((await inConv("D1")).length, 1);
  }, 150);
});

Deno.test("mirror fan-in: an echo whose claim never lands is absorbed by the CC it came from", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    // the agent speaks → a CC to the self-DM, which a dispatcher posts and then dies on:
    // no `setDelivery`, so the row never gets the id its own post came back with
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "mind" }, payload: { turn_id: "t9" } }),
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
    assertEquals((await inConv("mind@ana")).length, 1); // the mind never heard itself
    assertEquals((await inConv("549")).length, 1); // …and nothing crossed to the other surface
  });
});

Deno.test("mirror fan-in: a CLAIMED CC never swallows the principal repeating its words", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    await publish(
      mindMsg("done!", { agent: { id: "ana", session_id: "mind" }, payload: { turn_id: "t9" } }),
    );
    await waitFor(async () => (await inConv("D1")).length === 1);
    const [cc] = await inConv("D1");
    await setDelivery(cc.id, { external_id: "slack:T1:D1:444.4" }); // a healthy dispatcher

    // the principal, typing the same words a moment later — a different id, and the CC is
    // claimed: the guard's whole safety is that an unstamped row is otherwise unobservable
    await publish(aliasInbound("`[agent]` done!", { external_id: "slack:T1:D1:555.5" }));
    await waitFor(async () => (await inConv("mind@ana")).length === 2);
    assertEquals(textOf((await inConv("mind@ana"))[1]), "`[agent]` done!");
  });
});

Deno.test("mirror: imported history never mirrors (no backfill — the REPL alone reads history)", async () => {
  await withMirror(async ({ publish, inConv }) => {
    await publish(aliasInbound("old news", { extra: { backfill: true } }));
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("mind@ana")).length, 0);
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
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "error",
        data: { error: "that approval was already answered" },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertStringIncludes(textOf((await inConv("D1"))[0]), "`[system]` that approval was already");
  });
});

Deno.test("mirror fan-out: a settlement's row — a verdict, a lapse, a withdrawal — and a refused call's outcome stay at the terminal", async () => {
  await withMirror(async ({ publish, inConv, waitFor, setDelivery }) => {
    const settle = (
      data: Record<string, unknown>,
      payload: { ref_id: string; turn_id?: string },
      text?: string,
    ): Draft<Event> => ({
      ts: new Date().toISOString(),
      type: "permission_response",
      payload,
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "permission_response",
        data,
        ...(text !== undefined ? { text } : {}),
      }],
    } as unknown as Draft<Event>);
    const card = await publish(sendCard());
    await waitFor(async () => (await inConv("D1")).length === 1);
    await setDelivery((await inConv("D1"))[0].id, { external_id: "slack:T1:D1:200.1" });
    // the principal's verdict, or the clock's: the line that gave it crossed, the row with
    // its handle is the terminal's
    await publish(settle({ behavior: "deny", scope: "once", reason: "más informal" }, {
      ref_id: card.payload!.ref_id!,
    }));
    await publish(settle(
      { behavior: "deny", scope: "once", lapsed: true, reason: "unanswered for 24h" },
      { ref_id: "01a0-use" },
    ));
    // …and the call it refused never ran: no outcome to tell
    await publish({
      ts: new Date().toISOString(),
      type: "tool_result",
      payload: { ref_id: card.payload!.ref_id!, turn_id: "t1", gated: true },
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{
        type: "data",
        kind: "tool_result",
        text: "send(to: Lucas, text: dale)",
        data: { output: "refused by your principal: más informal", is_error: true, refused: true },
      }],
    } as unknown as Draft<Event>);
    // …and the agent's cancel (turn-marked) is a settlement like any other
    await publish(settle(
      { behavior: "deny", scope: "once", reason: "withdrawn by the agent" },
      { ref_id: "01a0fd7f-cde6-7000-8000-412733bbc24a", turn_id: "T1" },
      "send(to: Vivian)",
    ));
    // the agent's next word crosses, and nothing stands between it and the card
    await publish(mindMsg("listo", {
      agent: { id: "ana", session_id: "mind" },
      payload: { turn_id: "t9" },
    }));
    await waitFor(async () => (await inConv("D1")).length === 2);
    await new Promise((r) => setTimeout(r, 150));
    const rows = await inConv("D1");
    assertEquals(rows.length, 2);
    assertEquals(textOf(rows[1]), "`[agent]` listo");
  });
});

Deno.test("mirror fan-out: a /cancel crosses as the principal's line, and that is the whole of the cut", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const env = {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@ana" },
    };
    // the call it stopped mid-run: the `/cancel` says why, so its result does not
    await publish({
      ts: new Date().toISOString(),
      type: "tool_result",
      payload: { ref_id: "u1", turn_id: "t1" },
      agent: { id: "ana", session_id: "mind" },
      envelope: env,
      parts: [{
        type: "data",
        kind: "tool_result",
        data: { output: "killed", is_error: true, cancelled: true },
      }],
    } as unknown as Draft<Event>);
    await publish({
      ts: new Date().toISOString(),
      type: "control",
      payload: { control: "cancel" },
      agent: { id: "ana", session_id: "mind" },
      envelope: { ...env, sender: { address: "ana", name: "ana" } },
      parts: [{ type: "text", kind: "text", text: "/cancel" }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("549")).length === 1);
    assertEquals((await inConv("549")).map(textOf), ["`[via terminal]` /cancel"]);
  });
});

Deno.test("mirror fan-out: a wake and a failure cross as `[system]`; a checkpoint does not", async () => {
  await withMirror(
    async ({ publish, inConv, waitFor }) => {
      const harness = (type: string, parts: unknown[], payload: Record<string, unknown> = {}) =>
        publish({
          ts: new Date().toISOString(),
          type,
          payload,
          envelope: {
            service: "local",
            connection_address: "agent",
            conversation: { address: "mind@ana" },
          },
          parts,
        } as unknown as Draft<Event>);
      // a checkpoint is the terminal's: a surface heard the mind compacting as it happened
      await harness("summary", [{ type: "text", kind: "text", text: "…" }], {
        covers: ["a", "b"],
      });
      await harness("alarm", [{ type: "text", kind: "alarm", text: "recordarle a Mecha el mail" }]);
      await harness("tool_result", [{
        type: "data",
        kind: "tool_result",
        data: { output: "Command exited with code 1", is_error: true },
      }], { ref_id: "u1", turn_id: "t1" });
      await harness(
        "tool_result",
        [{ type: "data", kind: "tool_result", data: { output: "ok" } }],
        {
          ref_id: "u2",
          turn_id: "t1",
        },
      ); // a call that went fine says nothing more, there as here
      await harness(
        "tool_result",
        [{ type: "data", kind: "tool_result", text: "send(to: Roxi)", data: { output: "sent" } }],
        { ref_id: "u3", turn_id: "t2", gated: true },
      ); // …an approved one included: the card asked for it, the `/y` gave it
      await harness("tool_result", [{
        type: "data",
        kind: "tool_result",
        text: "send(to: Vivian)",
        data: { output: "the bridge is down", is_error: true },
      }], { ref_id: "u4", turn_id: "t2", gated: true });
      await waitFor(async () => (await inConv("549")).length === 3);
      assertEquals((await inConv("549")).map(textOf), [
        "`[sistema]` ⏰ recordarle a Mecha el mail",
        "`[sistema]` ✗ Command exited with code 1",
        "`[sistema]` ✗ send(to: Vivian) — the bridge is down",
      ]);
    },
    30,
    "es_AR.UTF-8",
  );
});

Deno.test("mirror: a SILENCE note reaches no surface — nothing said is nothing sent", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    await publish(mindMsg(SILENCE, {
      agent: { id: "ana", session_id: "mind" },
      payload: { turn_id: "t9" },
      extra: { silence: true },
    }));
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("D1")).length, 0);
    assertEquals((await inConv("549")).length, 0);
    // and the next real word still crosses — silence is per message, not a state
    await publish(mindMsg("ahí va", {
      agent: { id: "ana", session_id: "mind" },
      payload: { turn_id: "t10" },
    }));
    await waitFor(async () => (await inConv("D1")).length === 1);
  });
});

Deno.test("mirror fan-in: a principal's DM with the agent's own number copies to its mind, signed by the roster (§4)", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([
    { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "549115550001" },
    { agentId: "sol", mind: "mind@sol", name: "Sol", phone: "549115550002", runs: false },
    {
      agentId: "ventas",
      mind: "mind@ventas",
      name: "Ventas",
      phone: "549117770000",
      principals: ["matias", "sol", "ventas"],
    },
  ]);
  await log.upsertConnections([
    {
      service: "whatsapp",
      address: "549117770000",
      agentId: "ventas",
      credentialKey: "whatsapp:549117770000",
    },
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    gates: (scope) => log.gates(scope),
    aliases: () => log.aliases(),
    nameOf: async (id) => (await log.agents()).find((a) => a.agentId === id)?.name ?? id,
  }, 10);
  const inConv = async (conversation: string) =>
    (await log.read({ conversation, types: ["message"] })) as MessageEvent[];
  const waitFor = async (cond: () => Promise<boolean>) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("waitFor timeout");
  };
  try {
    await new Promise((r) => setTimeout(r, 50));
    // matias, from his phone, to the org number — the classifier stamped him (§3)
    await log.publish({
      ts: new Date().toISOString(),
      type: "message",
      agent: { id: "matias" },
      envelope: {
        service: "whatsapp",
        connection_address: "549117770000",
        conversation: { address: "549115550001", kind: "direct" },
        sender: { address: "549115550001", name: "Matías (WA)" },
        external_id: "whatsapp:wmw.1",
      },
      parts: [{ type: "text", kind: "text", text: "mandá los recordatorios" }],
    });
    await waitFor(async () => (await inConv("mind@ventas")).length === 1);
    const [copy] = await inConv("mind@ventas");
    assertEquals(copy.agent, { id: "ventas", session_id: "mind" }); // whose mind
    assertEquals(copy.envelope.sender, { address: "matias", name: "Matías" }); // who spoke
    assertEquals(textOf(copy), "mandá los recordatorios");
    // and the other principal's DM gets the cross-broadcast, naming who typed it by username
    await waitFor(async () => (await inConv("549115550002")).length === 1);
    assertEquals(
      textOf((await inConv("549115550002"))[0]),
      "`[matias via whatsapp]` mandá los recordatorios",
    );
    assertEquals((await inConv("549115550001")).length, 1); // never back to the origin
    // the number's own self-chat is a surface too: the account is the agent's (§4)
    await waitFor(async () => (await inConv("549117770000")).length === 1);
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mirror: a Teams account's self-chat and a principal's DM with it both get the CC; the principal's line comes in through their own account's anchor all the same (§4)", async () => {
  const SELF = "19:aaaa_aaaa@unq.gbl.spaces";
  const DM = "19:aaaa_mmmm@unq.gbl.spaces";
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([
    { agentId: "matias", mind: "mind@matias", name: "Matías", email: "matias@contoso.com" },
    {
      agentId: "ventas",
      mind: "mind@ventas",
      name: "Ventas",
      email: "ventas@contoso.com",
      principals: ["matias"],
    },
  ]);
  await log.upsertConnections([
    {
      service: "microsoft",
      address: "ventas@contoso.com",
      agentId: "ventas",
      extra: { mirrors: { self: SELF, dms: { matias: DM } } },
    },
    { service: "microsoft", address: "matias@contoso.com", agentId: "matias" },
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    gates: (scope) => log.gates(scope),
    aliases: () => log.aliases(),
    nameOf: async (id) => (await log.agents()).find((a) => a.agentId === id)?.name ?? id,
  }, 10);
  const inConv = async (conversation: string) =>
    (await log.read({ conversation, types: ["message"] })) as MessageEvent[];
  const waitFor = async (cond: () => Promise<boolean>) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("waitFor timeout");
  };
  try {
    await new Promise((r) => setTimeout(r, 50));
    // the agent's voice reaches both faces of its mind, as the account
    await log.publish(mindMsg("informe listo", {
      agent: { id: "ventas", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ventas" },
        sender: { address: "ventas", name: "Ventas" },
      },
      payload: { turn_id: "t1" },
    }));
    await waitFor(async () => (await inConv(SELF)).length === 1 && (await inConv(DM)).length === 1);
    for (const conv of [SELF, DM]) {
      const [cc] = await inConv(conv);
      assertEquals(cc.envelope.service, "microsoft");
      assertEquals(cc.envelope.connection_address, "ventas@contoso.com");
      assertEquals(textOf(cc), "`[agent]` informe listo");
    }

    // matias writes in the DM, and his own account's subscription told it first: the row
    // anchors to his account, and still reaches the mind of the account he wrote to
    await log.publish({
      ts: new Date().toISOString(),
      type: "message",
      agent: { id: "matias" },
      envelope: {
        service: "microsoft",
        connection_address: "matias@contoso.com",
        conversation: { address: DM, kind: "direct" },
        sender: { address: "u-matias", name: "Matías Battocchia" },
        external_id: `teams:${DM}:5`,
      },
      parts: [{ type: "text", kind: "text", text: "mandalo" }],
    });
    await waitFor(async () => (await inConv("mind@ventas")).some((e) => textOf(e) === "mandalo"));
    const copy = (await inConv("mind@ventas")).find((e) => textOf(e) === "mandalo")!;
    assertEquals(copy.envelope.sender, { address: "matias", name: "Matías" });
    // the self-chat hears it, never the DM it came from
    await waitFor(async () => (await inConv(SELF)).length === 2);
    assertEquals(textOf((await inConv(SELF))[1]), "`[matias via microsoft]` mandalo");
    assertEquals((await inConv(DM)).length, 2);
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mirror fan-out: presence crosses as the tag alone, and the CC is marked transport", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const fact = await publish({
      ts: new Date().toISOString(),
      type: "delta",
      agent: { id: "ana", session_id: "mind" },
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@ana" },
      },
      parts: [{ type: "data", kind: "delta", data: { kind: "thinking" } }],
    });
    await waitFor(async () =>
      (await inConv("D1")).length === 1 && (await inConv("549")).length === 1
    );
    for (const conv of ["D1", "549"]) {
      const [cc] = await inConv(conv);
      // the log holds the fact; the words are the surface's — the same tag shape as every
      // crossing line, and nothing after it
      assertEquals(textOf(cc), "`[agent thinking...]`");
      assertEquals(cc.agent, { id: "ana", session_id: "mind" });
      assertEquals(cc.payload?.ref_id, fact.id);
      // only true while the turn runs: the mark the sweeper reads to never re-offer it
      assertEquals(cc.extra?.delta, true);
    }
    // the fact stays where it was written: nothing fans back in
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await inConv("mind@ana")).length, 0); // inConv reads messages only
  });
});

/** An org whose agent `sonar` has a steering room on an org account (`sonar:t1`, raw: its
 *  dispatcher renders) and a Slack self-DM of its own (`D1`, tagged lines), so a crossing
 *  can be read on both kinds of surface. */
async function withRoom(
  fn: (t: {
    publish: (e: Draft<Event>) => Promise<Event>;
    inConv: (conversation: string) => Promise<MessageEvent[]>;
    waitFor: (cond: () => Promise<boolean>) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([{ agentId: "sonar", mind: "mind@sonar", principals: [] }]);
  await log.upsertConnections([
    {
      service: "sonar",
      address: "t1",
      extra: { mirrors: { rooms: { sonar: "sonar" } }, raw: true },
    },
    { service: "slack", address: "T1:U1", agentId: "sonar", extra: { mirrors: { self: "D1" } } },
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    gates: (scope) => log.gates(scope),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
  }, 30);
  const waitFor = async (cond: () => Promise<boolean>) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("waitFor timeout");
  };
  try {
    await new Promise((r) => setTimeout(r, 50));
    await fn({
      publish: (e) => log.publish(e) as Promise<Event>,
      inConv: async (conversation) =>
        (await log.read({ conversation, types: ["message"] })) as MessageEvent[],
      waitFor,
    });
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const roomLine = (
  text: string,
  sender?: { address: string; name: string },
): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  envelope: {
    service: "sonar" as Event["envelope"]["service"],
    connection_address: "t1",
    conversation: { address: "sonar", kind: "group" },
    ...(sender ? { sender } : {}),
    external_id: `sonar:${crypto.randomUUID()}`,
  },
  parts: [{ type: "text", kind: "text", text }],
});

Deno.test("mirror fan-in: a steering room line is signed by its own sender, and reaches another surface by their name", async () => {
  await withRoom(async ({ publish, inConv, waitFor }) => {
    await publish(roomLine("who owns the Acme deal?", { address: "u-ana", name: "Ana" }));
    await waitFor(async () => (await inConv("mind@sonar")).length === 1);
    const [copy] = await inConv("mind@sonar");
    // whoever writes in the room steers: no roster username, the wire's own sender
    assertEquals(copy.envelope.sender, { address: "u-ana", name: "Ana" });
    assertEquals(copy.agent, { id: "sonar", session_id: "mind" });
    assertEquals(textOf(copy), "who owns the Acme deal?");
    // the agent's own surface hears it by the writer's name; the room, its origin, gets no echo
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(textOf((await inConv("D1"))[0]), "`[Ana via sonar]` who owns the Acme deal?");
    assertEquals((await inConv("sonar")).length, 1);
  });
});

Deno.test("mirror fan-in: a steering room line that names no sender crosses as nothing", async () => {
  await withRoom(async ({ publish, inConv }) => {
    await publish(roomLine("anyone?"));
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await inConv("mind@sonar")).length, 0);
  });
});

Deno.test("mirror fan-out: a room joining the mind, said by the connector that met it, crosses as the harness's word", async () => {
  await withRoom(async ({ publish, inConv, waitFor }) => {
    await publish({
      ts: new Date().toISOString(),
      type: "message",
      envelope: {
        service: "local",
        connection_address: "agent",
        conversation: { address: "mind@sonar" },
      },
      parts: [{
        type: "data",
        kind: "room",
        data: { joined: [{ address: "C9", name: "#sonar" }] },
      }],
    } as Draft<MessageEvent>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertEquals(textOf((await inConv("D1"))[0]), "`[system]` joined #sonar");
  });
});

Deno.test("mirror fan-out: a raw surface gets what the event is — its parts, its kind and step on via", async () => {
  await withRoom(async ({ publish, inConv, waitFor }) => {
    const mind = {
      service: "local" as const,
      connection_address: "agent",
      conversation: { address: "mind@sonar" },
    };
    const use = await publish({
      ts: new Date().toISOString(),
      type: "tool_use",
      payload: { turn_id: "t7" },
      agent: { id: "sonar", session_id: "mind" },
      envelope: mind,
      parts: [{
        type: "data",
        kind: "tool_use",
        data: { name: "bash", input: { command: "sonar batch" } },
      }],
    } as Draft<ToolUseEvent>);
    // a call that went fine says nothing again, on a raw surface as on any other
    await publish({
      ts: new Date().toISOString(),
      type: "tool_result",
      payload: { turn_id: "t7", ref_id: use.id },
      agent: { id: "sonar", session_id: "mind" },
      envelope: mind,
      parts: [{ type: "data", kind: "tool_result", data: { output: "ok", is_error: false } }],
    } as Draft<Event>);
    await publish(mindMsg("Acme is Sol's.", {
      payload: { turn_id: "t8" },
      agent: { id: "sonar", session_id: "mind" },
      envelope: { ...mind, sender: undefined },
    } as Partial<MessageEvent>));

    await waitFor(async () => (await inConv("sonar")).length === 2);
    const [call, voice] = await inConv("sonar");
    // the call as it was made, untruncated, for the dispatcher to render
    assertEquals(call.parts, [{
      type: "data",
      kind: "tool_use",
      data: { name: "bash", input: { command: "sonar batch" } },
    }]);
    assertEquals(call.extra?.via, {
      event: use.id,
      service: "local",
      conversation: "mind@sonar",
      type: "tool_use",
      turn_id: "t7",
    });
    // the voice as its words, no tag
    assertEquals(textOf(voice), "Acme is Sol's.");
    assertEquals((voice.extra?.via as { turn_id?: string }).turn_id, "t8");
    // the tagged surface reads the same crossings as lines
    await waitFor(async () => (await inConv("D1")).length === 2);
    assertEquals(textOf((await inConv("D1"))[0]), "`[agent tool]` **bash**(sonar batch)");
  });
});
