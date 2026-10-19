/**
 * connect/status.ts — connection management, read side: what the machinery holds (§4).
 *
 *   deno task status             # agents · connections · memberships · wakes · vault (REDACTED)
 *                                #   · each agent's turns: the running one, the last one's end,
 *                                #   the next wake, the last error
 *   deno task status --json      # the same facts, one JSON document
 *
 * The setup flows (`liquen connect <service>`: pastes, pairing, a sign-in) WRITE the map;
 * this prints it — the first thing a live smoke checks ("did the grant land?"). Every line
 * is read through the store's ports, so it prints the same wherever the catalog put the
 * store. Secrets never print: the vault lists keys, owners, and the FIELD NAMES of each
 * value blob, never values. A turn is read the way `liquen log turns` reads it (`turns.ts`);
 * whether one is running is the session's lease, read without taking it. Env: the store's
 * password when the catalog names Postgres.
 */

import { openStore } from "../store/mod.ts";
import { findRoot, orgFlag } from "../config.ts";
import { entry } from "../entry.ts";
import { helpFlag } from "./help.ts";
import type { Log } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import { turnLockOf } from "../store/lock.ts";
import { MIND, sessionAddress } from "../session.ts";
import { openedBy, readTurns, took, type Turn } from "../turns.ts";
import { errorTextOf, shortId } from "../render.ts";
import type { ErrorEvent, Json } from "../types.ts";

export const USAGE = `usage: liquen status [--dir <org>] [--json]

  What the org holds: the agents, the connections, who is enrolled where, the armed wakes,
  the vault's keys (never a value), and each agent's turns — the one running, how the last
  one ended, the next wake, the last error. --json says the same as one JSON document.`;

/** How far back the turn read looks for the last error and the turns around it. */
const TURNS = 2;

/** One agent's turns, as status reports them. */
export interface AgentTurns {
  agent: string;
  /** The turn holding the mind's lease now: its handle, opener and progress. */
  running:
    | Pick<Turn, "id" | "started" | "steps" | "calls" | "tool_errors"> & { opened_by: string }
    | null;
  /** The newest turn with an end in the log. */
  last:
    | Pick<Turn, "id" | "ended" | "end" | "duration_ms" | "tool_errors" | "tokens"> & {
      opened_by: string;
      error?: string;
      checkpoint: boolean;
    }
    | null;
  /** The next armed wake of the agent's, any session's. */
  next_wake: {
    id: string;
    fire_at: string;
    session: string;
    name?: string;
    cron?: string;
    note: string;
  } | null;
  /** The newest harness error in the mind's room. */
  last_error: { id: string; ts: string; error: string } | null;
}

/** Every fact `status` reports, as data — `--json`'s document. */
export interface OrgStatus {
  agents: ({ agent: string; mind: string } & Record<string, string>)[];
  connections: {
    service: string;
    address: string;
    owner?: string;
    kind: "owned" | "shared" | "stub";
    credential?: string;
    extra?: Json;
  }[];
  memberships: {
    service: string;
    connection: string;
    conversation: string;
    agent: string;
    session?: string;
    left?: string;
  }[];
  wakes: {
    id: string;
    fire_at: string;
    agent: string;
    session: string;
    name?: string;
    cron?: string;
    note: string;
  }[];
  vault: { key: string; owner: string | null; fields: string[] }[];
  turns: AgentTurns[];
}

/** Every fact `status` reports, read through the store's ports. */
export async function statusOf(log: Log, creds: Credentials): Promise<OrgStatus> {
  const agents = await log.agents();
  const armed = await log.armed();
  const turns: AgentTurns[] = [];
  for (const a of agents) {
    const ref = { agentId: a.agentId, id: MIND };
    const home = sessionAddress(a.agentId, MIND);
    const recent = await readTurns(log, ref, TURNS);
    const held = await log.lock(turnLockOf(home)).held();
    const open = recent.at(-1)?.end === "open" ? recent.at(-1) : undefined;
    const ended = recent.findLast((t) => t.end !== "open");
    const wake = armed.filter((t) => t.agentId === a.agentId)
      .sort((x, y) => x.fireAt < y.fireAt ? -1 : 1)[0];
    const [error] = await log.read({ conversation: home, types: ["error"], limit: 1 });
    turns.push({
      agent: a.agentId,
      running: held && open
        ? {
          id: open.id,
          started: open.started,
          steps: open.steps,
          calls: open.calls,
          tool_errors: open.tool_errors,
          opened_by: openedBy(open.opener),
        }
        : null,
      last: ended
        ? {
          id: ended.id,
          ended: ended.ended,
          end: ended.end,
          duration_ms: ended.duration_ms,
          tool_errors: ended.tool_errors,
          tokens: ended.tokens,
          opened_by: openedBy(ended.opener),
          ...(ended.error ? { error: ended.error } : {}),
          checkpoint: ended.checkpoint !== undefined,
        }
        : null,
      next_wake: wake
        ? {
          id: wake.id,
          fire_at: wake.fireAt,
          session: wake.sessionId,
          ...(wake.name ? { name: wake.name } : {}),
          ...(wake.cron ? { cron: wake.cron } : {}),
          note: wake.note,
        }
        : null,
      last_error: error
        ? { id: error.id, ts: error.ts, error: errorTextOf(error as ErrorEvent) }
        : null,
    });
  }
  return {
    agents: agents.map((a) => ({
      agent: a.agentId,
      mind: a.mind,
      ...Object.fromEntries(
        (["provider", "model", "effort", "email", "phone"] as const)
          .filter((k) => a[k]).map((k) => [k, a[k] as string]),
      ),
    })),
    connections: (await log.connections()).map((c) => ({
      service: c.service,
      address: c.address,
      ...(c.agentId ? { owner: c.agentId } : {}),
      kind: c.agentId ? "owned" : c.credentialKey ? "shared" : "stub",
      ...(c.credentialKey ? { credential: c.credentialKey } : {}),
      ...(c.extra ? { extra: c.extra as Json } : {}),
    })),
    memberships: (await log.memberships()).map((m) => ({
      service: m.service,
      connection: m.connection,
      conversation: m.conversation,
      agent: m.agentId,
      session: m.sessionId,
      ...(m.deletedAt ? { left: m.deletedAt } : {}),
    })),
    wakes: armed.map((t) => ({
      id: t.id,
      fire_at: t.fireAt,
      agent: t.agentId,
      session: t.sessionId,
      ...(t.name ? { name: t.name } : {}),
      ...(t.cron ? { cron: t.cron } : {}),
      note: t.note,
    })),
    // the vault shares the store (§4) — keys and value FIELD NAMES only, never secrets
    vault: (await creds.list("")).map((r) => ({
      key: r.key,
      owner: r.agentId ?? null,
      fields: Object.keys(r.value),
    })),
    turns,
  };
}

