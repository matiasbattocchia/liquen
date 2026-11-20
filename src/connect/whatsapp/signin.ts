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
 */

import { basename } from "node:path";
import { digits, type SignInFlow, type Word } from "../signin.ts";
import { readConfig } from "../../org.ts";
import { waitIngest } from "../declare.ts";
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
        steering: t.extra.steering === true,
        organizationId: tenant,
        store: ctx.log,
        publish: ctx.log.publish,
      });
      await gate.landed(t.ticket, state.address);
    },
  };
}
