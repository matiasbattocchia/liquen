import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Caller,
  createSignIns,
  type FlowCtx,
  type Gate,
  keyOf,
  LOST,
  type SignInFlow,
  type Word,
} from "./signin.ts";
import { openCredentials } from "../store/credentials.ts";
import type { ConnectionRow } from "../store/connections.ts";
import type { Appender } from "../store/log.ts";
import type { Draft, Event, ToolUseEvent } from "../types.ts";
import { newId } from "../store/id.ts";
import { membersAt } from "../testing.ts";
import { socketOf } from "../edge.ts";

/** A link service in miniature: its door answers with the ticket it was handed, and its
 *  link carries the ticket. */
function linkFlow(seen: { gate?: Gate } = {}): SignInFlow {
  return {
    life: () => 60_000,
    prepare: (ask) => Promise.resolve({ scopes: ask.scopes ?? ["openid"] }),
    link: {
      handler: (_ctx, gate) => {
        seen.gate = gate;
        return (req) => Promise.resolve(new Response(new URL(req.url).pathname));
      },
      start: (t) => ({
        link: `https://x.example/svc/oauth/start?ticket=${t.ticket}`,
        loopback: false,
      }),
    },
  };
}

/** A code service in miniature: it says one code, then waits to be told how it ends. */
function codeFlow(ends: PromiseWithResolvers<(gate: Gate, ticket: string) => Promise<void>>) {
  let runs = 0;
  const flow: SignInFlow & { runs: () => number } = {
    runs: () => runs,
    life: () => 60_000,
    prepare: () => Promise.resolve({}),
    async run(t, _ctx, gate) {
      runs++;
      await gate.say(t.ticket, { code: "ABCD", where: "type it there", until: t.deadline });
      const end = await ends.promise;
      await end(gate, t.ticket);
    },
  };
  return flow;
}

async function harness(
  flows: Record<string, SignInFlow>,
  opts: { connections?: ConnectionRow[]; unended?: ToolUseEvent[]; now?: () => number } = {},
) {
  const root = await Deno.makeTempDir();
  await membersAt(`${root}/data`, "ana", "bo");
  const creds = await openCredentials(`${root}/data`, opts.now ? { now: opts.now } : {});
  const published: Event[] = [];
  const declared: string[] = [];
  const ctx: FlowCtx = {
    root,
    creds,
    edge: { publicUrl: null, port: 8787 },
    declare: (service) => {
      declared.push(service);
      return Promise.resolve();
    },
    log: {
      publish: ((e: Draft) => {
        const stored = { ...e, id: e.id ?? newId() } as Event;
        published.push(stored);
        return Promise.resolve(stored);
      }) as Appender["publish"],
      agents: () =>
        Promise.resolve(
          ["ana", "bo"].map((agentId) => ({ agentId, mind: `mind@${agentId}` })),
        ),
      connections: () => Promise.resolve(opts.connections ?? []),
      upsertConnections: () => Promise.resolve(),
      upsertMemberships: () => Promise.resolve(),
      unended: () => Promise.resolve(opts.unended ?? []),
    },
  };
  const signIns = createSignIns(ctx, flows, { sweepMs: 3_600_000, firstWordMs: 2_000, ...opts });
  return {
    root,
    creds,
    published,
    declared,
    signIns,
    async close() {
      await signIns.close();
      await creds.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

const caller = (id: string): Caller => ({
  agentId: "ana",
  sessionId: "mind",
  use: { id, turn_id: "turn-1" },
  call: "connect(service: svc)",
});

/** The outcome a caller's update carries. */
const updates = (published: Event[]) =>
  published.filter((e) => e.type === "tool_result").map((e) => ({
    ref: e.payload?.ref_id,
    final: e.payload?.final,
    output: (e.parts[0] as { data: { output: string } }).data.output,
  }));

Deno.test("keyOf: the account when known before the sign-in, else whom the grant is for", () => {
  assertEquals(keyOf({ service: "google", agent: "ana" }), "agent:ana");
  assertEquals(keyOf({ service: "google" }), "org");
  assertEquals(
    keyOf({ service: "google", agent: "ana", account: "Ana@Example.com" }),
    "account:ana@example.com",
  );
  // a pairing code knows its number: a reconnect and a new pairing of it share the key
  assertEquals(
    keyOf({ service: "whatsapp", agent: "ana", pair: "+54 9 11 0000" }),
    "account:549110000",
  );
  assertEquals(keyOf({ service: "whatsapp", account: "549110000" }), "account:549110000");
});

Deno.test("open: a link sign-in serves its door, and a second ask gets the same link back", async () => {
  const h = await harness({ svc: linkFlow() });
  try {
    const heard: Word[] = [];
    const first = await h.signIns.open(
      { service: "svc", agent: "ana", caller: caller("u1") },
      (w) => heard.push(w),
    );
    if (!("link" in first)) throw new Error("a link");
    assertEquals(heard, [first]); // the listener hears the first word too
    const again = await h.signIns.open({ service: "svc", agent: "ana", caller: caller("u2") });
    assertEquals(again, first);
    const other = await h.signIns.open({ service: "svc", agent: "bo" });
    if (!("link" in other)) throw new Error("a link");
    assertEquals(other.link === first.link, false); // bo's is his own
    // the door answers on the service's oauth socket
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketOf(h.root, "svc", "oauth") },
    });
    try {
      const res = await fetch("http://x/svc/oauth/start", { client });
      assertEquals(await res.text(), "/svc/oauth/start");
    } finally {
      client.close();
    }
    // both calls wait on the one ticket
    const [t] = (await h.creds.tickets()).filter((t) => t.agentId === "ana");
    assertEquals((t.extra.callers as Caller[]).map((c) => c.use.id), ["u1", "u2"]);
  } finally {
    await h.close();
  }
});

