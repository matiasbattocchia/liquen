/**
 * xi.ts — the consumer (DESIGN §2): short-lived, one invocation per event.
 *
 * xi is not a process. main (or a DB trigger, later) invokes `handle` once per POKE — and
 * **the invocation IS the poke**: it carries no event, no payload, no id, because there is
 * nothing xi would trust. xi reads the log, derives THE verdict — once — does the owed work,
 * and exits. The log is the continuation engine: every publish is itself the next trigger,
 * the closing assistant message is the turn's self-poke, and quiescence is an invocation that
 * finds nothing owed. xi never re-triggers itself.
 *
 *   handle: owed (think | act | null)
 *     null       → return                      (no lock — a poke that finds nothing is free)
 *     think/act  → acquire-or-exit → fresh re-read (the work input) → work → publish → release
 *
 * So there is no filter above xi and no state beside it: no event classes, no poke queue, no
 * coalescing (N invocations during one turn all bounce off the lock and the last window read
 * sees everything). WHAT is owed — pending tools, an unclosed chain, unanswered messages — is
 * derived from the log, so every invocation does the right work. A stolen lock (TTL expired — the previous holder crashed) turns act's execute into a
 * sweep: pending uses get cancelled results instead of a blind re-run of tools whose
 * side-effects may already have happened; the model sees the cancellations and re-decides.
 *
 * xi is the harness's sole contact with the log — the only reader (the window, `search`,
 * gate/barrier queries) and the only publisher. Nothing below it — neither nu nor mu —
 * sees a log; and xi itself never subscribes: the tail belongs to main.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  Action,
  AlarmEvent,
  Draft,
  Emit,
  Envelope,
  ErrorEvent,
  Event,
  EventId,
  Json,
  MessageEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  PermissionVerdict,
  PolicyAction,
  Rule,
  SearchArgs,
  SearchResult,
  Session,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import {
  DEFAULT_DIGEST_AFTER_MESSAGES,
  DEFAULT_DIGEST_MINUTES,
  DEFAULT_ENGAGED_MINUTES,
  DEFAULT_RULES,
  DEFAULT_SLEEP_HOURS,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_LIMIT,
} from "./config.ts";
import { type Describe, describeCall, nameResolver } from "./describe.ts";
import type { Appender, Reader } from "./store/log.ts";
import type { Registry } from "./store/agents.ts";
import type { RememberedRule, Standing } from "./store/rules.ts";
import type { Connections } from "./store/connections.ts";
import type { Docs } from "./store/docs.ts";
import { LeaseLost, type Locker } from "./store/lock.ts";
import { nextFire, type Timers, zonedTime } from "./store/timers.ts";
import { filePartOf, loadMediaBlock, memoizedLoader } from "./store/media.ts";
import { dmAddress, MIND, parseSession, sessionAddress } from "./session.ts";
import { hhmm, ownComplex, ownVoice, parseVerdict, shortId, silenced, textOf } from "./render.ts"; // shared predicates: silenced never wakes;
// ownVoice (§3) tells the model's output from EVERYTHING else — including its own
// principal's rows, which carry agent.id (and via the harness, session_id) but no turn_id
import { type ModelTransport, nu, type TurnConfig } from "./nu.ts";

/* ── the poke, the class filter, and the owed-derivation ──────────────── */

/** The decision: what the log owes right now (§2). `ignore` ⇒ nothing owed — quiescence,
 *  the next move is a human's, or we just failed. */
export type Decision = "think" | "act" | "ignore";

/** Policy, per CALL — the name, the arguments, and where the call LANDS (§9): a dispatching
 *  tool carries a target, and that is what a scoped rule matches on. */
export type Gate = (name: string, input: Json, target?: Target) => PolicyAction;

/** Where a call lands (§9): send's resolved destination, the fields a scoped rule names —
 *  the conversation, and the connection (account/workspace) it rides. */
export interface Target {
  connection?: string;
  conversation?: string;
}

/** The default table (`config.ts` catalog, org/agent-overridable) — and it IS a table, not
 *  a branch: there are no special tools. `bash` runs unasked because a rule says so, and
 *  `send` asks because dispatch leaves the org and speaks in the principal's name. First
 *  match decides, so specifics go first: `deny #general` above `allow slack` above
 *  `ask send`. A standing verdict (`/always`, `/never`) will write into this same shape. */
export function gateOf(rules: Rule[] = DEFAULT_RULES): Gate {
  return (name, _input, target) =>
    rules.find((r) => (r.tool === name || r.tool === "*") && inScope(r, target))?.action ??
      "allow";
}

/** A remembered row (store/rules.ts) as the table row it compiles to — a standing verdict
 *  is `allow`/`deny` by construction, never `ask` (asking is what it replaced). */
function ruleOf(r: RememberedRule): Rule {
  return {
    tool: r.tool,
    action: r.action,
    ...(r.connection !== undefined ? { connection: r.connection } : {}),
    ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
  };
}

/** A rule's scope fields must ALL hold on the call's target; a scopeless rule holds on any
 *  call. A call with no target (bash) matches only scopeless rules — a rule that names a
 *  place never leaks onto tools that go nowhere. */
function inScope(r: Rule, t?: Target): boolean {
  const keys = (["connection", "conversation"] as const)
    .filter((k) => r[k] !== undefined);
  if (keys.length === 0) return true;
  return t !== undefined && keys.every((k) => r[k] === t[k]);
}

/** The slice of AgentConfig the wake policy reads (§2 attention) — its own type so tests
 *  and future callers state exactly what deciding takes. Unset knobs are the catalog's. */
export interface Wake {
  timezone?: string;
  engagedMinutes?: number;
  digestAfterMessages?: number;
  digestMinutes?: number;
  /** Org-clock span "23-8" the ambient world waits out; null ⇒ never sleeps; unset ⇒ catalog. */
  sleepHours?: string | null;
}

/** Decide — once, from one window — what is owed. Position-aware, so a late invocation that
 *  arrives after the work was already done decides `ignore` (quiescence). */
export function decide(
  events: Event[],
  session: Session,
  wake: Wake,
  now: number = Date.now(),
): Decision {
  // A gate never wedges the mind. Every use gets an answer in the turn it was made — a
  // gated one gets `pending_approval` — so the chain always closes and the conversation
  // continues while the principal decides. (Before that it did not: a turn taken with our
  // own `tool_use` unresolved RE-ISSUES it, so the only safe move was to
  // ignore everything, principal included. Answering the call removes the reason.)
  if (pendingOf(events, session).length > 0) return "act";
  // …and a verdict that has since landed is work of its own: run the call, report back.
  if (owedOf(events, session).length > 0) return "act";
  if (cutOff(events)) return "think"; // a paced/truncated turn CONTINUES
  if (justFailed(events)) return "ignore"; // idle-after-error
  if (unclosedChain(events, session)) return "think";
  return attention(events, session, wake, now);
}

/* ── attention (§2): three wake classes over the unanswered news ────────── */

/**
 * The baseline is that every message deserves a reaction; this is the LADDER that cools
 * that down, and every rung is a fact about the news, never a timer deciding whether
 * something was worth reading:
 *
 *   1. a SUMMONS — the mind alias, and nothing else — wakes now
 *   2. during `sleepHours` the world gets nothing (3 and 4 still apply — see below)
 *   3. an ENGAGED conversation wakes now: you don't drop out of one you are in
 *   4. unless the principal took the floor there, which cancels 3 and only 3
 *   5. otherwise the agent CHECKS the world every `digestMinutes`, counted from the last
 *      time it looked — the way you put the phone down and pick it up again
 *   6. or early, when `digestAfterMessages` have piled up across the whole world
 *
 * A transcript is not a rung of its own: it INHERITS the attention of the note it names.
 * The words ARE that message, arriving late — so they wake once the note has been looked at
 * and could not be read (below the night, which swallows the note too), and they never count
 * as a second arrival in the depth.
 *
 * Deferring costs nothing and loses nothing: the news stays owed in the log, and the clock
 * poke (main's tick) re-asks this same question until it is due.
 */
function attention(events: Event[], session: Session, wake: Wake, now: number): Decision {
  const news = newsOf(events, session);
  if (news.length === 0) return "ignore";
  // a NAMED session is REACTIVE (§4): only its own rooms reach it at all — its window is
  // its enrollments — so every piece of news is addressed to it, and the ladder below
  // (digest cadence, the night) is the MIND's, built for a world that talks around you.
  if (session.id !== MIND) return "think";
  // The summons is the MIND ALIAS and nothing else (§2). Not a DM, not a reply to the
  // agent, not its name said out loud: none of those address the agent, they address the
  // principal's account in a room the agent is a bystander in — and answering each at wake
  // priority is a full turn per line of somebody else's conversation. What is genuinely
  // said TO the agent arrives here, through the mirror's fan-in; the rest is the world,
  // and the world waits. Nothing is lost that `engaged` doesn't already hold: a reply that
  // lands while the agent has the floor wakes it as engaged, and one that lands after the
  // floor decayed is the world talking, which is what the digest is for.
  if (news.some((e) => e.envelope.conversation.address === session.conversation)) {
    return "think";
  }
  // an ALARM wakes now, wherever it landed: it fired at a time the agent itself chose, and
  // deferring it to the digest (or sleeping through it) would answer a question nobody
  // asked — "was 07:00 really what you meant?". The one wake class the agent set itself.
  if (news.some((e) => e.type === "alarm")) return "think";
  // holding the floor is the one question that is per-conversation — so the news is grouped
  // for it, and for nothing else: the two rules below weigh the world as one thing
  for (const conv of new Set(news.map((e) => e.envelope.conversation.address))) {
    if (engaged(conv, events, session, wake, now)) return "think";
  }
  // ASLEEP: inside the span the ambient class wakes nobody, however deep the pile. The two
  // classes above still do — the principal's own line at 3am is answered, and a conversation
  // the agent is holding the floor in is one it is IN — so what sleeps is the world, which
  // is the only class that was never addressed to anyone here. A stretched night interval
  // (what this replaces) was a number tuned against a cache TTL nobody controls: past an
  // hour every wake pays a full uncached write anyway, so the three it bought cost more
  // than the ten they replaced, and each read a third of a night. Sleeping drops the
  // number: the night arrives once, whole, as the first digest of the morning.
  if (asleep(now, wake)) return "ignore";
  const looked = lastLook(events, session);
  // WORDS FOR A NOTE THE AGENT HAS ALREADY LOOKED AT wake now — below the night, because a
  // voice note is the ambient world and the night swallows that whole. A note reaches the
  // model as `<audio/>`: a marker saying somebody spoke, with no way to tell what. A turn
  // that "read" one did not read it — it was handed a sealed envelope and moved on, that
  // being the only move available. The transcript is the first legible copy of a message the
  // agent already spent its look on, and it lands out of band, minutes later, long after the
  // wake that carried the note is gone. Making it queue for the next digest decides that
  // message on the second chance when the first one was never usable. So the words inherit
  // what the note could not use. A note still unread needs none of this: its words are in
  // the same pile it is, and the digest reads the two together.
  if (news.some((e) => lateWords(e, events, looked))) return "think";
  return digestDue(news, looked, wake, now) ? "think" : "ignore";
}

