/**
 * script.ts — the door's user-space half (DESIGN §9): what an agent's script imports.
 *
 * A script never holds a log handle — it holds a pipe, and the pipe speaks the model's own
 * vocabulary: every verb publishes a DRAFT tool_use in the caller's name — the same event
 * the model's own call is, through the same permission table, executed by the same act
 * branch on the caller's scoped port. ONE path, search included: a policy on any tool
 * rules scripts and model alike. The runtime authenticates: identity is the socket's, and
 * there is no field here a script could claim another's in.
 *
 * A script binds this module to its own directory (`bind(new URL(".", import.meta.url)
 * .pathname)`) — which is the agent's folder, because that is the only place a script can
 * sit and reach a door. The script's location is therefore the whole of its addressing: it
 * needs no configuration to find the socket, and it can only ever find its own. The agent
 * learns those two lines from a skill and writes them itself.
 *
 * Every verb returns as soon as the ask is IN THE LOG (`{status: "queued"}`), never the
 * outcome — not even search's rows. The answer belongs to the next turn: act gates and
 * runs the use, the result lands in the log, and the agent is woken to narrate it. No
 * call here waits, because a foreground script runs INSIDE the very turn that would
 * answer it (bash holds the turn lease while the script runs), so a waiting call could
 * only deadlock there. The socket closes when the process exits — a script's end is its
 * hang-up.
 *
 * Nothing imported at runtime (types only): scripts run from the data root, outside the
 * repo's import map, so this module must resolve with nothing but itself.
 */

import type { SearchArgs, SendArgs } from "./types.ts";

/** A queued ask: the tool_use is in the log; the gate has not spoken yet. */
export interface Queued {
  id: string;
  status: "queued";
}

export interface Mu {
  /** Queue the ask as one of YOUR gated tool calls — you narrate its outcome next turn. */
  send(args: SendArgs): Promise<Queued>;
  /** Queue the model's search (§6) the same way — the hits land in the log, next turn. */
  search(args?: SearchArgs): Promise<Queued>;
}

/** Bind a client to the agent folder holding `door.sock` — a script passes its own
 *  directory. Lazy: nothing connects until the first request. */
export function bind(home: string): Mu {
  const path = `${home.replace(/\/+$/, "")}/door.sock`;
  let conn: Deno.UnixConn | undefined;
  let buffered = "";
  const decoder = new TextDecoder();
  // requests are strictly serial — one connection, responses in ask order
  let chain: Promise<unknown> = Promise.resolve();

  const readLine = async (): Promise<string> => {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        return line;
      }
      const chunk = new Uint8Array(4096);
      const n = await conn!.read(chunk);
      if (n === null) throw new Error("the door closed");
      buffered += decoder.decode(chunk.subarray(0, n), { stream: true });
    }
  };

  const request = (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const run = chain.then(async () => {
      conn ??= await Deno.connect({ transport: "unix", path });
      const bytes = new TextEncoder().encode(JSON.stringify(req) + "\n");
      for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
      const res = JSON.parse(await readLine()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(res.error ?? "door refused the request"));
      return res;
    });
    chain = run.catch(() => {}); // one failure never wedges the queue
    return run;
  };

  const call = async (tool: string, input: unknown): Promise<Queued> => {
    const res = await request({ op: "call", tool, input });
    return { id: String(res.id), status: "queued" };
  };

  return {
    send: (args) => call("send", args),
    search: (args = {}) => call("search", args),
  };
}
