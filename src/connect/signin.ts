/**
 * connect/signin.ts — every sign-in in flight, held by main (DESIGN §4, §9).
 *
 * A sign-in is asked for by the `connect` tool or by a CLI door over main's socket, and
 * both reach one table: a ticket in the vault (`sign_ins`), keyed by service and by who
 * signs in. Two asks for the same sign-in share its ticket, so a link is handed out once
 * and a phone is never linked twice.
 *
 * A link service (Google, Microsoft, Slack) is served on its oauth socket while any of its
 * tickets is open: one door, many sign-ins, each link carrying its ticket alone. A page
 * service (Telegram, Mercado Pago, a pasted token) is a link too, whose door draws the
 * form the person types the secret into (page.ts). A code service (WhatsApp, GitHub) runs
 * its poll here. Either way the handler judges the account the service vouched for
 * against the ticket (`judge`), and the first callback settles it. The outcome is said
 * once: to every call that asked, as the call's update, final, and to every CLI still
 * listening. A ticket past its deadline lapses the same way.
 *
 * The tickets outlive main: at boot `resume` lapses what ran out, opens the doors the rest
 * need, and takes the polls up where they were noted.
 */

import type { CredentialRow, Credentials, TicketRow } from "../store/credentials.ts";
import type { Appender } from "../store/log.ts";
import type { Connections } from "../store/connections.ts";
import type { Gates } from "../store/gates.ts";
import type { Registry } from "../store/agents.ts";
import type { CallRef } from "../xi.ts";
import type { Json } from "../types.ts";
import { updateDraft } from "../late.ts";
import { disabled } from "../config.ts";
import { socketOf } from "../edge.ts";
import { MIND } from "../session.ts";
import { serveSocket } from "./serve.ts";
import { steeringRefused } from "./steering.ts";
import { type TokenArgs, tokenKey } from "./token/grant.ts";

/** How long a link lives. */
export const SIGN_IN_MS = 15 * 60_000;
/** How often main looks for a sign-in past its deadline. */
const SWEEP_MS = 15_000;
/** How long an ask waits for a code service to name its first code. */
const FIRST_WORD_MS = 60_000;

/** One ask for a sign-in, from the tool or a CLI door. */
export interface SignInAsk {
  service: string;
  /** The agent the grant is for; absent, the org's shared account. */
  agent?: string;
  /** A reconnect: the connection address the sign-in must come back as. */
  account?: string;
  /** A grant for another agent: the handle on their row the account must match. */
  email?: string;
  phone?: string;
  /** The CLI's `--app` and `--scopes`. */
  app?: string;
  scopes?: string[];
  /** WhatsApp: the number a pairing code is minted for; absent, a QR. */
  pair?: string;
  /** WhatsApp and Telegram: keep the account to its owner's mind surfaces (§4). Each
   *  sign-in says it anew: one without it gives the agent the whole account. */
  steering?: boolean;
  /** A pasted token: what it is for, and where it may be spent. */
  token?: TokenArgs;
  /** The tool call to tell the outcome to. */
  caller?: Caller;
}

/** A tool call waiting on a sign-in: where its update goes. */
export interface Caller {
  agentId: string;
  sessionId: string;
  use: CallRef;
  call: string; // the call as a person reads it
}

/** A word on a sign-in: what the person does, then how it ended. `until` is epoch ms. */
export type Word =
  | { link: string; until: number; loopback: boolean }
  | { code: string; where: string; until: number }
  | { qr: string; until: number }
  | { landed: string; missing?: string[] }
  | { refused: string }
  | { lapsed: true };

/** Whether a word ends the sign-in. */
export function ends(w: Word): boolean {
  return "landed" in w || "refused" in w || "lapsed" in w;
}

/** The account a service vouched for, as the judge reads it: the connection address the
 *  grant writes, the identity a reconnect is pinned to when that differs, and the handles
 *  a grant for another agent is matched by. */
export interface Who {
  address: string;
  account?: string;
  email?: string;
  phone?: string;
}

