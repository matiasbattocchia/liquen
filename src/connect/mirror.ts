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
 *             the origin surface (read off `extra.via`): the agent's voice as `[agent] …`
 *             (a self-conversation renders both speakers as the principal — the tag is
 *             the surface's only input/output distinction); the principal's own words as
 *             `> quoted` + `[sent via <surface>]` (input displayed as output); tool calls
 *             as redacted one-liners (`● bash(git status)`).
 *
 * Fan-out applied to fan-in's own mind copy is what cross-broadcasts surfaces: a WA line
 * copies to the mind, and that copy CCs — quoted — to Slack, origin skipped. A CC is a
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
import { backfilled } from "../render.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type { Draft, Event, EventId, MessageEvent, Part, Service, ToolUseEvent } from "../types.ts";

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
  const settleMs = deps.settleMs ?? 1_000;
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
    if (e.type !== "message" || e.agent || viaOf(e)) return; // CCs and copies never re-enter
    const { service, connection_address, conversation } = e.envelope;
    const binding = aliasOf(deps.aliases(), service, connection_address, conversation.address);
    if (binding) {
      enqueue(
        e,
        () => fanIn(deps, e as MessageEvent, binding, settleMs, deps.claimMs ?? 60_000, now),
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

  await deps.publish({
    ts: now(),
    type: "message",
    cause: e.id,
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
    cause: e.id,
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

/** What a mind event looks like on a surface — exactly what the REPL shows (§4): the
 *  voice verbatim, the principal quoted (input displayed as output), tools redacted.
 *  Null ⇒ this event kind never crosses (thinking, results, permission plumbing). */
function ccParts(e: Event): Part[] | null {
  if (e.type === "tool_use") {
    return [{ type: "text", kind: "text", text: redact(e as ToolUseEvent) }];
  }
  if (e.type !== "message") return null;
  const m = e as MessageEvent;
  const parts = m.parts ?? [];
  const text = textOf(m);
  if (e.agent) {
    // the voice — tagged: in a self-conversation BOTH speakers are the same account on
    // the surface (everything renders as the principal), so the tag is the only thing
    // that tells output from input there. The log needs none — authorship is the bit.
    if (!text && parts.length === 0) return null;
    return [
      ...(text ? [{ type: "text", kind: "text", text: `[agent] ${text}` } as const] : []),
      ...parts.filter((p) => p.type === "file"),
    ];
  }
  if (!text) return null;
  const tag = viaOf(e)?.service ?? "repl";
  const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
  return [
    { type: "text", kind: "text", text: `${quoted}\n[sent via ${tag}]` },
    ...parts.filter((p) => p.type === "file"),
  ];
}

/** The message's words — what a surface shows and what an echo comes back carrying. */
function textOf(e: MessageEvent): string {
  return (e.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

/** One redacted line per tool call, Claude-Code style: `● bash(git status)`. */
function redact(e: ToolUseEvent): string {
  const { name, input } = e.parts[0].data;
  const args = (input ?? {}) as Record<string, unknown>;
  const detail = typeof args.command === "string"
    ? args.command // bash: the command line IS the story
    : name === "send"
    ? `→ ${String(args.to ?? "")}`
    : Object.entries(args)
      .filter(([, v]) => typeof v === "string" && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  const line = `● ${name}(${detail.replace(/\s+/g, " ").trim()})`;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
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
  const dir = Deno.env.get("MU_DIR") ?? "./data";
  const log = await openLog(`${dir}/log`);
  createMirror({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    read: (q) => log.read(q),
    aliases: () => log.aliases(),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    onError: (e, err) =>
      console.error(`[mirror] FAILED on ${e.envelope.conversation.address}:`, err),
  });
  console.error(`[mirror] syncing minds ↔ alias surfaces on ${dir}/log`);
}
