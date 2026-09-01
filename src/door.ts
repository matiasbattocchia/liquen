/**
 * door.ts — the syscall boundary AND the attach seam (DESIGN §9): how anything in user
 * space — a script, an interface — reaches the log.
 *
 * One unix socket per agent, `agents/<name>/door.sock`, served by main. A `call` executes
 * nothing — the door publishes a DRAFT tool_use in the agent's name and replies with its
 * id — the same event the model's own call is, ruled by the same permission table,
 * executed by the same act branch on the agent's scoped port, wake and narration included
 * (§2, §9). Search rides it like any tool: the hits land in the log as the use's result,
 * for the mind — one path, so a policy on ANY tool rules scripts and model alike. The
 * door's whole authority is the agent's scoped port, so it never acts as root.
 *
 * IDENTITY IS THE SOCKET'S. The path fixes the agent — the door stamps `agent`, and the
 * protocol has no field that could claim another agent's session. The filesystem enforces
 * it where enforcement exists: under the container split each `agents/<name>/` is owned by
 * that agent's unix user, so connecting proves you may. Locally one user owns everything
 * and the door is convention, like the rest of the exec plane. One principal per agent
 * makes the same proof cover the principal verbs: whoever may open this socket may speak
 * as this agent's principal, and `sender` is how they sign that speech — a display name,
 * inside an envelope the door already pinned to this agent's mind.
 *
 * The wire, newline-JSON, requests answered in order per connection. Every verb takes an
 * optional `session` — the bare name of the session it speaks to (§4); absent, the mind.
 * Naming one is what births it:
 *   call                 {op, tool, input, session?}     → tool_use, gated as ever
 *                                                          → {ok, id, status: "queued"}
 *   message              {op, text, sender?, session?}   → the principal's half of the
 *                                                          complex (no turn_id, §3) → {ok, id}
 *   permission_response  {op, ref_id, verdict, session?} → answers a gate → {ok, id}
 *   tail                 {op, from?, session?}           → {ok} — then the connection also
 *                                                  PUSHES: {event} per row of that
 *                                                  session's scoped view (from the
 *                                                  cursor), {delta} per model delta,
 *                                                  {status} on the session's turn edges
 *                                                  (below). Full disclosure: what to do
 *                                                  with a gate or `<|SILENCE|>` is the
 *                                                  interface's decision, never the door's.
 *
 * One synthetic turn key per connection (`job:<id>`): a `call` run is a turn no session
 * ever held, so its uses read as fresh work to act, its results weld to their uses in the
 * next window, and the model wakes to narrate them.
 *
 * The live connections are the daemon's ATTACHMENTS: an interface killed and one that
 * quit are the same event here — a hang-up — so a lifetime derived from `attachments()`
 * needs no bookkeeping a dead client could fail to update.
 */

import type {
  Delta,
  Draft,
  Event,
  MessageEvent,
  PermissionResponseEvent,
  PermissionVerdict,
  ToolUseEvent,
} from "./types.ts";
import type { Log } from "./store/log.ts";
import { newId } from "./store/id.ts";
import { sessionAddress } from "./session.ts";

export interface DoorAgent {
  agentId: string;
  /** The default session a session-less request speaks to — the mind. */
  sessionId: string;
  /** A SESSION's scoped port (§6): the door reads and writes as the session the request
   *  named, never wider. Asking for a session is what births it (main's runner). */
  port(sessionId: string): Pick<Log, "publish" | "subscribe">;
}

/** A turn's edges, volunteered on the tail (§2): the verdict `decide` reached under the
 *  lease, which is the one fact an attach client cannot compute for itself. `after` on
 *  idle is the last event the deciding read saw — a client that wrote id M knows its line
 *  was weighed once `after >= M` (UUIDv7 order), an address comparison, never a judgment.
 *  Ephemeral like a delta: pushed to tailers, never stored, correctness never rides it. */
export interface Status {
  status: "idle" | "busy";
  after?: string;
}

export interface Doors {
  /** Fan a model delta out to every connection tailing this SESSION on the agent's door. */
  emit(agentId: string, sessionId: string, delta: Delta): void;
  /** Fan a turn edge out the same way — the daemon discloses, the interface decides. */
  status(agentId: string, sessionId: string, line: Status): void;
  /** Live connections across every door — what an attachment-derived lifetime reads. */
  attachments(): number;
  close(): Promise<void>;
}

type Push = (line: Record<string, unknown>) => void;
/** One tailing connection: where to push, and which session it tails. */
type Tailer = { push: Push; session: string };

