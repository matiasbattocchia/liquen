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
 *   a gate fires        → an approval card; answer `/y [note]` or `/n [reason]`
 *   /quit (or Ctrl-D)   → clean stop
 */

import { TextLineStream } from "@std/streams";
import { userInfo } from "node:os";
import { type MainConfig, readOrgConfig, start } from "./main.ts";
import type { Draft, Event, MessageEvent, PermissionResponseEvent } from "./types.ts";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const dir = Deno.env.get("MU_DIR") ?? "./data";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const effortEnv = Deno.env.get("MU_EFFORT");
if (effortEnv !== undefined && !(EFFORTS as readonly string[]).includes(effortEnv)) {
  console.error(`MU_EFFORT must be one of ${EFFORTS.join("|")} (got: ${effortEnv})`);
  Deno.exit(1);
}

// The trusted-localhost principal (§9): identity is the OS username — and when the agent
// folder shares that name, no identity map exists at all (principal name = agent name).
// The vision line: user and agent are one. MU_AGENT overrides to talk to another agent.
const username = (() => {
  try {
    return userInfo().username;
  } catch {
    return Deno.env.get("USER") ?? "principal";
  }
})();
const target = Deno.env.get("MU_AGENT") ?? username;
const session = target; // session_id ≈ agent id in v0 (§7)
const home = `mind:${target}`; // the home IS the mind session (§4): steer where the tools live
// resolved here (not just in scanAgents) so the banner names the model that will run
const model = Deno.env.get("MU_MODEL") ??
  (await readOrgConfig(`${dir}/org/config.json`)).model ?? "claude-opus-4-8";

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
  envelope: {
    ...homeEnv,
    sender: { address: username, name: username },
  },
  parts: [{ type: "text", kind: "text", text }],
});

const respond = (
  refId: string, // the gated tool_use — request and response both point at it (§3)
  behavior: "allow" | "deny",
  reason?: string,
): Draft<PermissionResponseEvent> => ({
  ts: new Date().toISOString(),
  type: "permission_response",
  payload: { ref_id: refId },
  envelope: homeEnv,
  parts: [{
    type: "data",
    kind: "permission_response",
    data: { behavior, scope: "once", ...(reason ? { reason } : {}) },
  }],
});

const write = (s: string) => Deno.stdout.writeSync(new TextEncoder().encode(s));

let pendingRequest: string | undefined; // the last approval card — what /y and /n answer

function paint(e: Event): void {
  const self = e.agent?.session_id === session;
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
      const { name, input } = e.parts[0].data;
      write(`\n${DIM}⚙ ${name} ${JSON.stringify(input).slice(0, 120)}${RESET}\n`);
      return;
    }
    case "tool_result": {
      const { is_error } = e.parts[0].data;
      write(is_error ? `${RED}✗ tool failed${RESET}\n` : `${DIM}✓${RESET}\n`);
      return;
    }
    case "permission_request": {
      const { tool, args_preview } = e.parts[0].data;
      pendingRequest = e.payload?.ref_id;
      write(`\n${YELLOW}? approve ${tool} ${args_preview}${RESET}\n  /y [note] · /n [reason]\n> `);
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
  model,
  effort: effortEnv as MainConfig["effort"], // unset ⇒ the API default (high)
  maxTokens: 64_000, // streaming — give the turn room (thinking + tools + text)
  onDelta: (d) => {
    if (d.kind === "text") write(d.text ?? "");
    else if (d.kind === "thinking") write(`${DIM}${d.text ?? ""}${RESET}`);
    else if (d.kind === "error") write(`\n${RED}! ${d.text ?? ""}${RESET}\n`);
  },
});
const unpaint = main.log.subscribe(paint);

write(`${DIM}mu — ${target} · ${model} · log: ${dir} · /y /n /quit${RESET}\n> `);

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
  if (text === "/y" || text.startsWith("/y ") || text === "/n" || text.startsWith("/n ")) {
    if (!pendingRequest) {
      write(`${DIM}nothing pending${RESET}\n> `);
      continue;
    }
    const behavior = text.startsWith("/y") ? "allow" : "deny";
    await main.log.publish(respond(pendingRequest, behavior, text.slice(2).trim() || undefined));
    pendingRequest = undefined;
    continue;
  }
  await main.log.publish(principalMsg(text));
}

unpaint();
await main.stop();
write(`\n${DIM}bye${RESET}\n`);