if (import.meta.main) {
  await entry(async () => {
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const json = org.args.includes("--json");
    const stray = org.args.find((a) => a !== "--json");
    if (stray !== undefined) throw new Error(`unknown argument ${stray}\n${USAGE}`);
    const root = findRoot(org);
    const store = await openStore(root);
    const log = await store.log();
    const creds = await store.vault();
    try {
      const s = await statusOf(log, creds);
      if (json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log("agents (the registry — folders + config.jsonc declare, table mirrors):");
      for (const a of s.agents) {
        const { agent, mind, ...opts } = a;
        const said = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join("  ");
        console.log(`  ${agent}  mind=${mind}${said ? "  " + said : ""}`);
      }

      console.log(
        "\nconnections (the live map: owned=private · org-credentialed=shared · stub=gate-only, §6):",
      );
      for (const c of s.connections) {
        const owner = c.owner ? `owner=${c.owner}` : c.kind;
        const cred = c.credential ? `  cred=${c.credential}` : "";
        const extra = c.extra ? `  extra=${JSON.stringify(c.extra)}` : "";
        console.log(`  ${c.service}:${c.address}  ${owner}${cred}${extra}`);
      }

      console.log("\nmemberships (who is enrolled where — a stamp is a LEAVE):");
      for (const m of s.memberships) {
        const left = m.left ? `  LEFT ${m.left}` : "";
        console.log(
          `  ${m.service}:${m.connection} ${m.conversation}  ∋ ${m.agent}/${m.session}${left}`,
        );
      }

      // armed wakes (§10): the one non-log fact about the future, so the only way to read it
      // is the table. A handle means the org armed it from `liquen schedule`; the rest the
      // agent chose for itself, and a cron says the wake comes back.
      console.log("\narmed wakes (the future — handle = the org's, §10):");
      for (const t of s.wakes) {
        const repeats = t.cron ? `  repeats=${t.cron}` : "";
        const handle = t.name ? `  ${t.name}` : "";
        console.log(`  ${t.fire_at}  ${t.agent}/${t.session}${handle}${repeats}  id=${t.id}`);
        console.log(`    ${t.note}`);
      }

      console.log("\nvault (keys and value field names only — secrets never print):");
      for (const r of s.vault) {
        console.log(
          `  ${r.key}  ${r.owner ? `owner=${r.owner}` : "org"}  fields=${r.fields.join(",")}`,
        );
      }

      console.log(
        "\nturns (each agent's mind — `liquen log turns` lists them, `liquen log tail` watches):",
      );
      for (const t of s.turns) {
        console.log(`  ${t.agent}`);
        console.log(
          t.running
            ? `    running  ${
              shortId(t.running.id)
            } since ${t.running.started} · ${t.running.steps.length} steps · opened by ${t.running.opened_by}`
            : "    running  none",
        );
        console.log(
          t.last
            ? `    last     ${shortId(t.last.id)} ${t.last.end}${
              t.last.error ? `: ${t.last.error}` : ""
            } at ${t.last.ended} · ${took(t.last.duration_ms)} · ${t.last.tool_errors} tool errors`
            : "    last     none",
        );
        console.log(
          t.next_wake
            ? `    wake     ${t.next_wake.fire_at}${t.next_wake.name ? ` ${t.next_wake.name}` : ""}`
            : "    wake     none armed",
        );
        console.log(
          t.last_error
            ? `    error    ${t.last_error.ts}  ${t.last_error.error}`
            : "    error    none",
        );
      }
    } finally {
      await creds.close();
      await log.close();
    }
  });
}
