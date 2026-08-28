/**
 * door.ts — the syscall boundary (DESIGN §9): how a script in user space reaches the log.
 *
 * One unix socket per agent, `agents/<name>/door.sock`, served by main. ONE op: a `call`
 * executes nothing — the door publishes a DRAFT tool_use in the agent's name and replies
 * with its id — the same event the model's own call is, ruled by the same permission
 * table, executed by the same act branch on the agent's scoped port, wake and narration
 * included (§2, §9). Search rides it like any tool: the hits land in the log as the use's
 * result, for the mind — one path, so a policy on ANY tool rules scripts and model alike.
 * The door's whole authority is the agent's scoped port, so it never acts as root.
 *
 * IDENTITY IS THE SOCKET'S. The path fixes the agent — the door stamps `agent`, and the
 * protocol has no field a script could claim another identity in. The filesystem enforces
 * it where enforcement exists: under the container split each `agents/<name>/` is owned by
 * that agent's unix user, so connecting proves you may. Locally one user owns everything
 * and the door is convention, like the rest of the exec plane. Discovery is a SKILL, not a
 * file: the agent is taught the two lines that bind `script.ts` to its own folder, and
 * writes them into the script it was writing anyway — `bind` takes the folder, so a script
 * that lives here addresses its door by pointing at the directory it is already in.
 *
 * The wire, newline-JSON, serial per connection:
 *   call   `{op, tool, input}`  → publish the tool_use → `{ok, id, status: "queued"}`
 *
 * One synthetic turn key per connection (`job:<id>`): the run is a turn no session ever
 * held, so its uses read as fresh work to act, its results weld to their uses in the next
 * window, and the model wakes to narrate them ("sent 5 reminders; Juan Pérez failed").
 */

import type { Draft, ToolUseEvent } from "./types.ts";
import type { Log } from "./store/log.ts";
import { newId } from "./store/id.ts";

export interface DoorAgent {
  agentId: string;
  sessionId: string;
  /** The agent's scoped port (§6): the door writes as the agent, never wider. */
  log: Pick<Log, "publish">;
}

export interface Doors {
  close(): Promise<void>;
}

/** Serve one door per agent under `dir` — one unix socket in each agent's own folder. */
export async function installDoors(dir: string, agents: DoorAgent[]): Promise<Doors> {
  const conns = new Set<Deno.Conn>();
  const listeners: { listener: Deno.Listener; path: string }[] = [];
  const serving: Promise<void>[] = [];

  for (const agent of agents) {
    const home = `${dir}/agents/${agent.agentId}`;
    await Deno.mkdir(home, { recursive: true });
    const path = `${home}/door.sock`;
    try {
      await Deno.remove(path); // a stale socket from a crashed run refuses the bind
    } catch { /* none */ }
    const listener = Deno.listen({ transport: "unix", path });
    listeners.push({ listener, path });
    serving.push(
      (async () => {
        for await (const conn of listener) {
          conns.add(conn);
          serve(conn, agent)
            .catch((err) => console.error(`[door] ${agent.agentId}:`, err))
            .finally(() => {
              conns.delete(conn);
              try {
                conn.close();
              } catch { /* already closed */ }
            });
        }
      })().catch(() => {/* listener closed — teardown */}),
    );
  }

  return {
    async close() {
      for (const { listener } of listeners) listener.close();
      for (const conn of conns) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      await Promise.all(serving);
      for (const { path } of listeners) {
        try {
          await Deno.remove(path);
        } catch { /* already gone */ }
      }
    },
  };
}

/** One connection: newline-JSON requests, answered in order. A framing error is fatal to
 *  the connection; a request error is an `{ok: false}` reply and the loop continues. */
async function serve(conn: Deno.Conn, agent: DoorAgent) {
  // one run, one synthetic turn (§2): a key no session ever held, so act classifies the
  // run's uses as fresh work — and render welds use to result under it, like any turn's
  const turnId = `job:${newId()}`;
  const decoder = new TextDecoder();
  let buffered = "";
  const write = async (res: Record<string, unknown>) => {
    const bytes = new TextEncoder().encode(JSON.stringify(res) + "\n");
    for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
  };

  for (;;) {
    const nl = buffered.indexOf("\n");
    if (nl === -1) {
      const chunk = new Uint8Array(4096);
      let n: number | null;
      try {
        n = await conn.read(chunk);
      } catch {
        return; // the socket closed under the read — a hang-up or the door's own teardown
      }
      if (n === null) return; // the script hung up
      buffered += decoder.decode(chunk.subarray(0, n), { stream: true });
      continue;
    }
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      await write(await handle(JSON.parse(line), agent, turnId));
    } catch (err) {
      await write({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function handle(
  req: Record<string, unknown>,
  agent: DoorAgent,
  turnId: string,
): Promise<Record<string, unknown>> {
  if (req.op === "call") {
    const tool = req.tool;
    if (typeof tool !== "string" || tool === "") throw new Error("call needs a tool name");
    const use = await agent.log.publish(
      {
        ts: new Date().toISOString(),
        type: "tool_use",
        payload: { turn_id: turnId },
        agent: { id: agent.agentId, session_id: agent.sessionId },
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: `mind:${agent.agentId}` },
        },
        parts: [{
          type: "data",
          kind: "tool_use",
          data: {
            name: tool,
            input: (req.input ?? {}) as ToolUseEvent["parts"][0]["data"]["input"],
          },
        }],
      } satisfies Draft<ToolUseEvent>,
    );
    return { ok: true, id: use!.id, status: "queued" };
  }
  throw new Error(`unknown op "${String(req.op)}" — the door speaks call`);
}
