/**
 * repl.ts — `mu repl`: the v0.0 principal interface, a line REPL attached to the daemon.
 *
 * The REPL is an ATTACH client (DESIGN §2, §9): it never holds a log handle and hosts
 * nothing — it speaks to its agent through the door (`agents/<name>/door.sock`),
 * publishing the principal's messages and painting what the tail pushes back. "Is a
 * daemon running?" is the connect itself: a refused socket means no, and the REPL raises
 * one — main alone (`--ephemeral`), which reaps itself once nothing has been attached for
 * a linger. `mu start` owns the standing org and its connections; the REPL only ever
 * attaches — the attach path is the only path it has.
 *
 *   you type            → {op: "message"} through the door
 *   the agent thinks    → thinking deltas stream dim; assistant text streams live
 *   the agent acts      → tool_use/result lines; peer sends as `→ conv: text`
 *   a gate fires        → an approval card; answer `/{y,n} [once|conv|conn|always|all]
 *                         [reason]` — a scope word makes the verdict STANDING (remembered
 *                         policy, §9); `all` answers every card waiting at once
 *   /cancel             → cut the running turn: a thinking model is hung up on, a running
 *                         tool is killed, and the agent idles until you speak again (§2)
 *   /quit (or Ctrl-D)   → hang up — the daemon's life is its attachments, not ours
 */

import { TextLineStream } from "@std/streams";
import { attach, resolveAgent, wire } from "./attach.ts";
import { MIND, sessionAddress } from "./session.ts";
import { DIM, painter, RED, RESET } from "./paint.ts";
import { parseVerdict } from "./xi.ts";

// `mu repl [agent] [--session name]` — both are session choices, so arguments, not
// config: the agent picks the door, the session picks the room behind it (default: the
// mind). Naming a session is what births it (§4).
const args = [...Deno.args];
const si = args.indexOf("--session");
const session = si >= 0 ? args.splice(si, 2)[1] ?? "" : MIND;
const a = await resolveAgent(args[0]);
const home = sessionAddress(a.target, session); // refuses a malformed session name

const conn = await attach(a);
let leaving = false;

const write = (s: string) => Deno.stdout.writeSync(new TextEncoder().encode(s));
const prompt = () => write("\n> ");

// every approval card still waiting, oldest first. A bare `/y` answers the newest (the
// one just painted); `/y all` answers the whole pile, which is the point of the list.
const pending: string[] = [];

const p = painter({
  session: { agentId: a.target, id: session }, // the pair — bare names collide (§4)
  home,
  write,
  error: (t) => {
    write(`\n${RED}! ${t}${RESET}`);
    prompt();
  },
  prompt,
  thinking: true,
  gateHint: "  /{y,n} [once|conv|conn|always|all] [reason]",
  onGate: (ref) => {
    if (!pending.includes(ref)) pending.push(ref);
  },
  onGateSettled: (ref) => {
    const i = pending.indexOf(ref);
    if (i >= 0) pending.splice(i, 1);
  },
});

const w = wire(conn, { event: p.event, delta: p.delta });
w.hangup.then(() => {
  if (!leaving) {
    write(`\n${RED}the daemon hung up${RESET}\n`);
    Deno.exit(1);
  }
});

// live: the screen is the present, the log holds the past. The agent's shell stands where
// its principal does — a place it cannot stand in ends the REPL before a word is typed.
const t = await w.request({ op: "tail", session, cwd: Deno.cwd() });
if (!t.ok) {
  write(`${RED}${t.error}${RESET}\n`);
  leaving = true;
  conn.close();
  Deno.exit(1);
}

write(
  `${DIM}mu — ${home} · ${a.model} · log: ${a.dir} · /y[once|conv|conn|always|all] /n /cancel /quit${RESET}\n> `,
);

const lines = Deno.stdin.readable
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new TextLineStream());

for await (const line of lines) {
  const text = line.trim();
  if (text === "") {
    write("> ");
    continue;
  }
  if (text === "/quit" || text === "/q") break;
  if (text === "/cancel") {
    const r = await w.request({ op: "control", kind: "cancel", session });
    write(r.ok ? `${DIM}cancel sent${RESET}\n> ` : `\n${RED}! ${r.error}${RESET}\n> `);
    continue;
  }
  const verdict = text.startsWith("/y") || text.startsWith("/n") ? parseVerdict(text) : undefined;
  if (verdict) {
    if (pending.length === 0) {
      write(`${DIM}nothing pending${RESET}\n> `);
      continue;
    }
    // `all` takes the pile in the order it was asked; a bare word takes the newest card,
    // the one whose text is still on screen
    const answered = verdict.every ? pending.splice(0) : [pending.pop()!];
    for (const ref of answered) {
      const r = await w.request({ op: "permission_response", ref_id: ref, verdict, session });
      if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n> `);
    }
    if (answered.length > 1) write(`${DIM}${answered.length} approvals answered${RESET}\n`);
    continue;
  }
  const r = await w.request({
    op: "message",
    text,
    sender: { address: a.username, name: a.username },
    session,
  });
  if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n> `);
}

leaving = true;
try {
  conn.close();
} catch { /* already closed */ }
write(`\n${DIM}bye${RESET}\n`);
Deno.exit(0);
