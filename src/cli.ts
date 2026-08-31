/**
 * cli.ts — `mu repl`: the v0.0 principal interface, a line REPL attached to the daemon.
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
 *   /quit (or Ctrl-D)   → hang up — the daemon's life is its attachments, not ours
 */

import { TextLineStream } from "@std/streams";
import { userInfo } from "node:os";
import { findRoot, readConfig } from "./config.ts";
import { outcomeLine, ownVoice, SILENCE, silent } from "./render.ts";
import { describeCall } from "./describe.ts";
import { parseVerdict } from "./xi.ts";
import type { Delta, Event } from "./types.ts";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

// A raised daemon owes the REPL a bound socket within this window — seeding, the exec
// planes and the proxy all sit between spawn and bind.
const ATTACH_TIMEOUT_MS = 20_000;
const ATTACH_RETRY_MS = 250;

// The org lives where you run mu: the nearest config.jsonc up from cwd is the project
// marker (findRoot), and the substrate sits beside it. Env is for secrets only.
const root = findRoot();
const dir = `${root}/data`;
const catalog = await readConfig(root);

// The trusted-localhost principal (§9): identity is the OS username — and when the agent
// folder shares that name, no identity map exists at all (principal name = agent name).
// The vision line: user and agent are one. `mu <agent>` — a session choice, so an
// argument, not config — talks to another agent.
const username = (() => {
  try {
    return userInfo().username;
  } catch {
    return "principal";
  }
})();
const target = Deno.args[0] ?? username;
const session = target; // session_id ≈ agent id in v0 (§7)
const home = `mind:${target}`; // the home IS the mind session (§4): steer where the tools live
// the roster is the catalog's: an agent the config does not declare cannot run
if (!(target in catalog.agents)) {
  console.error(
    `no agent "${target}" in ${root}/config.jsonc — declare it: "agents": { "${target}": {} }`,
  );
  Deno.exit(1);
}
// resolved here in the roster's OWN order (agents.<name> → org.agent) so the banner names
// the model that will actually run
const model = catalog.agents[target].model ?? catalog.org.agent.model;

/** Attach to the agent's door. A refusal means no daemon — raise an ephemeral one and
 *  keep connecting until it binds; the daemon takes itself down (the linger) when the
 *  last attachment is gone. */
async function attach(): Promise<Deno.UnixConn> {
  const path = `${dir}/agents/${target}/door.sock`;
  try {
    return await Deno.connect({ transport: "unix", path });
  } catch { /* nothing listening — raise a daemon */ }
  const daemon = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./main.ts", import.meta.url).href, "--ephemeral"],
    cwd: root,
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
        console.error(`no daemon answered on ${path} — run \`mu start\` to see it boot`);
        Deno.exit(1);
      }
      await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS));
    }
  }
}

const conn = await attach();
let leaving = false;

/* ── the wire: newline-JSON requests answered in order, {event}/{delta} pushed after
 *    a tail — writes ride one chain, replies resolve oldest-first ─────────────────── */

interface Reply {
  ok?: boolean;
  error?: string;
  id?: string;
}

const encoder = new TextEncoder();
let wchain: Promise<void> = Promise.resolve();
const awaiting: ((r: Reply) => void)[] = [];

function request(req: Record<string, unknown>): Promise<Reply> {
  const reply = new Promise<Reply>((resolve) => awaiting.push(resolve));
  wchain = wchain.then(async () => {
    const bytes = encoder.encode(JSON.stringify(req) + "\n");
    for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
  }).catch(() => {/* the daemon hung up — the read pump reports and exits */});
  return reply;
}

const write = (s: string) => Deno.stdout.writeSync(new TextEncoder().encode(s));

// every approval card still waiting, oldest first. A bare `/y` answers the newest (the one
// just painted); `/y all` answers the whole pile, which is the point of having the list.
const pending: string[] = [];

// The REPL is a surface like any other, so `SILENCE` has to LOOK like silence here too —
// but text arrives as deltas, before we know which word it is. So hold back whatever could
// still turn out to be the sentinel and release it the moment it can't: an ordinary answer
// pays one delta of latency, and a turn that says nothing prints nothing.
let held = "";
const say = (text: string) => {
  held += text;
  if (SILENCE.startsWith(held.trimStart())) return;
  write(held);
  held = "";
};

