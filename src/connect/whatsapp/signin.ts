/**
 * connect/whatsapp/signin.ts — a WhatsApp pairing as main holds it (connect/signin.ts).
 *
 * A code: main asks the bridge for a pairing, notes its pending session on the ticket, and
 * polls it, saying each code the person needs (a pairing code for a number, else a QR
 * that rotates). Once the phone pairs, the ticket judges the number and the map is
 * written (`landWhatsApp`). A restart takes the poll up from the noted session.
 *
 * The service is declared, with its ingest up, before a pairing starts: from the pairing on
 * the bridge delivers to that ingest, the history first. An org's first pairing declares
 * it, naming the bridge's tenant after the org's folder, as the CLI door does.
 *
 * The pairing names the history the phone is asked for, since the phone hears the ask at
 * pairing and never after: none for a number kept to its chat with itself, else its lines
 * from where the listening stopped on the number, no further back than `historyDays`
 * (`connect/history.ts`). The number is the one the pairing names, else the phone on its
 * agent's row, else the one number its agent owns; a QR pairing that names none is asked
 * the whole window.
 */

import { basename } from "node:path";
import { digits, type FlowCtx, type SignInFlow, type Word } from "../signin.ts";
import type { TicketRow } from "../../store/credentials.ts";
import { readConfig } from "../../org.ts";
import { waitIngest } from "../declare.ts";
import { heardUntil, historySince } from "../history.ts";
import { ingestUrlOf, type WhatsappConfig, whatsappConfig } from "./config.ts";
import {
  bridgeSessions,
  landWhatsApp,
  type WABridgeSessions,
  type WAPairingState,
} from "./connect.ts";

/** How long a pairing code is good: WhatsApp ends its stream about 3 minutes after minting. */
export const PAIRING_CODE_MS = 3 * 60_000;
/** How long a QR pairing stays pending: the bridge's own TTL. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** How often the bridge is asked whether the phone has answered. */
const POLL_MS = 1_000;

/** Where the person types a pairing code. */
export const PAIRING_WHERE = "On the phone: WhatsApp → Settings → Linked devices → Link a " +
  "device → Link with phone number instead, and type the code.";

/** What the person does with a pairing state, if anything. */
export function pairingWord(s: WAPairingState, until: number): Word | undefined {
  if (s.pairing_code) return { code: s.pairing_code, where: PAIRING_WHERE, until };
  if (s.qr_code) return { qr: s.qr_code, until };
  return undefined;
}

/** The number a pairing will most likely land as: the one it names, else the phone on its
 *  agent's row, else the one number its agent owns. */
async function numberOf(
  t: TicketRow,
  pair: string | undefined,
  log: FlowCtx["log"],
): Promise<string | undefined> {
  if (pair) return pair;
  if (!t.agentId) return undefined;
  const phone = (await log.agents()).find((a) => a.agentId === t.agentId)?.phone;
  if (phone) return digits(phone);
  const own = (await log.connections()).filter((c) =>
    c.service === "whatsapp" && c.agentId === t.agentId
  );
  return own.length === 1 ? own[0].address : undefined;
}

/** The history a pairing asks the phone for, as the bridge takes it. */
export async function historyAsked(
  t: TicketRow,
  days: number,
  pair: string | undefined,
  ctx: Pick<FlowCtx, "log">,
  at: string = new Date().toISOString(),
): Promise<{ no_history: true } | { history_since: string }> {
  if (t.extra.self === true || days === 0) return { no_history: true };
  const number = await numberOf(t, pair, ctx.log);
  const heard = number ? await heardUntil(ctx.log, "whatsapp", number, at) : undefined;
  return { history_since: historySince(at, days, heard) };
}

export function createWhatsappSignIn(
  opts: {
    bridge?: (cfg: WhatsappConfig) => WABridgeSessions;
    config?: (root: string) => Promise<WhatsappConfig>;
    pollMs?: number;
  } = {},
): SignInFlow {
  const bridgeOf = opts.bridge ??
    ((cfg) => bridgeSessions(cfg.bridgeUrl, Deno.env.get("WA_BRIDGE_TOKEN") ?? ""));
  const configOf = opts.config ?? whatsappConfig;
  const pollMs = opts.pollMs ?? POLL_MS;
  return {
    life: (ask) => ask.pair ? PAIRING_CODE_MS : PAIRING_TTL_MS,

    async prepare(_ask, ctx) {
      const tenant = (await configOf(ctx.root)).organizationId ?? basename(ctx.root);
      if (!("whatsapp" in (await readConfig(ctx.root)).connections)) {
        await ctx.declare("whatsapp", { organizationId: tenant });
      }
      await waitIngest(ctx.root, "whatsapp");
      return { organizationId: tenant };
    },

    async run(t, ctx, gate, signal) {
      const cfg = await configOf(ctx.root);
      const bridge = bridgeOf(cfg);
      const tenant = String(t.extra.organizationId ?? cfg.organizationId ?? basename(ctx.root));
      const pair = typeof t.extra.pair === "string" ? digits(t.extra.pair) : undefined;
      let state: WAPairingState;
      if (typeof t.extra.pending === "string") state = await bridge.pending(t.extra.pending);
      else {
        state = await bridge.create({
          organization_id: tenant,
          webhook_url: ingestUrlOf(cfg, ctx.edge.port),
          ...(pair ? { phone_number: pair } : {}),
          ...(t.agentId ? { agent_id: t.agentId } : {}),
          ...await historyAsked(t, cfg.historyDays, pair, ctx),
        });
        await gate.note(t.ticket, { pending: state.session_id });
      }
      let shown = "";
      const show = async (s: WAPairingState) => {
        const word = pairingWord(s, t.deadline);
        if (!word || JSON.stringify(word) === shown) return;
        shown = JSON.stringify(word);
        await gate.say(t.ticket, word);
      };
      await show(state);
      while (state.status === "pending") {
        await new Promise((r) => setTimeout(r, pollMs));
        if (signal.aborted) return;
        state = await bridge.pending(state.session_id);
        await show(state);
      }
      if (state.status !== "paired" || !state.address) {
        throw new Error(`pairing failed: ${state.error ?? state.status}`);
      }
      const verdict = await gate.judge(t.ticket, { address: state.address, phone: state.address });
      if ("refused" in verdict) return;
      await landWhatsApp(state.address, {
        ...(verdict.agent ? { principal: verdict.agent } : {}),
        self: t.extra.self === true,
        organizationId: tenant,
        store: ctx.log,
        publish: ctx.log.publish,
      });
      await gate.landed(t.ticket, state.address);
    },
  };
}
