/**
 * connect/whatsapp/connect.ts — `liquen connect whatsapp`: the PAIRING door (§4).
 *
 * The bridge (open-bsp-whatsmeow) owns the wire: `POST /sessions` starts a pairing and
 * `GET /sessions/pending/{id}` is polled while WhatsApp rotates QR codes (~20s each) —
 * or, given a phone number, answers a one-shot pairing code the person types into
 * WhatsApp (Linked devices → Link with phone number). This file is liquen's CLIENT of that
 * contract: drive the poll, and on `paired` WRITE THE MAP — the same three writes as
 * the Slack doors, minus the vault: liquen holds NO WhatsApp secret (the Signal session
 * keys live in the bridge's store; liquen's only credential is the shared BRIDGE_TOKEN).
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

import { helpFlag } from "../help.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { SERVICE } from "./ingest.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { declared } from "../declare.ts";
import { SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

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
  /** The member whose phone this is — the connection's owner (§4). Absent ⇒ the org's
   *  number: an agent whose declared phone it is speaks through it, steered by the roster. */
  principal?: string;
  /** The bridge's tenant id — `connections.whatsapp.organizationId` (it stores and
   *  echoes it back on session events). */
  organizationId: string;
  /** Set ⇒ the pairing-code flow (typed into the phone); absent ⇒ the QR flow. */
  phoneNumber?: string;
  /** The machinery's write side (§4) — the same seam the sessions/events route uses. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  /** UI hook: fires on every visible change (first QR, each rotation, the code). */
  onState?: (state: WAPairingState) => void;
  /** The clock every stamp and the pairing deadline read (§9: the seam a test moves). */
  now?: () => string;
}

/** How often the bridge is asked whether the phone has answered. */
const POLL_MS = 1_000;
/** Mirrors the bridge's own pendingTTL — past it the poll only ever answers error. */
const PAIRING_TTL_MS = 10 * 60_000;

/** Drive one pairing to completion: create, poll, and on `paired` write the map and
 *  notify the log. Throws (writing nothing) on error or timeout. `pollMs` is `POLL_MS` —
 *  a waited constant, so the value is the seam (§9): a test drives the loop faster. */
export async function connectWhatsApp(
  deps: WhatsAppConnectDeps,
  pollMs: number = POLL_MS,
): Promise<{ address: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const deadline = Date.parse(now()) + PAIRING_TTL_MS;

  let state = await deps.bridge.create({
    organization_id: deps.organizationId,
    ...(deps.phoneNumber ? { phone_number: deps.phoneNumber } : {}),
    ...(deps.principal ? { agent_id: deps.principal } : {}),
  });
  deps.onState?.(state);

  while (state.status === "pending") {
    if (Date.parse(now()) >= deadline) throw new Error("pairing timed out — run the door again");
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

  // the map: one anchor row (opens the publish gate the next webhook batch checks) —
  // OWNED by the principal who paired their own phone, or the org's (§4: no owner, and a
  // credential key naming the bridge session, which is the credential the org holds for
  // it) — and, for a member's, the membership that carries the note into their view
  deps.store.upsertConnections([{
    service: SERVICE,
    address,
    ...(deps.principal ? { agentId: deps.principal } : { credentialKey: `${SERVICE}:${address}` }),
    extra: { state: "connected", connected_at: now(), organization_id: deps.organizationId },
  }]);
  if (deps.principal) {
    deps.store.upsertMemberships([
      { service: SERVICE, connection: address, conversation: "connect", agentId: deps.principal },
    ]);
  }

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
      text: `WhatsApp connected: ${address} → ${deps.principal ?? "the org"}`,
    }],
  };
  await deps.publish(note);
  return { address };
}

/* ── local entry: drive the pairing against the bridge, QR in the terminal ──────────
 *
 * The positional is the principal (default: the OS username — a session choice, so an
 * argument); `--org` pairs a number nobody owns, the one an org agent speaks through;
 * the number is a flag, international digits, no `+`. The flow is chosen by
 * the number's presence because the code flow CANNOT exist without it (whatsmeow's
 * PairPhone mints the code for that specific number), while the QR flow needs nothing.
 *
 * A phone code is short-lived: WhatsApp ends the pairing stream ~3 minutes after minting,
 * and the bridge fails the pending session then (events.go) rather than idling to its TTL.
 * Expired ⇒ run the door again for a fresh one.
 *
 * Env: WA_BRIDGE_TOKEN (the secret); the knobs are connections.whatsapp. */
const USAGE = `usage: liquen connect whatsapp [agent] [--phone <digits>]
       liquen connect whatsapp --org [--phone <digits>]

  Pair a WhatsApp number through the whatsmeow bridge; knobs: connections.whatsapp.

  [agent]           the roster member whose phone this is (default: your OS username)
  --org             the org's own number — owned by nobody, spoken through by its agents
  --phone <digits>  the pairing-code flow for that number (international digits, no +);
                    without it, a QR code to scan from the phone
  --dir <org>       the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openLog } = await import("../../store/log.ts");
    const { userInfo } = await import("node:os");
    const { basename } = await import("node:path");
    const qrcode = (await import("qrcode-terminal")).default;

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const flags = new Map<string, string>();
    const positional: string[] = [];
    let orgOwned = false;
    for (let i = 0; i < org.args.length; i++) {
      if (org.args[i] === "--org") orgOwned = true;
      else if (org.args[i].startsWith("--")) flags.set(org.args[i].slice(2), org.args[++i] ?? "");
      else positional.push(org.args[i]);
    }
    if (orgOwned && positional.length > 0) {
      console.error("--org pairs the org's own number: no agent to name");
      Deno.exit(2);
    }
    const principal = orgOwned ? undefined : positional[0] ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return "principal";
      }
    })();
    const { whatsappConfig } = await import("./config.ts");
    const { bridgeUrl: base, organizationId } = await whatsappConfig(root);
    // the first door names the tenant after the folder and declares it; from then on the
    // file says, and a rename of the folder moves nothing on the bridge
    const tenant = organizationId ?? basename(root);
    const token = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";
    const phoneNumber = flags.get("phone") || undefined;
    if (flags.has("phone") && !phoneNumber) {
      console.error("--phone needs the number (international digits, no `+`)");
      Deno.exit(2);
    }

    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await timedFetch(`${base}${path}`, {
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

    console.error(
      `Connecting WhatsApp as ${
        principal ? `agent "${principal}"` : "the org"
      } (bridge ${base}, tenant "${tenant}") — ` +
        `${phoneNumber ? `pairing code for ${phoneNumber}` : "QR"}.\n`,
    );
    const log = await openLog(`${dir}/log`);
    try {
      const { address } = await connectWhatsApp({
        bridge,
        principal,
        organizationId: tenant,
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
      console.error(`\n✓ paired: ${address} → ${principal ?? "the org"}`);
      console.error("  (deno task status shows the map; run:whatsapp to receive)");
      await declared(root, SPEC, { organizationId: tenant });
    } finally {
      await log.close();
    }
  });
}
