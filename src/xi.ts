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
  Draft,
  Emit,
  Event,
  Json,
  MessageEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  Session,
  ToolResultEvent,
  ToolUseEvent,
} from "./types.ts";
import type { Appender, Reader } from "./store/log.ts";
import type { Registry } from "./store/agents.ts";
import type { Connections } from "./store/connections.ts";
import type { Docs } from "./store/docs.ts";
import type { Locker } from "./store/lock.ts";
import { filePartOf, loadMediaBlock } from "./store/media.ts";
import { backfilled } from "./render.ts"; // one predicate: what never wakes never renders
import { type ModelTransport, nu, type TurnConfig } from "./nu.ts";

/* ── the poke, the class filter, and the owed-derivation ──────────────── */

/** The decision: what the log owes right now (§2). `ignore` ⇒ nothing owed — quiescence,
 *  the next move is a human's, or we just failed. */
export type Decision = "think" | "act" | "ignore";

export type Gate = (name: string, input: Json) => boolean;

/** Decide — once, from one window — what is owed. Position-aware, so a late invocation that
 *  arrives after the work was already done decides `ignore` (quiescence). */
export function decide(events: Event[], session: Session, home: string, gate: Gate): Decision {
  const pending = pendingOf(events, session, gate);
  if (pending.length > 0) return pending.every(waiting) ? "ignore" : "act";
  if (cutOff(events)) return "think"; // a paced/truncated turn CONTINUES
  if (justFailed(events)) return "ignore"; // idle-after-error
  if (unclosedChain(events, session, home) || unanswered(events, session, home)) return "think";
  return "ignore";
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
      return !backfilled(event); //   catches whatever landed mid-turn (§2)
    case "tool_use":
    case "tool_result":
      return event.agent?.session_id === config.sessionId; // never react to others' tools
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

interface Pending {
  use: ToolUseEvent;
  gated: boolean;
  requested: boolean;
  response?: PermissionResponseEvent["parts"][0]["data"];
}

/** Our tool uses without a result, each annotated with its gate state (all log queries). */
function pendingOf(events: Event[], session: Session, gate: Gate): Pending[] {
  const answered = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => e.payload?.ref_id),
  );
  return events
    .filter((e): e is ToolUseEvent =>
      e.type === "tool_use" && e.agent?.session_id === session.id && !answered.has(e.id)
    )
    .map((use) => {
      const { name, input } = use.parts[0].data;
      const gated = gate(name, input);
      return {
        use,
        gated,
        // request and response both point ref_id at the USE — a star, not a chain (§3)
        requested: gated &&
          events.some((e) => e.type === "permission_request" && e.payload?.ref_id === use.id),
        response: gated
          ? events.find((e): e is PermissionResponseEvent =>
            e.type === "permission_response" && e.payload?.ref_id === use.id
          )?.parts[0].data
          : undefined,
      };
    });
}

/** Waiting on a human: requested, unanswered. The permission_response carries the wake. */
const waiting = (p: Pending) => p.gated && p.requested && !p.response;

/** Non-self messages our last home message's step did NOT consume ⇒ an answer is owed.
 *  Measured against the closing's `meta.consumed` horizon (what its window actually held),
 *  not log position — a message landing between the window-read and the closing's publish
 *  sits BEFORE the closing in the log yet was never seen (the live-bench coalescing race).
 *  Position is the fallback for messages without a horizon (pre-horizon logs). */
function unanswered(events: Event[], session: Session, home: string): boolean {
  let last = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (
      e.type === "message" && e.agent?.session_id === session.id &&
      e.envelope.conversation.address === home
    ) last = i;
  }
  if (last === -1) {
    return events.some((e) =>
      e.type === "message" && e.agent?.session_id !== session.id && !backfilled(e)
    );
  }
  // resolve the horizon to a POSITION — the window may be re-sorted for display (§5)
  const horizon = events[last].extra?.consumed;
  const h = typeof horizon === "string" ? events.findIndex((e) => e.id === horizon) : -1;
  const from = h !== -1 ? h : last; // no/stale horizon → fall back to the closing's position
  return events.slice(from + 1).some((e) =>
    e.type === "message" && e.agent?.session_id !== session.id && !backfilled(e)
  );
}

/** All our uses have results but no turn output followed ⇒ the closing think is owed.
 *  Turn output = our thinking / tool_use / home message; a directed peer send is not. */
function unclosedChain(events: Event[], session: Session, home: string): boolean {
  const uses = new Set(
    events
      .filter((e) => e.type === "tool_use" && e.agent?.session_id === session.id)
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
    e.agent?.session_id === session.id &&
    (e.type === "thinking" || e.type === "tool_use" ||
      (e.type === "message" && e.envelope.conversation.address === home))
  );
}

/* ── the invocation ───────────────────────────────────────────────────── */

export interface AgentConfig extends TurnConfig {
  /** Gate policy: true ⇒ this tool call needs approval (§9). v0 default: gate `send`. */
  gate?: Gate;
  windowLimit?: number; // history query cap — a fallback; compaction is the mechanism (§5)
  lockTtlMs?: number; // turn-lease TTL; a lease older than this is STOLEN (the crash signal)
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
}