/** Is this event a transcript — machine words ridden onto a message that carried none? */
function words(e: Event): { ref: string } | undefined {
  if (e.type !== "message" || e.payload?.action !== "add") return undefined;
  if (!e.parts.some((p) => p.type === "text" && p.kind === "transcript")) return undefined;
  const ref = e.payload.ref_external_id;
  return typeof ref === "string" && ref !== "" ? { ref } : undefined;
}

/** A transcript whose note is already BEHIND the last look — the half of rung-inheritance
 *  that wakes (the other half, not double-counting, lives in `digestDue`). A note the window
 *  no longer holds is older than everything in it, so it is behind any look that happened. */
function lateWords(e: Event, events: Event[], looked: number): boolean {
  const w = words(e);
  if (!w || looked === -Infinity) return false; // never looked ⇒ nothing is behind the look
  const note = events.find((n) => n.envelope.external_id === w.ref);
  return note === undefined || Date.parse(note.ts) < looked;
}

/**
 * The agent HOLDS THE FLOOR in the conversation ⇒ it is IN it. Two conditions, both on the
 * last thing our complex said there: it was the agent's own voice, and it is recent. Every
 * reply refreshes the clock (the ping-pong extension); silence lets it decay.
 *
 * The floor is the point. Scanning for the agent's last word alone would skip PAST the
 * principal's — so an agent that spoke once kept waking for a conversation its principal
 * had since taken over by hand, answering over them for a whole engagement window. So the
 * scan stops at whichever half spoke last (`ownComplex`, either half) and engagement holds
 * only if that half was the model (`ownVoice` — the discriminator is `payload.turn_id`,
 * §3). A principal typing into that conversation from their phone ends it, at once and
 * without a clock: they took the floor back. To hand it over again they say so at home,
 * which is the one thing that still wakes the agent now.
 */
function engaged(
  conversation: string,
  events: Event[],
  session: Session,
  wake: Wake,
  now: number,
): boolean {
  const minutes = wake.engagedMinutes ?? DEFAULT_ENGAGED_MINUTES;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === "message" && ownComplex(e, session) &&
      e.envelope.conversation.address === conversation
    ) return ownVoice(e, session) && now - Date.parse(e.ts) < minutes * 60_000;
  }
  return false;
}

/**
 * Checking the phone (rules 5 and 6). Both weigh the world as ONE thing, and both are
 * clocked off the agent, not off the messages.
 *
 * The interval runs from the LAST LOOK, not from the oldest unread — that is the whole
 * difference between "I check every fifteen minutes" and "every message sits for fifteen
 * minutes before I read it". The second is what a pile-age clock does, and it is not
 * behaviour anyone would ask for: a line arriving fourteen minutes into the interval waits
 * fifteen more. From the last look it waits one. It also means an agent that has been quiet
 * for hours reads the next world message at once — the anchor is long past — which is what
 * a person does when they pick up a phone they put down after lunch.
 *
 * The depth is a count across every conversation, so it measures how much has arrived,
 * not how much arrived in any one room. There is nothing to exclude: home news never
 * accumulates (it is answered on arrival and the horizon eats it), an engaged conversation
 * wakes before it piles, and a silenced one never becomes news at all.
 */
function digestDue(news: Event[], looked: number, wake: Wake, now: number): boolean {
  // …and it counts ARRIVALS, not rows. A voice note still in the pile when its transcript
  // lands is one thing that happened, not two — the words are that message becoming
  // readable. Counting both would let a handful of notes fake a deep pile.
  const unread = new Set(news.map((e) => e.envelope.external_id).filter(Boolean));
  const depth = news.filter((e) => !unread.has(words(e)?.ref)).length;
  if (depth >= (wake.digestAfterMessages ?? DEFAULT_DIGEST_AFTER_MESSAGES)) return true;
  const minutes = wake.digestMinutes ?? DEFAULT_DIGEST_MINUTES;
  return now - looked >= minutes * 60_000;
}

/** When the agent last LOOKED: the stamp on its last closing home message. That closing is
 *  the end of a turn that read a whole window, so everything the world had said by then was
 *  in front of the model — including the conversations it chose to leave alone. Which is why
 *  one mark serves the whole world and none of this is per-conversation. `-Infinity` when
 *  the agent has never closed a turn: it has never looked, so the world is due now. */
function lastLook(events: Event[], session: Session): number {
  const i = lastClosing(events, session);
  return i === -1 ? -Infinity : Date.parse(events[i].ts);
}

/** Index of the agent's last message home — where a turn ends, §2. */
function lastClosing(events: Event[], session: Session): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === "message" && ownVoice(e, session) &&
      e.envelope.conversation.address === session.conversation
    ) return i;
  }
  return -1;
}

/** Is the org's clock inside the sleep span? "23-8" wraps midnight; null ⇒ never sleeps. */
function asleep(now: number, wake: Wake): boolean {
  const span = wake.sleepHours === undefined ? DEFAULT_SLEEP_HOURS : wake.sleepHours;
  const m = span === null ? null : /^(\d{1,2})-(\d{1,2})$/.exec(span);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const hour = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(wake.timezone ?? DEFAULT_TIMEZONE).hour;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Max consecutive `max_tokens` continuations — bounds a runaway generation (§2). */
const MAX_OVERFLOWS = 3;

/** The last turn ended mid-flight ⇒ re-entering CONTINUES it. `pause_turn`: the server paced
 *  ONE turn. `max_tokens`: the ceiling cut it off, and the partial output is already committed,
 *  so the next turn picks up where it stopped (nu emitted the advisory the model reads).
 *  nu stamps the outcome on the turn's last event, which is what puts this continuation in
 *  the LOG rather than in a loop inside xi — one invocation, one turn. */
function cutOff(events: Event[]): boolean {
  const stops = events.map((e) => e.payload?.stop_reason).filter((s): s is string =>
    s !== undefined
  );
  const last = stops.at(-1);
  if (last === "pause_turn") return true; // the server's own pacing — it says when to stop
  if (last !== "max_tokens") return false; // end_turn · tool_use · refusal are all endings
  let run = 0; // consecutive overflows at the tail — 3 and we stop, however long the work is
  for (let i = stops.length - 1; i >= 0 && stops[i] === "max_tokens"; i--) run++;
  return run < MAX_OVERFLOWS;
}

/** A harness `error` is the LAST thing in the window ⇒ nothing owed, on purpose (§2).
 *  The work is still unanswered, so every other derivation would say "think" — and since
 *  publishing that error is itself the next trigger, re-deriving would hot-loop a failing
 *  think with no backoff. A logged error means we already gave up: transient failures were
 *  retried inside nu before one was ever written, so this is a PERMANENT failure until
 *  something new arrives. `relevant` says the same from the event side.
 *
 *  Except while we're CONTINUING: nu's `max_tokens` advisory is itself an error event (the
 *  turn WAS truncated), so "an error is terminal" has to mean "…unless the turn is being
 *  continued" — including the moment the overflow cap ends the continuation, which is exactly
 *  when this rule takes over and idles. Self-contained on purpose: `decide` may test the two
 *  in either order. */
function justFailed(events: Event[]): boolean {
  return events.at(-1)?.type === "error" && !cutOff(events);
}

/**
 * The cheap gate, over the ONE event that triggered this invocation: could it change what the
 * log owes *this* agent? Pure — no log, no lease — so a spectator costs nothing at all. Same
 * semantics as `decide` from the other end: `false` ≡ `ignore`.
 *
 * One question, answerable from the event alone: can its CLASS imply work. Visibility is NOT
 * asked here — it's the port's law (§6): the trigger arrives through the agent's scoped
 * subscription (already readable, the Realtime shape) and the window comes through the scoped
 * read, so xi never handles an event it may not see. An invocation with no trigger at all
 * (boot) skips the gate and looks.
 *
 * It stays a pure predicate over one row on purpose: that's what a Postgres trigger's `WHEN`
 * clause can express (readable being the trigger body's shared-predicate check + RLS, §9), so
 * the DB tier can skip the invocation entirely.
 */
export function relevant(config: AgentConfig, event: Event): boolean {
  switch (event.type) {
    case "message": // a peer's IS the work; our own closing message is the self-poke that
      return !silenced(event); //   catches whatever landed mid-turn (§2)
    case "tool_use":
    case "tool_result": // never react to others' tools — ownership is the PAIR (§4)
      return ownComplex(event, { agentId: config.agentId, id: config.sessionId });
    case "permission_response": // the human moved — the settlement is derivable now
    case "alarm": // the universal poke (§2)
      return true;
    case "summary": // the one self-authored non-message that wakes: a checkpoint DISPLACES a
      return true;
    // `error` is a PERMANENT failure until something new arrives — retrying transient ones
    // already happened inside nu, so a logged error means we stopped. `decide` says the same
    // from the window side (a trailing error ⇒ ignore); waking here would hot-loop.
    // `control` acts on a RUNNING turn (§10), it never starts one.
    //  turn (§5), so its insert must carry the think it displaced forward
    default:
      return false; // thinking · error · permission_request · control · unknown
  }
}

/* ── the owed derivations (pure, over one window) ─────────────────────── */

/** Our tool uses with no result yet — the batch `act` owes an answer to (a log query). */
function pendingOf(events: Event[], session: Session): ToolUseEvent[] {
  const answered = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => e.payload?.ref_id),
  );
  return events.filter((e): e is ToolUseEvent =>
    e.type === "tool_use" && ownComplex(e, session) && !answered.has(e.id)
  );
}