/** What a door's handler and a code service's poll ask of the sign-in they serve. */
export interface Gate {
  /** The open ticket, while it is in time; null once it settled or ran out. */
  view(ticket: string): Promise<TicketRow | null>;
  /** Settle the ticket on the account the service vouched for: whom to bind the grant to,
   *  or the sentence that refused it, already told. */
  judge(ticket: string, who: Who): Promise<{ agent?: string } | { refused: string }>;
  /** The grant is written: tell it. */
  landed(ticket: string, account: string, missing?: string[]): Promise<void>;
  /** The sign-in failed before or after the judge: settle it and tell why. */
  failed(ticket: string, why: string): Promise<void>;
  /** Keep what a poll learned on the ticket, so a restart takes it up. */
  note(ticket: string, extra: Record<string, unknown>): Promise<void>;
  /** A new instruction for the person (a QR rotating): kept, and said to the listeners. */
  say(ticket: string, word: Word): Promise<void>;
}

/** The writes a sign-in makes and the rows it reads. */
export type SignInLog =
  & Pick<Appender, "publish">
  & Pick<Registry, "agents">
  & Pick<Connections, "connections" | "upsertConnections" | "upsertMemberships">
  & Partial<Pick<Gates, "unended">>;

/** What every flow is handed. */
export interface FlowCtx {
  root: string;
  creds: Credentials;
  log: SignInLog;
  /** The org's edge as it stands when a flow reads it. */
  edge: { publicUrl: string | null; port: number };
  /** Whether a service is on: false for one declared and disabled, whose sign-in fails.
   *  Absent, every service is. */
  enabled?(service: string): boolean;
  /** Declare the service when it is new, with the knobs it starts with, and have the
   *  running org start it. */
  declare(service: string, knobs?: Record<string, Json>): Promise<void>;
}

/** One service's sign-in. */
export interface SignInFlow {
  /** What the ticket keeps beyond the ask (the app, the scopes); throws the sentence that
   *  refuses a sign-in that cannot start. */
  prepare(ask: SignInAsk, ctx: FlowCtx): Promise<Record<string, unknown>>;
  /** How long the person has. */
  life(ask: SignInAsk): number;
  /** False for a grant that runs no process (a token), so landing declares nothing. */
  declares?: false;
  /** A link service's handler, mounted while its tickets are open, and one ticket's link. */
  link?: {
    handler(ctx: FlowCtx, gate: Gate): (req: Request) => Promise<Response>;
    start(ticket: TicketRow, ctx: FlowCtx): { link: string; loopback: boolean };
  };
  /** A code service's sign-in, run from its ticket until it lands or fails, taking up what
   *  the ticket noted. Each code goes out through `gate.say`. */
  run?(ticket: TicketRow, ctx: FlowCtx, gate: Gate, signal: AbortSignal): Promise<void>;
}

/** What a ticket keeps, read back. */
interface Kept {
  account?: string;
  email?: string;
  phone?: string;
  callers?: Caller[];
  said?: Word;
}

const keptOf = (t: TicketRow): Kept => t.extra as Kept;

/** Who signs in, as the key a sign-in is opened under: the account whenever it is known
 *  before the sign-in (a reconnect, a WhatsApp pairing code's number, a token's vault
 *  key), else whom the grant is for. */
export function keyOf(ask: SignInAsk): string {
  if (ask.account) return `account:${same(ask.account)}`;
  if (ask.pair) return `account:${digits(ask.pair)}`;
  if (ask.token) return `account:${tokenKey(ask.token.name, ask.agent)}`;
  return ask.agent ? `agent:${ask.agent}` : "org";
}

/** An address as compared: emails and logins ignore case. */
function same(s: string): string {
  return s.trim().toLowerCase();
}