Deno.test("judge: the account lands once; every caller and listener hears it, final", async () => {
  const seen: { gate?: Gate } = {};
  const h = await harness({ svc: linkFlow(seen) });
  try {
    const heard: Word[] = [];
    await h.signIns.open(
      { service: "svc", agent: "ana", caller: caller("u1") },
      (w) => heard.push(w),
    );
    await h.signIns.open({ service: "svc", agent: "ana", caller: caller("u2") });
    const [t] = await h.creds.tickets();
    assertEquals(await seen.gate!.judge(t.ticket, { address: "ana@example.com" }), {
      agent: "ana",
    });
    // the first callback settled it: a second one is refused
    assertEquals(await seen.gate!.judge(t.ticket, { address: "ana@example.com" }), {
      refused: "this sign-in is over: ask for a new one",
    });
    await seen.gate!.landed(t.ticket, "ana@example.com", ["calendar"]);
    await seen.gate!.landed(t.ticket, "ana@example.com"); // told once
    assertEquals(updates(h.published), [
      {
        ref: "u1",
        final: true,
        output: "signed in: svc ana@example.com, without calendar: the calls that need them " +
          "are refused",
      },
      {
        ref: "u2",
        final: true,
        output: "signed in: svc ana@example.com, without calendar: the calls that need them " +
          "are refused",
      },
    ]);
    assertEquals(heard.at(-1), { landed: "ana@example.com", missing: ["calendar"] });
    assertEquals(h.declared, ["svc"]);
    assertEquals(await h.creds.tickets(), []);
  } finally {
    await h.close();
  }
});

Deno.test("judge: a reconnect is pinned, a grant for another matches their handle", async () => {
  const seen: { gate?: Gate } = {};
  const h = await harness({ svc: linkFlow(seen) });
  try {
    await h.signIns.open({ service: "svc", agent: "ana", account: "ana@example.com" });
    await h.signIns.open({ service: "svc", agent: "bo", email: "bo@example.com" });
    const tickets = await h.creds.tickets();
    const pinned = tickets.find((t) => t.agentId === "ana")!;
    const matched = tickets.find((t) => t.agentId === "bo")!;
    const refused = await seen.gate!.judge(pinned.ticket, { address: "eve@example.com" });
    assertStringIncludes(
      (refused as { refused: string }).refused,
      "signed in as eve@example.com, and this sign-in was for ana@example.com",
    );
    const wrong = await seen.gate!.judge(matched.ticket, { address: "eve@example.com" });
    assertStringIncludes((wrong as { refused: string }).refused, "which is not bo's");
    // each refusal is the sign-in's end
    assertEquals(await h.creds.tickets(), []);
  } finally {
    await h.close();
  }
});