/** The asks nobody has answered yet: the anchor's list, and what a verdict lands on. Request
 *  and response both point `ref_id` at the USE — a star, not a chain (§3). */
function openCards(events: Event[]): PermissionRequestEvent[] {
  const answered = new Set(
    events.filter((e) => e.type === "permission_response").map((e) => e.payload?.ref_id),
  );
  return events.filter((e): e is PermissionRequestEvent =>
    e.type === "permission_request" && !answered.has(e.payload?.ref_id as EventId)
  );
}

/** The principal's verdict on a use, if they have given one. */
function verdictOf(events: Event[], use: EventId): PermissionVerdict | undefined {
  return events.find((e): e is PermissionResponseEvent =>
    e.type === "permission_response" && e.payload?.ref_id === use
  )?.parts[0].data;
}

/** An answered ask whose OUTCOME is still owed: the model already holds its
 *  `pending_approval` result, the principal has since ruled, and nothing has run or
 *  reported back. This is the second half of a non-blocking gate — the call the harness
 *  makes on the model's behalf, long after the turn that asked for it ended. */
interface Owed {
  use: ToolUseEvent;
  verdict: PermissionVerdict;
}

function owedOf(events: Event[], session: Session): Owed[] {
  const reported = new Set<EventId | undefined>();
  const answered = new Set<EventId | undefined>();
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    (e.payload.deferred ? reported : answered).add(e.payload.ref_id);
  }
  const out: Owed[] = [];
  const seen = new Set<EventId>();
  for (const e of events) {
    if (e.type !== "permission_response") continue;
    // turn_id marks a settlement a model turn produced — a `cancel` withdrawing its own
    // ask (§3 authorship). Only someone ELSE's ruling ever creates the harness's errand.
    if (e.payload.turn_id !== undefined) continue;
    const ref = e.payload.ref_id;
    // not answered yet ⇒ the fresh batch settles it inline, with a real tool_result;
    // already reported ⇒ done. Only the middle case is the harness's late errand.
    if (seen.has(ref) || reported.has(ref) || !answered.has(ref)) continue;
    const use = events.find((x): x is ToolUseEvent =>
      x.type === "tool_use" && x.id === ref && ownComplex(x, session)
    );
    if (!use) continue;
    seen.add(ref);
    out.push({ use, verdict: e.parts[0].data });
  }
  return out;
}

/** The verdict, as the principal types it on any surface (§9):
 *  `/{y,n} [once|conv|conn|always|all] [reason]`. Two independent axes, one word each:
 *
 *    HOW LONG   `once` (the bare form) settles this call. `conv` · `conn` · `always` make
 *               it STANDING — remembered for the conversation, the connection, or the tool
 *               everywhere.
 *    HOW MANY   `all` answers every open card at once, each settled `once` — the pile a
 *               phone cannot comfortably quote through, cleared in one line.
 *
 *  `always` is the widest SCOPE precisely so `all` can mean all of them: a bare `/y` reads
 *  as `/y once`, which makes `/y always` the natural opposite and leaves `all` free for
 *  what it plainly says. One syntax, every door: gateVerdict here, the REPL's own line. */
export { parseVerdict } from "./render.ts"; // the steering vocabulary lives with the
// predicate that hides it from the window — one parser, both doors

/**
 * A gate answered from wherever the principal is (§9). The approval card crosses to their
 * surfaces (mirror), and this is the way back: their own line, in their own DM, IS the
 * verdict — so a principal steering from a phone can approve without a terminal. Only their
 * words count (`ownComplex` and not `ownVoice`: our complex authored it, the model didn't),
 * and only after the ask — a `/y` typed before the card answers nothing.
 *
 * WHICH card it answers is the whole problem, and the answer is: whichever one they pointed
 * at. A bare `/y` settles the single open card and nothing else — with two waiting, a bare
 * word is genuinely ambiguous, and guessing would send the wrong message under their name.
 * `/y all` is that ambiguity answered rather than dodged: they mean all of them, every open
 * card settles at once, and the pile a phone is bad at quoting through clears in one line.
 * To answer one of several they QUOTE it, which is what a chat app is for. The mirror
 * translates the quote at fan-in — the alias conversation is invisible to this port
 * (policy §6), so the join happens where visibility lives: the copy's `ref_id` names the
 * card event itself, and `ref_external_id` survives as the mark that they quoted at all.
 *
 * No verdict ever falls silently: a bare word against several cards, or a quote pointing at a
 * card already answered, comes back as a harness `error` the mirror carries. Said ONCE — the
 * same latest line is re-read on every wake while the gate waits.
 */
function gateVerdict(
  events: Event[],
  session: Session,
  hereEnv: Envelope,
): (Draft<PermissionResponseEvent> | Draft<ErrorEvent>)[] {
  const live = openCards(events);
  if (live.length === 0) return [];
  const open = live.map((c) => c.payload.ref_id);
  // resolution reads EVERY card in the window, not just the open ones: a quote that lands on
  // a card already settled is a mistake worth naming (their phone shows the whole history,
  // and after a re-issue two identical-looking cards sit there, only one of them live).
  const cards = events.filter((e) => e.type === "permission_request");
  const last = live.at(-1);
  if (!last) return [];
  /** One card settled, exactly as they typed it. */
  const response = (card: Event): Draft<PermissionResponseEvent> => ({
    ts: new Date().toISOString(),
    type: "permission_response",
    payload: { ref_id: card.payload!.ref_id as EventId },
    envelope: hereEnv,
    parts: [{
      type: "data",
      kind: "permission_response",
      data: said!, // behavior + scope + reason, exactly as they typed it
    }],
  });
  let said: PermissionVerdict | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "message" || !ownComplex(e, session) || ownVoice(e, session)) continue;
    said = parseVerdict(textOf(e));
    if (!said) break; // their latest word is not a verdict — they said something else
    // Answered already? While a gate waits, EVERY event re-reads this same latest line —
    // and a line stays latest long after it did its work. Two ways it is spent: a verdict
    // came of it, or the harness already said why none could. Either way, say nothing twice.
    const spoken = events.slice(i + 1).some((x) =>
      x.type === "error" || x.type === "permission_response"
    );
    // `all` points at no single card BECAUSE it points at all of them: no quote to resolve,
    // no ambiguity to report, one response per open card in the order they were asked
    if (said.every) return spoken ? [] : live.map(response);
    // a quote that hits no card at all (they replied to something else) is no quote: fall
    // back to the bare rule rather than dropping their word on the floor
    const quoted = (e.payload?.ref_external_id
      ? cards.find((c) => c.id === e.payload?.ref_id)
      : undefined) ??
      (live.length === 1 ? last : AMBIGUOUS);
    if (quoted === AMBIGUOUS) return spoken ? [] : [ambiguity(live.length, hereEnv)];
    if (!quoted || events.indexOf(quoted) > i) break; // answered before it was ever asked
    // the card they pointed at has already been answered — say so, with what is still open
    if (!open.includes(quoted.payload?.ref_id as EventId)) {
      return spoken ? [] : [settled(live.length, hereEnv)];
    }
    return [response(quoted)];
  }
  return [];
}

/** Several cards up and a bare word: the HARNESS says so, rather than guessing or going
 *  quiet. It rides an `error` (the harness's own voice, §2) — which the mirror carries to
 *  the principal's surfaces and which, being the window's last event, keeps the agent from
 *  taking a turn it would only spend re-issuing the tools it is already waiting on. */
const AMBIGUOUS = Symbol("ambiguous");

function ambiguity(open: number, hereEnv: Envelope): Draft<ErrorEvent> {
  return harness(
    `${open} approvals are waiting — reply TO the one you mean (quote it), ` +
      `or \`/y all\` · \`/n all\` to answer all ${open} at once`,
    hereEnv,
  );
}

/** They answered a card that is no longer open — the usual cause is two copies of the same
 *  ask on the surface (a re-issue), where the newest is the DEAD one. Silence here reads as
 *  a broken gate, so the harness names it and points at what is actually waiting. */
function settled(open: number, hereEnv: Envelope): Draft<ErrorEvent> {
  return harness(
    `that approval was already answered — ${open} still waiting, quote one of those ` +
      `(they are the OLDER cards: the newer copies are the ones already settled)`,
    hereEnv,
  );
}

/** The harness's own voice (§2): an `error` the mirror carries to the principal's surfaces. */
function harness(error: string, hereEnv: Envelope): Draft<ErrorEvent> {
  return {
    ts: new Date().toISOString(),
    type: "error",
    envelope: hereEnv,
    parts: [{ type: "data", kind: "error", data: { error } }],
  };
}