/** A phone as compared: its digits. */
export function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Every sign-in in flight, over the vault. */
export interface SignIns {
  /** The services it can sign in: one per flow it was handed. */
  services: string[];
  /** Open a sign-in, or join the one open under the same key: its first word, the link or
   *  the code. `listen` hears every word, that first one included and the outcome last.
   *  Throws the sentence that refuses it. */
  open(ask: SignInAsk, listen?: (w: Word) => void): Promise<Word>;
  /** At boot: lapse what ran out, serve what is open, take the polls up. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

export function createSignIns(
  ctx: FlowCtx,
  flows: Record<string, SignInFlow>,
  opts: { now?: () => number; sweepMs?: number; firstWordMs?: number } = {},
): SignIns {
  const now = opts.now ?? Date.now;
  const { creds, log } = ctx;
  const doors = new Map<string, Promise<Deno.HttpServer<Deno.UnixAddr>>>();
  const listeners = new Map<string, Set<(w: Word) => void>>();
  const firsts = new Map<string, PromiseWithResolvers<Word>>();
  const runs = new Map<string, AbortController>();
  // tickets the judge settled, for the word that follows it
  const judged = new Map<string, TicketRow>();
  const told = new Set<string>();
  // doors closing behind their last answer, for `close` to wait out
  const closing = new Set<Promise<void>>();

  const hear = (ticket: string, w: Word) => {
    for (const l of listeners.get(ticket) ?? []) {
      try {
        l(w);
      } catch {
        listeners.get(ticket)?.delete(l); // a listener that hung up
      }
    }
  };

  /** The outcome, once per ticket: each caller's update, final, and each listener. */
  const tell = async (t: TicketRow, w: Word) => {
    if (told.has(t.ticket)) return;
    told.add(t.ticket);
    judged.delete(t.ticket);
    runs.get(t.ticket)?.abort();
    runs.delete(t.ticket);
    firsts.get(t.ticket)?.resolve(w);
    firsts.delete(t.ticket);
    const at = new Date(now()).toISOString();
    for (const c of keptOf(t).callers ?? []) {
      await log.publish(updateDraft({
        agentId: c.agentId,
        sessionId: c.sessionId,
        use: c.use,
        call: c.call,
        output: outcomeText(t.service, w),
        ...("landed" in w ? {} : { is_error: true }),
        final: true,
      }, at)).catch((err) => console.error(`[sign-in] ${t.ticket}: its update:`, err));
    }
    hear(t.ticket, w);
    listeners.delete(t.ticket);
    await idle(t.service);
  };

  /** Close a link service's door when none of its tickets is open. The callback that
   *  settled the last one is still being answered through it, and a shutdown waits for
   *  every request in flight, so the door closes behind that answer, not before it. The
   *  socket goes with it unless another sign-in opened the door again meanwhile. */
  const idle = async (service: string) => {
    const door = doors.get(service);
    if (!door) return;
    if ((await creds.tickets()).some((t) => t.service === service)) return;
    doors.delete(service);
    const server = await door.catch(() => undefined);
    const shut = (async () => {
      await server?.shutdown();
      if (!doors.has(service)) {
        await Deno.remove(socketOf(ctx.root, service, "oauth")).catch(() => {});
      }
    })().catch((err) => console.error(`[sign-in] ${service}'s door:`, err));
    closing.add(shut);
    void shut.then(() => closing.delete(shut));
  };

  const serve = (service: string): Promise<unknown> => {
    let door = doors.get(service);
    if (!door) {
      const flow = flows[service];
      door = serveSocket(socketOf(ctx.root, service, "oauth"), flow.link!.handler(ctx, gate));
      doors.set(service, door);
      door.catch(() => doors.delete(service));
    }
    return door;
  };

  const lapse = async (t: TicketRow) => {
    if (!(await creds.settleTicket(t.ticket))) return;
    await tell(t, { lapsed: true });
  };

  const sweep = async () => {
    for (const t of await creds.tickets()) if (t.deadline <= now()) await lapse(t);
  };

