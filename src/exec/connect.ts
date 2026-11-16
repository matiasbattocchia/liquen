/**
 * exec/connect.ts — the `connect` tool: an agent signs an account in (§4, §9).
 *
 * The call is gated like any other (`ask` by default), and once it runs it asks main's
 * table of sign-ins for one (connect/signin.ts): a link to open, or a code and where to
 * type it, answered at once and `async`. Whether the sign-in lands comes later, as the
 * call's update, final.
 *
 * The services it offers are the ones main's table holds a flow for, so the schema is
 * built from that list (`connectSpec`). What the call may ask is decided here, before any
 * ticket opens:
 *
 *   • without `account`, a new account for the caller or for `for`. A grant for another
 *     agent lands only as the account their row names (email, or the phone for WhatsApp
 *     and Telegram), so the handle is required, and GitHub, whose account carries no
 *     handle the row keeps, takes no `for`. A new shared account is the CLI's (`--shared`).
 *   • with `account`, a reconnect of a connection the caller may sign in again: its own,
 *     one `for` owns, or a shared one. The grant keeps the row's owner.
 *   • a token names itself (`token`), and is the caller's or `for`'s: capability, not
 *     identity, so there is no handle to match and no connection to reconnect.
 *
 * WhatsApp goes by pairing code alone, since a QR rotates too fast for a chat: the number
 * is the account's for a reconnect, else the phone on the row the grant is for.
 */

import type { ExecTool } from "../xi.ts";
import type { Json } from "../types.ts";
import type { Registry } from "../store/agents.ts";
import type { Connections } from "../store/connections.ts";
import type { SignInAsk, SignIns, Word } from "../connect/signin.ts";
import type { TokenArgs } from "../connect/token/grant.ts";
import { describeCall } from "../describe.ts";

/** The tool's schema, over the services main can sign in. */
export function connectSpec(services: string[]) {
  const strings = { type: "array", items: { type: "string" } };
  return {
    name: "connect",
    input_schema: {
      type: "object" as const,
      properties: {
        service: { type: "string", enum: services },
        account: { type: "string" },
        for: { type: "string" },
        token: {
          type: "object",
          properties: {
            name: { type: "string" },
            env: { type: "string" },
            hosts: strings,
            paths: strings,
            probe: { type: "string" },
          },
          required: ["name", "env", "hosts"],
        },
      },
      required: ["service"],
    },
  };
}

export interface ConnectDeps {
  agentId: string;
  sessionId: string;
  signIns: Pick<SignIns, "open" | "services">;
  log: Pick<Registry, "agents"> & Pick<Connections, "connections">;
  /** A moment as the agent reads the clock: "15:42" in the org's zone. */
  clock: (ms: number) => string;
}

/** What a call asks, checked against the roster and the connections. Throws the sentence
 *  that refuses it. */
export async function askOf(
  input: Record<string, unknown>,
  deps: Pick<ConnectDeps, "agentId" | "log"> & { services: string[] },
): Promise<SignInAsk> {
  const service = String(input.service ?? "").trim();
  if (!deps.services.includes(service)) {
    throw new Error(
      service
        ? `${service} signs in at the terminal: \`liquen connect ${service}\``
        : `say \`service\`: ${deps.services.join(", ")}`,
    );
  }
  const named = typeof input.for === "string" ? input.for.trim() : "";
  const other = named && named !== deps.agentId ? named : undefined;
  const target = other ?? deps.agentId;
  const row = (await deps.log.agents()).find((a) => a.agentId === target);
  if (!row) throw new Error(`no agent "${target}"`);
  const account = typeof input.account === "string" ? input.account.trim() : "";

  if (service === "token") {
    if (account) {
      throw new Error("a token is no connection: ask again under its name, and it is replaced");
    }
    return { service, agent: target, token: tokenOf(input.token) };
  }
  if (input.token !== undefined) throw new Error("`token` goes with service `token` alone");

  if (account) {
    const conn = (await deps.log.connections()).find((c) =>
      c.service === service && c.address.toLowerCase() === account.toLowerCase()
    );
    if (!conn) throw new Error(`${service} ${account} is no connection here`);
    const owner = conn.agentId;
    if (owner && owner !== deps.agentId && owner !== other) {
      throw new Error(`${service} ${conn.address} is ${owner}'s: only a call for them signs it in`);
    }
    return {
      service,
      ...(owner ? { agent: owner } : {}),
      account: conn.address,
      ...(service === "whatsapp" ? { pair: conn.address } : {}),
    };
  }

  const ask: SignInAsk = { service, agent: target };
  if (other) {
    if (service === "github") {
      throw new Error("GitHub takes no `for`: its account carries no handle the row keeps");
    }
    if (service === "whatsapp" || service === "telegram") {
      if (!row.phone) throw new Error(`${target} has no phone on their row to match`);
      ask.phone = row.phone;
    } else {
      if (!row.email) throw new Error(`${target} has no email on their row to match`);
      ask.email = row.email;
    }
  }
  if (service === "whatsapp") {
    if (!row.phone) {
      throw new Error(
        `${target} has no phone on their row: a WhatsApp pairing code is minted for one`,
      );
    }
    ask.pair = row.phone;
  }
  return ask;
}

/** The token a call names, as its fields read: `hosts` and `paths` a list, or one string
 *  split at commas. What they say is checked when the sign-in opens. */
function tokenOf(raw: unknown): TokenArgs {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("service `token` needs `token`: {name, env, hosts}");
  }
  const t = raw as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
      .map(text).filter(Boolean);
  const paths = list(t.paths);
  const probe = text(t.probe);
  return {
    name: text(t.name),
    env: text(t.env),
    hosts: list(t.hosts),
    ...(paths.length ? { paths } : {}),
    ...(probe ? { probe } : {}),
  };
}

/** The first word, as the call's answer. */
export function answerOf(w: Word, clock: (ms: number) => string): string {
  if ("link" in w) {
    return `Open this link to sign in: ${w.link}\nIt is good until ${clock(w.until)}` +
      (w.loopback ? ", and it opens only in a browser on the org's machine" : "") +
      ". You are told when it lands.";
  }
  if ("code" in w) {
    return `The code is ${w.code}. ${w.where} It is good until ${clock(w.until)}. ` +
      "You are told when it lands.";
  }
  return "the sign-in has begun; you are told when it lands";
}

export function connectTool(deps: ConnectDeps): ExecTool {
  const services = deps.signIns.services;
  return {
    spec: connectSpec(services),
    async execute(input, _signal, _report, call) {
      const ask = await askOf((input ?? {}) as Record<string, unknown>, { ...deps, services });
      if (call) {
        ask.caller = {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
          use: call,
          call: describeCall({ name: "connect", input: input as Json }),
        };
      }
      const word = await deps.signIns.open(ask);
      return { output: answerOf(word, deps.clock), files: [], async: true };
    },
  };
}
