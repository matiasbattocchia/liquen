/**
 * connect/whatsapp/connect.ts — `mu connect whatsapp`: the PAIRING door (§4).
 *
 * The bridge (open-bsp-whatsmeow) owns the wire: `POST /sessions` starts a pairing and
 * `GET /sessions/pending/{id}` is polled while WhatsApp rotates QR codes (~20s each) —
 * or, given a phone number, answers a one-shot pairing code the person types into
 * WhatsApp (Linked devices → Link with phone number). This file is mu's CLIENT of that
 * contract: drive the poll, and on `paired` WRITE THE MAP — the same three writes as
 * the Slack doors, minus the vault: mu holds NO WhatsApp secret (the Signal session
 * keys live in the bridge's store; mu's only credential is the shared BRIDGE_TOKEN).
 *
 *   paired → connections: ONE row — the session's own number is BOTH the anchor every
 *            event carries AND the principal's identity (unlike Slack's two-row
 *            team + team:user split), so `agentId` rides the anchor: owned ⇒ private
 *            (§6), and the classifier resolves the account's own messages to the
 *            principal by the same point lookup
 *          → membership: the `connect` conversation, so the note reaches the principal
 *          → the log: the grant notification crosses the frontier as an event (§4)
 *
 * The bridge posts its own `connected` session event at the ingest too — same upsert,
 * either order (§4: the map converges by upsert); the door's write means pairing works
 * even when the ingest webhook isn't up yet.
 */

import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { SERVICE } from "./ingest.ts";

/** The bridge's pairing poll response (sessions.go `PairingState`) — verbatim. */
export interface WAPairingState {
  session_id: string;
  status: "pending" | "paired" | "error";
  qr_code?: string;
  pairing_code?: string;
  /** Set once paired: the session's own number — the connection address. */
  address?: string;
  error?: string;
}

/** The bridge's session-management client (server.go routes) — injectable for tests. */
export interface WABridgeSessions {
  create(req: {
    organization_id: string;
    phone_number?: string;
    agent_id?: string;
  }): Promise<WAPairingState>;
  pending(id: string): Promise<WAPairingState>;
}

export interface WhatsAppConnectDeps {
  bridge: WABridgeSessions;
  /** The registry name the pairing binds to (v0: principal name = agent name). */
  principal: string;
  /** The bridge's tenant id (it stores and echoes it back on session events). */
  organizationId?: string;
  /** Set ⇒ the pairing-code flow (typed into the phone); absent ⇒ the QR flow. */
  phoneNumber?: string;
  /** The machinery's write side (§4) — the same seam the sessions/events route uses. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** UI hook: fires on every visible change (first QR, each rotation, the code). */
  onState?: (state: WAPairingState) => void;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => string;
}

/** Drive one pairing to completion: create, poll, and on `paired` write the map and
 *  notify the log. Throws (writing nothing) on error or timeout. */
export async function connectWhatsApp(
  deps: WhatsAppConnectDeps,
): Promise<{ address: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const org = deps.organizationId ?? "mu";
  const pollMs = deps.pollMs ?? 1000;
  // mirrors the bridge's own pendingTTL — past it the poll only ever answers error
  const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60 * 1000);

  let state = await deps.bridge.create({
    organization_id: org,
    ...(deps.phoneNumber ? { phone_number: deps.phoneNumber } : {}),
    agent_id: deps.principal,
  });
  deps.onState?.(state);

  while (state.status === "pending") {
    if (Date.now() >= deadline) throw new Error("pairing timed out — run the door again");
    await new Promise((r) => setTimeout(r, pollMs));
    const next = await deps.bridge.pending(state.session_id);
    if (
      next.status !== state.status || next.qr_code !== state.qr_code ||
      next.pairing_code !== state.pairing_code
    ) deps.onState?.(next);
    state = next;
  }
  if (state.status !== "paired" || !state.address) {
    throw new Error(`pairing failed: ${state.error ?? state.status}`);
  }
  const address = state.address;

  // the map: one OWNED anchor row (opens the publish gate the next webhook batch
  // checks), and the membership that carries the note into the principal's view
  deps.store.upsertConnections([{
    service: SERVICE,
    address,
    agentId: deps.principal,
    extra: { state: "connected", connected_at: now(), organization_id: org },
  }]);
  deps.store.upsertMemberships([
    { service: SERVICE, connection: address, conversation: "connect", agentId: deps.principal },
  ]);

  // cross the frontier the only legal way: an event (§4)
  const note: Draft<MessageEvent> = {
    ts: now(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: address,
      conversation: { address: "connect" },
      sender: { address: "whatsapp-connect" },
    },
    parts: [{
      type: "text",
      kind: "text",
      text: `WhatsApp connected: ${address} → ${deps.principal}`,
    }],
  };
  await deps.publish(note);
  return { address };
}

