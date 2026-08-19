/**
 * connect/mirror.ts — the mind-alias mirror (DESIGN §4): one agent, many surfaces, one log.
 *
 * A principal-identified conversation on a connected surface (the WA self-chat, the Slack
 * self-DM) IS the mind — the same chat as the REPL, picked up from a phone. The mirror is
 * the broker-side component that keeps every such surface and the mind in sync, by COPY
 * (never rewrite — an event with the right envelope must exist in the log for a dispatcher
 * to carry it, and the wire original stays honest where it landed):
 *
 *   fan-in    an inbound on an alias conversation → a COPY into `mind:<agent>` — the agent
 *             wakes on it exactly as on a REPL line. `extra.via` holds the provenance
 *             (origin event id + wire coordinates); `cause` points home.
 *   fan-out   every mind event the REPL would show → a CC to every alias binding EXCEPT
 *             the origin surface (read off `extra.via`). Every crossing line opens with
 *             WHO, because a self-conversation renders both speakers as the same account
 *             and the tag is the surface's only input/output distinction: the agent's
 *             voice as `[agent] …`, its tool calls as `[agent tool] **bash**(git status)`
 *             (redacted to one line), a gate waiting on the principal as `[agent asks] …`,
 *             the harness's own word as `[harness] …`, and the principal's own words as
 *             `[you via <surface>] …` — input replayed as output. Every tag ships wrapped
 *             in backticks, so a surface that reads markdown sets it apart from the words
 *             around it (WhatsApp renders it monospace; the bridge passes code spans
 *             through untouched). The log needs no tag: authorship is the bit.
 *
 * Fan-out applied to fan-in's own mind copy is what cross-broadcasts surfaces: a WA line
 * copies to the mind, and that copy CCs — tagged `[you via whatsapp]` — to Slack, origin
 * skipped. A CC is a
 * plain outbound event on its service: the dispatchers post it and backfill `external_id`,
 * so the platform echo MERGES into it like any other send (§4). The loop is closed by
 * construction: CCs are agent-authored AND carry `extra.via`, so fan-in skips them; they
 * live in alias conversations, so fan-out never re-reads them.
 *
 * NO BACKFILL: the mirror tails LIVE and skips imported history — a surface that connects
 * mid-conversation starts mid-stream; only the REPL reads the log, so only the REPL has
 * history.
 *
 * THE ECHO, twice over (§4). Every CC we write is posted, and the platform hands it back
 * through the ingest as an ordinary inbound — in an alias conversation that reads as the
 * principal speaking, so fan-in would copy our own words into the mind, fan them out to the
 * other surfaces, and let two aliases feed each other. Reconciliation is by id, never by
 * author (a self-conversation shows the same account both ways — that is what `[agent]` is
 * for), and it has two failure modes, each with its own defence:
 *
 *   the echo lands EARLY, before the dispatcher's backfill claims the CC (the 小-window) —
 *     fan-in settles (`settleMs`) and re-reads the origin row; the backfill has absorbed it
 *     by then, and a row that is gone copies nothing.
 *   the claim NEVER lands — the dispatcher died between posting and backfilling, or the API
 *     returned no id to stamp (a Slack file share). Then the echo stays a first-class
 *     inbound forever. But an inbound always carries the platform's id, so a CC of the same
 *     words still holding NONE can only be that post: fan-in stamps it (`unclaimed`), which
 *     absorbs the echo exactly as the dispatcher would have, and copies nothing.
 */

import { aliasOf, type AliasRow } from "../store/connections.ts";
import { DEFAULT_MIRROR_CLAIM_MS, DEFAULT_MIRROR_SETTLE_MS } from "../config.ts";
import { backfilled, outcomeLine } from "../render.ts";
import { describeCall } from "../describe.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type {
  Draft,
  ErrorEvent,
  Event,
  EventId,
  MessageEvent,
  Part,
  PermissionRequestEvent,
  PermissionResponseEvent,
  Service,
  ToolUseEvent,
} from "../types.ts";

export interface MirrorDeps {
  subscribe: Subscriber["subscribe"];
  /** → the EventLog: copies and CCs are ordinary published events (§4 frontier rule). */
  publish: Appender["publish"];
  /** The settle re-read (小-window): is the origin row still there, or absorbed? */
  read: Reader["read"];
  /** The live bindings (§4): connect flows write them, the mirror reads through. */
  aliases: () => AliasRow[];
  /** The unclaimed-CC repair: stamp a CC with the id its own post came back carrying —
   *  the dispatcher's `setDelivery`, run late by the mirror (it absorbs the echo row). */
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  /** How long fan-in waits for a dispatch backfill to absorb an early echo. */
  settleMs?: number;
  /** How far back the unclaimed-CC guard looks for an echo's twin (default 60s). */
  claimMs?: number;
  now?: () => string;
  onError?: (event: Event, err: unknown) => void;
}