  const gate: Gate = {
    async view(ticket) {
      const t = await creds.ticket(ticket);
      return t && t.deadline > now() ? t : null;
    },

    async judge(ticket, who) {
      const t = await gate.view(ticket);
      if (!t) return { refused: "this sign-in is over: ask for a new one" };
      if (!(await creds.settleTicket(ticket))) return { refused: "this link was already used" };
      judged.set(ticket, t);
      const why = await refusal(t, who);
      if (why) {
        await tell(t, { refused: why });
        return { refused: why };
      }
      return t.agentId ? { agent: t.agentId } : {};
    },

    async landed(ticket, account, missing) {
      const t = judged.get(ticket);
      if (!t) return;
      if (flows[t.service]?.declares !== false) {
        await ctx.declare(t.service).catch((err) =>
          console.error(`[sign-in] ${t.service} could not be declared:`, err)
        );
      }
      await tell(t, { landed: account, ...(missing?.length ? { missing } : {}) });
    },

    async failed(ticket, why) {
      const t = judged.get(ticket) ?? await creds.ticket(ticket);
      if (!t) return;
      await creds.settleTicket(ticket);
      await tell(t, { refused: why });
    },

    note: (ticket, extra) => creds.noteTicket(ticket, extra),

    async say(ticket, word) {
      await creds.noteTicket(ticket, { said: word });
      firsts.get(ticket)?.resolve(word);
      firsts.delete(ticket);
      hear(ticket, word);
    },
  };

  /** Why the account the service vouched for does not land on this ticket; undefined when
   *  it does. */
  const refusal = async (t: TicketRow, who: Who): Promise<string | undefined> => {
    const kept = keptOf(t);
    const account = who.account ?? who.address;
    if (kept.account && same(kept.account) !== same(account)) {
      return `signed in as ${account}, and this sign-in was for ${kept.account}: ` +
        "nothing was connected";
    }
    if (kept.email && same(kept.email) !== same(who.email ?? account)) {
      return `signed in as ${who.email ?? account}, which is not ${t.agentId}'s ` +
        `(${kept.email}): nothing was connected`;
    }
    if (kept.phone && digits(kept.phone) !== digits(who.phone ?? account)) {
      return `paired ${who.phone ?? account}, which is not ${t.agentId}'s number ` +
        `(${kept.phone}): nothing was connected`;
    }
    const row = (await log.connections()).find((c) =>
      c.service === t.service && c.address === who.address
    );
    if (row && (row.agentId ?? undefined) !== t.agentId) {
      return `${who.address} is ${row.agentId ? `${row.agentId}'s` : "shared"}: ` +
        "nothing was connected";
    }
    return undefined;
  };

  /** Start what an open ticket needs: its door, or its poll. */
  const go = async (t: TicketRow) => {
    const flow = flows[t.service];
    if (flow.link) {
      await serve(t.service);
      return;
    }
    if (!flow.run || runs.has(t.ticket)) return;
    const control = new AbortController();
    runs.set(t.ticket, control);
    flow.run(t, ctx, gate, control.signal).catch(async (err) => {
      if (control.signal.aborted) return;
      await gate.failed(t.ticket, err instanceof Error ? err.message : String(err));
    });
  };

  const sweeper = setInterval(() => {
    sweep().catch((err) => console.error("[sign-in] sweep:", err));
  }, opts.sweepMs ?? SWEEP_MS);

