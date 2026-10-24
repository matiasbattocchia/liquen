import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { jsonOf, jsonOfStatus, jsonRecap, parseTailArgs } from "./tail.ts";
import { attach } from "./attach.ts";
import type { Event } from "./types.ts";

const room = {
  service: "local" as const,
  connection_address: "default",
  conversation: { address: "mind@ana" },
};
const self = { id: "ana", session_id: "mind" };

const rows = [
  {
    id: "e1",
    ts: "2026-10-13T15:00:00Z",
    type: "message",
    agent: self,
    envelope: { ...room, sender: { address: "matias", name: "Matías" } },
    parts: [{ type: "text", kind: "text", text: "revisá" }],
  },
  {
    id: "e2",
    ts: "2026-10-13T15:00:02Z",
    type: "tool_use",
    agent: self,
    envelope: room,
    payload: { turn_id: "s1", stop_reason: "tool_use" },
    parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command: "ls" } } }],
  },
  {
    id: "e3",
    ts: "2026-10-13T15:00:03Z",
    type: "tool_result",
    agent: self,
    envelope: room,
    payload: { turn_id: "s1", ref_id: "e2" },
    extra: { exec: { exit_code: 2, duration_ms: 4, bytes: 9 } },
    parts: [{ type: "data", kind: "tool_result", data: { output: "no such", is_error: true } }],
  },
] as Event[];

Deno.test("tail --json: every row carries id, turn_id, type and ts, then its content decoded", () => {
  const usage = {
    created_at: "2026-10-13T15:00:02Z",
    turn_id: "s1",
    kind: "think" as const,
    model: "m",
    input_tokens: 10,
    output_tokens: 2,
  };
  const out = jsonRecap(rows, [usage]);
  assertEquals(out.map((o) => [o.id, o.turn_id, o.type]), [
    ["e1", null, "message"],
    ["e2", "s1", "tool_use"],
    [null, "s1", "usage"], // the step's spend, after the last row the step itself wrote
    ["e3", "s1", "tool_result"],
  ]);
  assertEquals(out[0].from, "Matías");
  assertEquals(out[0].text, "revisá");
  assertEquals(out[1].call, "bash(ls)");
  assertEquals(out[2].input_tokens, 10);
  assertEquals(out[3], {
    id: "e3",
    turn_id: "s1",
    type: "tool_result",
    ts: "2026-10-13T15:00:03Z",
    session: "mind",
    conversation: "mind@ana",
    ref_id: "e2",
    output: "no such",
    is_error: true,
    exec: { exit_code: 2, duration_ms: 4, bytes: 9 },
  });
  // each object is one line: nothing in it breaks one
  for (const o of out) assertEquals(JSON.stringify(o).includes("\n"), false);
  assertEquals(jsonOf(rows[2]).exec, { exit_code: 2, duration_ms: 4, bytes: 9 });
  assertEquals(jsonOfStatus({ status: "idle", after: "e3" }, new Date(0)), {
    id: null,
    turn_id: null,
    type: "status",
    ts: "1970-01-01T00:00:00.000Z",
    status: "idle",
    after: "e3",
  });
});

Deno.test("tail: the flags, and nothing that would speak", () => {
  assertEquals(parseTailArgs([]), { session: "mind", recall: 50, follow: false, json: false });
  assertEquals(parseTailArgs(["--agent", "ana", "-f", "--json", "--recall", "5"]), {
    agent: "ana",
    session: "mind",
    recall: 5,
    follow: true,
    json: true,
  });
  assertThrows(() => parseTailArgs(["hola"]), Error, "unknown argument");
  assertThrows(() => parseTailArgs(["--recall", "0"]), Error, "positive");
});

Deno.test("tail: an observer raises no daemon — nothing running is its answer", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        attach({
          root: dir,
          dir: `${dir}/data`,
          target: "ana",
          username: "ana",
          model: "m",
          effort: null,
          tune: {},
          timezone: "UTC",
          paused: false,
        }, { raise: false }),
      Error,
      "nothing is running for ana",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "liquen log tail --follow --json: it watches a running org through the door, and the org hears nothing from it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { start } = await import("./main.ts");
    const { readConfig } = await import("./config.ts");
    const { scripted, canned } = await import("./testing.ts");
    const root = await Deno.makeTempDir();
    await Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ agents: { ana: {} } }));
    const catalog = await readConfig(root);
    const { transport } = scripted([
      canned([{ kind: "tool_use", name: "search", input: { query: "x" } }], "tool_use", {
        input_tokens: 70,
        output_tokens: 3,
      }),
      canned([{ kind: "assistant", text: "nada" }], "end_turn"),
    ]);
    const main = await start(
      { dir: `${root}/data`, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 },
      { transport },
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("./log.ts", import.meta.url).pathname,
        "tail",
        "--dir",
        root,
        "--agent",
        "ana",
        "--json",
        "-f",
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const got: Record<string, unknown>[] = [];
    const reading = (async () => {
      const lines = child.stdout.pipeThrough(new TextDecoderStream())
        .pipeThrough(new (await import("@std/streams")).TextLineStream());
      for await (const l of lines) if (l.trim()) got.push(JSON.parse(l));
    })();
    const until = async (cond: () => boolean, ms = 8000) => {
      const t0 = Date.now();
      while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
      if (!cond()) throw new Error(`timeout: ${JSON.stringify(got)}`);
    };
    try {
      // the tail is open once the door has it as an attachment
      await until(() => main.attachments() > 0);
      const before = (await main.log.read()).length;
      await main.log.publish({
        ts: new Date().toISOString(),
        type: "message",
        envelope: {
          service: "local",
          connection_address: "default",
          conversation: { address: "mind@ana" },
          sender: { address: "matias", name: "matias" },
        },
        parts: [{ type: "text", kind: "text", text: "buscá" }],
      });
      await until(() => got.some((o) => o.type === "message" && o.stop_reason === "end_turn"));
      const types = got.map((o) => o.type);
      for (const t of ["message", "tool_use", "tool_result", "usage", "status"]) {
        assertEquals(types.includes(t), true, `${t} in ${types}`);
      }
      const usage = got.find((o) => o.type === "usage" && o.input_tokens === 70)!;
      const use = got.find((o) => o.type === "tool_use")!;
      assertEquals(usage.turn_id, use.turn_id);
      assertEquals(types.indexOf("usage") > types.indexOf("tool_use"), true);
      // everything since is the principal's line and the turn's rows: the watcher wrote none
      const rows = (await main.log.read()).slice(before);
      assertEquals(rows.filter((e) => e.payload?.turn_id === undefined).map((e) => e.type), [
        "message",
      ]);
    } finally {
      child.kill("SIGINT");
      await child.status;
      await reading.catch(() => {});
      await child.stderr.cancel();
      await main.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