/** Non-self messages our last home message's step did NOT consume — the answer owed.
 *  Measured against the closing's `meta.consumed` horizon (what its window actually held),
 *  not log position — a message landing between the window-read and the closing's publish
 *  sits BEFORE the closing in the log yet was never seen (the live-bench coalescing race).
 *  Position is the fallback for messages without a horizon (pre-horizon logs). Returns the
 *  news itself: attention classes it (§2) rather than waking on its mere existence. */
function newsOf(events: Event[], session: Session): (MessageEvent | AlarmEvent)[] {
  // news = a message our side didn't produce (§3 ownVoice) — which now includes the
  // principal's rows: they carry agent.id (and, typed into the session, session_id),
  // but input never carries a turn_id, so it stays answerable — OR an alarm, which is
  // the agent's own past self arriving with something to say (§10): harness-authored, so
  // never our voice, and unanswered until a turn reads past it like any other news
  const news = (e: Event): e is MessageEvent | AlarmEvent =>
    e.type === "alarm" || (e.type === "message" && !ownVoice(e, session) && !silenced(e));
  const last = lastClosing(events, session);
  if (last === -1) return events.filter(news);
  // resolve the horizon to a POSITION — the window may be re-sorted for display (§5)
  const horizon = events[last].extra?.consumed;
  const h = typeof horizon === "string" ? events.findIndex((e) => e.id === horizon) : -1;
  const from = h !== -1 ? h : last; // no/stale horizon → fall back to the closing's position
  return events.slice(from + 1).filter(news);
}

/** All our uses have results but no turn output followed ⇒ the closing think is owed.
 *  Turn output = our thinking / tool_use / home message; a directed peer send is not. */
function unclosedChain(events: Event[], session: Session): boolean {
  const uses = new Set(
    events
      .filter((e) => e.type === "tool_use" && ownComplex(e, session))
      .map((e) => e.id),
  );
  if (uses.size === 0) return false;
  let lastResult = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "tool_result" && uses.has(e.payload.ref_id)) lastResult = i;
  }
  if (lastResult < 0) return false;
  return !events.slice(lastResult + 1).some((e) =>
    ownVoice(e, session) &&
    (e.type === "thinking" || e.type === "tool_use" ||
      (e.type === "message" && e.envelope.conversation.address === session.conversation))
  );
}

/* ── the invocation ───────────────────────────────────────────────────── */

/** Turn input + the wake policy (`Wake`, §2 attention) + the permission table (§9) —
 *  main funnels every field from the catalog (org/agent config, config.ts). */
export interface AgentConfig extends TurnConfig, Wake {
  /** The tools offered to the model, by name (§9) — built-ins and exec alike; main
   *  funnels it from `agent.tools`. Unset ⇒ every tool the deployment has. The offer is
   *  config's to shape: a coding-agent deployment simply leaves `send` off the list. */
  tools?: string[];
  /** Permission policy as DATA (§9) — the table `gate` is compiled from; main funnels it
   *  from org/agent config. Unset ⇒ the catalog's `DEFAULT_RULES`. */
  rules?: Rule[];
  /** The compiled policy, for callers that would rather write the predicate than the table
   *  (tests, task mode). Overrides `rules`. */
  gate?: Gate;
  windowLimit?: number; // history query cap — a fallback; compaction is the mechanism (§5)
  /** The floor in EVENT TIME: nothing older than this is ever owed. A FIXED instant, decided
   *  once when the agent comes up (main: start − `backlogHours`), not a distance from now —
   *  a moving bound would keep re-deciding what "old" means under the agent's feet, and the
   *  thing being bounded is a one-time question: what backlog did it inherit? Coming up is
   *  when a pile of unanswered messages is history rather than a mandate; from then on the
   *  count cap is what bounds the prompt. Older rows stay readable through `search` (§6). */
  since?: string;
}

/** A tool outcome carrying ATTACHMENTS (§5 media): `files` are local paths the result
 *  hands the model — they ride the tool_result event as FileParts, and render shows the
 *  inlineable ones as real blocks (the `aread`-an-image loop). Plain Json = no files. */
export interface ExecOutcome {
  output: Json;
  files: string[];
}

/** An exec-plane tool: its API spec + its executor. Executors should throw on failure. */
export interface ExecTool {
  spec: Anthropic.Tool;
  execute: (input: Json, signal: AbortSignal) => Promise<Json | ExecOutcome>;
  /** How a call READS to a person — the approval card, the anchor's pending list, the
   *  mirror's tool line (§9). Optional: `describeCall`'s default already renders a
   *  one-argument tool as `bash(git status)`, which is what most tools want. */
  describe?: Describe;
}

function isOutcome(x: Json | ExecOutcome): x is ExecOutcome {
  return typeof x === "object" && x !== null && !Array.isArray(x) &&
    "output" in x && Array.isArray((x as { files?: unknown }).files);
}

export interface XiPorts {
  /** Publish · read · lock — plus the three connection slices the send path needs (§6):
   *  `agents` to recognize a peer's name, `upsertMemberships` to enroll a DM's ends,
   *  `aliases` to recognize the principal's own surfaces so a send at them is refused
   *  rather than gated — and the standing half of the permission table (§9): `remembered`
   *  compiles into the gate, `remember` is where a scoped verdict lands. NOT `Subscriber`:
   *  the tail belongs to main (§2). The lock is a store capability so a turn's writes and
   *  its release can share one transaction later. */
  log:
    & Appender
    & Reader
    & Locker
    & Pick<Registry, "agents">
    & Pick<Standing, "remember" | "remembered">
    & Pick<Connections, "upsertMemberships" | "aliases">
    & Pick<Timers, "arm" | "timers" | "disarm">;
  docs: Docs;
  /** The model edge. main picks it (Anthropic today) and it travels down the chain unchanged
   *  — the transport is where another provider adapts in, so nothing above it changes. */
  transport: ModelTransport;
  exec?: Record<string, ExecTool>; // bash + MCP; send/search are built-in
  onDelta?: Emit; // → the harness stream (fire-and-forget)
  /** The decision, disclosed the moment it is made — fire-and-forget like onDelta: main
   *  fans it to the door's tailers as a turn edge ({status}), the one fact an attach
   *  client cannot compute for itself. `cursor` is the last event the deciding read saw. */
  onDecision?: (verdict: Decision, cursor: string | undefined) => void;
  ambient?: () => Promise<string[]>; // env lines (cwd·git·jobs) for the anchor (§5); edge: absent
}

/** How coarse the window's floor is: the grid the oldest kept event snaps DOWN to. */
const WINDOW_ANCHOR_MS = 30 * 60_000;
/** How much history the read carries beyond the window, for the snap to keep. */
const WINDOW_SLACK = 200;

/**
 * Anchor the window's floor (§5). `read({limit})` is a sliding TAIL: every append drops one
 * event off the front, so the oldest rendered event — the first bytes of the prompt — is
 * different on every turn. A prompt cache matches a PREFIX, so that one shift voids the whole
 * rendered history and every breakpoint behind it: the transcript is re-WRITTEN each turn
 * (1.25x input) instead of read back (0.1x), and render's boundary mark never once hits.
 *
 * So the floor snaps DOWN to a coarse grid and stands still between jumps: for a whole
 * bucket of turns the prefix is byte-identical, and one re-anchor pays a single write. The
 * window is then `limit` plus whatever else shares the floor's bucket — which is what the
 * read's slack carries. Time, not position, because position is exactly what slides.
 */
export function anchored(rows: Event[], limit: number): Event[] {
  if (rows.length <= limit) return rows;
  const oldest = Date.parse(rows[rows.length - limit].ts); // the floor a plain tail would use
  if (!Number.isFinite(oldest)) return rows.slice(-limit);
  const grid = Math.floor(oldest / WINDOW_ANCHOR_MS) * WINDOW_ANCHOR_MS;
  // the floor is a POSITION: the first row stamped in the bucket, and everything appended
  // after it — a late-stamped row (an offline sync, a lagged webhook) is news by position,
  // whatever its clock says
  const floor = rows.findIndex((e) => Date.parse(e.ts) >= grid);
  return floor === -1 ? rows.slice(-limit) : rows.slice(floor);
}

/** One xi invocation: poke → owed → (think/act: acquire-or-exit → work) → return what it
 *  decided — `"held"` when the lease was taken (someone is on it: busy by definition),
 *  `"lost"` when this turn was declared dead mid-work and its writes refused,
 *  `undefined` when the trigger was irrelevant (no read happened; nothing to say). */
