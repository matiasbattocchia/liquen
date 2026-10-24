import { assertEquals } from "@std/assert";
import { statusOf } from "./status.ts";
import { openLog } from "../store/log.ts";
import { openCredentials } from "../store/credentials.ts";
import type { Draft } from "../types.ts";

const room = {
  service: "local" as const,
  connection_address: "default",
  conversation: { address: "mind@ana" },
};
const self = { id: "ana", session_id: "mind" };

Deno.test("status --json: the org's facts, and each agent's turns — running, the last one's end, the next wake, the last error", async () => {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  const at = (s: number) => new Date(Date.parse("2026-10-13T15:00:00Z") + s * 1000).toISOString();
  const put = async (d: Partial<Draft>) => (await log.publish({ envelope: room, ...d } as Draft))!;
  try {
    await log.syncAgents([{ agentId: "ana", mind: "mind@ana" }]);
    await creds.put({ key: "slack:T1", value: { token: "xoxb-secret", team: "T1" } });
    const hi = await put({
      ts: at(0),
      type: "message",
      agent: self,
      envelope: { ...room, sender: { address: "matias", name: "matias" } },
      parts: [{ type: "text", kind: "text", text: "hola" }],
    });
    await put({
      ts: at(2),
      type: "message",
      agent: self,
      payload: { turn_id: "t1", stop_reason: "end_turn" },
      extra: { consumed: hi.id },
      parts: [{ type: "text", kind: "text", text: "hola!" }],
    });
    await put({
      ts: at(3),
      type: "error",
      parts: [{ type: "data", kind: "error", data: { error: "overloaded" } }],
    });
    const again = await put({
      ts: at(10),
      type: "message",
      agent: self,
      envelope: { ...room, sender: { address: "matias", name: "matias" } },
      parts: [{ type: "text", kind: "text", text: "y?" }],
    });
    await put({
      ts: at(12),
      type: "tool_use",
      agent: self,
      payload: { turn_id: "t2", stop_reason: "tool_use" },
      extra: { consumed: again.id },
      parts: [{ type: "data", kind: "tool_use", data: { name: "bash", input: { command: "ls" } } }],
    });
    await log.arm({
      agentId: "ana",
      sessionId: "mind",
      fireAt: "2026-10-14T16:00:00.000Z",
      note: "poll",
      name: "poll",
      conversation: "mind@ana",
    });
    await log.arm({
      agentId: "ana",
      sessionId: "mind",
      fireAt: "2026-10-14T15:00:00.000Z",
      note: "earlier",
      conversation: "mind@ana",
    });

    // the second turn is open, but nobody holds the lease: nothing is running
    let s = await statusOf(log, creds);
    assertEquals(s.vault, [{ key: "slack:T1", owner: null, fields: ["token", "team"] }]);
    assertEquals(JSON.stringify(s).includes("xoxb-secret"), false);
    const [ana] = s.turns;
    assertEquals(ana.running, null);
    assertEquals([ana.last?.id, ana.last?.end, ana.last?.opened_by], [
      "t1",
      "end_turn",
      'message from matias "hola"',
    ]);
    assertEquals(ana.next_wake?.note, "earlier");
    assertEquals(ana.last_error?.error, "overloaded");

    // a held lease is a running turn: the open one
    const lease = log.lock("turn-mind@ana");
    await lease.acquire();
    s = await statusOf(log, creds);
    assertEquals(s.turns[0].running?.id, "t2");
    assertEquals(s.turns[0].running?.opened_by, 'message from matias "y?"');
    await lease.release();
  } finally {
    await creds.close();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
