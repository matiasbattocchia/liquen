import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMirror } from "./mirror.ts";
import { words } from "../i18n.ts";
import { SILENCE } from "../render.ts";
import { parseVerdict } from "../xi.ts";
import { openLog } from "../store/log.ts";
import type { Draft, Event, MessageEvent, ToolUseEvent } from "../types.ts";
import type { Connections } from "../store/connections.ts";

/** A live org with two alias surfaces bound to `ana`: the Slack self-DM `D1` (grant
 *  `T1:U1`) and the WA self-chat `549` (paired own number). The mirror under test rides a
 *  REAL log — the upsert/absorb machinery is half the contract. */
async function withMirror(
  fn: (t: {
    publish: (e: Draft<Event>) => Promise<Event>;
    inConv: (conversation: string) => Promise<MessageEvent[]>;
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
    { service: "slack", address: "T1:U1", agentId: "ana", extra: { self_conversation: "D1" } },
    { service: "whatsapp", address: "549", agentId: "ana" }, // WA binding is DERIVED (§4)
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
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

Deno.test("mirror fan-out: a line that answers a card quotes the card's crossing, its handle said by the quote", async () => {
  await withMirror(async ({ publish, inConv, waitFor, setDelivery }) => {
    const card = await publish(sendCard());
    await waitFor(async () =>
      (await inConv("D1")).length === 1 && (await inConv("549")).length === 1
    );
    // the dispatchers stamp what they posted
    for (const [conv, id] of [["D1", "slack:T1:D1:200.1"], ["549", "whatsapp:wmw.card"]]) {
      const [cc] = await inConv(conv);
      await setDelivery(cc.id, { external_id: id });
    }
    await publish(mindMsg("/n bbc24a not today", { payload: { ref_id: card.id } }));
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
    // the copy of a thumb given on Slack: an `add` naming the card
    await publish(mindMsg("", {
      payload: { ref_id: card.id, action: "add" },
      parts: [{ type: "data", kind: "reaction", data: { unicode: "👍" } }],
      extra: { via: { event: "x", service: "slack", conversation: "D1" } },
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

Deno.test("mirror fan-in: a quoted CC is TRANSLATED — the copy's ref_id names the mind event (§9)", async () => {
  await withMirror(async ({ publish, inConv, setDelivery, waitFor }) => {
    // a card crosses to the self-DM and its CC gets claimed by the dispatcher
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
    // conversation (policy §6), so the mirror is where the quote becomes a liquen-side ref
    await waitFor(async () =>
      (await inConv("mind@ana")).some((e) => e.payload?.ref_external_id !== undefined)
    );
    const copy = (await inConv("mind@ana")).find((e) => e.payload?.ref_external_id)!;
    assertEquals(copy.payload?.ref_id, (cc.extra?.via as { event: string }).event);
    assertEquals(copy.payload?.ref_external_id, "slack:T1:D1:666.6");
    // …while the unquoted /y keeps plain provenance
    const bare = (await inConv("mind@ana")).find((e) => !e.payload?.ref_external_id)!;
    assertEquals(bare.payload?.ref_id, reply.id);

    // a reaction on the card is the same join with its action kept: an `add` naming the
    // card is what the gate reads as a thumb ON the card (§9), an un-react is a `remove`
    await publish({
      ...aliasInbound("", { external_id: "slack:T1:D1:999.9" }),
      payload: { ref_external_id: "slack:T1:D1:666.6", action: "add" },
      parts: [{ type: "data", kind: "reaction", data: { name: "+1" } }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("mind@ana")).some((e) => e.payload?.action === "add"));
    const thumb = (await inConv("mind@ana")).find((e) => e.payload?.action === "add")!;
    assertEquals(thumb.payload?.ref_id, (cc.extra?.via as { event: string }).event);
    assertEquals(thumb.parts, [{ type: "data", kind: "reaction", data: { name: "+1" } }]);
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
        data: { error: "2 approvals are waiting — reply TO the one you mean" },
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("D1")).length === 1);
    assertStringIncludes(textOf((await inConv("D1"))[0]), "`[system]` 2 approvals are waiting");
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
      payload: { ref_id: card.payload!.ref_id!, turn_id: "t1", deferred: true },
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

Deno.test("mirror fan-out: a /cancel crosses as the principal's line, the cut turn as the system's", async () => {
  await withMirror(async ({ publish, inConv, waitFor }) => {
    const env = {
      service: "local",
      connection_address: "agent",
      conversation: { address: "mind@ana" },
    };
    await publish({
      ts: new Date().toISOString(),
      type: "control",
      payload: { control: "cancel" },
      agent: { id: "ana", session_id: "mind" },
      envelope: { ...env, sender: { address: "ana", name: "ana" } },
      parts: [{ type: "text", kind: "text", text: "/cancel" }],
    } as Draft<Event>);
    await publish({
      ts: new Date().toISOString(),
      type: "control",
      payload: { control: "cancelled" },
      envelope: env,
      parts: [{
        type: "text",
        kind: "text",
        text: "cancelled by your principal — the turn stopped here",
      }],
    } as Draft<Event>);
    await waitFor(async () => (await inConv("549")).length === 2);
    assertEquals((await inConv("549")).map(textOf), [
      "`[via terminal]` /cancel",
      "`[system]` cancelled by your principal — the turn stopped here",
    ]);
  });
});

Deno.test("mirror fan-out: a wake, a failure and a cut turn cross as `[system]`; a checkpoint does not", async () => {
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
        { ref_id: "u3", turn_id: "t2", deferred: true },
      ); // …an approved one included: the card asked for it, the `/y` gave it
      await harness("tool_result", [{
        type: "data",
        kind: "tool_result",
        text: "send(to: Vivian)",
        data: { output: "the bridge is down", is_error: true },
      }], { ref_id: "u4", turn_id: "t2", deferred: true });
      await harness(
        "control",
        [{
          type: "text",
          kind: "text",
          text: "cancelled by your principal — the turn stopped here",
        }],
        { control: "cancelled" },
      );
      await waitFor(async () => (await inConv("549")).length === 4);
      assertEquals((await inConv("549")).map(textOf), [
        "`[sistema]` ⏰ recordarle a Mecha el mail",
        "`[sistema]` ✗ Command exited with code 1",
        "`[sistema]` ✗ send(to: Vivian) — the bridge is down",
        "`[sistema]` cancelled by your principal — the turn stopped here",
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

Deno.test("mirror fan-in: a principal's DM with the org number copies to the org agent's mind, signed by the roster (§4)", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.syncAgents([
    { agentId: "matias", mind: "mind@matias", name: "Matías", phone: "549115550001" },
    { agentId: "sol", mind: "mind@sol", name: "Sol", phone: "549115550002", runs: false },
    { agentId: "ventas", mind: "mind@ventas", name: "Ventas", phone: "549117770000" },
  ]);
  await log.upsertConnections([
    { service: "whatsapp", address: "549117770000", credentialKey: "whatsapp:549117770000" },
  ]);
  const stop = createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
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
    assertEquals((await inConv("549117770000")).length, 0); // the org number has no self-chat surface
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
