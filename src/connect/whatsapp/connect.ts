/**
 * connect/whatsapp/connect.ts — `liquen connect whatsapp`: the PAIRING door (§4).
 *
 * The bridge (open-bsp-whatsmeow) owns the wire: `POST /sessions` starts a pairing and
 * `GET /sessions/pending/{id}` is polled while WhatsApp rotates QR codes (~20s each) —
 * or, given a phone number, answers a one-shot pairing code the person types into
 * WhatsApp (Linked devices → Link with phone number). Main drives the poll for every
 * pairing (signin.ts, whatsapp/signin.ts), and on `paired` WRITES THE MAP here
 * (`landWhatsApp`) — the same three writes as the Slack doors, minus the vault: liquen
 * holds NO WhatsApp secret (the Signal session keys live in the bridge's store; liquen's
 * only credential is the shared BRIDGE_TOKEN).
 *
 *   paired → connections: ONE row — the session's own number is BOTH the anchor every
 *            event carries AND the principal's identity (unlike Slack's two-row
 *            team + team:user split), so `agentId` rides the anchor: owned ⇒ private
 *            (§6), and the classifier resolves the account's own messages to the
 *            principal by the same point lookup
 *          → membership: the `connect` conversation, so the note reaches the principal
 *          → the log: the grant notification crosses the frontier as an event (§4)
 *
 * The row is this write's alone: it says whose the number is and whether it is kept to
 * steering, so nothing of the number lands before it does. The bridge's session events
 * move its state once it stands, and the batches the bridge sends first are refused at
 * the gate and sent again. Which ingest is the org's to say: the bridge is one sidecar
 * for many orgs, and `webhook_url` on the create request is where THIS session's traffic
 * lands from then on (`ingestUrlOf`, `config.ts`).
 *
 * Which is why the door DECLARES the connection and waits for its ingest before it asks
 * main for the pairing (`requireIngest`): pairing makes the bridge start delivering at
 * once, and the history it sends arrives once or never.
 */

import { helpFlag } from "../help.ts";
import type { Appender } from "../../store/log.ts";
import { type Connections, STEERING } from "../../store/connections.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { noSteeringShared } from "../steering.ts";
import { SERVICE } from "./ingest.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { timedFetch } from "../http.ts";
import { requireIngest } from "../declare.ts";
import { SPEC } from "./config.ts";
import { linked } from "../health.ts";
import { entry } from "../../entry.ts";
import { signInHere, terminalUser } from "../door.ts";

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
    /** where the bridge delivers this session's traffic — this org's ingest */
    webhook_url: string;
  }): Promise<WAPairingState>;
  pending(id: string): Promise<WAPairingState>;
}

/** The bridge's session routes over HTTP, on the shared token. */
export function bridgeSessions(base: string, token: string): WABridgeSessions {
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
  return {
    create: (req) => call("POST", "/sessions", req),
    pending: (id) => call("GET", `/sessions/pending/${id}`),
  };
}

export interface WhatsAppLandDeps {
  /** The member whose phone this is — the connection's owner (§4). Absent ⇒ the org's
   *  number: an agent whose declared phone it is speaks through it, steered by the roster. */
  principal?: string;
  /** Keep the number to steering: its owner's mind surfaces and nothing else (§4). */
  steering?: boolean;
  /** The bridge's tenant id — `connections.whatsapp.organizationId` (it stores and
   *  echoes it back on session events). */
  organizationId: string;
  /** The machinery's write side (§4) — the same seam the sessions/events route uses. */
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  /** → the EventLog: the grant notification crosses the frontier as an event (§4). */
  publish: Appender["publish"];
  now?: () => string;
}

/** A paired number, written: the anchor row, the owner's membership, the note. */
export async function landWhatsApp(address: string, deps: WhatsAppLandDeps): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  if (deps.steering && !deps.principal) throw noSteeringShared();
  // the map: one anchor row (opens the publish gate the next webhook batch checks) —
  // OWNED by the principal who paired their own phone, or the org's (§4: no owner, and a
  // credential key naming the bridge session, which is the credential the org holds for
  // it) — and, for a member's, the membership that carries the note into their view. Each
  // pairing says anew whether the number is kept to steering
  await deps.store.upsertConnections([{
    service: SERVICE,
    address,
    ...(deps.principal ? { agentId: deps.principal } : { credentialKey: `${SERVICE}:${address}` }),
    extra: {
      ...linked(now()),
      organization_id: deps.organizationId,
      [STEERING]: deps.steering ? true : null,
    },
  }]);
  if (deps.principal) {
    await deps.store.upsertMemberships([
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
      text: `WhatsApp connected: ${address} → ${deps.principal ?? "the org"}` +
        (deps.steering ? ", for steering" : ""),
    }],
  };
  await deps.publish(note);
}

