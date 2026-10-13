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
 *   usage: liquen cli [--dir <org>] [--agent <name>] [--timeout <seconds>]
 *                     [--fail-on-tool-error] <instruction…>
 *
 * stdout is the transcript, as the REPL shows it (text streams live; tool calls as
 * described lines; thinking stays silent). stderr is failure: the log's error rows and
 * the CLI's own. Exit 0 = idle arrived over our message; 1 = no daemon, a hang-up, or
 * the timeout; 2 = usage; 3 = `--fail-on-tool-error` and a call of the session's that ran
 * after our message failed — a scripted wake's way to tell "it ran" from "it worked".
 *
 * A card the agent raises waits in the session on its own — the turn closes around it — so
 * the transcript ends on `? approve <handle>`, and the answer is another instruction in
 * the REPL's words: `liquen cli /y <handle>`, `/n <handle> [reason]`, `/y all`, and
 * `/cancel` to cut a running turn. Steering is said and the CLI exits on the door's reply.
 */

import { attach, resolveAgent, steering, tuneFlags, type Wire, wire } from "./attach.ts";
import { shortId } from "./render.ts";
import { MIND, sessionAddress } from "./session.ts";
import { painter } from "./paint.ts";
import { tailOf } from "./line.ts";
import { orgFlag } from "./config.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";
import type { Event } from "./types.ts";

export const USAGE =
  `usage: liquen cli [--dir <org>] [--agent <name>] [--session <name>] [--model <name>]
                  [--effort <level>] [--provider <name>] [--timeout <seconds>]
                  [--fail-on-tool-error] <instruction…>

  One instruction to an agent; its work streams to stdout until the agent is idle over it.
  Exit 0 once it is; 1 with no daemon, a hang-up or the timeout; 2 on a usage error; 3
  with --fail-on-tool-error, when a call the session made after the instruction failed
  (a refusal or a cancel is not a failure).`;

/** `/y` · `/n` · `/cancel`, said through the door as the REPL says them: the door reads a
 *  verdict against the cards still open in the session, and the answer is the exit code —
 *  0 said, 1 the door refused it (nothing to answer, not a verdict, a stale handle). */
async function steer(
  w: Wire,
  line: string,
  session: string,
  username: string,
): Promise<number> {
  if (line === "/cancel") {
    const r = await w.request({
      op: "control",
      kind: "cancel",
      sender: { address: username, name: username },
      session,
    });
    if (!r.ok) console.error(String(r.error));
    else console.log("cancel sent");
    return r.ok ? 0 : 1;
  }
  const r = await w.request({
    op: "permission_response",
    text: line,
    sender: { address: username, name: username },
    session,
  });
  if (!r.ok) {
    console.error(String(r.error));
    return 1;
  }
  const said = r.verdict?.behavior === "allow" ? "allowed" : "denied";
  for (const ref of r.refs ?? []) console.log(`${said} ${shortId(ref)}`);
  return 0;
}

await entry(async () => {
  const org = orgFlag();
  helpFlag(org.args, USAGE);
  // what the session thinks with, for this one instruction (§9): the flags hold while the
  // CLI is attached, and the roster's values come back when it exits
  const tune = tuneFlags(org.args);
  const flags: { agent?: string; session?: string; timeout?: number; failOnToolError?: boolean } =
    {};
  const words: string[] = [];
  for (let i = 0; i < org.args.length; i++) {
    const arg = org.args[i];
    if (arg === "--agent") flags.agent = org.args[++i];
    else if (arg === "--session") flags.session = org.args[++i];
    else if (arg === "--timeout") flags.timeout = Number(org.args[++i]);
    else if (arg === "--fail-on-tool-error") flags.failOnToolError = true;
    else words.push(arg);
  }
  const instruction = words.join(" ").trim();
  if (!instruction || (flags.timeout !== undefined && !(flags.timeout > 0))) {
    console.error(USAGE);
    Deno.exit(2);
  }

  const a = await resolveAgent(flags.agent, org.dir, tune);
  const session = flags.session ?? MIND;
  sessionAddress(a.target, session); // refuses a malformed session name before attaching
  const conn = await attach(a);
  let leaving = false;

  // stdout has no block of its own to redraw, but it still has a tail: the painter asks
  // for a closed row or a blank one, and this answers with the newlines it actually owes
  const tail = tailOf();
  const say = (s: string) => {
    tail.note(s);
    Deno.stdout.writeSync(new TextEncoder().encode(s));
  };
  const write = say;

  const p = painter({
    session: { agentId: a.target, id: session },
    home: sessionAddress(a.target, session),
    zone: a.timezone,
    write,
    error: (t) => console.error(t),
    prompt: () => say(tail.owed(1)),
    gap: () => say(tail.owed(2)),
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

  // a verdict or a cancel is steering, not a turn: it is said, the CLI says what the door
  // answered, and it is done — there is no transcript to paint
  const steers = instruction === "/cancel" || steering(instruction);
  // the session's failed calls, by id: those after our message are the turn it started
  const failed: string[] = [];
  const failure = (e: Event) => {
    if (e.type !== "tool_result" || e.agent?.id !== a.target || e.agent.session_id !== session) {
      return;
    }
    const { is_error, refused, cancelled } = e.parts[0].data;
    if (is_error && !refused && !cancelled && !e.payload.turn_id.startsWith("job:")) {
      failed.push(e.id);
    }
  };
  const w = wire(conn, {
    event: steers ? () => {} : (e) => {
      failure(e);
      p.event(e);
    },
    delta: p.delta,
    status: (s) => {
      if (s.status === "idle" && s.after !== undefined) {
        idleAt = s.after;
        check();
      }
    },
  });
  void w.hangup.then(() => {
    if (!leaving) {
      console.error("the daemon hung up");
      settle(1);
    }
  });

  // live: the transcript starts at our instruction. The agent's shell stands where its
  // principal does — a place it cannot stand in is the failure, before anything is sent.
  const t = await w.request({ op: "tail", session, cwd: Deno.cwd(), ...a.tune });
  if (!t.ok) {
    console.error(String(t.error));
    leaving = true;
    conn.close();
    Deno.exit(1);
  }
  if (steers) {
    leaving = true;
    const code = await steer(w, instruction, session, a.username);
    conn.close();
    Deno.exit(code);
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

  let code = await finished;
  if (code === 0 && flags.failOnToolError && failed.some((id) => id > myId)) {
    console.error(`${failed.filter((id) => id > myId).length} call(s) failed in the turn`);
    code = 3;
  }
  leaving = true;
  try {
    conn.close();
  } catch { /* already closed */ }
  Deno.exit(code);
});
