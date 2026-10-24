import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  callRows,
  dayOf,
  errorGroups,
  isWrite,
  parseWhen,
  sessionOfRow,
  sessionsOfSteps,
  signatureOf,
  spendGroups,
  turnsOfRequests,
} from "./views.ts";
import { parseLogArgs } from "./log.ts";
import { exportSessions, sessionsIn } from "./export.ts";
import { changedInputs, inputsOf } from "./inputs.ts";
import { openLog } from "./store/log.ts";
import { turnsOf } from "./turns.ts";
import type { Draft, ErrorEvent, Event, ToolResultEvent, ToolUseEvent } from "./types.ts";
import type { Turn } from "./turns.ts";

const self = { id: "ana", session_id: "mind" };
const room = {
  service: "local" as const,
  connection_address: "default",
  conversation: { address: "mind@ana" },
};

const use = (id: string, step: string, command: string, ts = "2026-10-19T09:00:00.000Z") =>
  ({
    id,
    ts,
    type: "tool_use",
    agent: self,
    envelope: room,
    payload: { turn_id: step },
    parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command } } }],
  }) as unknown as ToolUseEvent;

const result = (
  id: string,
  of: string,
  step: string,
  output: string,
  flags: { is_error?: boolean; refused?: boolean } = {},
  ts = "2026-10-19T09:00:01.000Z",
) =>
  ({
    id,
    ts,
    type: "tool_result",
    agent: self,
    envelope: room,
    payload: { turn_id: step, ref_id: of },
    extra: { exec: { exit_code: flags.is_error ? 1 : 0, duration_ms: 1, bytes: 1 } },
    parts: [{ type: "data", kind: "tool_result", data: { output, ...flags } }],
  }) as unknown as ToolResultEvent;

Deno.test("a time is an age, a day or a time on the org's clock, or an instant with its zone", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assertEquals(parseWhen("30m", "UTC", now), "2026-10-19T11:30:00.000Z");
  assertEquals(parseWhen("3d", "UTC", now), "2026-10-16T12:00:00.000Z");
  // the org's midnight, not UTC's: Los Angeles runs seven hours behind in October
  assertEquals(parseWhen("2026-10-19", "America/Los_Angeles", now), "2026-10-19T07:00:00.000Z");
  assertEquals(
    parseWhen("2026-10-19T09:30", "America/Los_Angeles", now),
    "2026-10-19T16:30:00.000Z",
  );
  assertEquals(parseWhen("2026-10-19T09:30:00-03:00", "UTC", now), "2026-10-19T12:30:00.000Z");
  assertThrows(() => parseWhen("yesterday", "UTC", now), Error, "not a time");
  assertEquals(dayOf("2026-10-19T05:00:00Z", "America/Los_Angeles"), "2026-10-18");
});

Deno.test("a view takes the shared filters and its own flags, and refuses another view's", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const a = parseLogArgs(
    "errors",
    ["--kind", "tool", "--since", "1d", "--agent", "ana"],
    "UTC",
    now,
  );
  assertEquals([a.kind, a.since, a.agent], ["tool", "2026-10-18T12:00:00.000Z", "ana"]);
  assertEquals(parseLogArgs("spend", ["--by", "model"], "UTC").by, "model");
  assertEquals(parseLogArgs("export", ["--jsonl"], "UTC").format, "jsonl");
  assertThrows(
    () => parseLogArgs("turns", ["--kind", "tool"], "UTC"),
    Error,
    "unknown argument --kind",
  );
  assertThrows(() => parseLogArgs("errors", ["--kind", "nope"], "UTC"), Error, "--kind is one of");
  assertThrows(() => parseLogArgs("spend", ["--by", "week"], "UTC"), Error, "--by is one of");
  assertThrows(() => parseLogArgs("logs", [], "UTC"), Error, 'no view "logs"');
  assertThrows(
    () => parseLogArgs("turns", ["--since", "1h", "--until", "2h"], "UTC", now),
    Error,
    "--since comes before --until",
  );
});