  return {
    services: Object.keys(flows),

    async open(ask, listen) {
      const flow = flows[ask.service];
      if (!flow) {
        throw new Error(
          `${ask.service} signs in at the terminal: \`liquen connect ${ask.service}\``,
        );
      }
      if (ctx.enabled?.(ask.service) === false) throw disabled(ask.service);
      if (ask.agent && !(await log.agents()).some((a) => a.agentId === ask.agent)) {
        throw new Error(`no agent "${ask.agent}": a grant binds to an agent on the roster`);
      }
      const unsteered = ask.steering ? steeringRefused(ask) : undefined;
      if (unsteered) throw unsteered;
      await sweep();
      const prepared = await flow.prepare(ask, ctx);
      const { caller, ...rest } = ask;
      const { row, opened } = await creds.openTicket({
        service: ask.service,
        key: keyOf(ask),
        ...(ask.agent ? { agentId: ask.agent } : {}),
        extra: { ...rest, ...prepared, ...(caller ? { callers: [caller] } : {}) },
        deadline: now() + flow.life(ask),
      });
      if (!opened && caller) {
        await creds.noteTicket(row.ticket, { callers: [...keptOf(row).callers ?? [], caller] });
      }
      if (listen) {
        let set = listeners.get(row.ticket);
        if (!set) listeners.set(row.ticket, set = new Set());
        set.add(listen);
      }
      const said = keptOf(row).said;
      if (flow.link) {
        await serve(ask.service);
        let word = said;
        if (!word) {
          const { link, loopback } = flow.link.start(row, ctx);
          word = { link, until: row.deadline, loopback };
          await creds.noteTicket(row.ticket, { said: word });
        }
        listen?.(word);
        return word;
      }
      if (said && !opened) {
        listen?.(said);
        return said;
      }
      let first = firsts.get(row.ticket);
      if (!first) firsts.set(row.ticket, first = Promise.withResolvers<Word>());
      await go(row);
      const timer = setTimeout(
        () => first!.reject(new Error(`${ask.service} named no code in time`)),
        opts.firstWordMs ?? FIRST_WORD_MS,
      );
      try {
        const word = await first.promise;
        if (ends(word)) throw new Error(outcomeText(ask.service, word));
        return word;
      } finally {
        clearTimeout(timer);
      }
    },

    async resume() {
      await sweep();
      const open = await creds.tickets();
      for (const t of open) {
        await go(t).catch((err) =>
          console.error(`[sign-in] ${t.service} ${t.ticket} could not be taken up:`, err)
        );
      }
      // a call answered with a sign-in whose ticket is gone has nothing more coming
      const waiting = new Set(open.flatMap((t) => (keptOf(t).callers ?? []).map((c) => c.use.id)));
      for (const use of await log.unended?.("connect") ?? []) {
        if (waiting.has(use.id) || !use.agent) continue;
        await log.publish(updateDraft({
          agentId: use.agent.id,
          sessionId: use.agent.session_id ?? MIND,
          use: { id: use.id, turn_id: use.payload.turn_id },
          call: "connect",
          output: LOST,
          is_error: true,
          final: true,
        }, new Date(now()).toISOString()));
      }
    },

    async close() {
      clearInterval(sweeper);
      for (const c of runs.values()) c.abort();
      runs.clear();
      for (const [service, door] of doors) {
        doors.delete(service);
        const server = await door.catch(() => undefined);
        await server?.shutdown();
        await Deno.remove(socketOf(ctx.root, service, "oauth")).catch(() => {});
      }
      await Promise.all(closing);
    },
  };
}

/** The app a sign-in goes through: the one named, else the vault's one app for the
 *  service. Several and none named refuses, naming the CLI's `--app`. */
export async function appOf(
  creds: Pick<Credentials, "get" | "list">,
  prefix: string,
  command: string,
  named?: string,
): Promise<CredentialRow> {
  if (named) {
    const row = await creds.get(`${prefix}${named}`);
    if (!row) throw new Error(`no app ${named} in the vault`);
    return row;
  }
  const apps = await creds.list(prefix);
  if (apps.length === 0) {
    // `liquen connect <service> <verb>` → its app door
    const door = `${command.split(" ").slice(0, 3).join(" ")} app`;
    throw new Error(`no app in the vault for it: \`${door}\` adds one`);
  }
  if (apps.length > 1) {
    throw new Error(`several apps in the vault: \`${command} --app <id>\` picks one`);
  }
  return apps[0];
}

/** The scopes a grant holds, as its vault row records them. */
export function scopesHeld(row: CredentialRow | null): string[] | undefined {
  const s = row?.extra?.scope;
  return typeof s === "string" && s.trim() ? s.trim().split(/\s+/) : undefined;
}

/** What a call whose sign-in left no ticket is told. */
export const LOST = "not signed in: the sign-in left nothing to follow when the harness went " +
  "down, so nothing more is told of it; ask again if it is still wanted";

/** How a sign-in ended, as the call that asked for it reads it. */
export function outcomeText(service: string, w: Word): string {
  if ("landed" in w) {
    return `signed in: ${service} ${w.landed}` +
      (w.missing?.length
        ? `, without ${w.missing.join(" ")}: the calls that need them are refused`
        : "");
  }
  if ("refused" in w) return `not signed in: ${w.refused}`;
  if ("lapsed" in w) return "not signed in: it lapsed unused";
  return "not signed in";
}