/** Serve one door per agent under `dir` — one unix socket in each agent's own folder. */
export async function installDoors(dir: string, agents: DoorAgent[]): Promise<Doors> {
  const conns = new Set<Deno.Conn>();
  const listeners: { listener: Deno.Listener; path: string }[] = [];
  const serving: Promise<void>[] = [];
  const casts = new Map<string, Set<Tailer>>();

  for (const agent of agents) {
    const home = `${dir}/agents/${agent.agentId}`;
    await Deno.mkdir(home, { recursive: true });
    const path = `${home}/door.sock`;
    try {
      await Deno.remove(path); // a stale socket from a crashed run refuses the bind
    } catch { /* none */ }
    const listener = Deno.listen({ transport: "unix", path });
    listeners.push({ listener, path });
    const cast = new Set<Tailer>();
    casts.set(agent.agentId, cast);
    serving.push(
      (async () => {
        for await (const conn of listener) {
          conns.add(conn);
          serve(conn, agent, cast)
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
    emit(agentId: string, sessionId: string, delta: Delta) {
      for (const t of casts.get(agentId) ?? []) {
        if (t.session === sessionId) t.push({ delta });
      }
    },
    status(agentId: string, sessionId: string, line: Status) {
      for (const t of casts.get(agentId) ?? []) {
        if (t.session === sessionId) t.push({ ...line });
      }
    },
    attachments: () => conns.size,
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

/** One connection: newline-JSON requests, answered in order; after a `tail`, pushed
 *  {event}/{delta} lines share the wire (every write rides one chain, so lines never
 *  interleave). A framing error is fatal to the connection; a request error is an
 *  `{ok: false}` reply and the loop continues. */
async function serve(conn: Deno.Conn, agent: DoorAgent, cast: Set<Tailer>) {
  // one run, one synthetic turn (§2): a key no session ever held, so act classifies the
  // run's uses as fresh work — and render welds use to result under it, like any turn's
  const turnId = `job:${newId()}`;
  const decoder = new TextDecoder();
  let buffered = "";
  let chain: Promise<void> = Promise.resolve();
  const write = (res: Record<string, unknown>): Promise<void> =>
    chain = chain.then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(res) + "\n");
      for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
    }).catch(() => {/* the peer hung up — the read loop is what ends the connection */});
  const push: Push = (line) => void write(line);

  let untail: (() => void) | undefined;
  let tailer: Tailer | undefined;
  const tail = (session: string, from?: string) => {
    if (untail) throw new Error("already tailing");
    untail = agent.port(session).subscribe(
      (e: Event) => push({ event: e }),
      from !== undefined ? { from } : {},
    );
    tailer = { push, session };
    cast.add(tailer);
  };

  try {
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
        if (n === null) return; // the client hung up
        buffered += decoder.decode(chunk.subarray(0, n), { stream: true });
        continue;
      }
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        await write(await handle(JSON.parse(line), agent, turnId, tail));
      } catch (err) {
        await write({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    untail?.();
    if (tailer) cast.delete(tailer);
  }
}

async function handle(
  req: Record<string, unknown>,
  agent: DoorAgent,
  turnId: string,
  tail: (session: string, from?: string) => void,
): Promise<Record<string, unknown>> {
  // every verb the door speaks lands in a session's own room (§4): the socket decided
  // WHOSE, the request's `session` decides which — absent, the mind. A malformed name
  // dies in sessionAddress before anything is written.
  const session = typeof req.session === "string" && req.session !== ""
    ? req.session
    : agent.sessionId;
  const address = sessionAddress(agent.agentId, session);
  const port = agent.port(session);
  const envelope = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address },
  };
  if (req.op === "call") {
    const tool = req.tool;
    if (typeof tool !== "string" || tool === "") throw new Error("call needs a tool name");
    const use = await port.publish(
      {
        ts: new Date().toISOString(),
        type: "tool_use",
        payload: { turn_id: turnId },
        agent: { id: agent.agentId, session_id: session },
        envelope,
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
  if (req.op === "message") {
    const text = req.text;
    if (typeof text !== "string" || text === "") throw new Error("message needs text");
    const sender = (req.sender ?? {}) as { address?: unknown; name?: unknown };
    const address = typeof sender.address === "string" && sender.address
      ? sender.address
      : agent.agentId;
    const msg = await port.publish(
      {
        ts: new Date().toISOString(),
        type: "message",
        // the principal's stamp (§3): agent.id = whose mind, session_id = entered through
        // the harness. No turn_id, ever: that is the model's mark, and its absence is what
        // keeps this row input — one complex, two halves, told apart by turn_id alone.
        agent: { id: agent.agentId, session_id: session },
        envelope: {
          ...envelope,
          sender: { address, name: typeof sender.name === "string" ? sender.name : address },
        },
        parts: [{ type: "text", kind: "text", text }],
      } satisfies Draft<MessageEvent>,
    );
    return { ok: true, id: msg!.id };
  }
  if (req.op === "permission_response") {
    const ref = req.ref_id;
    if (typeof ref !== "string" || ref === "") throw new Error("permission_response needs ref_id");
    const verdict = req.verdict;
    if (verdict === null || typeof verdict !== "object") {
      throw new Error("permission_response needs a verdict");
    }
    const res = await port.publish(
      {
        ts: new Date().toISOString(),
        type: "permission_response",
        payload: { ref_id: ref },
        envelope,
        parts: [{
          type: "data",
          kind: "permission_response",
          data: verdict as PermissionVerdict,
        }],
      } satisfies Draft<PermissionResponseEvent>,
    );
    return { ok: true, id: res!.id };
  }
  if (req.op === "tail") {
    tail(session, typeof req.from === "string" ? req.from : undefined);
    return { ok: true, status: "tailing" };
  }
  throw new Error(
    `unknown op "${String(req.op)}" — the door speaks call, message, permission_response, tail`,
  );
}
