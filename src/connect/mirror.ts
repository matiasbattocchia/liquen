/**
 * connect/mirror.ts — the mind-alias mirror (DESIGN §4): one agent, many surfaces, one log.
 *
 * A principal-identified conversation on a connected surface (the WA self-chat, the Slack
 * self-DM) IS the mind — the same chat as the REPL, picked up from a phone. The mirror is
 * the broker-side component that keeps every such surface and the mind in sync, by COPY
 * (never rewrite — an event with the right envelope must exist in the log for a dispatcher
 * to carry it, and the wire original stays honest where it landed):
 *
 *   fan-in    an inbound on an alias conversation → a COPY into `mind@<agent>` — the agent
 *             wakes on it exactly as on a REPL line. `extra.via` holds the provenance
 *             (origin event id + wire coordinates); `cause` points home.
 *   fan-out   every mind event the REPL would show → a CC to every alias binding EXCEPT
 *             the origin surface (read off `extra.via`). Every crossing line opens with
 *             WHO, because a self-conversation renders both speakers as the same account
 *             and the tag is the surface's only input/output distinction: the agent's
 *             voice as `[agent] …`, its tool calls as `[agent tool] **bash**(git status)`
 *             (redacted to one line), a gate waiting on the principal as `[agent asks] …`,
 *             the harness's own word as `[system] …`, and the principal's own words as
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
 *     fan-in settles (`SETTLE_MS`) and re-reads the origin row; the backfill has absorbed it
 *     by then, and a row that is gone copies nothing.
 *   the claim NEVER lands — the dispatcher died between posting and backfilling, or the API
 *     returned no id to stamp (a Slack file share). Then the echo stays a first-class
 *     inbound forever. But an inbound always carries the platform's id, so a CC of the same
 *     words still holding NONE can only be that post: fan-in stamps it (`unclaimed`), which
 *     absorbs the echo exactly as the dispatcher would have, and copies nothing.
 */

import { aliasOf, type AliasRow } from "../store/connections.ts";
import { MIND, parseSession, sessionAddress } from "../session.ts";
import { outcomeLine, silenced, silent } from "../render.ts";
import { describeCall, nameResolver } from "../describe.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type {
  DeltaEvent,
  DeltaKind,
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
  /** The roster's word for a member (§4) — what a principal's copy is signed with, and
   *  what the replayed-input tag names. Absent ⇒ the username. */
  nameOf?: (agentId: string) => string;
  /** The unclaimed-CC repair: stamp a CC with the id its own post came back carrying —
   *  the dispatcher's `setDelivery`, run late by the mirror (it absorbs the echo row). */
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  now?: () => string;
  onError?: (event: Event, err: unknown) => void;
}

/** Wire the mirror to the log. Returns unsubscribe. Serialized: copies keep log order.
 *  `settleMs` is `SETTLE_MS` — a waited constant, so the value is the seam (§9): a test
 *  passes a smaller one rather than sitting out the real window. */
export function createMirror(deps: MirrorDeps, settleMs: number = SETTLE_MS): () => void {
  const now = deps.now ?? (() => new Date().toISOString());
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (e: Event, work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => deps.onError?.(e, err));
  };

  return deps.subscribe((e) => {
    if (silenced(e)) return; // silenced rows are not news (§5) — history never mirrors,
    //   and a muted chat's traffic never reaches a surface the principal silenced it from
    const mind = mindOf(e);
    if (mind !== null) {
      enqueue(e, async () => {
        const parts = await ccParts(e, deps);
        if (parts) await fanOut(deps, e, mind, parts, now);
      });
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
      enqueue(e, () => fanIn(deps, e as MessageEvent, binding, settleMs, now));
    }
  });
}

/* ── fan-in: alias surface → the mind ─────────────────────────────────── */

/** The 小-window: how long fan-in waits for a dispatch backfill to absorb an early echo.
 *  It measures one thing — the gap between a post going out and its id being written down —
 *  so it is a property of the code, not of a deployment. */
const SETTLE_MS = 1_000;

/** How far back the unclaimed-CC guard looks for an echo's twin. A false-positive bound,
 *  not a latency budget: past it, saying the same words again stops being confusable with
 *  a post whose claim never landed. */
