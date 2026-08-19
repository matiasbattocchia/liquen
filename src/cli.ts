/**
 * cli.ts — the v0.0 principal interface (DESIGN §2, §9): a line REPL over the log.
 *
 * The CLI is a *client* of the harness, shaped like any connection: it publishes the
 * principal's messages and subscribes to paint what the agent does. It holds no harness
 * state — main (hosted in-process here) does the fan-out; the log is the conversation.
 *
 *   you type            → publish a principal `message` to home
 *   the agent thinks    → thinking deltas stream dim; assistant text streams live
 *   the agent acts      → tool_use/result lines; peer sends as `→ conv: text`
 *   a gate fires        → an approval card; answer `/{y,n} [conv|conn|all] [reason]` —
 *                         a scope word makes the verdict STANDING (remembered policy, §9)
 *   /quit (or Ctrl-D)   → clean stop
 */

import { TextLineStream } from "@std/streams";
import { userInfo } from "node:os";
import { start } from "./main.ts";
import { ensureOrgConfig, readAgentOverrides } from "./config.ts";
import { outcomeLine, ownVoice } from "./render.ts";
import { describeCall } from "./describe.ts";
import { parseVerdict } from "./xi.ts";
import type {
  Draft,
  Event,
  MessageEvent,
  PermissionResponseEvent,
  PermissionVerdict,
} from "./types.ts";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

// The org lives where you run mu — a path constant like any other. Every knob is in the
// catalog (`org/config.jsonc`, config.ts); env is for secrets (ANTHROPIC_API_KEY) only.
const dir = "./data";

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
// resolved here in scanAgents' OWN order (agent file → org catalog) so the banner names
// the model that will actually run: the agent's own config.jsonc outranks the org's
const model = (await readAgentOverrides(dir, target)).agent?.model ??
  (await ensureOrgConfig(dir)).agent.model;

// the framework way: running IS scaffolding — a blank org bootstraps your alter-ego
await Deno.mkdir(`${dir}/agents/${target}`, { recursive: true });

const homeEnv = {
  service: "local" as const,
  connection_address: "agent",
  conversation: { address: home },
};

const principalMsg = (text: string): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  // the principal's stamp (§3): agent.id = whose mind, session_id = entered through the
  // harness (deterministic in v0, so it stamps at append — even the session's first line).
  // No turn_id, ever: that is the model's mark, and its absence is what keeps this row
  // input. One complex, two halves, told apart by turn_id alone.
  agent: { id: target, session_id: session },
  envelope: {
    ...homeEnv,
    sender: { address: username, name: username },
  },
  parts: [{ type: "text", kind: "text", text }],
});

const respond = (
  refId: string, // the gated tool_use — request and response both point at it (§3)
  verdict: PermissionVerdict, // behavior + scope + reason, as `parseVerdict` read them
): Draft<PermissionResponseEvent> => ({
  ts: new Date().toISOString(),
  type: "permission_response",
  payload: { ref_id: refId },
  envelope: homeEnv,
  parts: [{ type: "data", kind: "permission_response", data: verdict }],
});

const write = (s: string) => Deno.stdout.writeSync(new TextEncoder().encode(s));

let pendingRequest: string | undefined; // the last approval card — what /y and /n answer

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
      if (e.envelope.conversation.address === home) write("\n> "); // body already streamed
      else write(`\n${CYAN}→ ${e.envelope.conversation.address}:${RESET} ${text}\n> `);
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
      pendingRequest = e.payload?.ref_id;
      write(
        `\n${YELLOW}? approve ${detail}${RESET}\n  /{y,n} [conv|conn|all] [reason]\n> `,
      );
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

const main = await start({
  dir, // no principals: the folders under agents/ declare the org (the framework way, §9)
  // …and no settings either: everything funnels from the catalog (org/agent config.jsonc)
  onDelta: (d) => {
    if (d.kind === "text") write(d.text ?? "");
    else if (d.kind === "thinking") write(`${DIM}${d.text ?? ""}${RESET}`);
    else if (d.kind === "error") write(`\n${RED}! ${d.text ?? ""}${RESET}\n`);
  },
});
const unpaint = main.log.subscribe(paint);

write(`${DIM}mu — ${target} · ${model} · log: ${dir} · /y[conv|conn|all] /n /quit${RESET}\n> `);

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
    if (!pendingRequest) {
      write(`${DIM}nothing pending${RESET}\n> `);
      continue;
    }
    await main.log.publish(respond(pendingRequest, verdict));
    pendingRequest = undefined;
    continue;
  }
  await main.log.publish(principalMsg(text));
}

unpaint();
await main.stop();
write(`\n${DIM}bye${RESET}\n`);