Deno.test("judge: an account someone else holds, or a shared one, is never taken over", async () => {
  const seen: { gate?: Gate } = {};
  const h = await harness({ svc: linkFlow(seen) }, {
    connections: [
      { service: "svc", address: "bo@example.com", agentId: "bo" },
      { service: "svc", address: "team@example.com", credentialKey: "svc:team" },
      { service: "svc", address: "ana@example.com", agentId: "ana" },
    ],
  });
  try {
    const judge = async (address: string) => {
      await h.signIns.open({ service: "svc", agent: "ana" });
      const [t] = await h.creds.tickets();
      return await seen.gate!.judge(t.ticket, { address });
    };
    assertEquals(await judge("bo@example.com"), {
      refused: "bo@example.com is bo's: nothing was connected",
    });
    assertEquals(await judge("team@example.com"), {
      refused: "team@example.com is shared: nothing was connected",
    });
    assertEquals(await judge("ana@example.com"), { agent: "ana" }); // her own, again
  } finally {
    await h.close();
  }
});

Deno.test("sweep: a sign-in past its deadline lapses, and its caller is told", async () => {
  let skew = 0;
  const h = await harness({ svc: linkFlow() }, { now: () => Date.now() + skew });
  try {
    await h.signIns.open({ service: "svc", agent: "ana", caller: caller("u1") });
    skew = 61_000;
    await h.signIns.open({ service: "svc", agent: "bo" }); // every open sweeps first
    assertEquals(updates(h.published), [
      { ref: "u1", final: true, output: "not signed in: it lapsed unused" },
    ]);
    assertEquals((await h.creds.tickets()).map((t) => t.agentId), ["bo"]);
  } finally {
    await h.close();
  }
});

Deno.test("a code sign-in answers with its first code; a joiner gets the same one", async () => {
  const ends = Promise.withResolvers<(gate: Gate, ticket: string) => Promise<void>>();
  const flow = codeFlow(ends);
  const h = await harness({ code: flow });
  try {
    const heard: Word[] = [];
    const first = await h.signIns.open(
      { service: "code", agent: "ana", caller: caller("u1") },
      (w) => heard.push(w),
    );
    assertEquals("code" in first && first.code, "ABCD");
    const again = await h.signIns.open({ service: "code", agent: "ana" });
    assertEquals(again, first);
    assertEquals(flow.runs(), 1); // one poll for both
    ends.resolve(async (gate, ticket) => {
      const v = await gate.judge(ticket, { address: "5491100000000" });
      if (!("refused" in v)) await gate.landed(ticket, "5491100000000");
    });
    for (let i = 0; i < 50 && !heard.some((w) => "landed" in w); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(heard, [first, { landed: "5491100000000" }]);
    assertEquals(updates(h.published)[0].output, "signed in: code 5491100000000");
  } finally {
    await h.close();
  }
});

Deno.test("a code sign-in that fails before its first code refuses the ask", async () => {
  const flow: SignInFlow = {
    life: () => 60_000,
    prepare: () => Promise.resolve({}),
    run: () => Promise.reject(new Error("bridge /sessions HTTP 500: down")),
  };
  const h = await harness({ code: flow });
  try {
    await assertRejects(
      () => h.signIns.open({ service: "code", agent: "ana" }),
      Error,
      "bridge /sessions HTTP 500",
    );
    assertEquals(await h.creds.tickets(), []);
  } finally {
    await h.close();
  }
});

Deno.test("open: a service with no flow is refused, naming the CLI", async () => {
  const h = await harness({});
  try {
    await assertRejects(
      () => h.signIns.open({ service: "telegram", agent: "ana" }),
      Error,
      "`liquen connect telegram`",
    );
  } finally {
    await h.close();
  }
});

Deno.test("open: a grant for a name off the roster is refused in a sentence", async () => {
  const h = await harness({ svc: linkFlow() });
  try {
    await assertRejects(
      () => h.signIns.open({ service: "svc", agent: "eve" }),
      Error,
      'no agent "eve"',
    );
    assertEquals(await h.creds.tickets(), []);
  } finally {
    await h.close();
  }
});

Deno.test("resume: open tickets are served again; a call left with no ticket is told lost", async () => {
  const use = {
    id: "u-gone",
    type: "tool_use",
    agent: { id: "ana", session_id: "mind" },
    payload: { turn_id: "turn-0" },
  } as unknown as ToolUseEvent;
  const h = await harness({ svc: linkFlow() }, { unended: [use] });
  try {
    await h.creds.openTicket({
      service: "svc",
      key: "agent:ana",
      agentId: "ana",
      extra: {},
      deadline: Date.now() + 60_000,
    });
    await h.signIns.resume();
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketOf(h.root, "svc", "oauth") },
    });
    try {
      assertEquals((await fetch("http://x/svc/oauth/start", { client })).status, 200);
    } finally {
      client.close();
    }
    assertEquals(updates(h.published), [{ ref: "u-gone", final: true, output: LOST }]);
  } finally {
    await h.close();
  }
});