Deno.test("errors group by message with what varies masked, the most frequent first", () => {
  const uses = [
    use("u1", "s1", "sonar ask a"),
    use("u2", "s2", "sonar ask b"),
    use("u3", "s3", "ls"),
  ];
  const refusal = (tenant: string) =>
    `sonar: POST /messages for tenant ${tenant} failed: 400 missing "kind"\n\nCommand exited with code 1`;
  const results = [
    result("r1", "u1", "s1", refusal("744acc65-4298-4c65-a3ff-8bfa0b1df522"), { is_error: true }),
    result("r2", "u2", "s2", refusal("91daed41-0000-4000-8000-000000000000"), { is_error: true }),
    result("r3", "u3", "s3", "lapsed", { is_error: true, refused: true }), // a refusal is no error
  ];
  const errors = [{
    id: "e1",
    ts: "2026-10-19T09:00:02.000Z",
    type: "error",
    envelope: room,
    parts: [{ type: "data", kind: "error", data: { error: "429 quota", origin: "model" } }],
  }, {
    id: "e2",
    ts: "2026-10-19T09:00:03.000Z",
    type: "error",
    envelope: room,
    parts: [{ type: "data", kind: "error", data: { error: "checkpoint failed: empty" } }],
  }] as unknown as ErrorEvent[];
  const requests = [
    {
      created_at: "2026-10-19T09:00:04Z",
      method: "GET",
      host: "h",
      path: "/drafts",
      status: 404,
      swapped: true,
    },
    {
      created_at: "2026-10-19T09:00:05Z",
      method: "GET",
      host: "h",
      path: "/ok",
      status: 200,
      swapped: true,
    },
  ];
  const groups = errorGroups({ uses, results, errors, requests });
  assertEquals(groups.map((g) => [g.kind, g.count]), [
    ["tool", 2],
    ["proxy", 1], // a tie: the most recent first
    ["system", 1],
    ["provider", 1],
  ]);
  assertEquals(
    groups[0].signature,
    'bash: sonar: POST /messages for tenant ‹id› failed: 400 missing "kind"',
  );
  assertEquals(groups[0].steps, ["s1", "s2"]);
  assertEquals(groups[1].signature, "GET h/drafts → 404");
  assertEquals(signatureOf("job 1234567 at 00ff00ff00ff00"), "job ‹n› at ‹id›");
  assertEquals(signatureOf("exit 400 after 12 tries"), "exit 400 after 12 tries");
});

Deno.test("a call's outcome is its latest result; one with none is pending", () => {
  const calls = callRows(
    [use("u1", "s1", "sonar batch"), use("u2", "s1", "sleep 99"), use("u3", "s2", "false")],
    [
      result("r1", "u1", "s1", "<batch/>"),
      result("r2", "u2", "s1", "still running"),
      result("r2b", "u2", "s1", "killed\n\nCommand exited with code 137", { is_error: true }),
    ],
  );
  assertEquals(calls.map((c) => c.outcome), ["ok", "error", "pending"]);
  assertEquals(calls[1].said, "killed");
  assertEquals(calls[1].exit_code, 1);
  assertEquals(calls[0].call, "bash(sonar batch)");
  assertEquals([calls[0].agent, calls[0].session], ["ana", "mind"]);
});

Deno.test("a request is matched to the turn of its agent whose span holds it", () => {
  const turn = (id: string, started: string, ended: string) =>
    ({ id, agent: "ana", started, ended }) as Turn;
  const turns = [turn("t1", "2026-10-19T09:00:00Z", "2026-10-19T09:01:00Z")];
  const q = (at: string, agent?: string) => ({
    created_at: at,
    ...(agent ? { agent_id: agent } : {}),
    method: "PUT",
    host: "h",
    path: "/x",
    status: 200,
    swapped: true,
  });
  assertEquals(
    turnsOfRequests([
      q("2026-10-19T09:00:30Z", "ana"),
      q("2026-10-19T09:02:00Z", "ana"),
      q("2026-10-19T09:00:30Z"),
    ], turns),
    ["t1", undefined, undefined],
  );
  assert(isWrite(q("x")));
  assert(!isWrite({ ...q("x"), method: "CONNECT" }));
});

Deno.test("spend sums per key and prices each call at its day's rate", () => {
  const row = (at: string, model: string, input: number) => ({
    created_at: at,
    agent_id: "ana",
    turn_id: "s1",
    model,
    input_tokens: input,
    output_tokens: 0,
  });
  const prices = [{ model: "m", valid_since: "2026-10-01", input: 1, output: 1 }];
  const groups = spendGroups(
    [
      row("2026-10-18T10:00:00Z", "m", 1_000_000),
      row("2026-10-19T10:00:00Z", "m", 2_000_000),
      row("2026-10-19T11:00:00Z", "x", 5),
    ],
    (r) => dayOf(r.created_at, "UTC"),
    prices,
  );
  assertEquals(groups.map((g) => [g.key, g.calls, g.input, g.cost.usd, g.cost.unpriced]), [
    ["2026-10-18", 1, 1_000_000, 1, 0],
    ["2026-10-19", 2, 2_000_005, 2, 1],
  ]);
});

Deno.test("a row's session is its author's, or the session room a harness row was written in", () => {
  assertEquals(sessionOfRow(use("u1", "s1", "ls")), { agent: "ana", session: "mind" });
  assertEquals(
    sessionOfRow({ envelope: { conversation: { address: "bd@sonar" } } } as unknown as Event),
    {
      agent: "sonar",
      session: "bd",
    },
  );
  assertEquals(sessionsOfSteps([use("u1", "s1", "ls")]).get("s1"), "mind@ana");
});

