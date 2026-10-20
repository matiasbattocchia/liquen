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
 *             (origin event id + wire coordinates); `cause` points home. A line or a
 *             reaction that answers a card enters as its settlement instead, carrying the
 *             line (`verdict.ts`): the mind holds no message the model does not read.
 *   fan-out   every mind event the REPL would show → a CC to every alias binding EXCEPT
 *             the origin surface (read off `extra.via`). Every crossing line opens with
 *             WHO, because a self-conversation renders both speakers as the same account
 *             and the tag is the surface's only input/output distinction: the agent's
 *             voice as `[agent] …`, its tool calls as `[agent tool] **bash**(git status)`
 *             (redacted to one line), a gate waiting on the principal as `[agent asks] …`,
 *             the harness's own word as `[system] …`, and the principal's own words as
 *             `[via <surface>] …` — input replayed as output, a `/y` and a thumb on a
 *             card among them, quoting the card's own crossing. Every tag ships wrapped
 *             in backticks, so a surface that reads markdown sets it apart from the words
 *             around it (WhatsApp renders it monospace; the bridge passes code spans
 *             through untouched). The log needs no tag: authorship is the bit.
 *
 * Fan-out applied to fan-in's own mind copy is what cross-broadcasts surfaces: a WA line
 * copies to the mind, and that copy CCs — tagged `[via whatsapp]` — to Slack, origin
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
import {
  failedCallOf,
  failureOf,
  isLate,
  reactionOf,
  shortId,
  silenced,
  silent,
} from "../render.ts";
import { describeCall, describeSendCard, nameResolver } from "../describe.ts";
import { roomWords } from "../room.ts";
import { type Words, words } from "../i18n.ts";
import {
  answer,
  answerLine,
  parseVerdict,
  reactionVerdict,
  type Said,
  settle,
} from "../verdict.ts";
import type { Gates } from "../store/gates.ts";
import type { Appender, DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type {
  AlarmEvent,
  ControlEvent,
  DeltaEvent,
  Draft,
  ErrorEvent,
  Event,
  EventId,
  MessageEvent,
  Part,
  PermissionRequestEvent,
  PermissionResponseEvent,
  RoomPart,
  Service,
  ToolUseEvent,
} from "../types.ts";

export interface MirrorDeps {
  subscribe: Subscriber["subscribe"];
  /** → the EventLog: copies and CCs are ordinary published events (§4 frontier rule). */
  publish: Appender["publish"];
  /** The settle re-read (小-window): is the origin row still there, or absorbed? */
  read: Reader["read"];
  /** The open cards, off the store (§9): what a surface's `/y` is read against. */
  gates: Gates["gates"];
  /** The live bindings (§4): connect flows write them, the mirror reads through. */
  aliases: () => Promise<AliasRow[]>;
  /** The roster's word for a member (§4) — what a principal's copy is signed with, and
   *  what the replayed-input tag names. Absent ⇒ the username. */
  nameOf?: (agentId: string) => Promise<string>;
  /** The org's language (config `locale`) — the harness's own words on a surface: the tags,
   *  the reply hint, the presence line. The model's voice needs no translating: the prefix
   *  states the locale and it answers in it. Unset, or a tongue we don't speak ⇒ English. */
  locale?: string | null;
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
  const w = words(deps.locale);
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
        const cc = await ccParts(e, deps, w);
        if (cc) await fanOut(deps, e, mind, cc, now);
      });
      return;
    }
    // CCs and copies never re-enter. A CC is OURS-not-yet-on-the-wire: agent-stamped with
    // no external_id at insert (§4). Agent presence ALONE no longer means ours — the
    // classifier stamps the principal's inbound rows too, and those (external_id always
    // present: ingests refuse to mint without one) must still fan in.
    if (e.type !== "message" || (e.agent && !e.envelope.external_id) || viaOf(e)) return;
    const { service, connection_address, conversation } = e.envelope;
    enqueue(e, async () => {
      const binding = aliasOf(
        await deps.aliases(),
        service,
        connection_address,
        conversation.address,
      );
      if (binding) await fanIn(deps, e as MessageEvent, binding, settleMs, now);
    });
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
  // who signs the copy. The binding says who is on the other side (§4): the row is signed
  // with their username and the roster's word for them, never the wire's display name — a
  // self-chat carries no sender at all (the account spoke), a principal's DM carries the
  // phone's. A steering room names nobody: whoever writes there steers, so the line is
  // signed by the sender the wire names, and a line that names none crosses as nothing.
  const wire = e.envelope.sender;
  const sender = binding.principal !== undefined
    ? {
      address: binding.principal,
      name: (await deps.nameOf?.(binding.principal)) ?? binding.principal,
    }
    : wire && { address: wire.address, name: wire.name ?? wire.address };
  if (!sender) return;

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
  const mind = sessionAddress(binding.agentId, MIND);
  const origin = await quotedOrigin(deps, e, mind);
  // whose, and where from, whatever the row becomes in the mind
  const from = {
    // the principal's stamp (§3): whose mind + entered through the harness — a surface is
    // the mind's face, so the row is the MIND session's. No turn_id: input, not voice —
    // exactly a REPL line in wire clothing.
    agent: { id: binding.agentId, session_id: MIND },
    envelope: {
      service: "local" as const,
      connection_address: "agent",
      conversation: { address: mind },
      sender,
    },
    extra: {
      via: {
        event: e.id,
        service: binding.service,
        connection: e.envelope.connection_address,
        conversation: e.envelope.conversation.address,
        ...(e.envelope.external_id ? { external_id: e.envelope.external_id } : {}),
      },
    },
  };

  // a line or a reaction that answers a card is the principal settling it (§9): the mind
  // gets the settlement, carrying the line, and no message — read by the same rule the door
  // reads a terminal's `/y` by (`verdict.ts`). What settles nothing is the harness's to say.
  const card = origin ? await cardAt(deps, mind, origin) : undefined;
  const said = verdictSaid(e, card);
  if (said) {
    const a = answer(said, await deps.gates({ agentId: binding.agentId, sessionId: MIND }), card);
    const settled = typeof a === "string" ? a : await settle(
      (rows) => deps.publish(rows),
      a,
      "line" in said ? said.line : said.glyph,
      from,
    );
    if (typeof settled === "string") {
      await deps.publish({
        ts: now(),
        type: "error",
        envelope: {
          service: "local",
          connection_address: "agent",
          conversation: { address: mind },
        },
        parts: [{ type: "data", kind: "error", data: { error: settled } }],
      } as Draft<ErrorEvent>);
    }
    return;
  }

  await deps.publish({
    ts: now(),
    type: "message",
    // `ref_external_id` still rides along as the mark that they quoted AT ALL — a quote
    // that resolves to nothing falls back to provenance, not to silence. The action rides
    // too: a reaction is an `add` or a `remove` naming what it sits on.
    payload: {
      ref_id: origin ?? e.id,
      ...(e.payload?.ref_external_id ? { ref_external_id: e.payload.ref_external_id } : {}),
      ...(e.payload?.action ? { action: e.payload.action } : {}),
    },
    ...from,
    parts: e.parts ?? [],
  } as Draft<MessageEvent>);
}