export async function xi(
  config: AgentConfig,
  ports: XiPorts,
  trigger?: Event,
): Promise<Decision | "held" | "lost" | undefined> {
  // 1. the gate — free: no read, no lease. Most invocations end here (§2)
  if (trigger && !relevant(config, trigger)) return;

  // 2. the lease. Taken BEFORE the read: one read per invocation, and the read is then
  //    already up to date w.r.t. whatever landed while we were acquiring. Keyed by the
  //    SESSION (§4): the lock serializes one session's turns; siblings run concurrently.
  const name = `turn-${sessionAddress(config.agentId, config.sessionId)}`;
  const lock = ports.log.lock(name);
  const got = await lock.acquire();
  if (got === "held") return "held"; // no retry: someone is on it, and their turn's end will poke

  const session: Session = {
    id: config.sessionId,
    agentId: config.agentId,
    conversation: sessionAddress(config.agentId, config.sessionId),
  };
  // policy is a TABLE (§9), compiled from two halves: the remembered rows (standing
  // verdicts — the principal's rulings outrank the base) over the configured base. No
  // tool is special.
  const gate = config.gate ??
    gateOf([
      ...ports.log.remembered(config.agentId).map(ruleOf),
      ...(config.rules ?? DEFAULT_RULES),
    ]);
  // 3. decide, under the lease and from a fresh window — so it can't act on a stale verdict
  //    (another holder may have finished this very work while we were being invoked).
  //    The port is scoped (§6): visibility applies inside the read, BEFORE the limit, so the
  //    window holds N visible events — xi never sees, nor re-checks, what policy hides.
  const limit = config.windowLimit ?? DEFAULT_WINDOW_LIMIT;
  const events = anchored(
    await ports.log.read({
      limit: limit + WINDOW_SLACK, // the slack the anchor keeps — see `anchored`
      ...(config.since ? { after: config.since } : {}), // the boot floor, fixed (§5)
      silenced: false, // imported history and muted/archived-chat traffic are not news: they
      //   wake nothing and render nowhere — `search` is the door (§5)
    }),
    limit,
  ); // the
  //    ONE read: the work's input as well as the decision's (§2)
  // 3a. a gate the principal answered on a SURFACE (§9): their `/y` · `/n [reason]` becomes
  //     the verdict before the verdict is read, so one invocation settles it AND acts on it
  const hereEnv: Envelope = {
    service: "local",
    connection_address: "agent",
    conversation: { address: session.conversation },
  };
  // a `/y all` answers several cards at once, so this is a list — published together, in the
  // order they were asked, before the verdict is read
  for (const answer of gateVerdict(events, session, hereEnv)) {
    const settled = await ports.log.publish(answer);
    if (settled) events.push(settled);
  }
  const v = decide(events, session, config);
  ports.onDecision?.(v, events.at(-1)?.id);
  if (v === "ignore") {
    await lock.release();
    return v;
  }

  // 4. the work, and 5. the end: ONE transaction holding its last events AND the release, so
  //    the wake they fire can never find the lease still held. Publishing first and releasing
  //    after is the stalled-cycle bug: that wake bounces, and nothing wakes again (§2).
  let last: Draft<Event>[];
  try {
    last = v === "act"
      ? await act(events, got === "stolen", session, config, gate, ports)
      : await think(events, config, ports);
  } catch (err) {
    await lock.release(); // nothing to pair the release with
    throw err;
  }
  try {
    await ports.log.publishAndRelease(last, lock.lease());
  } catch (err) {
    // declared dead mid-turn: a successor took the lease and is redoing this window from
    // the same events. Dropping the work is the point — landing it would publish the turn
    // twice. Loud, because a live turn losing its lease means the process stalled past the
    // TTL, and that is worth seeing.
    if (err instanceof LeaseLost) {
      console.error(`[xi] ${name}: ${err.message}, ${last.length} event(s) dropped`);
      return "lost";
    }
    throw err;
  } finally {
    // the lease row is already gone (the transaction dropped it), but the HEARTBEAT is this
    // object's, and only this object can stop it — the release doubles as that off-switch.
    await lock.release();
  }
  return v;
}

/* ── think: one locked turn ───────────────────────────────────────────── */

/** One loader for the process: a tool loop re-renders the same attachments step after
 *  step, and the bytes under a uri never change (content-named, §8). */
const loadMedia = memoizedLoader(loadMediaBlock);

async function think(
  events: Event[],
  config: AgentConfig,
  ports: XiPorts,
): Promise<Draft<Event>[]> {
  const home = sessionAddress(config.agentId, config.sessionId); // where this turn speaks (§4)
  const docs = await ports.docs.list({ agent: config.agentId, conversation: home });
  // the anchor (§5): the volatile environment, plus what is still in the air. A pending gate
  // is STATE, not history — the transcript already closed those calls with
  // `pending_approval`, so the only place they belong is the block that is rewritten every
  // turn. It also self-corrects: an ask that gets answered simply stops being listed.
  // `waitingOn` always has a line, so the anchor always carries the approval state.
  const ambient = [
    ...(ports.ambient ? await ports.ambient() : []),
    ...armedOn(config, ports),
    ...waitingOn(events, config),
  ];
  // ONE turn per invocation, and nu decides what the turn IS: an over-budget window makes it
  // the checkpoint (the summary's insert wakes the think it displaced); a paced/truncated
  // turn continues via `meta.stop` and `decide` (§2, §5). xi only gathers the I/O.
  return await nu(
    {
      events,
      docs,
      tools: specsOf(ports, config),
      config,
      ambient,
      // trailing-region media → real image/document blocks (§5); the store loads, render picks
      loadMedia,
      // the checkpoint instruction is a DOC (§5/§8) — editable like any instruction
      compactPrompt: () =>
        ports.docs.read({ agent: config.agentId, conversation: home }, {
          scope: "system",
          kind: "instruction",
          name: "instructions/compaction",
        }),
    },
    ports.transport,
    ports.onDelta,
  );
}

/** The anchor's pending-approval lines (§5, §9): one per ask nobody has answered, named the
 *  way the card named it and stamped with when it went out. The id is the handle `cancel`
 *  takes — `shortId`, the same vocabulary as `re`.
 *
 *  The empty case still speaks. Everywhere else the anchor states only what IS, and silence
 *  means nothing is there — but this is the one anchor fact the model SAYS to its principal
 *  in prose, who has no way to check it. A block that can only ever add a claim can never
 *  contradict one, so an invented "waiting for your ok" passes untouched. Present in one of
 *  two forms every turn, it is a ground truth the model reads instead of an absence it has
 *  to notice. */
/** The anchor's scheduled-wake lines (§5, §10): what is armed, when it fires, and the note
 *  it will arrive with — beside the background jobs and the open approvals, because they are
 *  the same kind of fact (something of yours is still standing). The id is `cancel`'s handle.
 *
 *  This session's wakes only (§4): the anchor is what THIS session is holding, and an id
 *  it can read is an id it can cancel.
 *
 *  Silence means nothing is armed: unlike an approval, a wake the model invents costs the
 *  principal nothing and reveals itself when it doesn't fire. */