Deno.test("inputs: a hash per doc, tool, program file and setting; a change names what changed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/bin/cli`, { recursive: true });
    await Deno.writeTextFile(`${dir}/bin/sonar`, "#!/bin/sh");
    await Deno.writeTextFile(`${dir}/bin/cli/api.ts`, "v1");
    const header = (name: string, kind = "instruction") => ({
      scope: "shared" as const,
      kind: kind as "instruction",
      name,
      load: "lazy" as const,
      handle: name,
    });
    const docs = [
      { header: header("instructions/sonar"), body: "rules" },
      { header: header("skills/deals") },
      { header: header("memories/notes", "memory"), body: "today" },
    ];
    const read = () => Promise.resolve("skill body");
    const before = await inputsOf({
      docs,
      read,
      tools: [{ name: "bash" }],
      bins: [{ dir: `${dir}/bin`, programs: [{ name: "sonar" }] }],
      settings: { model: "m" },
      version: "0.1.61",
    });
    assertEquals(Object.keys(before).sort(), [
      "bin/cli/api.ts",
      "bin/sonar",
      "config",
      "liquen",
      "shared/instructions/sonar",
      "shared/skills/deals",
      "tool/bash",
    ]);
    await Deno.writeTextFile(`${dir}/bin/cli/api.ts`, "v2");
    const after = await inputsOf({
      docs,
      read,
      tools: [{ name: "bash" }],
      bins: [{ dir: `${dir}/bin`, programs: [{ name: "sonar" }] }],
      settings: { model: "n" },
      version: "0.1.61",
    });
    assertEquals(changedInputs(before, after), ["bin/cli/api.ts", "config"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("turns: a turn whose stamp differs from the one before names what changed", () => {
  const ref = { agentId: "ana", id: "mind" };
  const rows: Event[] = [];
  let n = 0;
  const id = () => `0000000${String(++n).padStart(2, "0")}`;
  const step = (turn: string, inputs?: Record<string, string>) => {
    rows.push({
      id: id(),
      ts: `2026-10-19T09:00:${String(n).padStart(2, "0")}.000Z`,
      type: "message",
      agent: self,
      envelope: room,
      payload: { turn_id: turn, stop_reason: "end_turn" },
      ...(inputs ? { extra: { inputs } } : {}),
      parts: [{ type: "text", kind: "text", text: "ok" }],
    } as unknown as Event);
  };
  step("s1", { a: "1", b: "1" });
  step("s2");
  step("s3", { a: "1", b: "2" });
  const turns = turnsOf(rows, ref);
  assertEquals(turns.map((t) => t.changed), [undefined, undefined, ["b"]]);
});

Deno.test("export: every session in the log, turn by turn, as markdown or JSON lines", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  let t = Date.parse("2026-10-19T09:00:00Z");
  const ts = () => new Date(t += 1000).toISOString();
  const put = async (d: Partial<Event>) =>
    (await log.publish({ ts: ts(), envelope: room, ...d } as Draft))!;
  try {
    for (const [session, said] of [["mind", "one"], ["bd", "two"]]) {
      const here = { ...room, conversation: { address: `${session}@ana` } };
      const hi = await put({
        type: "message",
        envelope: { ...here, sender: { address: "matias", name: "matias" } },
        parts: [{ type: "text", kind: "text", text: `hola ${session}` }],
      });
      await put({
        type: "message",
        agent: { id: "ana", session_id: session },
        envelope: here,
        payload: { turn_id: `step-${session}`, stop_reason: "end_turn" },
        extra: { consumed: hi.id },
        parts: [{ type: "text", kind: "text", text: said }],
      });
      await log.meter({
        created_at: ts(),
        agent_id: "ana",
        turn_id: `step-${session}`,
        model: "gemini-3.8-flash",
        input_tokens: 1000,
        output_tokens: 10,
      });
    }
    const all = await log.read({});
    const sessions = sessionsIn(all, ["ana"]);
    assertEquals(sessions.map((s) => s.id), ["mind", "bd"]);
    const md = (await Array.fromAsync(exportSessions(log, sessions, { format: "md", rows: all })))
      .join("");
    assertStringIncludes(md, "# Turn");
    assertStringIncludes(md, "mind@ana");
    assertStringIncludes(md, "bd@ana");
    assertStringIncludes(md, "\n---\n");
    const only = (await Array.fromAsync(
      exportSessions(log, sessions, { format: "md", rows: all, scope: { match: "TWO" } }),
    )).join("");
    assert(!only.includes("mind@ana"), "a match keeps only the turns that hold it");
    const lines =
      (await Array.fromAsync(exportSessions(log, sessions, { format: "jsonl", rows: all })))
        .join("").trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(new Set(lines.map((l) => l.session)), new Set(["mind", "bd"]));
    assert(lines.some((l) => l.type === "usage"), "a metered call is a line of its own");
    assert(lines.every((l) => typeof l.turn === "string"));
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