/** A surface row as a verdict, if it is one: a `/y` · `/n` line, wherever it points, or a
 *  reaction from the verdict table ON a card. A thumb on any other row, a glyph off the
 *  table, an un-react — conversation, copied like any line. */
function verdictSaid(e: MessageEvent, card: PermissionRequestEvent | undefined): Said | undefined {
  const glyph = reactionOf(e);
  if (glyph === undefined) {
    const line = textOf(e);
    return parseVerdict(line) ? { line } : undefined;
  }
  if (!card || e.payload?.action === "remove" || !reactionVerdict(glyph)) return undefined;
  return { glyph };
}

/** The card a mind row id names, if it names one. */
async function cardAt(
  deps: Pick<MirrorDeps, "read">,
  mind: string,
  id: EventId,
): Promise<PermissionRequestEvent | undefined> {
  const [card] = await deps.read({
    conversation: mind,
    types: ["permission_request"],
    limit: 1,
    filter: (x) => x.id === id,
  });
  return card as PermissionRequestEvent | undefined;
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
  cc: CC,
  now: () => string,
): Promise<void> {
  const via = viaOf(e);
  // a copy goes to every surface the principal HOLDS: a revoked binding still names its
  // history, but the gate is closed there and nobody is reading
  const targets = (await deps.aliases()).filter((a) =>
    a.live && a.agentId === agentId &&
    !(via && via.service === a.service && via.conversation === a.conversation)
  );
  if (targets.length === 0) return;
  // a principal's line that points at a mind row — the card a `/y` answers, the card a
  // thumb sits on — quotes that row's crossing on each surface, the surface's own way of
  // pointing: a reply there, where a terminal names the card by its handle
  const pointed = e.type === "message" && e.payload?.turn_id === undefined
    ? e.payload?.ref_id
    : e.type === "permission_response" && !e.parts[0].data.every
    ? (await cardOf(deps, e.envelope.conversation.address, e.payload.ref_id))?.id
    : undefined;
  const quotes = await Promise.all(
    targets.map((a) => pointed ? crossingOf(deps, a.conversation, pointed) : undefined),
  );
  await deps.publish(targets.map((a, i): Draft<MessageEvent> => ({
    ts: now(),
    type: "message",
    payload: { ref_id: e.id, ...(quotes[i] ? { ref_external_id: quotes[i] } : {}) },
    // the CC is the agent's leg speaking on that surface (dispatch resolves the author's
    // alter-ego token off `agent.id`) — mind content, so the MIND session's row (§4)
    agent: { id: agentId, session_id: MIND },
    envelope: {
      service: a.service as Service, // the map stores wire strings; bindings are known services
      connection_address: a.connection,
      conversation: { address: a.conversation },
    },
    // a raw surface's dispatcher renders the crossing itself, so the copy carries what the
    // event is — its own parts, and on `via` the facts the tagged line would have spelled —
    // and the log holds exactly what that dispatcher sends. What crosses is decided above,
    // the same for every surface.
    parts: a.raw ? (e.parts ?? []) as Part[] : cc(a),
    extra: {
      via: {
        event: e.id,
        service: "local",
        conversation: sessionAddress(agentId, MIND),
        ...(a.raw ? rawVia(e) : {}),
      },
      // presence is only true while the turn runs: the sweeper never re-offers it
      ...(e.type === "delta" ? { delta: true } : {}),
    },
  })));
}

