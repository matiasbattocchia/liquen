/**
 * attach.ts — the attach client's shared half (DESIGN §2, §9): resolve which agent, find
 * its door, raise a daemon when nothing answers, and speak the wire. The REPL and the CLI
 * are surfaces over this; neither holds a log handle — the attach path is the only path.
 *
 * Every failure here raises: no project, no such agent, no daemon on the socket. They are
 * errors, and an error is a throw — a surface that wants to dress one up catches it.
 */

import { TextLineStream } from "@std/streams";
import { userInfo } from "node:os";
import { findRoot, readConfig } from "./config.ts";
import type { Status } from "./door.ts";
import type { Delta, Event } from "./types.ts";

// A raised daemon owes the client a bound socket within this window — seeding, the exec
// planes and the proxy all sit between spawn and bind.
const ATTACH_TIMEOUT_MS = 20_000;
const ATTACH_RETRY_MS = 250;

export interface Attached {
  root: string;
  dir: string; // the org's data root: `${root}/data`
  target: string; // the agent this client fronts
  username: string; // the trusted-localhost principal (§9): the OS username
  model: string; // resolved the roster's own way, so a banner names what will run
}

/** The org lives where you run mu: the nearest config.jsonc up from cwd is the project
 *  marker, and the substrate sits beside it. The roster is the catalog's — an agent the
 *  config does not declare cannot run. When the agent folder shares the OS username, no
 *  identity map exists at all (principal name = agent name); an explicit argument talks
 *  to another agent — a session choice, so an argument, not config. */
export async function resolveAgent(explicit?: string): Promise<Attached> {
  const root = findRoot();
  const catalog = await readConfig(root);
  const username = (() => {
    try {
      return userInfo().username;
    } catch {
      return "principal";
    }
  })();
  const target = explicit ?? username;
  if (!(target in catalog.agents)) {
    throw new Error(
      `no agent "${target}" in ${root}/config.jsonc — declare it: "agents": { "${target}": {} }`,
    );
  }
  const model = catalog.agents[target].model ?? catalog.org.agent.model;
  return { root, dir: `${root}/data`, target, username, model };
}

/** Attach to the agent's door. A refusal means no daemon — raise an ephemeral one and
 *  keep connecting until it binds; the daemon takes itself down (the linger) when the
 *  last attachment is gone. */
export async function attach(a: Attached): Promise<Deno.UnixConn> {
  const path = `${a.dir}/agents/${a.target}/door.sock`;
  try {
    return await Deno.connect({ transport: "unix", path });
  } catch { /* nothing listening — raise a daemon */ }
  const daemon = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./main.ts", import.meta.url).href, "--ephemeral"],
    cwd: a.root,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  daemon.unref(); // its life is its attachments, never this process's exit
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  for (;;) {
    try {
      return await Deno.connect({ transport: "unix", path });
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`no daemon answered on ${path} — run \`mu start\` to see it boot`);
      }
      await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS));
    }
  }
}

export interface Reply {
  ok?: boolean;
  error?: string;
  id?: string;
  status?: string;
}

export interface Wire {
  /** One request → one reply, in order — the door's wire invariant. */
  request(req: Record<string, unknown>): Promise<Reply>;
  /** Resolves when the pump ends — a hang-up, clean or not; the caller decides which. */
  hangup: Promise<void>;
}

/** Speak the wire: newline-JSON requests answered in order; after a `tail` the same
 *  connection pushes {event}, {delta} and {status} lines — demuxed by shape (a reply
 *  always carries `ok`; a push never does). Writes ride one chain so requests never
 *  interleave. */
export function wire(conn: Deno.UnixConn, on: {
  event(e: Event): void;
  delta(d: Delta): void;
  status?(s: Status): void;
}): Wire {
  const encoder = new TextEncoder();
  let wchain: Promise<void> = Promise.resolve();
  const awaiting: ((r: Reply) => void)[] = [];
  const request = (req: Record<string, unknown>): Promise<Reply> => {
    const reply = new Promise<Reply>((resolve) => awaiting.push(resolve));
    wchain = wchain.then(async () => {
      const bytes = encoder.encode(JSON.stringify(req) + "\n");
      for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
    }).catch(() => {/* the daemon hung up — the pump is what reports it */});
    return reply;
  };
  const hangup = (async () => {
    const lines = conn.readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { event?: Event; delta?: Delta } & Reply;
      if (msg.event) on.event(msg.event);
      else if (msg.delta) on.delta(msg.delta);
      else if (msg.ok !== undefined) awaiting.shift()?.(msg);
      else if (msg.status !== undefined) on.status?.(msg as Status);
    }
  })().catch(() => {/* the socket died under the pump — the same hang-up */})
    .finally(() => {
      // whatever was still waiting for a reply gets the hang-up as its answer — a request
      // the daemon never answered must not wait forever for it
      for (const settle of awaiting.splice(0)) settle({ ok: false, error: "the daemon hung up" });
    });
  return { request, hangup };
}
