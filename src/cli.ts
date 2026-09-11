/**
 * cli.ts — `liquen cli`: the headless principal. One instruction in, the transcript out,
 * exit when the daemon goes quiet over it.
 *
 * An ATTACH client exactly like the REPL, minus the keyboard: it publishes ONE message
 * through the door and streams the agent's work until the daemon discloses idle past
 * that message — {status: "idle", after} pushed on the tail, and `after >= id` (UUIDv7
 * order) says the line was weighed. That comparison is addressing, never judgment: the
 * daemon discloses, the client decides, and this client decides only "my message was
 * seen through". Whether the work SUCCEEDED is stdout's reader's call — an error row is
 * a failed command, and the fix is running it again.
 *
 *   usage: liquen cli [--dir <org>] [--agent <name>] [--timeout <seconds>] <instruction…>
 *
 * stdout is the transcript, as the REPL shows it (text streams live; tool calls as
 * described lines; thinking stays silent). stderr is failure: the log's error rows and
 * the CLI's own. Exit 0 = idle arrived over our message; 1 = no daemon, a hang-up, or
 * the timeout; 2 = usage.
 */

import { attach, resolveAgent, wire } from "./attach.ts";
import { MIND, sessionAddress } from "./session.ts";
import { painter } from "./paint.ts";
import { orgFlag } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = "usage: liquen cli [--dir <org>] [--agent <name>] [--session <name>] " +
  "[--timeout <seconds>] <instruction…>";

await entry(async () => {
  const org = orgFlag();
  helpFlag(org.args, USAGE);
  const flags: { agent?: string; session?: string; timeout?: number } = {};
  const words: string[] = [];
  for (let i = 0; i < org.args.length; i++) {
    const arg = org.args[i];
    if (arg === "--agent") flags.agent = org.args[++i];
    else if (arg === "--session") flags.session = org.args[++i];
    else if (arg === "--timeout") flags.timeout = Number(org.args[++i]);
    else words.push(arg);
  }
  const instruction = words.join(" ").trim();
  if (!instruction || (flags.timeout !== undefined && !(flags.timeout > 0))) {
    console.error(USAGE);
    Deno.exit(2);
  }

  const a = await resolveAgent(flags.agent, org.dir);
  const session = flags.session ?? MIND;
  sessionAddress(a.target, session); // refuses a malformed session name before attaching
  const conn = await attach(a);
  let leaving = false;

  const write = (s: string) => Deno.stdout.writeSync(new TextEncoder().encode(s));

  const p = painter({
    session: { agentId: a.target, id: session },
    home: sessionAddress(a.target, session),
    write,
    error: (t) => console.error(t),
    prompt: () => write("\n"),
    thinking: false,
  });

  // the ending: the freshest idle cursor the daemon disclosed, against our message's id —
  // checked from both sides because either fact can land first
  let myId = "";
  let idleAt = "";
  let settle!: (code: number) => void;
  const finished = new Promise<number>((resolve) => settle = resolve);
  const check = () => {
    if (myId && idleAt >= myId) settle(0);
  };

  const w = wire(conn, {
    event: p.event,
    delta: p.delta,
    status: (s) => {
      if (s.status === "idle" && s.after !== undefined) {
        idleAt = s.after;
        check();
      }
    },
  });
  w.hangup.then(() => {
    if (!leaving) {
      console.error("the daemon hung up");
      settle(1);
    }
  });

  // live: the transcript starts at our instruction. The agent's shell stands where its
  // principal does — a place it cannot stand in is the failure, before anything is sent.
  const t = await w.request({ op: "tail", session, cwd: Deno.cwd() });
  if (!t.ok) {
    console.error(String(t.error));
    leaving = true;
    conn.close();
    Deno.exit(1);
  }
  const r = await w.request({
    op: "message",
    text: instruction,
    sender: { address: a.username, name: a.username },
    session,
  });
  if (!r.ok || r.id === undefined) {
    console.error(`the door refused the message: ${r.error}`);
    leaving = true;
    conn.close();
    Deno.exit(1);
  }
  myId = r.id;
  check();

  if (flags.timeout !== undefined) {
    setTimeout(() => {
      console.error(`timeout: no idle after ${flags.timeout}s — the log still holds the work`);
      settle(1);
    }, flags.timeout * 1000);
  }

  const code = await finished;
  leaving = true;
  try {
    conn.close();
  } catch { /* already closed */ }
  Deno.exit(code);
});