/* ── local entry: drive the pairing against the bridge, QR in the terminal ──────────
 *
 *   deno task connect:whatsapp          # QR flow: scan with the phone
 *   deno task connect:whatsapp <phone>  # pairing-code flow (international digits, no `+`)
 *
 * No `--` before the number: `deno task` forwards it verbatim, so it arrives as args[0]
 * and the bridge answers "phone number too short". The flow is chosen by the number's
 * presence because the code flow CANNOT exist without it (whatsmeow's PairPhone mints the
 * code for that specific number), while the QR flow needs nothing.
 *
 * A phone code is short-lived: WhatsApp ends the pairing stream ~3 minutes after minting,
 * and the bridge fails the pending session then (events.go) rather than idling to its TTL.
 * Expired ⇒ run the door again for a fresh one.
 *
 * Arg: the principal (default: the OS username — a session choice, so an argument).
 * Env: WA_BRIDGE_URL (default http://localhost:8081) · WA_BRIDGE_TOKEN ·
 *      WA_ORG (default mu) · WA_PHONE. */
if (import.meta.main) {
  const { openLog } = await import("../../store/log.ts");
  const { userInfo } = await import("node:os");
  const qrcode = (await import("qrcode-terminal")).default;

  const dir = "./data";
  const principal = Deno.args[0] ?? (() => {
    try {
      return userInfo().username;
    } catch {
      return "principal";
    }
  })();
  const base = Deno.env.get("WA_BRIDGE_URL") ?? "http://localhost:8081";
  const token = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";
  const phoneNumber = Deno.args[0] ?? Deno.env.get("WA_PHONE") ?? undefined;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const reason = (await res.text()).slice(0, 256).trim();
      throw new Error(`bridge ${path} HTTP ${res.status}: ${reason}`);
    }
    return await res.json() as T;
  };
  const bridge: WABridgeSessions = {
    create: (req) => call("POST", "/sessions", req),
    pending: (id) => call("GET", `/sessions/pending/${id}`),
  };

  console.error(`Connecting WhatsApp as principal "${principal}" (bridge ${base}).\n`);
  const log = await openLog(`${dir}/log`);
  try {
    const { address } = await connectWhatsApp({
      bridge,
      principal,
      organizationId: Deno.env.get("WA_ORG") ?? "mu",
      phoneNumber,
      store: log, // connections live on the Log (§4)
      publish: log.publish,
      onState: (s) => {
        if (s.pairing_code) {
          console.error(`Pairing code:  ${s.pairing_code}\n`);
          console.error("On the phone: WhatsApp → Settings → Linked devices → Link a device");
          console.error("→ Link with phone number instead — and type the code.\n");
        } else if (s.qr_code) {
          console.error(
            "Scan with the phone: WhatsApp → Settings → Linked devices → Link a device\n",
          );
          qrcode.generate(s.qr_code, { small: true }, (q: string) => console.error(q));
        }
      },
    });
    console.error(`\n✓ paired: ${address} → ${principal}`);
    console.error("  (deno task status shows the map; run ingest:whatsapp to receive)");
  } finally {
    await log.close();
  }
}