/** Wire the mirror to the log. Returns unsubscribe. Serialized: copies keep log order. */
export function createMirror(deps: MirrorDeps): () => void {
  const now = deps.now ?? (() => new Date().toISOString());
  const settleMs = deps.settleMs ?? DEFAULT_MIRROR_SETTLE_MS;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (e: Event, work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => deps.onError?.(e, err));
  };

  return deps.subscribe((e) => {
    if (backfilled(e)) return; // history is not news (§5) — the no-backfill rule
    const mind = mindOf(e);
    if (mind !== null) {
      const parts = ccParts(e);
      if (parts) enqueue(e, () => fanOut(deps, e, mind, parts, now));
      return;
    }
    // CCs and copies never re-enter. A CC is OURS-not-yet-on-the-wire: agent-stamped with
    // no external_id at insert (§4). Agent presence ALONE no longer means ours — the
    // classifier stamps the principal's inbound rows too, and those (external_id always
    // present: ingests refuse to mint without one) must still fan in.
    if (e.type !== "message" || (e.agent && !e.envelope.external_id) || viaOf(e)) return;
    const { service, connection_address, conversation } = e.envelope;
    const binding = aliasOf(deps.aliases(), service, connection_address, conversation.address);
    if (binding) {
      enqueue(
        e,
        () =>
          fanIn(
            deps,
            e as MessageEvent,
            binding,
            settleMs,
            deps.claimMs ?? DEFAULT_MIRROR_CLAIM_MS,
            now,
          ),
      );
    }
  });
}

/* ── fan-in: alias surface → the mind ─────────────────────────────────── */

async function fanIn(
  deps: MirrorDeps,
  e: MessageEvent,
  binding: AliasRow,
  settleMs: number,
  claimMs: number,
  now: () => string,
): Promise<void> {
  // settle, then re-read: an early echo of our own CC is absorbed by the dispatcher's
  // backfill (dropped, merged into the CC) — if the row is gone, there is nothing to copy
  await new Promise((r) => setTimeout(r, settleMs));
  const still = await deps.read({
    conversation: e.envelope.conversation.address,
    after: new Date(Date.parse(e.ts) - 1).toISOString(),
    filter: (x) => x.id === e.id,
    limit: 1,
  });
  if (still.length === 0) return;

  // still there — but is it US? An inbound always carries the platform's id (the ingests
  // refuse to mint an event without one), so a CC of the same words still holding NONE is
  // a post whose claim never happened: the dispatcher died between posting and backfilling,
  // or the API returned no id to stamp (a Slack file share). Repair what it missed — the
  // stamp absorbs this row into the CC — and copy nothing. Without it the echo reads as the
  // principal speaking, and fan-out sends that reading to the OTHER surfaces, which echo in
  // turn: two aliases feed each other and the mind fills with its own words (§4).
  const twin = await unclaimed(deps, e, claimMs);
  if (twin) {
    if (e.envelope.external_id) {
      await deps.setDelivery?.(twin.id, { external_id: e.envelope.external_id });
    }
    return;
  }

  // the quote, TRANSLATED (§9): a surface quote names a surface row, but the agent reads
  // the mind — and its scoped port never sees the alias conversation (policy hides it), so
  // only the mirror, reading unscoped, can make the join. A quoted CC resolves to the mind
  // event it was made from (`extra.via.event`); that id rides the copy as `ref_id`, which
  // is how a `/y` quoting one of several cards names the card itself.
  const origin = await quotedOrigin(deps, e);
  await deps.publish({
    ts: now(),
    type: "message",
    // `ref_external_id` still rides along as the mark that they quoted AT ALL — a quote
    // that resolves to nothing falls back to provenance, not to silence
    payload: {
      ref_id: origin ?? e.id,
      ...(e.payload?.ref_external_id ? { ref_external_id: e.payload.ref_external_id } : {}),
    },
    // the principal's stamp (§3): whose mind + entered through the harness — session_id
    // is deterministic in v0 (session ≈ agent), so even a first-message copy stamps at
    // append. No turn_id: input, not voice — exactly a REPL line in wire clothing.
    agent: { id: binding.agentId, session_id: binding.agentId },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: `mind:${binding.agentId}` },
      // WA self-chat carries no sender (the account spoke) — but in an alias conversation
      // the account IS the principal, and v0 principal name = agent name
      sender: e.envelope.sender ?? { address: binding.agentId, name: binding.agentId },
    },
    parts: e.parts ?? [],
    extra: {
      via: {
        event: e.id,
        service: binding.service,
        connection: e.envelope.connection_address,
        conversation: e.envelope.conversation.address,
        ...(e.envelope.external_id ? { external_id: e.envelope.external_id } : {}),
      },
    },
  } as Draft<MessageEvent>);
}

