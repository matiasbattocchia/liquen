/**
 * repl.ts — `liquen repl`: the v0.0 principal interface, a line REPL attached to the daemon.
 *
 * The REPL is an ATTACH client (DESIGN §2, §9): it never holds a log handle and hosts
 * nothing — it speaks to its agent through the door (`agents/<name>/door.sock`),
 * publishing the principal's messages and painting what the tail pushes back. "Is a
 * daemon running?" is the connect itself: a refused socket means no, and the REPL raises
 * one — main alone (`--ephemeral`), which reaps itself once nothing has been attached for
 * a linger. `liquen start` owns the standing org and its connections; the REPL only ever
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
 *
 * The line you type is the REPL's own (`line.ts`): arrows place the cursor and walk the
 * lines you sent before — this session's, back past this REPL's lifetime, because the log
 * is what remembers them — and the transcript prints above the line without disturbing it.
 * The screen opens on that same past: the room's last messages, stamped and marked, so
 * dialling back in after two days shows what happened while you were gone. Who spoke is
 * a mark, never a name — `❯` is you, `•` is the agent — every message line is dated in
 * the org's clock, and the agent's markdown is shown as styles (`md.ts`), which is how
 * the transcript reads in `paint.ts`. A rule stands between the transcript and the line.
 */

import meta from "../deno.json" with { type: "json" };
import { attach, resolveAgent, wire } from "./attach.ts";
import { createScreen } from "./line.ts";
import { orgFlag } from "./config.ts";
import { MIND, sessionAddress } from "./session.ts";
import { DIM, painter, RED, RESET, YOU } from "./paint.ts";
import { hhmm, ownVoice, textOf } from "./render.ts";
import type { Event } from "./types.ts";
import { parseVerdict } from "./xi.ts";
import { entry } from "./entry.ts";
import { helpFlag } from "./connect/help.ts";

export const USAGE = "usage: liquen repl [--dir <org>] [agent] [--session <name>]";

/** How much of the room the REPL opens on: the last N messages, read off the log the door
 *  already keeps. They are the screen's first paint and the up arrow's reach both — one
 *  past, asked for once. */
// the page counts rows, not turns: the calls and the cards ride back with the words now,
// so the same depth of conversation needs a wider window
const RECALL = 60;

await entry(async () => {
  // `liquen repl [agent] [--session name]` — both are session choices, so arguments, not
  // config: the agent picks the door, the session picks the room behind it (default: the
  // mind). Naming a session is what births it (§4).
  const org = orgFlag();
  const args = org.args;
  helpFlag(args, USAGE);
  const si = args.indexOf("--session");
  const session = si >= 0 ? args.splice(si, 2)[1] ?? "" : MIND;
  // a flag is never an agent name: `--typo` would otherwise be looked up in the roster and
  // reported as a missing agent, which sends the reader to the wrong file
  const stray = args.find((x) => x.startsWith("-"));
  if (stray) throw new Error(`unknown flag ${stray}\n${USAGE}`);
  const a = await resolveAgent(args[0], org.dir);
  const home = sessionAddress(a.target, session); // refuses a malformed session name

  const conn = await attach(a);
  let leaving = false;

  // the screen owns the line being typed, so the transcript may print while it is typed;
  // the ring it opens with is the principal's half of what the tail recalled — their own
  // words, the only ones the up arrow is for
  let recalled: Event[] = [];
  const me = { agentId: a.target, id: session }; // the pair — bare names collide (§4)
  const screen = createScreen({
    head: `${YOU} `, // the line wears the principal's mark, as its recalled lines do
    // and once sent it stands as a recalled line would: the time, the mark, the words
    sent: (line) => `${DIM}${hhmm(new Date().toISOString(), a.timezone)}${RESET} ${YOU} ${line}`,
    recalled: () => recalled.filter((e) => e.type === "message" && !ownVoice(e, me)).map(textOf),
  });
  const write = (s: string) => screen.write(s);
  const prompt = () => screen.prompt();

  // every approval card still waiting, oldest first. A bare `/y` answers the newest (the
  // one just painted); `/y all` answers the whole pile, which is the point of the list.
  const pending: string[] = [];

  const p = painter({
    session: me,
    home,
    zone: a.timezone,
    write,
    error: (t) => {
      screen.gap();
      write(`${RED}! ${t}${RESET}`);
      prompt();
    },
    prompt,
    gap: () => screen.gap(),
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
      screen.close();
      Deno.exit(1);
    }
  });

  // live: the tail opens on the present, and carries the room's last messages back with
  // it. The agent's shell stands where its principal does — a place it cannot stand in
  // ends the REPL before a word is typed.
  const t = await w.request({ op: "tail", session, cwd: Deno.cwd(), recall: RECALL });
  if (!t.ok) {
    write(`${RED}${t.error}${RESET}\n`);
    leaving = true;
    conn.close();
    Deno.exit(1);
  }
  recalled = t.recalled ?? [];

  // the banner names what is about to run: the build you are speaking to, the room, and
  // the model with the effort it will think at
  write(
    `${DIM}liquen v${meta.version} — ${home} · ${a.model}${a.effort ? ` (${a.effort})` : ""}${
      a.paused ? " · PAUSED (mind: false — reads only)" : ""
    } · /y[once|conv|conn|always|all] /n /cancel /quit${RESET}\n`,
  );
  p.recap(recalled);

  for await (const line of screen.lines()) {
    const text = line.trim();
    if (text === "") continue;
    if (text === "/quit" || text === "/q") break;
    if (text === "/cancel") {
      const r = await w.request({ op: "control", kind: "cancel", session });
      write(r.ok ? `${DIM}cancel sent${RESET}\n` : `\n${RED}! ${r.error}${RESET}\n`);
      continue;
    }
    const verdict = text.startsWith("/y") || text.startsWith("/n") ? parseVerdict(text) : undefined;
    if (verdict) {
      if (pending.length === 0) {
        write(`${DIM}nothing pending${RESET}\n`);
        continue;
      }
      // `all` takes the pile in the order it was asked; a bare word takes the newest card,
      // the one whose text is still on screen
      const answered = verdict.every ? pending.splice(0) : [pending.pop()!];
      for (const ref of answered) {
        const r = await w.request({ op: "permission_response", ref_id: ref, verdict, session });
        if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n`);
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
    if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n`);
  }

  leaving = true;
  try {
    conn.close();
  } catch { /* already closed */ }
  screen.close();
  write(`\n${DIM}bye${RESET}\n`);
  Deno.exit(0);
});