function isOutcome(x: Json | ExecOutcome): x is ExecOutcome {
  return typeof x === "object" && x !== null && !Array.isArray(x) &&
    "output" in x && Array.isArray((x as { files?: unknown }).files);
}

export interface XiPorts {
  /** Publish · read · lock — plus the two team-chat slices the send path needs (§6):
   *  `agents` to recognize a peer's name, `upsertMemberships` to enroll a DM's ends.
   *  NOT `Subscriber`: the tail belongs to main (§2). The lock is a store capability so
   *  a turn's writes and its release can share one transaction later. */
  log:
    & Appender
    & Reader
    & Locker
    & Pick<Registry, "agents">
    & Pick<Connections, "upsertMemberships">;
  docs: Docs;
  /** The model edge. main picks it (Anthropic today) and it travels down the chain unchanged
   *  — the transport is where another provider adapts in, so nothing above it changes. */
  transport: ModelTransport;
  exec?: Record<string, ExecTool>; // bash + MCP; send/search are built-in
  onDelta?: Emit; // → the harness stream (fire-and-forget)
  ambient?: () => Promise<string[]>; // env lines (cwd·git·jobs) for the anchor (§5); edge: absent
}

const DEFAULT_WINDOW = 500;

/** One xi invocation: poke → owed → (think/act: acquire-or-exit → work) → return. */
export async function xi(config: AgentConfig, ports: XiPorts, trigger?: Event): Promise<void> {
  // 1. the gate — free: no read, no lease. Most invocations end here (§2)
  if (trigger && !relevant(config, trigger)) return;

  // 2. the lease. Taken BEFORE the read: one read per invocation, and the read is then
  //    already up to date w.r.t. whatever landed while we were acquiring
  const name = `turn-${config.agentId}`;
  const lock = ports.log.lock(name, config.lockTtlMs);
  const got = await lock.acquire();
  if (got === "held") return; // no retry: someone is on it, and their turn's end will poke

  const session: Session = { id: config.sessionId, agentId: config.agentId };
  const gate = config.gate ?? ((name: string) => name === "send");
  // 3. decide, under the lease and from a fresh window — so it can't act on a stale verdict
  //    (another holder may have finished this very work while we were being invoked).
  //    The port is scoped (§6): visibility applies inside the read, BEFORE the limit, so the
  //    window holds N visible events — xi never sees, nor re-checks, what policy hides.
  const events = await ports.log.read({
    limit: config.windowLimit ?? DEFAULT_WINDOW,
    backfill: false, // imported history is not news: it wakes nothing and renders nowhere
  }); // the
  //    ONE read: the work's input as well as the decision's (§2)
  const v = decide(events, session, config.home, gate);
  if (v === "ignore") {
    await lock.release();
    return;
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
  await ports.log.publishAndRelease(last, name);
}

/* ── think: one locked turn ───────────────────────────────────────────── */

async function think(
  events: Event[],
  config: AgentConfig,
  ports: XiPorts,
): Promise<Draft<Event>[]> {
  const docs = await ports.docs.list({ agent: config.agentId, conversation: config.home });
  const ambient = ports.ambient ? await ports.ambient() : undefined;
  // ONE turn per invocation, and nu decides what the turn IS: an over-budget window makes it
  // the checkpoint (the summary's insert wakes the think it displaced); a paced/truncated
  // turn continues via `meta.stop` and `decide` (§2, §5). xi only gathers the I/O.
  return await nu(
    {
      events,
      docs,
      tools: specsOf(ports),
      config,
      ambient,
      // trailing-region media → real image/document blocks (§5); the store loads, render picks
      loadMedia: loadMediaBlock,
      // the checkpoint instruction is a DOC (§5/§8) — editable like any instruction
      compactPrompt: () =>
        ports.docs.read({ agent: config.agentId, conversation: config.home }, {
          scope: "system",
          kind: "instruction",
          name: "instructions/compaction",
        }),
    },
    ports.transport,
    ports.onDelta,
  );
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
  const mind = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: `mind:${config.agentId}` },
  };
  const homeEnv = {
    service: "local" as const,
    connection_address: "agent",
    conversation: { address: config.home },
  };
  const ts = () => new Date().toISOString();

  const resultOf = (
    use: ToolUseEvent,
    outcome: Json | ExecOutcome,
    flags?: Partial<{ is_error: boolean; cancelled: boolean }>,
  ): Draft<ToolResultEvent> => {
    const { output, files } = isOutcome(outcome) ? outcome : { output: outcome, files: [] };
    return {
      ts: ts(),
      type: "tool_result",
      payload: { turn_id: use.payload.turn_id, ref_id: use.id },
      agent: self,
      envelope: mind,
      parts: [
        { type: "data", kind: "tool_result", data: { output, ...flags } },
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

  // every write this act produces is collected and committed ONCE, with the lease release
  // (§2) — the barrier completes atomically, and no half-batch can wake anyone
  const out: Draft<Event>[] = [];
  const runnable: ToolUseEvent[] = [];
  for (const p of pendingOf(events, session, gate)) {
    if (waiting(p)) continue; // the human's move — their response is the wake
    if (p.gated && !p.requested) {
      // surface the approval card in the principal-DM; ingest matches the reply (§9)
      const { name, input } = p.use.parts[0].data;
      const req: Draft<PermissionRequestEvent> = {
        ts: ts(),
        type: "permission_request",
        payload: { ref_id: p.use.id },
        agent: self,
        envelope: homeEnv,
        parts: [{
          type: "data",
          kind: "permission_request",
          data: {
            tool: name,
            args_preview: JSON.stringify(input).slice(0, 200),
          },
        }],
      };
      out.push(req);
      continue;
    }
    if (p.response?.behavior === "deny") {
      const reason = p.response.reason;
      out.push(resultOf(p.use, `denied${reason ? `: ${reason}` : ""}`, { is_error: true }));
      continue;
    }
    if (stolen) {
      // the previous holder crashed mid-act: execution state unknown — cancel, don't
      // re-run (a send may already have reached the peer); the model re-decides
      out.push(resultOf(p.use, "orphaned by a crashed turn", { is_error: true, cancelled: true }));
      continue;
    }
    runnable.push(p.use);
  }

  // the batch runs in parallel — the lock serializes the mind, not the tools (§2). Nothing
  // fires this controller yet: cancelling a running turn is a `control` event xi will check
  // for at tool boundaries (§10) — log-derived, because an out-of-process invocation can't
  // be signalled. The `cancelled` flag it sets is already the steal-sweep's flag.
  const ctl = new AbortController();
  out.push(
    ...await Promise.all(runnable.map(async (use) => {
      try {
        return resultOf(use, await execute(use, ctl.signal, self, ports));
      } catch (err) {
        return resultOf(use, err instanceof Error ? err.message : String(err), {
          is_error: true,
          ...(ctl.signal.aborted ? { cancelled: true } : {}),
        });
      }
    })),
  );
  return out;
}

async function execute(
  use: ToolUseEvent,
  signal: AbortSignal,
  self: { id: string; session_id: string },
  ports: XiPorts,
): Promise<Json | ExecOutcome> {
  const { name, input } = use.parts[0].data;
  const args = input as Record<string, Json>;
  if (name === "send") {
    // the only dispatch path (§9): directed message + queued result (two appends on
    // files — atomic pair on DB later; the steal-sweep covers the crash window)
    let to = String(args.to);
    // team chat (§6): a peer AGENT's name canonicalizes to the pair's DM conversation,
    // and both ends are enrolled — membership is what makes it visible to exactly them
    // (upsert-only and live, so the scoped publish below already passes WITH CHECK)
    const peer = ports.log.agents().find((a) => a.agentId === to);
    if (peer && peer.agentId !== self.id) {
      const pair = [self.id, peer.agentId].sort();
      to = `dm:${pair.join(":")}`;
      ports.log.upsertMemberships(pair.map((agentId) => (
        { service: "local", connection: "agent", conversation: to, agentId }
      )));
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
    const body = String(args.text);
    const msg: Draft<MessageEvent> = {
      ts: new Date().toISOString(),
      type: "message",
      payload: { ref_id: use.id }, // the send tool_use that dispatched it
      agent: self,
      envelope,
      parts: [...(body ? [{ type: "text", kind: "text", text: body } as const] : []), ...files],
    };
    const sent = await ports.log.publish(msg);
    return { queued: true, event_id: sent!.id }; // a full draft (parts present) always stores
  }
  if (name === "search") {
    const rows = await ports.log.read({
      conversation: args.in as string | undefined,
      from: args.from as string | undefined,
      before: args.before as string | undefined,
      after: args.after as string | undefined,
      text: args.text as string | undefined,
      types: ["message"],
      limit: 50,
    });
    return rows.map((e) => ({
      id: e.id,
      ts: e.ts,
      conversation: e.envelope.conversation.address,
      sender: e.envelope.sender?.name ?? e.envelope.sender?.address ?? "self",
      // `?? []` because a row's payload may legitimately carry no parts — a merge-only
      // draft that found no target inserts one (§3). Render already defends here; search
      // threw, which took the whole query down over a single malformed row.
      text: ((e as MessageEvent).parts ?? []).filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text).join(" "),
    }));
  }
  const tool = ports.exec?.[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await tool.execute(input, signal);
}

function specsOf(ports: XiPorts): Anthropic.Tool[] {
  return [
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
              "target conversation address (as shown in its conv element), or a peer agent's name to DM them",
          },
          text: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "file paths to attach (workspace or media-store paths)",
          },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "search",
      description: "Search the event log: filter by conversation, sender, time range, text.",
      input_schema: {
        type: "object",
        properties: {
          in: { type: "string" },
          from: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          text: { type: "string" },
        },
      },
    },
    ...Object.values(ports.exec ?? {}).map((t) => t.spec),
  ];
}