/** The mind event a quoted surface row was made from, if the quote can be joined: the row
 *  the `ref_external_id` names, when it is one of our CCs, carries `extra.via.event` — the
 *  approval card, the agent line, whatever crossed. A quote of anything else (an inbound,
 *  a row outside the log) resolves to nothing and the copy keeps plain provenance. */
async function quotedOrigin(deps: MirrorDeps, e: MessageEvent): Promise<EventId | undefined> {
  const quoted = e.payload?.ref_external_id;
  if (!quoted) return undefined;
  const rows = await deps.read({
    conversation: e.envelope.conversation.address,
    limit: 1,
    filter: (x) => x.envelope.external_id === quoted,
  });
  const via = rows[0]?.extra?.via as { event?: EventId } | undefined;
  return via?.event;
}

/** Our own post, returning unrecognized: a CC on this surface carrying the same words and
 *  no `external_id`. A healthy dispatcher stamps its row in milliseconds, so an unstamped
 *  one means the claim never landed — the state is otherwise unobservable, which is what
 *  makes the match safe. Newest first: the last thing we said is what just came back. */
async function unclaimed(
  deps: MirrorDeps,
  e: MessageEvent,
  claimMs: number,
): Promise<Event | undefined> {
  const words = textOf(e);
  const rows = await deps.read({
    conversation: e.envelope.conversation.address,
    types: ["message"],
    after: new Date(Date.parse(e.ts) - claimMs).toISOString(),
    filter: (x) =>
      x.agent !== undefined && x.envelope.external_id === undefined &&
      textOf(x as MessageEvent) === words,
  });
  return rows.at(-1);
}

/* ── fan-out: the mind → every alias surface but the origin ───────────── */

async function fanOut(
  deps: MirrorDeps,
  e: Event,
  agentId: string,
  parts: Part[],
  now: () => string,
): Promise<void> {
  const via = viaOf(e);
  const targets = deps.aliases().filter((a) =>
    a.agentId === agentId &&
    !(via && via.service === a.service && via.conversation === a.conversation)
  );
  if (targets.length === 0) return;
  await deps.publish(targets.map((a): Draft<MessageEvent> => ({
    ts: now(),
    type: "message",
    payload: { ref_id: e.id },
    // the CC is the agent's leg speaking on that surface (dispatch resolves the author's
    // alter-ego token off `agent.id`); v0 session ≈ agent (§7)
    agent: { id: agentId, session_id: agentId },
    envelope: {
      service: a.service as Service, // the map stores wire strings; bindings are known services
      connection_address: a.connection,
      conversation: { address: a.conversation },
    },
    parts,
    extra: { via: { event: e.id, service: "local", conversation: `mind:${agentId}` } },
  })));
}

/** What a mind event looks like on a surface — exactly what the REPL shows (§4). Every
 *  line opens with WHO, because a self-conversation renders both speakers as the same
 *  account: `[agent] …` for the voice, `[agent tool] …` for a redacted tool call,
 *  `[agent asks] …` for a gate waiting on the principal, `[you via <surface>] …` for the
 *  principal's own words replayed as output. Null ⇒ this event kind never crosses
 *  (thinking, results, the verdict itself — which is the principal's own `/y`; the
 *  agent's own settlement, a `cancel`, crosses as a `[harness]` withdrawal). */
