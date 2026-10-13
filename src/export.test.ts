import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { exportTurn, findTurn } from "./export.ts";
import { openLog } from "./store/log.ts";
import { shortId } from "./render.ts";
import type { Turn } from "./turns.ts";
import type { Draft, Event } from "./types.ts";

const self = { id: "ana", session_id: "mind" };
const room = {
  service: "local" as const,
  connection_address: "agent",
  conversation: { address: "mind@ana" },
};
let t = Date.parse("2026-10-13T15:00:00Z");
const ts = () => new Date(t += 1000).toISOString();

Deno.test("export: one turn as a transcript — thinking, words, each call's full output and facts, spend, the checkpoint over it", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  const put = async (d: Partial<Event>) =>
    (await log.publish({ ts: ts(), envelope: room, ...d } as Draft))!;
  try {
    const hi = await put({
      type: "message",
      agent: self,
      envelope: { ...room, sender: { address: "matias", name: "matias" } },
      parts: [{ type: "text", kind: "text", text: "listá" }],
    });
    await put({
      type: "thinking",
      agent: self,
      payload: { turn_id: "s1" },
      extra: { consumed: hi.id },
      parts: [{
        type: "data",
        kind: "thinking",
        data: { thinking: "**Listing**\n\nfirst ls", signature: "x" },
      }],
    });
    const use = await put({
      type: "tool_use",
      agent: self,
      payload: { turn_id: "s1", stop_reason: "tool_use" },
      parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command: "ls" } } }],
    });
    // an output that carries a fence of its own stays inside one
    const output = "a.txt\n```\nb.txt";
    await put({
      type: "tool_result",
      agent: self,
      payload: { turn_id: "s1", ref_id: use.id },
      extra: { exec: { exit_code: 0, duration_ms: 12, bytes: 2048 } },
      parts: [{ type: "data", kind: "tool_result", data: { output } }],
    });
    const closing = await put({
      type: "message",
      agent: self,
      payload: { turn_id: "s2", stop_reason: "end_turn" },
      extra: { consumed: use.id },
      parts: [{ type: "text", kind: "text", text: "# Done\n\ntwo files" }],
    });
    await put({
      type: "summary",
      agent: self,
      payload: { turn_id: "c1", covers: [hi.id, use.id] },
      parts: [{ type: "text", kind: "text", text: "## Open\n- nothing" }],
    });
    for (const [turn, input] of [["s1", 100], ["s2", 30], ["c1", 7]] as const) {
      await log.meter({
        created_at: ts(),
        agent_id: "ana",
        turn_id: turn,
        kind: turn === "c1" ? "checkpoint" : "think",
        model: "m",
        input_tokens: input,
        output_tokens: 1,
      });
    }
    const doc = await exportTurn(log, { agentId: "ana", id: "mind" }, "last");
    for (
      const part of [
        `# Turn ${shortId("s1")} — mind@ana`,
        'opened by** message from matias "listá"',
        "**2 steps** · 1 call · 0 tool errors",
        "**tokens** 130 in · 2 out",
        "## Step 1 · ",
        "100 in / 1 out",
        "> **Listing**\n>\n> first ls",
        "### ⚙ bash(ls)",
        "ok · exit 0 · 12 ms · 2.0 kB",
        "````text\na.txt\n```\nb.txt\n````",
        "## Step 2 · ",
        "### Done\n\ntwo files", // the model's heading sits under the document's
        "## Checkpoint ",
        "### Open\n- nothing",
      ]
    ) assertStringIncludes(doc, part);
    assert(doc.indexOf("listá") < doc.indexOf("## Step 1"));
    // the same turn by its handle, a step's, or a row inside it
    for (const key of [closing.id, shortId("s2"), "s1"]) {
      assertEquals(await exportTurn(log, { agentId: "ana", id: "mind" }, key), doc);
    }
    await assertRejects(
      () => exportTurn(log, { agentId: "ana", id: "mind" }, "nope"),
      Error,
      "liquen turns",
    );
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findTurn: by handle, by a step, by a row's id within the span, or the last", () => {
  const turn = (id: string, steps: string[], from: string, to: string) =>
    ({ id, steps, span: { from, to } }) as unknown as Turn;
  const turns = [turn("t1", ["t1", "t2"], "e01", "e09"), turn("t3", ["t3"], "e10", "e19")];
  assertEquals(findTurn(turns, "last")?.id, "t3");
  assertEquals(findTurn(turns, "t2")?.id, "t1");
  assertEquals(findTurn(turns, "e05")?.id, "t1");
  assertEquals(findTurn(turns, "e15")?.id, "t3");
  assertEquals(findTurn(turns, "zz"), undefined);
});