const CLAIM_MS = 60_000;

async function fanIn(
  deps: MirrorDeps,
  e: MessageEvent,
  binding: AliasRow,
  settleMs: number,
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
  const twin = await unclaimed(deps, e);
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
  const origin = await quotedOrigin(deps, e, sessionAddress(binding.agentId, MIND));
  await deps.publish({
    ts: now(),
    type: "message",
    // `ref_external_id` still rides along as the mark that they quoted AT ALL — a quote
    // that resolves to nothing falls back to provenance, not to silence
    payload: {
      ref_id: origin ?? e.id,
      ...(e.payload?.ref_external_id ? { ref_external_id: e.payload.ref_external_id } : {}),
    },
    // the principal's stamp (§3): whose mind + entered through the harness — a surface is
    // the mind's face, so the copy is the MIND session's row. No turn_id: input, not
    // voice — exactly a REPL line in wire clothing.
    agent: { id: binding.agentId, session_id: MIND },
    envelope: {
      service: "local",
      connection_address: "agent",
      conversation: { address: sessionAddress(binding.agentId, MIND) },
      // the binding says who is on the other side (§4): the copy is signed with their
      // username and the roster's word for them, never the wire's display name — a
      // self-chat carries no sender at all (the account spoke), a principal's DM carries
      // the phone's
      sender: {
        address: binding.principal,
        name: deps.nameOf?.(binding.principal) ?? binding.principal,
      },
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

/** The mind event a quoted surface row was made from, if the quote can be joined. Both
 *  directions of the crossing carry the join, at opposite ends:
 *
 *    OURS   — the quoted row is one of our CCs, and its `extra.via.event` names the mind
 *             event it was made from (the approval card, the agent line, whatever crossed).
 *    THEIRS — the quoted row is an inbound, and the mind's own copy of it carries the
 *             surface id in `extra.via.external_id`. The transcriber's case (§5): a
 *             transcript is an `add` naming the audio it transcribes, and in the mind it has
 *             to name the audio's COPY, which is the only row the agent can see.
 *
 *  A quote that joins to neither (a row outside the log) resolves to nothing and the copy
 *  keeps plain provenance. */
async function quotedOrigin(
  deps: MirrorDeps,
  e: MessageEvent,
  mind: string,
): Promise<EventId | undefined> {
  const quoted = e.payload?.ref_external_id;
  if (!quoted) return undefined;
  const ours = await deps.read({
    conversation: e.envelope.conversation.address,
    limit: 1,
    filter: (x) => x.envelope.external_id === quoted,
  });
  const via = ours[0]?.extra?.via as { event?: EventId } | undefined;
  if (via?.event) return via.event;
  const theirs = await deps.read({
    conversation: mind,
    limit: 1,
    filter: (x) => (x.extra?.via as { external_id?: string } | undefined)?.external_id === quoted,
  });
  return theirs[0]?.id;
}

/** Our own post, returning unrecognized: a CC on this surface carrying the same words and
 *  no `external_id`. A healthy dispatcher stamps its row in milliseconds, so an unstamped
 *  one means the claim never landed — the state is otherwise unobservable, which is what
 *  makes the match safe. Newest first: the last thing we said is what just came back. */
async function unclaimed(deps: MirrorDeps, e: MessageEvent): Promise<Event | undefined> {
  const words = textOf(e);
  const rows = await deps.read({
    conversation: e.envelope.conversation.address,
    types: ["message"],
    after: new Date(Date.parse(e.ts) - CLAIM_MS).toISOString(),
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
  // a copy goes to every surface the principal HOLDS: a revoked binding still names its
  // history, but the gate is closed there and nobody is reading
  const targets = deps.aliases().filter((a) =>
    a.live && a.agentId === agentId &&
    !(via && via.service === a.service && via.conversation === a.conversation)
  );
  if (targets.length === 0) return;
  await deps.publish(targets.map((a): Draft<MessageEvent> => ({
    ts: now(),
    type: "message",
    payload: { ref_id: e.id },
    // the CC is the agent's leg speaking on that surface (dispatch resolves the author's
    // alter-ego token off `agent.id`) — mind content, so the MIND session's row (§4)
    agent: { id: agentId, session_id: MIND },
    envelope: {
      service: a.service as Service, // the map stores wire strings; bindings are known services
      connection_address: a.connection,
      conversation: { address: a.conversation },
    },
    parts,
    extra: {
      via: { event: e.id, service: "local", conversation: sessionAddress(agentId, MIND) },
      // presence is only true while the turn runs: the sweeper never re-offers it
      ...(e.type === "delta" ? { delta: true } : {}),
    },
  })));
}

/** The word a presence line carries for each delta (§9): the surface's, not the log's. */
export const PRESENCE_WORD: Record<DeltaKind, string> = {
  thinking: "thinking",
  checkpoint: "compacting",
};

/** What a mind event looks like on a surface — exactly what the REPL shows (§4). Every
 *  line opens with WHO, because a self-conversation renders both speakers as the same
 *  account: `[agent] …` for the voice, `[agent tool] …` for a redacted tool call,
 *  `[agent asks] …` for a gate waiting on the principal, `[<name> via <surface>] …` for a
 *  principal's own words replayed as output. Null ⇒ this event kind never crosses
 *  (thinking, results, the verdict itself — which is the principal's own `/y`; the
 *  agent's own settlement, a `cancel`, crosses as a `[system]` withdrawal). */
async function ccParts(
  e: Event,
  deps: Pick<MirrorDeps, "read" | "nameOf">,
): Promise<Part[] | null> {
  const read = deps.read;
  if (silent(e)) return null; // the model said nothing (§5) — nothing crosses to a surface
  if (e.type === "tool_use") {
    // the same rendering the card gets (§9), addresses and all: a surface is where the
    // principal READS the call, so `in: Sprinters Friends` beats `in: 1203…@g.us`
    const call = (e as ToolUseEvent).parts[0].data;
    const resolve = await nameResolver(read, [call]);
    return [{
      type: "text",
      kind: "text",
      text: `\`[agent tool]\` ${boldName(describeCall(call, { resolve }))}`,
    }];
  }
  if (e.type === "tool_result" && e.payload.deferred) {
    // a call the principal approved, now run: they asked for it, so they hear how it went
    // — the same sentence the model is given (§9). Ordinary results never cross.
    return [{ type: "text", kind: "text", text: `\`[system]\` ${outcomeLine(e, 160)}` }];
  }
  if (e.type === "error") {
    // the harness's own voice reaching the principal (§2): it speaks when the model can't
    // — a gate is waiting, so no turn will be taken to relay this
    const { error } = (e as ErrorEvent).parts[0].data;
    return [{ type: "text", kind: "text", text: `\`[system]\` ${error}` }];
  }
  if (e.type === "delta") {
    // presence (§9): what the mind is doing, for the principal on the other side of a
    // chat — the log holds the fact, the words are the surface's. The whole line is the
    // tag, the same shape every crossing line opens with
    const { kind } = (e as DeltaEvent).parts[0].data;
    return [{ type: "text", kind: "text", text: `\`[agent ${PRESENCE_WORD[kind]}...]\`` }];
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
      text: `\`[system]\` withdrawn: ${boldName(call ?? "a pending approval")}`,
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
  // a principal's own line, coming back as output on another surface: same tag shape as
  // the voice, naming who typed it and where — the reader there may be another principal
  // (§4), so the line says which; the REPL when the mind itself is where it landed
  const where = viaOf(e)?.service ?? "repl";
  const sender = e.envelope.sender;
  const who = sender?.address
    ? deps.nameOf?.(sender.address) ?? sender.name ?? sender.address
    : sender?.name ?? "you";
  return [
    { type: "text", kind: "text", text: `\`[${who} via ${where}]\` ${text}` },
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

/** The agent whose MIND this event lives in, or null. A sibling session's room is a
 *  session address too, and it never mirrors: surfaces are the mind's faces alone (§4). */
function mindOf(e: Event): string | null {
  const s = parseSession(e.envelope.conversation.address);
  return s !== null && s.sessionId === MIND ? s.agentId : null;
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