function ccParts(e: Event): Part[] | null {
  if (e.type === "tool_use") {
    const call = describeCall((e as ToolUseEvent).parts[0].data);
    return [{ type: "text", kind: "text", text: `\`[agent tool]\` ${boldName(call)}` }];
  }
  if (e.type === "tool_result" && e.payload.deferred) {
    // a call the principal approved, now run: they asked for it, so they hear how it went
    // — the same sentence the model is given (§9). Ordinary results never cross.
    return [{ type: "text", kind: "text", text: `\`[harness]\` ${outcomeLine(e, 160)}` }];
  }
  if (e.type === "error") {
    // the harness's own voice reaching the principal (§2): it speaks when the model can't
    // — a gate is waiting, so no turn will be taken to relay this
    const { error } = (e as ErrorEvent).parts[0].data;
    return [{ type: "text", kind: "text", text: `\`[harness]\` ${error}` }];
  }
  if (e.type === "permission_request") {
    // the approval card, wherever the principal is (§9). It carries the ARGUMENTS, not
    // just the tool: approving is judging what will be said, and this chat is the
    // principal's own. The reply syntax rides along — the surface has no key bindings.
    const ask = (e as PermissionRequestEvent).parts[0].data;
    return [{
      type: "text",
      kind: "text",
      text: `\`[agent asks]\` approve ${boldName(ask.detail)}\n` +
        `\`reply /y to approve · /n <reason> to refuse\``,
    }];
  }
  if (e.type === "permission_response" && e.payload?.turn_id !== undefined) {
    // the agent took an ask back (`cancel`, §9) — turn_id marks the settlement as the
    // model's own doing. The principal saw the card, so they hear the withdrawal; their
    // own verdicts (no turn_id) never cross — their `/y` line is already on their surface.
    const call = (e as PermissionResponseEvent).parts[0].text;
    return [{
      type: "text",
      kind: "text",
      text: `\`[harness]\` withdrawn: ${boldName(call ?? "a pending approval")}`,
    }];
  }
  if (e.type !== "message") return null;
  const m = e as MessageEvent;
  const parts = m.parts ?? [];
  const text = textOf(m);
  if (e.payload?.turn_id !== undefined) {
    // the voice — turn_id is the mark (§3: the principal's rows carry `agent` too, so
    // presence alone can't tell the halves). Tagged: in a self-conversation BOTH speakers
    // are the same account on the surface (everything renders as the principal), so the
    // tag is the only thing that tells output from input there.
    if (!text && parts.length === 0) return null;
    return [
      ...(text ? [{ type: "text", kind: "text", text: `\`[agent]\` ${text}` } as const] : []),
      ...parts.filter((p) => p.type === "file"),
    ];
  }
  if (!text) return null;
  // the principal's own line, coming back as output on another surface: same tag shape as
  // the voice, naming where it was typed — the REPL when the mind itself is where it landed
  const where = viaOf(e)?.service ?? "repl";
  return [
    { type: "text", kind: "text", text: `\`[you via ${where}]\` ${text}` },
    ...parts.filter((p) => p.type === "file"),
  ];
}

/** `send(to: …)` → `**send**(to: …)` — the tool name in bold. Common markdown, like every
 *  harness line: the log speaks one flavour, and translating it to a surface's own dialect
 *  is the dispatcher's job, not the mirror's. The REPL shows it raw, which is fine. */
function boldName(call: string): string {
  return call.replace(/^([\w-]+)\(/, "**$1**(");
}

/** The message's words — what a surface shows and what an echo comes back carrying. */
function textOf(e: MessageEvent): string {
  return (e.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

/* ── plumbing ─────────────────────────────────────────────────────────── */

/** The agent whose mind this event lives in, or null. */
function mindOf(e: Event): string | null {
  const address = e.envelope.conversation.address;
  return address.startsWith("mind:") ? address.slice("mind:".length) : null;
}

interface Via {
  event?: string;
  service?: string;
  connection?: string;
  conversation?: string;
}

function viaOf(e: Event): Via | undefined {
  const via = e.extra?.via;
  return typeof via === "object" && via !== null ? via as Via : undefined;
}

/* ── local entry: tail the log, sync minds ↔ aliases ───────────────────
 *
 *   deno task mirror              # runs beside the ingests and dispatchers
 *
 * Env: MU_DIR. */
if (import.meta.main) {
  const { openLog } = await import("../store/log.ts");
  const { ensureOrgConfig } = await import("../config.ts");
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const cfg = await ensureOrgConfig(dir);
  const log = await openLog(`${dir}/log`);
  createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    settleMs: cfg.system.mirrorSettleMs,
    claimMs: cfg.system.mirrorClaimMs,
    onError: (e, err) =>
      console.error(`[mirror] FAILED on ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[mirror] syncing minds ↔ alias surfaces on ${dir}/log`);
}
