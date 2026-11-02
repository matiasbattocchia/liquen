/**
 * script.ts — the door's user-space half (DESIGN §9): what an agent's script imports.
 *
 * A script never holds a log handle — it holds a pipe, and the pipe speaks the model's own
 * vocabulary: every verb is a tool_use in the caller's name — the same event the model's
 * own call is, through the same permission table, answered by the same branch on the
 * caller's scoped port. ONE path, search included: a policy on any tool rules scripts and
 * model alike. The runtime authenticates: identity is the socket's, and there is no field
 * here a script could claim another's in.
 *
 * A script binds this module to its own directory (`bind(new URL(".", import.meta.url)
 * .pathname)`) — which is the agent's folder, because that is the only place a script can
 * sit and reach a door. The script's location is therefore the whole of its addressing: it
 * needs no configuration to find the socket, and it can only ever find its own. The agent
 * learns those two lines from a skill and writes them itself.
 *
 * Every verb resolves with the call's answer, the one the model would have read: search's
 * hits, a send's receipt, `pending_approval` for a call that asks the principal. What is
 * said of a call after its answer — the ruling, the run it allows, whether a send arrived —
 * goes to the agent, which is woken with it. A script running inside a bash call names it
 * (`LIQUEN_JOB`, which every process of the call's job carries): its answers wake nobody,
 * and the agent's window folds them into that bash call. The socket closes when the process
 * exits — a script's end is its hang-up.
 *
 * Nothing imported at runtime (types only): scripts run from the data root, outside the
 * repo's import map, so this module must resolve with nothing but itself.
 */

import type { ContactArgs, Json, SearchArgs, SendArgs } from "./types.ts";

/** A call's answer: the tool's output, and whether it is an error. */
export interface Answer {
  id: string;
  output: Json;
  is_error?: true;
}

export interface Mu {
  /** Send, as one of YOUR gated tool calls: the receipt, or `pending_approval`. */
  send(args: SendArgs): Promise<Answer>;
  /** Search the log (§6), as the model's search does: the hits. */
  search(args?: SearchArgs): Promise<Answer>;
  /** Write to an address book (§9), gated like a send, in your name. */
  contact(args: ContactArgs): Promise<Answer>;
}

/** The variable every process of a bash call's job carries: the call's id (exec/jobs.ts). */
const JOB_ENV = "LIQUEN_JOB";

/** The bash call this script runs inside, when it does. */
function bashCall(): string | undefined {
  try {
    return Deno.env.get(JOB_ENV) || undefined;
  } catch {
    return undefined; // no env permission: the script names no bash call
  }
}

/** Bind a client to the agent folder holding `door.sock` — a script passes its own
 *  directory. Lazy: nothing connects until the first request. */
export function bind(home: string): Mu {
  const path = `${home.replace(/\/+$/, "")}/door.sock`;
  const bash = bashCall();
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

  const call = async (tool: string, input: unknown): Promise<Answer> => {
    const res = await request({ op: "call", tool, input, ...(bash ? { bash } : {}) });
    return {
      id: String(res.id),
      output: res.output as Json,
      ...(res.is_error ? { is_error: true as const } : {}),
    };
  };

  return {
    send: (args) => call("send", args),
    search: (args = {}) => call("search", args),
    contact: (args) => call("contact", args),
  };
}