/* ── local entry: the pairing asked of main, QR in the terminal ──────────────────────
 *
 * The positional is the principal (default: the OS username — a session choice, so an
 * argument); `--shared` pairs a number nobody owns, read by every agent;
 * the number is a flag, international digits, no `+`. The flow is chosen by
 * the number's presence because the code flow CANNOT exist without it (whatsmeow's
 * PairPhone mints the code for that specific number), while the QR flow needs nothing.
 *
 * A phone code is short-lived: WhatsApp ends the pairing stream ~3 minutes after minting,
 * and the bridge fails the pending session then (events.go) rather than idling to its TTL.
 * Expired ⇒ run the door again for a fresh one.
 *
 * Env: WA_BRIDGE_TOKEN (the secret, main's); the knobs are connections.whatsapp. */
const USAGE = `usage: liquen connect whatsapp [agent] [--steering] [--phone <digits>]
       liquen connect whatsapp --shared [--phone <digits>]

  Pair a WhatsApp number through the whatsmeow bridge; knobs: connections.whatsapp.

  [agent]           the roster member whose phone this is (default: your OS username)
  --steering        keep the number to steering: its chat with itself and its principals'
                    DMs reach the agent, and nothing else crosses either way; a pairing
                    without it gives the agent the whole number
  --shared          a shared number: owned by nobody, read by every agent
  --phone <digits>  the pairing-code flow for that number (international digits, no +);
                    without it, a QR code to scan from the phone
  --dir <org>       the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { basename } = await import("node:path");
    const qrcode = (await import("qrcode-terminal")).default;

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const flags = new Map<string, string>();
    const positional: string[] = [];
    let shared = false;
    let steering = false;
    for (let i = 0; i < org.args.length; i++) {
      if (org.args[i] === "--shared") shared = true;
      else if (org.args[i] === "--steering") steering = true;
      else if (org.args[i].startsWith("--")) flags.set(org.args[i].slice(2), org.args[++i] ?? "");
      else positional.push(org.args[i]);
    }
    if (shared && positional.length > 0) {
      console.error("--shared pairs a number nobody owns: no agent to name");
      Deno.exit(2);
    }
    if (shared && steering) {
      console.error(noSteeringShared().message);
      Deno.exit(2);
    }
    const principal = shared ? undefined : positional[0] ?? terminalUser();
    const phone = flags.get("phone") || undefined;
    if (flags.has("phone") && !phone) {
      console.error("--phone needs the number (international digits, no `+`)");
      Deno.exit(2);
    }
    const { whatsappConfig } = await import("./config.ts");
    // the first door names the tenant after the folder and declares it; from then on the
    // file says, and a rename of the folder moves nothing on the bridge
    const tenant = (await whatsappConfig(root)).organizationId ?? basename(root);
    // declared, and up: from the pairing on, the bridge delivers to this org's ingest —
    // the phone's history first, within seconds — and a post that finds nobody there is
    // logged once and dropped. The door is the only moment anyone can check.
    await requireIngest(root, SPEC, { organizationId: tenant });

    console.error(
      `Connecting WhatsApp as ${principal ? `agent "${principal}"` : "the org"}` +
        `${steering ? ", for steering" : ""} — ` +
        `${phone ? `pairing code for ${phone}` : "QR"}.\n`,
    );
    Deno.exit(
      await signInHere(
        root,
        {
          service: "whatsapp",
          ...(principal ? { agent: principal } : {}),
          ...(phone ? { pair: phone } : {}),
          ...(steering ? { steering } : {}),
        },
        {
          where: "Scan with the phone: WhatsApp → Settings → Linked devices → Link a device\n",
          qr: (code) => qrcode.generate(code, { small: true }, (q: string) => console.error(q)),
        },
      ),
    );
  });
}