function armedOn(config: AgentConfig, ports: XiPorts): string[] {
  const rows = ports.log.timers(config.agentId, config.sessionId);
  if (rows.length === 0) return [];
  return [
    `scheduled — ${rows.length} wake${rows.length === 1 ? "" : "s"}:`,
    ...rows.map((t) =>
      `· ${hhmm(t.fireAt, config.timezone)}${
        t.cron ? ` (repeats \`${t.cron}\`)` : ""
      } — ${t.note}` +
      ` · id ${shortId(t.id)}`
    ),
  ];
}

function waitingOn(events: Event[], config: AgentConfig): string[] {
  const cards = openCards(events);
  if (cards.length === 0) return ["nothing is waiting on your principal — no approval is open"];
  return [
    `waiting on your principal — ${cards.length} approval${cards.length === 1 ? "" : "s"}:`,
    ...cards.map((c) => {
      const ask = c.parts[0].data;
      return `· ${ask.call ?? ask.tool} — asked ${hhmm(c.ts, config.timezone)} · id ${
        shortId(c.payload.ref_id)
      }`;
    }),
  ];
}

/* ── act: settle the pending batch (no model) ─────────────────────────── */

async function act(
  events: Event[],
  stolen: boolean,
  session: Session,
  config: AgentConfig,
  gate: Gate,
  ports: XiPorts,
): Promise<Draft<Event>[]> {
  const self = { id: config.agentId, session_id: config.sessionId };
  // one session, one place (§4): the harness's own rows land where the session speaks
  const here = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: session.conversation },
  };
  const ts = () => new Date().toISOString();

  const resultOf = (
    use: ToolUseEvent,
    outcome: Json | ExecOutcome,
    flags?: Partial<{ is_error: boolean; cancelled: boolean }>,
    /** The call, rendered — set only on a DEFERRED outcome, which has to name what it is
     *  reporting on: its `tool_use` has already collapsed out of the transcript (§5). */
    call?: string,
  ): Draft<ToolResultEvent> => {
    const { output, files } = isOutcome(outcome) ? outcome : { output: outcome, files: [] };
    return {
      ts: ts(),
      type: "tool_result",
      payload: {
        turn_id: use.payload.turn_id,
        ref_id: use.id,
        ...(call !== undefined ? { deferred: true as const } : {}),
      },
      agent: self,
      envelope: here,
      parts: [
        {
          type: "data",
          kind: "tool_result",
          data: { output, ...flags },
          ...(call !== undefined ? { text: call } : {}),
        },
        // the tool's attachments (§5 media) — a path that vanished mid-turn just drops
        ...files.flatMap((f) => {
          try {
            return [filePartOf(f)];
          } catch {
            return [];
          }
        }),
      ],
    };
  };

  const refused = (v: PermissionVerdict) =>
    `refused by your principal${v.reason ? `: ${v.reason}` : ""}`;

  // every write this act produces is collected and committed ONCE, with the lease release
  // (§2) — the barrier completes atomically, and no half-batch can wake anyone
  const out: Draft<Event>[] = [];
  const runnable: { use: ToolUseEvent; call?: string }[] = [];
  const pending = pendingOf(events, session);
  const owed = owedOf(events, session);
  // one rendering for every call this act touches — the card, the anchor and the deferred
  // report all read it, and resolving addresses to names takes the log (§9)
  const describers = describersOf(ports);
  const resolve = await nameResolver(
    ports.log.read,
    [...pending, ...owed.map((o) => o.use)].map((u) => u.parts[0].data),
  );
  const describe = (use: ToolUseEvent, full = false) =>
    describeCall(use.parts[0].data, { resolve, full, tools: describers });

  // a scoped verdict is STANDING (§9): it writes the remembered half of the table, pinned
  // to where THIS call landed — `conv` the conversation, `conn` the whole connection,
  // `all` the tool everywhere. Upserted, so the same window re-read writes the same row.
  // A conv/conn word on a call that lands nowhere cannot pin: the harness says so rather
  // than silently widening the rule.
  const standing = async (use: ToolUseEvent, v: PermissionVerdict): Promise<void> => {
    if (v.scope === "once") return;
    const tool = use.parts[0].data.name;
    if (v.scope === "always") {
      ports.log.remember({ agentId: session.agentId, tool, action: v.behavior });
      return;
    }
    const target = await targetOf(use, self, ports);
    const pin = v.scope === "connection" ? target?.connection : target?.conversation;
    if (!pin) {
      out.push(harness(
        `cannot pin a ${v.scope} rule for ${tool} — the call lands nowhere; ` +
          "`all` makes it tool-wide",
        here,
      ));
      return;
    }
    ports.log.remember({
      agentId: session.agentId,
      tool,
      action: v.behavior,
      ...(target?.connection ? { connection: target.connection } : {}),
      ...(v.scope === "conversation" ? { conversation: target!.conversation } : {}),
    });
  };

  // (a) the fresh batch: EVERY use is answered in the turn that made it — including a gated
  //     one, whose answer is `pending_approval`. Asking is part of executing, so the chain
  //     closes and the mind stays free while the principal decides (§9).
  for (const use of pending) {
    const { name, input } = use.parts[0].data;
    // a send AT THE PRINCIPAL is refused before it is gated: the assistant channel already
    // reaches them, so this call has no destination to approve — asking would put a card
    // in front of them whose only outcomes are a message they were already getting and a
    // refusal. Cheap to raise, and the model reads the hint and says the thing instead.
    const nowhere = selfSend(name, input, config, ports);
    if (nowhere) {
      out.push(resultOf(use, nowhere, { is_error: true }));
      continue;
    }
    const verdict = verdictOf(events, use.id);
    if (verdict) await standing(use, verdict);
    // the ruling (§9): where a send lands is part of the call, so the table can scope by
    // it. A verdict already given supersedes the table — the principal outranks policy.
    const ruling = verdict ? undefined : gate(name, input, await targetOf(use, self, ports));
    if (ruling === "deny") {
      out.push(resultOf(use, "refused by policy — a standing rule denies this call", {
        is_error: true,
      }));
      continue;
    }
    if (ruling === "ask") {
      // the card goes to the principal-DM and crosses to their surfaces (mirror, §4);
      // a card already up is not asked twice — this use is simply being answered late
      if (!events.some((e) => e.type === "permission_request" && e.payload?.ref_id === use.id)) {
        out.push(
          {
            ts: ts(),
            type: "permission_request",
            payload: { ref_id: use.id },
            agent: self,
            envelope: here,
            parts: [{
              type: "data",
              kind: "permission_request",
              data: { tool: name, call: describe(use), detail: describe(use, true) },
            }],
          } satisfies Draft<PermissionRequestEvent>,
        );
      }
      out.push(resultOf(use, PENDING_APPROVAL));
      continue;
    }
    if (verdict?.behavior === "deny") {
      out.push(resultOf(use, refused(verdict), { is_error: true }));
      continue;
    }
    if (stolen) {
      // the previous holder crashed mid-act: execution state unknown — cancel, don't
      // re-run (a send may already have reached the peer); the model re-decides
      out.push(resultOf(use, "orphaned by a crashed turn", { is_error: true, cancelled: true }));
      continue;
    }
    runnable.push({ use });
  }

  // (b) the errand: asks the principal has ruled on since. The tool_use is spent, so the
  //     outcome cannot be a `tool_result` block — it comes back as the harness's own line
  //     (§5), which is also what reaches the principal's surfaces.
  for (const { use, verdict } of owed) {
    await standing(use, verdict);
    const call = describe(use);
    if (verdict.behavior === "deny") {
      out.push(resultOf(use, refused(verdict), { is_error: true }, call));
    } else if (stolen) {
      out.push(
        resultOf(use, "orphaned by a crashed turn", { is_error: true, cancelled: true }, call),
      );
    } else {
      runnable.push({ use, call });
    }
  }

  // the batch runs in parallel — the lock serializes the mind, not the tools (§2). Nothing
  // fires this controller yet: cancelling a running turn is a `control` event xi will check
  // for at tool boundaries (§10) — log-derived, because an out-of-process invocation can't
  // be signalled. The `cancelled` flag it sets is already the steal-sweep's flag.
  const ctl = new AbortController();
  out.push(
    ...await Promise.all(runnable.map(async ({ use, call }) => {
      try {
        return resultOf(
          use,
          await execute(use, events, ctl.signal, self, config, ports),
          undefined,
          call,
        );
      } catch (err) {
        return resultOf(use, err instanceof Error ? err.message : String(err), {
          is_error: true,
          ...(ctl.signal.aborted ? { cancelled: true } : {}),
        }, call);
      }
    })),
  );
  return out;
}

/** What a gated call returns THE MOMENT it is made (§9). The model is told plainly that the
 *  call is alive and not its move any more — the anchor keeps the list, and the outcome
 *  arrives later in the harness's voice. Re-issuing is the one failure mode worth naming:
 *  it is what a model does with a tool_use it never got an answer to. Nothing here may
 *  share a word with what a RUN call returns (`sent`): the model reports the two apart on
 *  the strength of the vocabulary alone, and it reports them to the principal. */
const PENDING_APPROVAL = {
  status: "pending_approval",
  note: "your principal was asked and has not answered yet — the call has NOT run. " +
    "Do NOT issue it again; you will be told the outcome when they decide. If it stops " +
    "being worth asking, withdraw it with cancel(id) — your pending list names the id.",
};

/** A send target that names a SESSION (§4): a peer agent's bare name (an agent IS its
 *  mind), or a full session address wearing a roster agent's name. Anything else — a
 *  wire address, a local room — is not a session target. */
function sessionTarget(
  to: string,
  agents: { agentId: string }[],
): { agentId: string; sessionId: string } | null {
  if (agents.some((a) => a.agentId === to)) return { agentId: to, sessionId: MIND };
  const s = parseSession(to);
  return s !== null && agents.some((a) => a.agentId === s.agentId) ? s : null;
}

/** Contact between sessions is a DM room (§4): `dm:` + the sorted pair of session
 *  addresses — one rule for sessions of one agent and sessions of two. */
function sessionDm(self: { id: string; session_id: string }, target: {
  agentId: string;
  sessionId: string;
}): string {
  return dmAddress(
    sessionAddress(self.id, self.session_id),
    sessionAddress(target.agentId, target.sessionId),
  );
}

/** Where a send LANDS (§9): the destination's own envelope — the same anchoring read and
 *  peer-name canonicalization `execute` does, so a scoped rule matches the conversation
 *  the log will record. Tools that dispatch nowhere have no target. */
async function targetOf(
  use: ToolUseEvent,
  self: { id: string; session_id: string },
  ports: XiPorts,
): Promise<Target | undefined> {
  const { name, input } = use.parts[0].data;
  if (name !== "send") return undefined;
  const raw = (input as { to?: unknown } | null)?.to;
  if (typeof raw !== "string" || raw === "") return undefined;
  let to = raw;
  const target = sessionTarget(to, ports.log.agents());
  if (target && !(target.agentId === self.id && target.sessionId === self.session_id)) {
    to = sessionDm(self, target);
  }
  const prior = (await ports.log.read({ conversation: to, limit: 1 }))[0];
  return prior
    ? { connection: prior.envelope.connection_address, conversation: to }
    : { conversation: to };
}

/**
 * Is this a `send` aimed at the agent's own principal? Then it lands NOWHERE and the tool
 * says so instead of dispatching (§9). Their name, the mind, and the wire surfaces the
 * mirror keeps their face on are all the same destination — the assistant channel — which
 * the model is already writing when the turn closes. Sending there either invents a local
 * conversation nobody reads (a bare handle is first contact, §5) or dies on the alias's
 * visibility rule; both read to the principal as the agent talking about them in the third
 * person, which is what the live log showed. The error carries the hint because the fix is
 * a channel choice, not a retry.
 */
function selfSend(
  name: string,
  input: Json,
  config: AgentConfig,
  ports: XiPorts,
): string | undefined {
  if (name !== "send") return undefined;
  const to = (input as { to?: unknown } | null)?.to;
  if (typeof to !== "string" || to === "") return undefined;
  const me = ports.log.agents().find((a) => a.agentId === config.agentId);
  // the session's OWN ROOM, and the principal's handles. The bare agent name is refused
  // only from the mind — an agent IS its mind (§4), so from a sibling it is a real
  // target, the dm: with the mind, not a self-send.
  const mine = new Set(
    [
      sessionAddress(config.agentId, config.sessionId),
      ...(config.sessionId === MIND ? [config.agentId] : []),
      me?.email,
      me?.phone,
    ].filter((x): x is string => typeof x === "string" && x !== ""),
  );
  const alias = ports.log.aliases().some((r) =>
    r.agentId === config.agentId && r.conversation === to
  );
  if (!mine.has(to) && !alias) return undefined;
  return "that address is your principal — `send` is for everyone ELSE. What you say to " +
    "them is the assistant channel: write it as your reply and it reaches them when the " +
    "turn closes.";
}

/** The schedule horizon (§10): a wake fires within a year. Leap-tolerant by a day, so "this
 *  date next year" always fits. */
const YEAR_MS = 366 * 864e5;

/** `20m` · `3h` · `2d` · `90s` · `1w` → milliseconds. The units a person says out loud. */
function durationMs(spec: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)\s*$/i.exec(spec);
  if (!m) throw new Error(`"${spec}" is not a delay — say it like \`20m\`, \`3h\`, \`2d\``);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()]!;
  const ms = Number(m[1]) * unit;
  if (ms <= 0) throw new Error("a delay has to be in the future");
  return ms;
}

/**
 * An `at` moment → UTC ISO. A stamp carrying its own offset (or `Z`) is absolute and passes
 * through; a bare one (`2026-09-01T17:00`) means the ORG's wall clock — which is the clock
 * the model is reading, since every stamp it was shown was rendered in that zone. `zonedTime`
 * does the zone math (§10), DST included.
 */