/** What a raw surface reads off a crossing besides its parts: what kind of event it was,
 *  the step that produced it (`turn_id`, the voice and its calls), who said it and through
 *  which surface (a principal's line), and the action it takes on what it points at. */
function rawVia(e: Event): Record<string, unknown> {
  const origin = viaOf(e)?.service;
  return {
    type: e.type,
    ...(e.payload?.turn_id !== undefined ? { turn_id: e.payload.turn_id } : {}),
    ...(e.envelope.sender ? { sender: e.envelope.sender } : {}),
    ...(origin ? { surface: origin } : {}),
    ...(e.payload?.action ? { action: e.payload.action } : {}),
  };
}

/** The card raised for a use, in the room it was raised in. */
async function cardOf(
  deps: Pick<MirrorDeps, "read">,
  conversation: string,
  use: EventId,
): Promise<Event | undefined> {
  const [card] = await deps.read({
    conversation,
    types: ["permission_request"],
    limit: 1,
    filter: (x) => x.payload?.ref_id === use,
  });
  return card;
}

/** The wire id a mind row's crossing landed under on one surface — what a quote of that
 *  row names there. Undefined until the dispatcher stamps it, or where it never crossed. */
async function crossingOf(
  deps: Pick<MirrorDeps, "read">,
  conversation: string,
  event: EventId,
): Promise<string | undefined> {
  const [cc] = await deps.read({
    conversation,
    limit: 1,
    filter: (x) => viaOf(x)?.event === event,
  });
  return cc?.envelope.external_id;
}