function onDelta(d: Delta): void {
  if (d.kind === "text") say(d.text ?? "");
  else if (d.kind === "thinking") write(`${DIM}${d.text ?? ""}${RESET}`);
  else if (d.kind === "error") write(`\n${RED}! ${d.text ?? ""}${RESET}\n`);
}

function paint(e: Event): void {
  const self = ownVoice(e, session); // the model's output (§3) — the principal's own
  // stamped lines stay non-self: locally they're already on screen
  switch (e.type) {
    case "message": {
      const via = (e.extra?.via ?? undefined) as { service?: string } | undefined;
      const text = e.parts.filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text).join(" ");
      if (!self) {
        // the principal spoke — locally it's already on screen; through a mind-alias
        // surface (§4) the mirror's copy is the only sighting, so paint it, tagged
        if (via && e.envelope.conversation.address === home) {
          write(`\n${CYAN}[via ${via.service}]${RESET} ${text}\n> `);
        }
        return;
      }
      if (via) return; // an alias CC is plumbing — its mind original already painted
      if (e.envelope.conversation.address === home) {
        // the message is published: whatever `say` is still holding was the sentinel, or
        // the tail of a reply that ended mid-word. Either way this turn is over.
        if (!silent(e)) write(held);
        held = "";
        write("\n> "); // the body itself already streamed
      } else write(`\n${CYAN}→ ${e.envelope.conversation.address}:${RESET} ${text}\n> `);
      return;
    }
    case "tool_use": {
      write(`\n${DIM}⚙ ${describeCall(e.parts[0].data)}${RESET}\n`);
      return;
    }
    case "tool_result": {
      // a deferred outcome is the harness reporting on a call the principal approved — it
      // reads as a sentence, not a checkmark, because nothing on screen is expecting it
      if (e.payload.deferred) {
        write(`\n${YELLOW}${outcomeLine(e, 160)}${RESET}\n> `);
        return;
      }
      const { is_error } = e.parts[0].data;
      write(is_error ? `${RED}✗ tool failed${RESET}\n` : `${DIM}✓${RESET}\n`);
      return;
    }
    case "permission_request": {
      const { detail } = e.parts[0].data;
      const ref = e.payload?.ref_id;
      if (ref && !pending.includes(ref)) pending.push(ref);
      write(
        `\n${YELLOW}? approve ${detail}${RESET}\n  /{y,n} [once|conv|conn|always|all] [reason]\n> `,
      );
      return;
    }
    case "permission_response": {
      // settled elsewhere (the agent withdrew it, a surface answered it) — it is no longer
      // ours to answer, so `/y all` must not reach for it
      const i = pending.indexOf(e.payload?.ref_id as string);
      if (i >= 0) pending.splice(i, 1);
      return;
    }
    case "error": {
      write(`\n${RED}! ${JSON.stringify(e.parts[0]?.data ?? {})}${RESET}\n> `);
      return;
    }
    default:
      return; // thinking is streamed as deltas; the rest is substrate
  }
}

// the read pump: demux by shape — pushes carry {event}/{delta}, everything else is the
// oldest outstanding request's reply
(async () => {
  const lines = conn.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { event?: Event; delta?: Delta } & Reply;
    if (msg.event) paint(msg.event);
    else if (msg.delta) onDelta(msg.delta);
    else awaiting.shift()?.(msg);
  }
})().catch(() => {/* the socket died under the pump — same hang-up */}).finally(() => {
  if (!leaving) {
    write(`\n${RED}the daemon hung up${RESET}\n`);
    Deno.exit(1);
  }
});

await request({ op: "tail" }); // live: the screen is the present, the log holds the past

write(
  `${DIM}mu — ${target} · ${model} · log: ${dir} · /y[once|conv|conn|always|all] /n /quit${RESET}\n> `,
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
      const r = await request({ op: "permission_response", ref_id: ref, verdict });
      if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n> `);
    }
    if (answered.length > 1) write(`${DIM}${answered.length} approvals answered${RESET}\n`);
    continue;
  }
  const r = await request({
    op: "message",
    text,
    sender: { address: username, name: username },
  });
  if (!r.ok) write(`\n${RED}! ${r.error}${RESET}\n> `);
}

leaving = true;
try {
  conn.close();
} catch { /* already closed */ }
write(`\n${DIM}bye${RESET}\n`);
Deno.exit(0);