function momentOf(spec: string, tz: string): string {
  const raw = spec.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw);
    if (Number.isNaN(t)) throw new Error(`"${spec}" is not a moment I can read`);
    return new Date(t).toISOString();
  }
  // anchored: a stamp with trailing garbage is refused, not silently truncated to its date;
  // seconds are tolerated and dropped — the clock that fires it reads minutes (§10)
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(raw);
  if (!m) throw new Error(`"${spec}" is not a moment — try \`2026-09-01T17:00\``);
  const [year, month, day, hour, minute] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  try {
    // a reading that names no real date (31 February, hour 25) is refused there, not slid
    return new Date(zonedTime({ year, month, day, hour, minute }, tz)).toISOString();
  } catch {
    throw new Error(`"${spec}" is not a moment — try \`2026-09-01T17:00\``);
  }
}

/** Tool-supplied renderings, by name (§9) — the built-ins' live in `describe.ts`. */
function describersOf(ports: XiPorts): Record<string, Describe> {
  const out: Record<string, Describe> = {};
  for (const [name, tool] of Object.entries(ports.exec ?? {})) {
    if (tool.describe) out[name] = tool.describe;
  }
  return out;
}

async function execute(
  use: ToolUseEvent,
  events: Event[],
  signal: AbortSignal,
  self: { id: string; session_id: string },
  config: AgentConfig,
  ports: XiPorts,
): Promise<Json | ExecOutcome> {
  const { name, input } = use.parts[0].data;
  const args = input as Record<string, Json>;
  if (name === "schedule") {
    // a future wake is the one thing the log cannot hold (§10): it records what happened,
    // and this hasn't. So it is a row — and the row is not the wake: when it comes due the
    // clock publishes an alarm carrying the note, and THAT is the wake, log-shaped like
    // everything else. What is stored is words, never a call: the agent re-decides at fire
    // time with today's window in front of it, which is also what keeps the gate meaningful.
    const note = String(args.note ?? "").trim();
    if (!note) throw new Error("a wake needs a note — it is what you will read when it fires");
    const when = ["at", "in", "cron"].filter((k) => args[k] !== undefined && args[k] !== "");
    if (when.length !== 1) {
      throw new Error(
        when.length === 0
          ? "say when: `at` a moment, `in` a delay, or `cron` to repeat"
          : `pick one: ${when.join(", ")} — a wake fires one way`,
      );
    }
    const cron = args.cron === undefined ? undefined : String(args.cron);
    const zone = config.timezone ?? DEFAULT_TIMEZONE;
    const fireAt = cron !== undefined
      ? nextFire(cron, new Date().toISOString(), zone) // validates as it computes
      : args.in !== undefined
      ? new Date(Date.now() + durationMs(String(args.in))).toISOString()
      : momentOf(String(args.at), zone);
    // the horizon (§10): a wake fires in the future, and within a year — past that, the
    // fact belongs in a file, not a timer
    if (Date.parse(fireAt) <= Date.now()) {
      throw new Error(`${fireAt} already passed — a wake fires in the future`);
    }
    if (Date.parse(fireAt) > Date.now() + YEAR_MS) {
      throw new Error(`${fireAt} is more than a year out — write it down instead`);
    }
    // a wake belongs to the SESSION that armed it (§4): that session lists it, cancels it,
    // and is the one woken — so the row carries the session and the conversation it speaks
    // in, and firing needs no guess about where the note goes.
    const armed = ports.log.arm({
      agentId: self.id,
      sessionId: self.session_id,
      fireAt,
      ...(cron !== undefined ? { cron } : {}),
      note,
      conversation: sessionAddress(self.id, self.session_id),
      refId: use.id,
    });
    return { armed: shortId(armed.id), fires: hhmm(fireAt, config.timezone), at: fireAt };
  }
  if (name === "cancel") {
    // withdraw an open ask (§9): the one settlement invariant does all the work — a
    // permission_response ref'ing the use closes the card, so the anchor line drops and a
    // late verdict from the principal gets gateVerdict's already-answered reply. The
    // window is the act's own read: the lock serializes the mind, so nothing settles
    // between that read and this publish.
    const id = String(args.id ?? "");
    const byId = (ref: EventId) => ref === id || shortId(ref) === id;
    const card = openCards(events).find((c) => byId(c.payload.ref_id));
    if (!card) {
      // the same verb unsets a scheduled wake (§10): one "withdraw by id" the model can
      // reach for without knowing which list the id came from
      const timer = ports.log.timers(self.id, self.session_id).find((t) => byId(t.id));
      if (timer) {
        ports.log.disarm(timer.id, self.id, self.session_id);
        return { disarmed: shortId(timer.id), note: timer.note };
      }
      const ever = events.some((e) => e.type === "permission_request" && byId(e.payload.ref_id));
      throw new Error(
        ever
          ? `"${id}" was already answered — the outcome is on its way`
          : `nothing of yours is called "${id}" — your pending and scheduled lists name them`,
      );
    }
    const call = card.parts[0].data.call;
    await ports.log.publish(
      {
        ts: new Date().toISOString(),
        type: "permission_response",
        // turn_id marks this settlement the model's own doing (§3 authorship): the mirror
        // carries it as a withdrawal, and act never mistakes it for a ruling to run
        payload: { turn_id: use.payload.turn_id, ref_id: card.payload.ref_id },
        agent: self,
        // the card's coordinates, rebuilt — its stored envelope carries an external_id,
        // and reusing that would upsert-merge this settlement INTO the card's row
        envelope: {
          service: card.envelope.service,
          connection_address: card.envelope.connection_address,
          conversation: { address: card.envelope.conversation.address },
        },
        parts: [{
          type: "data",
          kind: "permission_response",
          data: { behavior: "deny", scope: "once", reason: "withdrawn by the agent" },
          text: call, // the card's own rendering — what the withdrawal notice names
        }],
      } satisfies Draft<PermissionResponseEvent>,
    );
    return { withdrawn: true, call };
  }
  if (name === "send") {
    // the only dispatch path (§9): directed message + sent result (two appends on
    // files — atomic pair on DB later; the steal-sweep covers the crash window)
    let to = String(args.to);
    // team chat (§6): a session target — a peer agent's name, a session address —
    // canonicalizes to the pair's DM conversation, and both ends are enrolled as the
    // SESSIONS they are: membership is what makes it visible to exactly them
    // (upsert-only and live, so the scoped publish below already passes WITH CHECK)
    const peer = sessionTarget(to, ports.log.agents());
    if (peer && !(peer.agentId === self.id && peer.sessionId === self.session_id)) {
      to = sessionDm(self, peer);
      ports.log.upsertMemberships([
        {
          service: "local",
          connection: "agent",
          conversation: to,
          agentId: self.id,
          sessionId: self.session_id,
        },
        {
          service: "local",
          connection: "agent",
          conversation: to,
          agentId: peer.agentId,
          sessionId: peer.sessionId,
        },
      ]);
    }
    // The tool gave us an address; the envelope is ours to write (§2). The conversation's
    // events ARE its record: complete service · connection · kind from the latest visible
    // one, so a reply carries the envelope its conversation always had — and the SCOPED
    // read bounds anchoring by visibility. No events ⇒ the local channel (a never-seen
    // address is first contact — the §5 address-book open).
    const prior = (await ports.log.read({ conversation: to, limit: 1 }))[0];
    const envelope = prior
      ? {
        service: prior.envelope.service,
        connection_address: prior.envelope.connection_address,
        conversation: {
          address: to,
          ...(prior.envelope.conversation.kind !== undefined
            ? { kind: prior.envelope.conversation.kind }
            : {}),
        },
      }
      : {
        service: "local" as const,
        connection_address: "agent",
        conversation: { address: to },
      };
    // attachments (§5 media): paths → FileParts, statted and classified broker-side; a
    // missing path throws here and the tool_result carries the error back to the model
    const files = Array.isArray(args.files) ? args.files.map((f) => filePartOf(String(f))) : [];
    const body = args.text === undefined ? "" : String(args.text);
    const glyph = args.react === undefined ? "" : String(args.react);
    // the reference (§5): the model points with the `id` its window showed. Resolving it
    // to the referent — and the referent to the name the WIRE knows it by — is the whole
    // job; a miss throws, and the tool_result sends the model back to its window rather
    // than letting it answer the wrong message.
    const target = args.re === undefined ? undefined : await referent(ports, to, String(args.re));
    // what the send DOES to its referent (§3, §5): the vocabulary the window renders, in
    // reverse — the model writes back the action it reads. Absent, the send is a create,
    // or a reply/an added reaction if it points somewhere.
    const action = args.action === undefined ? undefined : String(args.action);
    if (action !== undefined && !MUTATIONS.includes(action)) {
      throw new Error(`unknown action "${action}" — one of ${MUTATIONS.join(", ")}`);
    }
    if (action && !target) throw new Error(`\`${action}\` needs \`re\`: the message it acts on`);
    if (glyph && !target) throw new Error("a reaction needs `re`: the message it lands on");
    // the account may unsay its OWN words — either hand of `self`, since the wire holds one
    // account (§3) — and nobody else's: the platform would refuse, silently on some wires
    if ((action === "edit" || action === "delete") && target!.agent === undefined) {
      throw new Error(
        `only this account's own messages can be ${action === "edit" ? "edited" : "deleted"}` +
          " — that one is not",
      );
    }
    if (action === "edit" && !body) throw new Error("`edit` needs the replacement text");
    if (action === "remove" && !glyph) throw new Error("`remove` needs the reaction it lifts");
    if (!action && !glyph && !body && files.length === 0) throw new Error("nothing to send");
    const msg: Draft<MessageEvent> = {
      ts: new Date().toISOString(),
      type: "message",
      // the send tool_use that dispatched it — whose turn_id rides along: the send IS
      // turn output, and turn_id presence is what marks it the model's voice (§3)
      payload: {
        turn_id: use.payload.turn_id,
        ref_id: use.id,
        ...(target ? { ref_external_id: target.envelope.external_id } : {}),
        ...(action
          ? { action: action as Action }
          // a glyph is a part added to someone else's message; text beside a reference is
          // relational, not mutational
          : glyph
          ? { action: "add" as const }
          : target
          ? { action: "reply" as const }
          : {}),
      },
      agent: self,
      envelope,
      // a delete carries no body: what it removed is the referent's, and the window
      // already holds it (§5)
      parts: glyph
        ? [{ type: "data", kind: "reaction", data: { name: glyph, unicode: glyph } } as const]
        : action === "delete"
        ? []
        : [...(body ? [{ type: "text", kind: "text", text: body } as const] : []), ...files],
    };
    const sent = await ports.log.publish(msg);
    return { sent: true, event_id: sent!.id }; // a full draft (parts present) always stores
  }
  if (name === "search") return await search(ports.log, args as SearchArgs);
  const tool = ports.exec?.[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await tool.execute(input, signal);
}

/** The actions a send may take ON its referent (§3 `Action`, §5 the rendered vocabulary).
 *  `reply`/`add` are not here: they are what a reference and a glyph already mean, so the
 *  model never has to name them. */
const MUTATIONS = ["edit", "delete", "remove"];

/** How far back a reference may point: a superset of any render window, so every `id` the
 *  model can still read resolves, and the scan stays one conversation's recent rows. */
const REF_REACH = 500;

/**
 * `re` → the event it names (§5). The handle is render's `shortId`, so this walks the
 * conversation's recent rows for the one whose id ends that way — scoped to the target
 * conversation, which is what makes six hex enough. Every failure is loud and lands in the
 * tool_result: an unknown handle, an ambiguous one (the model re-reads rather than us
 * guessing), and a referent that has no wire name yet — our own send still in flight,
 * which no platform can be asked to quote.
 */
async function referent(ports: XiPorts, conversation: string, re: string): Promise<Event> {
  const matches = await ports.log.read({
    conversation,
    limit: REF_REACH,
    filter: (e) => shortId(e.id) === re,
  });
  if (matches.length === 0) throw new Error(`no message "${re}" in ${conversation}`);
  if (matches.length > 1) throw new Error(`"${re}" names ${matches.length} messages — ambiguous`);
  const target = matches[0];
  if (!target.envelope.external_id) {
    throw new Error(`message "${re}" has not reached the wire yet — nothing to point at`);
  }
  return target;
}

/**
 * `search` (§6) — the tool's implementation, reached only through act: a script's door
 * search is a tool_use like any other (§9), so this runs for both under the same gate.
 * Visibility is the log handle's — the caller's scoped port answers, RLS-style.
 */
async function search(log: Pick<Reader, "read">, args: SearchArgs): Promise<SearchResult> {
  // the filters narrow by ADDRESS; a name is only ever a way to find one (§6)
  const [conversations, senders] = await Promise.all([
    rooms(log, args.in === undefined ? undefined : String(args.in)),
    people(log, args.from === undefined ? undefined : String(args.from)),
  ]);
  const rows = await log.read({
    ...(conversations ? { conversations } : {}),
    ...(senders ? { senders } : {}),
    before: args.before,
    after: args.after,
    text: args.text,
    types: ["message"],
    limit: 50,
  });
  return rows.map((e) => ({
    id: e.id,
    ts: e.ts,
    conversation: e.envelope.conversation.name ?? e.envelope.conversation.address,
    address: e.envelope.conversation.address, // what `in`/`send(to:)` take back
    sender: e.envelope.sender?.name ?? e.envelope.sender?.address ?? "self",
    // `?? []` because a row's payload may legitimately carry no parts — a merge-only
    // draft that found no target inserts one (§3). Render already defends here; search
    // threw, which took the whole query down over a single malformed row.
    text: ((e as MessageEvent).parts ?? []).filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text).join(" "),
  }));
}