/** A crossing's parts for one surface: most read the same everywhere, but a principal's
 *  line names its author only where the surface is somebody else's. */
type CC = (target: AliasRow) => Part[];
const same = (parts: Part[]): CC => () => parts;

/** What a mind event looks like on a surface — exactly what the REPL shows (§4). Every
 *  line opens with WHO, because a self-conversation renders both speakers as the same
 *  account: `[agent] …` for the voice, `[agent tool] …` for a redacted tool call,
 *  `[agent asks] …` for a gate waiting on the principal, `[via <surface>] …` for a
 *  principal's own words replayed as output — `[<username> via <surface>]` on a surface
 *  that is another principal's — a `/y`, a `/n`, a `/cancel` among them — and `[system] …`
 *  for what the harness says there: a failure, a wake, a cut turn, a room joining or
 *  leaving the mind. Null ⇒ nothing to say
 *  there: a checkpoint (the presence line said the mind was compacting), a result that
 *  went fine, an approved call's included (the card asked for it, the `/y` gave it), a
 *  call refused (its `/n` said so) or cut (its `/cancel` said so), a settlement (the line that gave it said so; its row
 *  — handle, lapse and withdrawal all — is the terminal's). */
async function ccParts(
  e: Event,
  deps: Pick<MirrorDeps, "read" | "aliases">,
  w: Words,
): Promise<CC | null> {
  const read = deps.read;
  const line = async (words: string, files: Part[]) =>
    principalLine(e, words, files, w, await fromRoom(deps, e));
  if (silent(e)) return null; // the model said nothing (§5) — nothing crosses to a surface
  if (e.type === "tool_use") {
    // the same rendering the card gets (§9), addresses and all: a surface is where the
    // principal READS the call, so `in: Sprinters Friends` beats `in: 1203…@g.us`
    const call = (e as ToolUseEvent).parts[0].data;
    const resolve = await nameResolver(read, [call]);
    return same([{
      type: "text",
      kind: "text",
      text: `\`[${w.tool}]\` ${boldName(describeCall(call, { resolve }))}`,
    }]);
  }
  if (e.type === "tool_result") {
    // a call says itself as it is made, so only a failure speaks again — the REPL's `✗`,
    // in the tool's own words; a late one (an approved call's, an update's) names the
    // call, its row long gone. A call refused never ran: the line that refused it crossed
    // already, as did the `/cancel` that cut one.
    const { is_error, refused, cancelled } = e.parts[0].data;
    if (!is_error || refused || cancelled) return null;
    const said = isLate(e) ? failedCallOf(e) : failureOf(e);
    return same([{ type: "text", kind: "text", text: `\`[${w.system}]\` ✗ ${said}` }]);
  }
  if (e.type === "alarm") {
    // a wake the agent scheduled, its own note handed back: what the turn after it acts on
    const note = (e as AlarmEvent).parts[0]?.text ?? "";
    return same([{ type: "text", kind: "text", text: `\`[${w.system}]\` ⏰ ${note}` }]);
  }
  if (e.type === "control") {
    // the principal's hard stop is their line (`/cancel`), and the whole of the cut
    const said = (e as ControlEvent).parts[0]?.text ?? "";
    return said ? line(said, []) : null;
  }
  if (e.type === "error") {
    // the harness's own voice reaching the principal (§2): it speaks when the model can't
    // — a gate is waiting, so no turn will be taken to relay this
    const { error } = (e as ErrorEvent).parts[0].data;
    return same([{ type: "text", kind: "text", text: `\`[${w.system}]\` ${error}` }]);
  }
  if (e.type === "delta") {
    // presence (§9): what the mind is doing, for the principal on the other side of a
    // chat — the log holds the fact, the words are the surface's. The whole line is the
    // tag, the same shape every crossing line opens with
    const { kind } = (e as DeltaEvent).parts[0].data;
    return same([{ type: "text", kind: "text", text: `\`[${w.presence[kind]}]\`` }]);
  }
  if (e.type === "permission_request") {
    // the approval card, wherever the principal is (§9). It carries the ARGUMENTS, not
    // just the tool: approving is judging what will be said, and this chat is the
    // principal's own. The reply syntax rides along — the surface has no key bindings.
    const ask = (e as PermissionRequestEvent).parts[0].data;
    // a send is laid out in rows — where, what it answers, what it says — because the
    // judgment is over the words as the other end will read them; any other call is its
    // one line in full
    const body = ask.send
      ? `**${ask.tool}**\n\n${describeSendCard(ask.send, w.card)}`
      : boldName(ask.detail);
    return same([{
      type: "text",
      kind: "text",
      // a blank row between them: the legend reads apart from the call it is about
      text: `\`[${w.asks}]\` ${w.approve} ${body}\n\n\`${w.hint}\``,
    }]);
  }
  if (e.type === "permission_response") {
    // a principal's answer crosses as the line that gave it. A terminal names the card by
    // its handle; on a surface the crossing quotes the card instead (fanOut), so the handle
    // is said already. A settlement with no line — a lapse, a withdrawal, the rest of a
    // `/y all` — is the terminal's row.
    const said = answerLine(e as PermissionResponseEvent);
    if (said === undefined) return null;
    const handle = shortId(e.payload.ref_id);
    return line(said.replace(new RegExp(`(^|\\s+)${handle}(?=\\s|$)`), ""), []);
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
    return same([
      ...(text ? [{ type: "text", kind: "text", text: `\`[${w.agent}]\` ${text}` } as const] : []),
      ...parts.filter((p) => p.type === "file"),
    ]);
  }
  // a room joining or leaving the mind — a steering room a connector met or lost — is the
  // harness's word, carried by no principal
  const room = parts.find((p): p is RoomPart => p.type === "data" && p.kind === "room");
  if (room && e.agent === undefined) {
    return same([{ type: "text", kind: "text", text: `\`[${w.system}]\` ${roomWords(room)}` }]);
  }
  // a principal's own line, coming back as output on another surface: what they said — a
  // reaction says its glyph — and whatever they sent with it
  const glyph = reactionOf(m);
  const said = glyph === undefined ? text : e.payload?.action === "remove" ? "" : glyph;
  const files = parts.filter((p) => p.type === "file");
  if (!said && files.length === 0) return null;
  return line(said, files);
}

/** A principal's row on a surface: the same tag shape as the voice, saying where it was
 *  typed — the terminal when the mind itself is where it landed (the REPL and `liquen cli`
 *  both speak through the door). On a surface that is another principal's (§4), it says
 *  who, by username — by the wire's name for them when the line came through a steering
 *  room, whose writers are on no roster. */
function principalLine(e: Event, words: string, files: Part[], w: Words, room: boolean): CC {
  const where = viaOf(e)?.service ?? "terminal";
  const by = e.envelope.sender?.address;
  // a steering room's writer is no roster username: the wire's name for them says who
  const named = room ? e.envelope.sender?.name ?? by : by;
  return (a) => [
    {
      type: "text",
      kind: "text",
      text: `\`[${w.via(where, by && by !== a.principal ? named : undefined)}]\`${
        words ? ` ${words}` : ""
      }`,
    },
    ...files,
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

/** Did a mind row come in through a steering room — the binding of the surface it was
 *  copied from names no principal? */
async function fromRoom(deps: Pick<MirrorDeps, "aliases">, e: Event): Promise<boolean> {
  const via = viaOf(e);
  if (!via?.service || !via.conversation || !via.connection) return false;
  const binding = aliasOf(await deps.aliases(), via.service, via.connection, via.conversation);
  return binding !== undefined && binding.principal === undefined;
}

function viaOf(e: Event): Via | undefined {
  const via = e.extra?.via;
  return typeof via === "object" && via !== null ? via as Via : undefined;
}