/** How deep a name lookup reads before giving up — the most recent rows that carry it. */
const NAME_REACH = 200;

/**
 * `in` / `from` → the addresses they mean (§6). The model points with the handle it was
 * SHOWN, and what it is shown is a name; the log keys on addresses. So a filter takes
 * either: an address matches itself, and anything else is looked up against the names
 * rows carry — case-insensitively, on a substring, because "Gianvito" should find
 * "Gianvito Rossi".
 *
 * Where `send` REFUSES an ambiguous handle, a search WIDENS on one: two people named Ana
 * cost a reader nothing but a longer result, and picking one for them would silently hide
 * the other. A name nobody wears is still an error — an empty result would read as "they
 * never said that" instead of "I don't know who that is".
 */
async function rooms(log: Pick<Reader, "read">, handle?: string): Promise<string[] | undefined> {
  if (handle === undefined) return undefined;
  if ((await log.read({ conversation: handle, limit: 1 })).length > 0) return [handle];
  const named = await log.read({ conversationName: handle, limit: NAME_REACH });
  // a DM has no subject of its own: it is named by the person on the other end (§3), so a
  // sender's name names their direct chat — never a group's, which wears its own
  const direct = await log.read({
    senderName: handle,
    limit: NAME_REACH,
    filter: (e) => e.envelope.conversation.kind === "direct",
  });
  const found = [...new Set([...named, ...direct].map((e) => e.envelope.conversation.address))];
  if (found.length === 0) throw new Error(`no conversation named "${handle}"`);
  return found;
}

async function people(log: Pick<Reader, "read">, handle?: string): Promise<string[] | undefined> {
  if (handle === undefined) return undefined;
  if ((await log.read({ from: handle, limit: 1 })).length > 0) return [handle];
  const named = await log.read({ senderName: handle, limit: NAME_REACH });
  const found = [...new Set(named.map((e) => e.envelope.sender?.address).filter((a) => !!a))];
  if (found.length === 0) throw new Error(`nobody named "${handle}" has spoken here`);
  return found as string[];
}

export function specsOf(ports: XiPorts, config: AgentConfig): Anthropic.Tool[] {
  const all: Anthropic.Tool[] = [
    {
      name: "send",
      description:
        "Dispatch a message to a peer conversation (never to your principal — just answer them directly).",
      input_schema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "target conversation address (as shown in its conv element), or a peer agent's " +
              "name to DM them. Never your principal, their handles, or your own name: they " +
              "read your reply itself, so a send at them is refused",
          },
          text: { type: "string", description: "the message body — omit only when reacting" },
          re: {
            type: "string",
            description:
              "the message this call acts on, exactly as its line shows the id. REQUIRED with " +
              "`react` and with every `action` — those have no object without it. With plain " +
              "`text` it does something else: it QUOTES that message on the wire, a visible " +
              "block above your words, so leave it out. Being a reply is already obvious from " +
              "the fact that you replied, and quoting an ordinary answer is the loudest tell " +
              "that a machine typed it. Set it there only when you can name the confusion it " +
              "prevents: several threads live at once in one group, or an answer to something " +
              "said well above the last line",
          },
          react: {
            type: "string",
            description:
              "an emoji to land on the `re` message instead of sending a message of your own",
          },
          action: {
            type: "string",
            enum: ["edit", "delete", "remove"],
            description:
              "what to do to the `re` message instead of adding to it: replace its text with `text` (edit, this account's own messages only — WhatsApp accepts one for about 20 minutes), take it back (delete, own only), or lift the `react` glyph you put on it (remove)",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "file paths to attach (workspace or media-store paths)",
          },
        },
        required: ["to"],
      },
    },
    {
      name: "search",
      description:
        "Search the message log — including everything older than your window. Results carry " +
        "the conversation's `address`, which `in` and `send(to:)` both take back.",
      input_schema: {
        type: "object",
        properties: {
          in: {
            type: "string",
            description:
              "one conversation: its address, or a name — a group's, or the person a direct " +
              "chat is with (any part of it, case doesn't matter)",
          },
          from: {
            type: "string",
            description: "one sender: their address, or any part of the name they go by",
          },
          before: { type: "string" },
          after: { type: "string" },
          text: { type: "string", description: "words said in the message itself" },
        },
      },
    },
    {
      name: "schedule",
      description:
        "Wake yourself later with a note. At the time you set, the note arrives as an alarm " +
        "in this conversation and you decide then what to do about it — nothing is executed " +
        "for you. Write the note to your future self, who will read it cold: say the thing " +
        "to do, not `as discussed`. Use `cancel` with the id to unset it. The horizon is a " +
        "year — anything further out belongs in your files, not a timer.",
      input_schema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "what you want to be told when it fires — your own words, self-contained",
          },
          at: {
            type: "string",
            description:
              "a moment: ISO-8601, e.g. `2026-09-01T17:00` (your org's clock unless it carries " +
              "an offset)",
          },
          in: {
            type: "string",
            description: "a delay from now: `20m`, `3h`, `2d` (also `90s`, `1w`)",
          },
          cron: {
            type: "string",
            description:
              "instead, repeat forever: five fields on your org's clock — `0 9 * * *` is every " +
              "day at 09:00, `*/15 9-18 * * 1-5` every quarter hour through the workweek",
          },
        },
        required: ["note"],
      },
    },
    {
      name: "cancel",
      description: "Unset something of yours that is still standing: a pending approval — a call " +
        "awaiting a verdict that stopped being worth asking (your principal is told; the " +
        "call never runs) — or a scheduled wake you no longer want.",
      input_schema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "the id, exactly as your pending or scheduled list shows it",
          },
        },
        required: ["id"],
      },
    },
    ...Object.values(ports.exec ?? {}).map((t) => t.spec),
  ];
  // the offer is config's to shape (§9): `agent.tools` names what the model sees
  return config.tools ? all.filter((t) => config.tools!.includes(t.name)) : all;
}
