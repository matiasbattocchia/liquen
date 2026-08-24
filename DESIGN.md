# Harness Design — mu / nu / xi

*State of the design as of 2026-07-14 — pre-coding baseline. Product: an org-level agent harness for **agents**
(AI alter-egos) over messaging channels (WhatsApp, Slack/Teams, email, CLI/UI), with
human-in-the-loop steering. Own harness — not Claude Code / Pi / OpenClaw — informed by
all of them.*

**Terminology (pinned):** **agent** = the AI (an alter-ego). **principal** = the human it
belongs to (the member/owner). **peer** = the other party in a conversation (an external
contact — a customer — or another agent). The agent↔principal conversation is the
**principal-DM**.

---

## 1. Vision & v0 scope

- **Agents (alter-egos)**: each org member (principal) gets an AI agent that acts under
  their identity. WhatsApp → one agent as the account owner. Slack/Teams → one per principal.
- Org-level (not personal-agent like OpenClaw/NanoClaw): shared inboxes, handoff between
  AI and humans, audit throughout.
- Proven seed: Mirlo's cabra-bot (one long-running Claude Code session + Slack polling +
  steering). This harness makes that pattern first-class, event-driven, and multi-channel.
- Deployment: **Docker per org** (env, credentials, tools per org) — same harness must
  also run on **edge functions** (Supabase). DB-backed state, not filesystem.
- v0 stack: **Deno · EventLog behind a storage port (files FIRST — a shared dir, multi-
  process; Postgres + edge later) · CLI as first control client · Anthropic-native protocol**.
  Reuses open-bsp-api concepts heavily (messages/parts model, producers/dispatchers,
  agents table).
- **v0 = the unified session** (§7): one long-running session per agent holding the
  principal-DM + all its peer conversations. Subagents/tree are **deferred** (§10).
- **Build order:**
  - **v0.0 — CLI-only.** One agent, one conversation (the CLI principal-DM, `local`
    service), files storage, single process, Anthropic-native mu, tools `send`+`search`+
    `bash`. Exercises the whole spine (mu/nu/xi, run-to-quiescence, Schema-B render, docs
    cascade, clock) with **zero channel machinery**.
  - **v0.1 — add Slack** → multiple conversations in the one session → exercises
    cross-conversation labeling, echo-dedup, coexistence-yield, thread hints.
  - **v0.2 — WhatsApp** (+ credentials/OAuth, media→openbsp), then Teams/email.

## 2. Core architecture

```
mu  — the step.     Pure: one model call. request in → emissions out.
nu  — the turn.     ONE think, assembled and stamped, no I/O: window + docs in →
                    render → mu (with the transport backoff) → stamped events out. The
                    turn's `stop` rides on its last event, so a paced/truncated turn
                    continues through the LOG, not through a loop.
xi  — the consumer. The log boundary, per principal — short-lived, one invocation
                    per POKE, and the only publisher. Reads the log, `decide`s once
                    (think | act | ignore), does the owed work, ends the turn with one
                    atomic publish+release, exits. Owns acts + gates + the turn lease.
                    Never subscribes, never re-triggers itself.
main — the process. Config (env + defaults; the registry scan), holds the subscriptions: EACH
                    agent tails the log through its own policy-scoped port (§6), so
                    delivery itself is filtered — Realtime-on-RLS — and every delivered
                    event invokes that agent's xi. Inspects nothing, decides nothing.
                    The only long-running piece. Picks the **transport** (the model
                    edge) and passes it down, metered and scoped per agent.
```

The purity gradient: **mu ⊂ nu ⊂ xi ⊂ main** — one model call, a pure-ish transform,
all substrate I/O + policy, the process shell. A rich principal interface (web UI/TUI)
is a *connection process* like any other: pub/sub on the log + the harness stream (§9).

Two planes:

- **EventLog** — durable, append-only. *The API and the queue.* Producers (webhooks)
  publish; consumers (dispatchers) subscribe to the log's change feed (fs-watch on files /
  DB-webhook·Realtime·pgmq·cron on Postgres) — the `publish` is itself the trigger.
- **Stream** — ephemeral broadcast for token deltas, thinking, tool progress, and errors
  the operator watches. Never stored. Rule: **stream the in-progress, log the completed.**

The ReAct loop is **unrolled across invocations** (invocation = step = one model call):

```
trigger → invoke:  read log (filtered) → build context → mu → write events → exit
continuation:      newly-written events re-trigger the next invocation (via xi)
```

Consequences: edge-compatible, crashproof (log = journal, recovery = replay),
suspension free (no verdict → no trigger), parallelism trivial.

### mu's contract

```ts
mu({system, messages, tools, model, maxTokens, effort?, turnId?}, transport, emit?) → StepResult
// transport = the model edge (main picks it — Anthropic today; where a provider adapts in)
//   + CallMeta{turn_id}: what the call is FOR — the provider never sees it, the meter does
  ok:    { emissions, usage, stop }     // usage → telemetry table, NOT the log
  fail:  { error }                      // nu owns retry policy; permanent → error event

// mu never: reads the log, writes, executes tools, stores, touches channels.
// emit = fire-and-forget deltas/thinking to the Stream (correctness never depends on it).
```

**mu emits three event types:** `message` (its bare assistant text to the
principal, §5), `tool_use`, and `thinking` (its extended-thinking block, logged
with signature so the unrolled next step can replay it — §5). Directed messages (to
peers/principal) are produced by nu via the `send` tool. Everything else is written by nu
(`tool_result`, `permission_request`, `summary`, `alarm/error`) or by producers (`message`
from the world, `control` from ingest).

### The Anthropic API loop signal (grounding)

- A response carries **text + tool_use together**; `stop_reason` drives the loop:
  **`tool_use` → run tools, continue** (a `tool_use` response *never* has `end_turn`);
  **`end_turn` → done** (text-only). So `stop_reason` *is* nu's continue/idle signal —
  no inference needed.
- Because ending requires `end_turn` (text), **every cycle ends with a final message** — the
  agent's **assistant** text to its principal (§5). A turn that acted on peers closes briefly;
  a turn with nothing to add closes tersely.

### xi's verdict (think / act / ignore — there is no await)

```
decide(log window)  →  think | act | ignore
```

The verdict **is** the owed-derivation (`decide`), computed **once** per invocation, from one
window, under the lease. The triggering event reaches xi, but only as a **gate**: `relevant`
can cheaply say *this cannot possibly matter*, never *this is the work*. What IS owed is
always a log query — which is why an invocation with no event at all (boot) is equally valid:
it skips the gate and reads.

main therefore delivers and decides nothing itself. Visibility filters at the STORE boundary
(`scoped`, §6): what an agent may not read is never delivered, never in its window, never in
its `search` — xi neither sees nor re-checks it. The class gate (`relevant`) keeps the rest
cheap: spectators cost nothing. Whatever survives pays one lease and one read — **read/write the store ·
decide · hold the lease** is xi's whole job.
**Awaiting IS ignoring**: there is no waiter — the obligation lives in the log, and the
event that completes it (the last `tool_result`, the `permission_response`) is just
another poke.

```
decide(window) →
  pending uses (ours, no result)                                   → act (answer them ALL)
  an answered ask whose call has not run yet                       → act (the late errand)
  last turn's `payload.stop_reason` was pause_turn / max_tokens (≤3) → think (CONTINUE it)
  trailing harness `error` (the last event in the window)          → ignore (idle-after-error)
  unclosed chain (all uses resolved, no turn output after)         → think (the closing turn)
  unanswered news (non-self msgs beyond the last closing's CONSUMED horizon), CLASSED:
    a summons — the mind alias, and nothing else                   → think (never waits)
    an engaged conversation — it HOLDS THE FLOOR: our complex's    → think (you don't drop
      last word there is the agent's, and it is recent               out mid-conversation)
    ambient, and a pile is due (deep enough, or old enough)        → think (the digest)
  else                                                             → ignore (quiescence)
```

**Attention**: not every message is worth a model turn — an agent sitting in busy group
channels would otherwise spend a turn per line. The unanswered news is classed per
conversation. A **summons** is the **mind alias** and nothing else: the one conversation
that addresses the agent. Not a DM, not a reply to something it said, not its name spoken
as a word — those address the principal's account in a room the agent is a bystander in,
and waking on each is a full turn per line of somebody else's conversation. What is
genuinely said TO the agent arrives at home, through the mirror's fan-in (§4); the rest is
the world, and the world waits. An **engaged** conversation wakes immediately too, and
engagement is **holding the floor**: the last thing our complex said there was the agent's
own voice (`ownVoice` — the `turn_id` discriminator, §3) and it is younger than
`engagedMinutes`. Every reply refreshes the clock (ping-pong), silence lets it decay — and
the **principal speaking there ends it at once, without a clock**: they took the floor
back, from their own phone, and an agent that answered over them for the rest of the window
would be talking past its own principal. To hand the floor over again they say so at home,
which is the one thing that still wakes the agent. So the world can never pull the agent in
without the principal: it is only ever engaged where it was sent.
Everything else is **ambient** and waits for the digest: a conversation's pile wakes the
agent when it reaches `digestAfterMessages`, or when its oldest news has waited out
`digestMinutes` — and inside `sleepHours` ("23-8"-style on the org clock, null ⇒ never
sleeps), neither does: the ambient class wakes nobody until morning, however deep the pile.
Sleep sits between the classes, not over them, so the two that were addressed to someone
still land at 3am — the principal's own line at home, and a conversation the agent is
holding the floor in. What sleeps is the world. (It replaces a stretched night interval,
which was a number tuned against a cache TTL nobody controls: past an hour every wake pays
a full uncached prefix write anyway, so three overnight wakes cost more than the ten they
replaced and each read a third of a night. The night now arrives once, whole.)
Deferring costs nothing and loses nothing: the news stays
owed in the log, and main's **tick** (`tickMs`) — the clock as a poke source, a
trigger-less invoke on a metronome — re-asks the same question until it comes due. All
knobs live in the catalog's `agent` section (§9), per-agent overridable; the whole policy
stays a pure derivation over one window, so a DB-tier `decide` can say the same thing.

Before any of that runs, a world trigger **settles**. People type the way they talk — three
lines two seconds apart are one thing said — so main arms a `settleMs` (5s) timer instead of
a turn, and the rest of the burst joins it; the turn that finally runs reads a window holding
the whole thought instead of answering its first line. The trigger is dropped, not queued
(the invocation IS the poke, §2), and only world triggers wait: a trigger-less poke has no
burst to wait for, and the agent's own writes are how one turn CHAINS to the next.

Beneath all three classes sit the **silencing marks** — `extra.backfill` (imported
history) and `extra.muted` · `extra.archived` (the chat's platform-synced state when the
message arrived; WhatsApp's phone-side mute/archive rides whatsmeow app state, stamped
per message by the bridge — the same denormalization as names, never retroactive). A
marked row is not news at all: it never wakes — not even into a pile, so a muted group
never comes due — never renders, never mirrors; the
turn window's read drops it in SQL (`silenced: false`) and `search` is the door. Slack
has no wire equivalent (mute is a private client preference the bot can't see) — a
mu-side mute waits for the conversations table.

`relevant` — authorship and class only, never payloads — and never visibility: the trigger
arrives through the agent's scoped subscription, already readable (§6).

| type | relevant? |
|---|---|
| `message` | **yes** — a peer's IS the work; our own closing message is the **self-poke** that catches mid-turn arrivals |
| `tool_use` · `tool_result` | ours **yes** · another session's **no** (never react to others' tools) |
| `permission_response` | **yes** (the human moved — the settlement is now derivable) |
| `alarm` | **yes** — the universal poke |
| `control` | **no** — it never *starts* work. Cancelling a running turn is a `control` event xi checks for at tool boundaries (§10), log-derived because an out-of-process invocation can't be signalled |
| `summary` | **yes** — a checkpoint DISPLACES a turn (§5): its insert carries the displaced think forward |
| `permission_request` · `thinking` · *(unknown)* | **no** (spectators) |
| `error` | **no** — and this one is policy, not economy: a logged error is a PERMANENT failure until something new arrives (transient ones were already retried inside nu before one was written). `decide` says the same from the window side, via the trailing-error rule. Waking here would hot-loop a failing think with no backoff |

The derivations are **position-aware**, so a late invocation that arrives after the work was
already done resolves to nothing — quiescence is a poke that finds nothing owed.

**The window has two bounds**, a count and a floor. `windowLimit` (500) bounds the prompt —
it is the size guard, and under live traffic it is the one that binds. Its floor is
**anchored**, snapped down to a half-hour grid: a plain tail drops one event off the front
on every append, and since a prompt cache matches a PREFIX, that shift alone voids the whole
rendered history and every breakpoint behind it — the transcript re-written each turn at
1.25× instead of read back at 0.1×. Snapped, the floor stands still for a bucket of turns
and jumps once; the window is `windowLimit` plus whatever else shares the floor's bucket.
`since` bounds the
BACKLOG: a fixed instant, set once when the agent comes up to start − `backlogHours` (24,
org-configurable: `organization.backlogHours`), before which nothing is ever owed. An
agent coming up after a week off answers the last day, not the week, and the rest is history
it can still reach through `search` (§6).

The floor is an instant, not a distance from now, because what it answers is a one-time
question — *what backlog did this process inherit?* A bound that followed the clock would
keep re-deciding it: a conversation the agent already engaged with would age out from under
it mid-thread, and the cards, horizons and own-messages the derivations read would go with
it. Set once, it decides the inheritance and then holds still while the count cap does the
ongoing bounding. It stays in hours for the same reason it must not be tight: the window is
also where a turn finds its own last message and the `consumed` horizon that proves a peer
was answered, so a floor cutting BETWEEN a message and its reply would answer it twice.

**The consumed horizon** (live-bench find, 2026-07-20): the closing message carries
`extra.consumed` — the last event id in the window its step actually read. `unanswered`
measures against the horizon's POSITION, not the closing's: a message landing between the
window-read and the closing's publish sits before the closing in the log yet was never
seen. render honors the same horizon (unconsumed messages render as trailing INPUT, not
history — also keeps the final user turn non-empty), and compaction never checkpoints
them away. Real model latency opens this race seconds wide; scripted steps never could.

**`<|SILENCE|>`** — the word that closes a turn without speaking. Every turn ends with a
home message, because that message is the close and the horizon rides on it; so an agent
that looks at the world and finds nothing still had to write a sentence to somebody who
did not ask, and that sentence then sat in the window being re-read for days. Most of what
an always-on agent writes is that sentence. The sentinel is stamped `extra.silence` and
the event is kept verbatim — the log stays honest, the close is a real close, the horizon
holds — but the body goes nowhere: the mirror carries it to no surface (§4), render draws
no block for it (§5), and the REPL holds the deltas back until it knows which word it is.
`silent` is not `silenced` (§2): a silenced row is not ours and never enters the window
read at all; a silence note is ours, and it is only the body that is absent.

*(v0 has no `held`/park pre-check. **Coexistence** — the principal answering a customer
directly — is handled by the model **yielding** when it sees the principal's reply, not by
a state flag. Explicit **takeover/hold** is deferred, §10.)*

**No wake-rule.** The agent wakes on **everything it can read** — access (the per-principal
readable filter / RLS, §6) *is* the wake filter. It decides relevance itself: act
(`send`/assistant text) or stay quiet. (Mention-only wake = deferred cost optimization, §10.)

- **The relational rule** (the discriminator): a message is `ignore` iff
  `event.agent.session_id == this_session` (own output). The **same bit** assigns the
  LLM role (self → assistant, else → user; §5) *and* the wake verdict. One bit, two
  derivations.
- **Two error channels, never conflated**: **tool failure** → `tool_result{is_error}`
  → normal routing (barrier → think), the agent's self-correction path (~99% of "errors").
  **mu execution failure** (API/overload/parse) → nu retries (slow outer layer; the SDK
  client already retries fast); permanent → `error` → ignore + render system (so the
  model knows) + stream (operator); idle, next message retriggers.

### Scheduling = the log + one lock

The only scheduling state that outlives an event is the **turn lease** — one `locks` row per
agent, **in the store beside the events** (a DB advisory lock on Postgres — §9 symmetry). It
lives there, not in a file, so a turn's writes and its release can share one transaction.
Everything else is **derived by query** (the `decide` derivation above). The invocation shape:

```
main: anything changed → invoke xi for EVERY registered agent (no filter, no payload)
xi:   relevant(event)? no → exit                (free: no read, no lease)
      acquire-or-exit
      read → decide once:
        ignore     → release, exit               (someone already did this very work)
        think/act  → work → publishAndRelease: the last events + the release, ONE transaction
```

Two filters, answering the same question from opposite ends. **`relevant(config, event)`** is
pure over the ONE triggering event — can this agent SEE it (§6, the RLS predicate) and can its
CLASS imply work — so a spectator costs nothing, and it stays expressible as a Postgres
trigger's `WHEN` clause (§9). **`decide(window)`** is the authority, and it runs *under the
lease*: an invocation can be queued behind a holder who already did this work, so deciding
before acquiring would run a duplicate turn.

- **The log is the continuation engine.** Every publish is itself the next trigger; xi
  never re-triggers itself. Every turn ends in output — `tool_use` continues the cycle
  through the log; the **closing assistant message** self-pokes the next owed-check (it's
  also render's boundary event and the public end-of-turn signal — one event, three
  jobs). Mid-turn messages therefore batch into ONE follow-up, never one spawn each.
  Quiescence is a poke that finds nothing owed. `pause_turn` and `max_tokens` are the
  continuation, and they run through the log like everything else: nu stamps `payload.stop_reason` on
  the turn's last event, `decide` reads it, and the next invocation continues — one invocation,
  ONE model turn, no loop in xi. The server paced ONE turn (`pause_turn`) or cut it off at the
  output ceiling (`max_tokens`); the partial turn is committed, so re-entering CONTINUES it,
  neither a re-trigger nor a dead-end. `max_tokens` continuation is bounded (3 consecutive
  overflows) against a runaway generation and carries an advisory to steer large output to
  files; `refusal` alone is terminal (surfaced as an error, no continuation). Corollary:
  per-turn `maxTokens` must leave headroom under any wall-clock budget — a turn that runs
  to a 64k ceiling takes ~13min and can't finish inside an 840s task wall, so task mode caps
  at 32k and lets the continuation span turns.
- **Costs, by case**: a `relevant`-rejected spectator is FREE (no read, no lease); a
  relevant event that decides ignore costs one lease pair + one read (the lease comes first
  — deciding before acquiring would act on a stale verdict); work costs the same plus the
  turn. Cannot acquire? Exit — no retry.
- **A turn ends with `publishAndRelease`** — its last events and its lease release in ONE
  transaction (§9). Not a detail: publishing first and releasing after cost us a real bug.
  The wake a turn's inserts fire arrives while the turn *still holds the lease*, so it bounces
  off the lock, and if it was the only wake in flight the obligation strands — measured at
  ~40% of runs stalling a tool cycle, because `watchFs` latency is *shorter* than the rest of
  a turn's teardown. Committed together, an observer sees neither or both, so the wake always
  finds the lease free. This is why the lease lives in the store beside the events: two
  substrates can't share a transaction. It keeps the log the only loop — nothing returns a
  "call me again", and no caller decides anything. What it does NOT cover is a holder that
  dies mid-turn; that's the periodic poke's job, the liveness floor (§10).
- **Crash recovery = the steal + the sweep.** A stale lock (TTL) is *stolen*, and the
  steal is the crash signal: act then **sweeps** pending uses (cancelled results) instead
  of blindly re-running tools whose side-effects may already have happened — the model
  sees the cancellations and re-decides. A cleanly released lock over pending uses means
  nothing crashed: just run them. At boot, main simply invokes every agent once — whatever
  the log owes, unprompted. (A failed think leaves a trailing `error`, and `decide` reads that
  as nothing owed; the next message or alarm retries — idle-after-error is intended.)
- **Parallel principals**: reads may overlap (shared inboxes — the log's founding case),
  **writes partition by authorship**, so N consumers never contend. Concurrent invocations of
  the *same* agent are fine too — they bounce off the turn lock, which is the only
  concurrency control anywhere (a second main, DB triggers later, all the same).
- **No queue, and no coalescing mechanism.** N events during one turn produce N invocations
  that all fail to acquire; the turn's own closing message then invokes once more and its
  window read sees everything, so one think answers them all. The lock plus one window read
  *is* the coalescing (the `consumed` horizon, below, is what makes a batched answer count as
  having answered each). main's only per-agent state is the set of in-flight invocations, so
  `stop()` can await them — lifecycle, not scheduling: closing the log and reaping the exec
  plane must not happen under a live turn.
- Principle: *any poke does whatever the log owes; events carry no work, only the wake.*

### The send path

`send` is a **plain tool** — full act cycle, no special casing:

```
think: mu emits tool_use(send)
act:   send-executor appends message(directed) + tool_result "sent"  (ONE transaction)
think: re-triggered; model continues (multi-send: "working on it" → work → results →
       final message). Cycle ends at end_turn (the final assistant text).
```

- **Invariant: dispatch to a *peer* is always the `send` tool; the agent's voice to its
  *principal* is bare `assistant` text** (auto-delivered to the principal-DM — no tool, like
  Claude Code answering; the mirror CCs it to every bound alias surface, §4). Three channels:
  **think** (`thinking`, private), **assistant** (bare
  text → principal), **send** (tool → peer). `send` is never principal-directed. (§5)
- **The closing call**: because `stop_reason=tool_use` never ends a turn, a think that sends
  needs a follow-up `end_turn` call — the model reacts if a send failed, then closes with its
  assistant text. ~1 extra call per *think*, amortized over parallel sends in a batch. A "terminal
  send" fast-path is deferred.
- Gated send = gated tool (outbound approval / future draft mode for free) — and gated
  never means blocked: the call returns `pending_approval` at once and the verdict runs it
  later (§3, the non-blocking gate).
- Failed send = errored tool (exchange kept in render as teaching material).
- Successful send: render **collapses the tool pair** into the decorated message line.
- **The agent addresses; the executor envelopes.** `send` takes `{to, text}`: an address
  and a body, nothing else. The outbound message's envelope is written by the
  send-executor, and it completes `service · connection · kind` **from the conversation's
  own events**: the denormalized envelope on every event IS the conversation's record, so
  the log is the authority on a conversation's coordinates and a reply carries the same
  envelope its conversation always had. The lookup goes through the agent's **scoped**
  log, so an agent anchors only into conversations it can see. A conversation with no
  events gets the local channel — reaching a conversation the log has never seen is
  first contact, the address-book open (§5).

### Scheduling, interruption & steering

The unrolled model is a **tape computer — one per agent**: each agent is a *serial*
machine (one mu at a time; its conversations are timeshared, messages are interrupts, mu
is the CPU), and **different agents run in parallel**. So: **per-session serialization (the lease — the
one must) + cross-agent parallelism** (a global provider-rate cap is deferred, §10).

- **Turns are atomic — interruption is admission, never preemption.** New events land in
  the log and are seen at the next spawn. A stop *interrupts acts* (killable processes),
  never a turn (atomic, brief; finish then process). The turn lock serializes turns only;
  acts run concurrently and are killable.
- **Coalescing scales with heat**: N messages during a busy period = one turn over a
  bigger window (the lock skips mid-turn arrivals; the closing message's self-poke
  batches them). The event log *is* the queue — a turn reads the window, not
  one-per-message. Strictly better than cabra-bot's fixed 5-min poll: responsive on
  arrival, batched when busy.
- **Steering** = any message authored by the agent's **principal** (anywhere, incl. WA
  coexistence). Never delayed — v0 has no debounce to skip (debounce itself: important, not
  urgent, §10). The model interprets it (steer / follow-up /
  add-to-TODO / leave-room) — no disambiguation syntax; authorship + envelope suffice.
- **Two stop paths**:
  - *Soft (model-mediated)*: "stop"/"wait" is a `message` → think; the model stops
    emitting and (if needed) kills a background process via the background-suite kill.
    (`cancel_pending` is **not** a dedicated tool — it decomposes into "stop emitting" +
    the existing kill.)
  - *Hard (nu-mediated, guaranteed)*: whole-message reserved word (ingest → `control`) or
    UI button → nu kills in-flight acts, writes **cancelled tool_results** (count toward
    barriers), voids pending gates. **Undirected — affects all the agent's in-flight work.**
- **`control` is ingest-classified** (a principal reserved-word in self-talk), routed to
  nu's stop-handler (`act`). Not "pre-xi" — it's classified at ingest, xi routes the type.

In v0's single session, `stop` = cancel the agent's current work → idle. *(Per-conversation
**takeover/hold** and — in the deferred tree — `cause`-scoped stop are deferred, §10.)*

### The clock

The machine is **purely eventful and runs to quiescence**: event written → xi assigns →
nu processes the queue → queue empty and no in-flight acts → **halt**. No polling; resting
state is off (zero idle cost, edge-perfect). Every continuation has an event cause;
determinism for testing (insert events → run to quiescence → assert log).

Apparent clock-needs, all clock-free: step continuation (control flow / delay-0 re-enqueue),
debounce (write-time abort + coalescing), await timeouts (conversation is the timeout;
acts self-timeout), cron (a **peripheral producer**, like a webhook).

**The clock is an optional peripheral** (pg_cron / delayed queue / in-mem wheel): timer
rows fire by **inserting `alarm` events**. An `alarm` is a *delayed,
harness-delivered effect* — the agent **scheduled** it (a `tool_use`), the **harness
fired** it (the sender), so it's `system`-authored (which is *required* — a self-authored
alarm would be ignored by the relational rule and never wake). Provenance lives in
`payload.ref_id` (→ the `schedule_wake`) + the data part. Invariants: anchored
where scheduled (self-wakes) or in the principal-DM (config crons); `timers` table is the
one non-log fact about the future (recovery = re-arm). Scheduling = a **timer-row write**
(control-plane SQL/RLS) or `at`/cron (files/OS), **skill-guided — no dedicated tool**;
the firing peripheral runs it.

Survey: **Pi** ships no scheduler; **Claude Code** makes the clock a harness peripheral
(Cron*, ScheduleWakeup, /loop, remote /schedule); **Agent SDK** embedders host their own
(nanoclaw `schedule_task`). Nobody puts the clock inside the machine.

The one honest hole: an obligation can strand until the next poke — an act that dies
**without writing its event**, or (before xi returned its decision, §2) a wake spent bouncing
off a still-held lease (fixed: `publishAndRelease`, §2). Mitigations, in order of directness:
one transaction for the turn's end, result-in-`finally`, the TTL steal-sweep, and — underneath
all of them — a **periodic poke** as the liveness floor. Any poke does whatever the log owes, so a heartbeat
makes every lost wake self-healing; that is the scheduler's first job, not its last (§10).
main's **tick** (`system.tickMs`, §2 attention) is that heartbeat, live: a trigger-less
invoke per agent on a metronome — it re-asks the digest question AND floors liveness,
one peripheral for both.

## 3. Event schema

**Common base — every event:**

```ts
{
  id: string        // uuidv7 — sortable; the STORE mints it (§9), producers publish a Draft
  ts: string        // platform time inbound; append time otherwise
  type: "message" | "control" | "tool_use" | "tool_result"
      | "permission_request" | "permission_response" | "summary"
      | "thinking" | "alarm" | "error" | ...open set
  envelope: {       // WHICH CONVERSATION — every event has a home (even internal ones)
    service: "whatsapp" | "slack" | "email" | "local" | ...   // local = harness's own channel
    connection_address: string                // org account id / workspace
    conversation: { address, name?, thread?, kind? }  // kind: direct | group | channel (below)
    sender?: { address, name? }   // external identity on the wire
    external_id?: string          // backfilled by dispatcher on send
    status?: Status               // mutable field; dispatcher delivery bookkeeping
  }
  agent?: { id, session_id }      // internal authorship (present iff a handler authored it)
  payload?: {       // what the event MEANS beside its parts — its own column
    action?: "edit" | "add" | "remove" | "delete" | "reply" | "forward"
    ref_external_id? | ref_id?    // the referent (the reference rule, below)
    turn_id?          // groups one step's emissions (boundary rule §5, tool barrier §2)
    stop_reason?      // on a turn's LAST event: the provider's verbatim stop (decide reads it)
    covers?           // on a summary: [from,to] — the id range the checkpoint stands for
    mentions?         // wire mentions, canonical addresses
    control?          // ingest-classified reserved word (stop | cancel)
  }
  extra?: {}        // the sidecar: backfill·muted·archived (silencing marks), consumed, silence, via, <service> provenance, raw
  status?: {        // delivery lifecycle — ONE mutable json_patch-merged column, never events
    state?          // furthest stage (envelope.status is its shorthand view)
    delivered_at? · read_at?   // scalars in a DM; {participant: ts} maps in groups
    deleted_at?     // a revoke stamps, never removes — content stays auditable
  }
}
```

**The action vocabulary** — what a message DOES to its referent's parts; absent = create:
`edit` replaces them · `add`/`remove` add or remove some (a reaction is a part somebody
added to someone else's message) · `delete` removes them all · `reply`/`forward` are
relational, not mutational. Edits and deletes are their OWN events (own external_id = the
carrier protocol message's id): the original row stays sealed, past WUMs stay invariant,
and the change renders in a later one (§5).

**The reference rule** — `ref_external_id` when the referent lives on a wire (the platform
id is the only stable name at ingest time); `ref_id` when both ends are ours (the log id
exists before the effect does: a reference always crosses an invocation boundary, so the
referent is stored by construction). LOCAL events adopt their own id as `external_id`, so
references live in one space; wire rows keep it NULL until their platform names them —
absence IS the "never confirmed" signal echo-dedup and the mirror's absorb guard read.

**Type-specific fields:**

```ts
message:  + parts: Part[]      // text | data | file, each with kind (open-bsp / A2A / MCP)
tool_use: + parts(data: {name, input}) + payload{turn_id}   // implicitly internal
thinking: + parts(data: {thinking, signature}) + payload{turn_id}  // replayed in-cycle, dropped after
tool_result: + parts(data: {output, is_error?, cancelled?}) + payload{turn_id, ref_id, deferred?}
          // deferred = a gated call approved LATER: narration, never a block (§9)
permission_request:  + parts(data: {tool, call, detail}) + payload{ref_id→tool_use}
permission_response: + parts(data: {behavior, scope, reason?}) + payload{ref_id→tool_use}
          // request and response BOTH point at the use — a star, not a chain
summary:  + parts(text) + payload{covers:[from,to]}
alarm/error: + parts(data)  // harness signals; no `agent` (harness-authored)
```

Decisions:
- **`address` for wire coordinates, `id` for store pkeys**: `connection_address`,
  `conversation.address`, `sender.address` name what the platform calls the thing; `id`
  names what the store mints (event ids). The store's
  columns (`conversation_address`, `sender_address`) follow the same rule.
- **An address is exactly what the platform calls the thing**: a Slack channel is `C123`,
  a GitHub issue is `owner/repo#42`, a WA chat is the jid. A CONNECTION address is the
  account coordinate, and it may be composite — a Slack user GRANT is `<team>:<user>`
  (both parts platform ids; the slack connector splits on `:`). EVENTS anchor to the
  workspace (`<team>`): a delivery is authorized for many grants at once, so no single
  user address can be an event's connection. The full coordinate is the (service,
  connection, address) triple, and each field lives once, on the envelope: dispatchers
  route on `envelope.service` and target with `connection_address` +
  `conversation.address`. `external_id` is the one prefixed string
  (`slack:T:C:ts`) — a global merge key in one store-wide map, where cross-service
  uniqueness is the point. The local service names its conversations `mind:<agent>` and
  `dm:<sorted>`. An address is meaningful WITH its envelope (or its `<conv>` element);
  single-string positions (`send.to`, log filters) rely on addresses not colliding
  across services — acceptable: platform id spaces (Slack C/D ids, jids, `owner/repo#N`,
  `mind:`/`dm:` names) are disjoint in practice.
- **`envelope` is on the base** — every event belongs to a conversation (internal events
  carry the conversation's own coordinates; `visibility` keeps them off the wire).
- **`payload` vs `extra`, one admission rule**: `payload` is what the event MEANS — the
  action, the reference, the turn keys — typed, and the machine branches on it. `extra` is
  the sidecar — how the wire said it plus harness bookkeeping (`backfill` · `muted` ·
  `archived` — the silencing marks, §2 — `consumed`, `silence`,
  `via`, `raw`, per-service provenance like `slack: {subtype, authorizations}`) —
  mergeable JSON the machine never branches on service keys of. Admission test: dropping
  an `extra` key must cost only auditability, never correctness — what queries or policy
  enforce on is a COLUMN (envelope coordinates, kind, external_id, status, payload), what
  a table owns stays in the table (the map is the truth, extra is provenance), secrets go
  to the vault only. With refs, action and mentions typed, WhatsApp's sidecar is empty.
- **Store-wide column conventions**: `created_at` on every table (a datetime; integer
  clocks keep their own names — `locks.born`, `oauth_states.born`); `updated_at` only
  where update operations exist; `agent_id` nullable with null meaning the org's;
  `extra` as the one JSON catch-all, always shallow-merged on update.
- **`visibility` is `message`-only — and PARKED (not in the v0 types).** The rationale
  stands for when it returns (with the subagent tree, §10): for every other type it's a
  constant (always internal), so it's not a variable; only a `message` would vary —
  **external** (delivered — a peer send, or the agent's assistant text to its principal)
  vs **internal** (a working note / to another session), and *the same conversation carries
  both*, so it couldn't be derived from the envelope. Until subagents exist, internal
  messages don't either — so the field was removed from the runtime types and the schema;
  every message is simply a message.
- **Class is derivable, not stored**: `agent` set → ai/human (authorship) · else (a
  message with only `sender`) → peer · a harness type (`alarm`/`error`) → system.
- **`park` dropped for v0** (session status derives from awaits; hold/takeover is the one
  imposed state — deferred with the tree).
- **`system` unfolded** into `alarm`/`error`/`summary` as top-level types
  (dropped the umbrella per "each type = a distinct handling contract").
- **`status` is a mutable field**, not events; delivery bookkeeping; render marks only
  `(failed!)` — a pending mark buys nothing (v0.2, with real channels). Transient failures retried silently. For v0 a **final actionable
  failure surfaces via the `(failed!)` mark** on the message; a distinct **`escalation`**
  event (agent- or operator-actionable → think) is **deferred** (§10) — `local` never fails
  to deliver, so it only earns its keep at v0.2 (WhatsApp windows, blocked numbers, expired
  creds), likely folded into a general **background-completion** signal.

### Event-type table

Common base = `id · ts · type · envelope · agent? · payload? · extra? · status?`.

| type | producer *(model→role)* | consumer *(→ LLM role)* | xi | type-specific fields |
|---|---|---|---|---|
| `message` | mu→**assistant** (say) · nu send-exec (directed) · ingest (incoming) | **user** (world) or **assistant** (this session's own) — by authorship | think (not-self) / ignore (self) | parts · payload{action?, ref_*?, mentions?} |
| `control` | ingest (reclassified) | **user** (context; nu acts) | **act** (hard-stop) | parts(raw) · payload{control} |
| `tool_use` | **model → assistant** | **assistant** *(live only)* | **act** — always: a gated call is answered too (§9) | parts(data:{name,input}) · payload{turn_id} |
| `tool_result` | nu · xi (a deferred outcome) | **user** *(live only)*; `deferred` ⇒ `[system]` text | think (barrier done) / await (open) | parts(data:{output,is_error?,cancelled?}) · payload{turn_id, ref_id→tool_use, deferred?} |
| `thinking` | **model → assistant** | **assistant** *(live turn only; dropped after)* | ignore | parts(data:{thinking,signature}) · payload{turn_id} |
| `permission_request` | xi, from inside the call | approver card; *n/a to model — the ANCHOR carries what waits* | ignore | parts(data:{tool,call,detail}) · payload{ref_id→tool_use} |
| `permission_response` | nu (auto) · xi (the principal's `/y`·`/n`, any surface) · the REPL | nu; *n/a to model* | act | parts(data:{behavior,scope,reason?}) · payload{ref_id→tool_use} |
| `summary` | nu (the checkpoint IS the turn, §5) | leading text block (§5) | **think** (it displaced one) | parts(text) · payload{covers} |
| `alarm` | main (boot) · task · timer (§10) | *(v0: a pure poke — not rendered; "a wake that informs" is the §10 open question)* | **think** | parts(payload) |
| `error` | nu | **system** + Stream | ignore | parts(data:{error}) |

- **mu emits 3**: `message` (say) + `tool_use` + `thinking`. Everything else is world + runtime.
- **Only inbound types: `message`, `control`.** Open-set holds: unknown → ignore, safe to add.

### Ingest is a classifier (deterministic, no model)

Every inbound passes through ingest, which does identity resolution **and** may reclassify:

| outcome | when | produces |
|---|---|---|
| pass through | ordinary text | `message` (+ resolved authorship) |
| `control` | reserved word from the agent's principal in self-talk | `control` + `payload.control` |

- Raw text always preserved (`parts` + `extra.raw`) — misclassification auditable/reversible.
- **Control vocab (v0)**: `stop`/`cancel`.
- **The verdict is not ingest's** (landed 2026-08-18): a gate is answered in **xi**, which
  already derives what the log owes and therefore already knows which cards are open. The
  principal's line passes through as an ordinary `message`, and xi reads
  `/{y,n} [conv|conn|all] [reason]` off it (`parseVerdict` — one syntax, every door) and
  publishes the structured `{behavior, scope, reason?}` + ref before it reads the verdict
  — so ONE invocation settles the gate and acts on it. The bare form settles the one
  call; a scope word makes it STANDING (§9): an allow/deny row remembered for that
  conversation, that connection, or the tool everywhere. That
  keeps every surface equal (the REPL's key handling is a shortcut, not the mechanism) and
  keeps the decision out of free text (Claude-Code discipline; its channels-relay does the
  same id-match). WHICH card an answer settles is the whole problem, and the rule is that
  they say so: a bare `/y` settles the ONE open card, and with several waiting they QUOTE
  the card they mean — a chat app's own reply mechanism, arriving as `ref_external_id`,
  resolved through the card's copy on that surface (`extra.via.event`). Guessing is not on
  the table: the wrong guess sends the wrong message under their name. A `/y` typed BEFORE
  a card settles nothing. A verdict that settles nothing is never silent — silence reads as
  a broken gate — but the one who says so is the HARNESS, on an `error` the mirror carries:
  it names the ambiguity ("N waiting, quote the one you mean") or the mistake ("that one was
  already answered") itself, rather than spending a model turn on plumbing. Once per line:
  the same latest line is re-read on every wake, and a line is spent once a verdict or a
  harness word followed it.
- **A gate never blocks the mind** (landed 2026-08-18). The ask happens *inside* the call:
  `act` publishes the `permission_request` AND answers the `tool_use` in the same batch,
  with `{status: pending_approval}`. So the chain closes, the model keeps its voice while
  the principal decides, and the failure that forced the old design away is gone — a turn
  taken with an unresolved `tool_use` RE-ISSUES it (live: a bare `/y` against two cards
  produced two more cards), which is why the gate used to have to mute everything.
  - **The verdict is a second, later call.** When it lands, xi runs the tool on the model's
    behalf. That outcome cannot be a `tool_result` block — its pair is spent — so it is a
    `tool_result` EVENT marked `payload.deferred`, which render narrates in the harness's
    voice (`[system] send(to: Vivian) → sent`) and the mirror carries to the principal
    who approved it. It collapses with the rest of the tool traffic at the boundary (§5).
  - **What is still waiting lives in the ANCHOR, not the transcript** (§5): a pending gate
    is state, not history — the transcript already closed those calls. The anchor is
    rewritten every turn, so an ask that gets answered simply stops being listed, and the
    model reads its own open business without anything having to be edited out of history.
    The empty case is stated, not left silent: this is the one anchor fact the model says to
    its principal in prose, and a block that only ever adds a claim can never contradict an
    invented one.
- **Policy is a table, not a branch** (§9): `Rule[] = [{tool, ask}]`, first match wins, `*`
  the catch-all. There are no special tools — `bash` runs unasked because the default table
  says so, not because bash is bash. The ask being *inside* execution is what lets a rule be
  conditional (arguments in hand), and the table is the home a standing verdict needs.
- **Scope is parked at `once`** — `/always` · `/never` (per conversation) is the next rung:
  `PermissionVerdict.scope` already carries `always`, and a standing verdict writes into
  that same rule table.
- A customer typing "stop"/"yes" is **not** reclassified (wrong author/context) — stays a
  `message` (e.g. "stop" = unsubscribe).

## 4. Identity, services & the loopback problem

**Email is a service, not a tool** — org email lives in the EventLog like any channel:
```
service: "email" · connection: "hi@org" | "matias@org" · conversation: {id: <thread-id>}
sender: {id: "customer@x.com"} · parts: [text, file(attachments)] · Gmail/IMAP adapter
```
Shared inbox (`hi@org`) = a `public` connection **every agent reads**; personal = that
principal's. Sending = `send` with `service: email`. One more service in the enum.
Shared-inbox coordination is left to **coexistence-yield** (an agent that sees another
already replied stays quiet) — observe whether they self-coordinate; patch (assignment/
ownership) only if double-answers show up.

- **Who a wire address IS — two homes (decided 2026-08-13)**: *declared* handles are
  registry columns (`agents.email` / `agents.phone`, mirrored from `config.jsonc`, §9) —
  the classifier's lookup is a column scan against the sender address. *Discovered*
  bindings ARE connections: a user grant is its own owned connection whose address
  carries the wire user (`<team>:<user>`, written by the connect flow from `auth.test`),
  so a sender matching the leg's own user IS the owner — the ownership edge and the
  handle binding are one row. Ingest's classifier (§3) reads both: principal → the
  mind-alias (the mirror copies it home, below); agent → echo/coexistence. With connections + credentials + the registry
  the machinery is complete — N principals on one workspace are N owned legs, nothing
  shared to fight over.
- **`conversation.kind` = `direct | group | channel | broadcast`** (landed 2026-08-05,
  column `conversation_kind`; broadcast added 2026-08-11 with the WhatsApp connector):
  *direct* = member-DEFINED identity (Slack im AND mpim — the member set is the address;
  local `dm:<sorted names>` makes that literal, and it scales to n parties unchanged);
  *group* = private room; *channel* = public room (room-defined: identity survives
  membership churn); *broadcast* = fan-out, not a room anyone is in (a WA broadcast list
  — replies land in the individual chats; open-bsp carries `…@broadcast` in production).
  Stamped by INGEST from platform facts (Slack conversation types, WA jid shape) — never
  derived from counting members. Parked idea: a "public direct" (members write, anyone
  reads) is a read/write asymmetry on MEMBERSHIP rows if ever wanted, not a fifth kind.
- **Echo-dedup (loopback)**: dispatcher records the platform id at send (`external_id`);
  inbound matching `(channel, external_id)` = echo → **merge**, never insert. Own-identity
  inbound *not* matching any dispatch = **coexistence** (the human typed from the shared
  account) → insert as `human`. Deterministic.
- **小-window** (the "small window"): between the dispatch API call and the `external_id`
  backfill landing, the platform's webhook can echo our own message back first. No holding,
  no pending-record (an earlier design): the echo simply INSERTs, and `setDelivery`'s
  transaction **absorbs** it — merges its payload/status into our row and drops it (§9).
  The log converges to one row per artifact either way; the wake the echo fired finds a
  quiescent window and no-ops.
- `sender` is the wire's fact, both fields: `address` — if we know it, we stamp it (the
  whatsmeow bridge knows its own number and says so; a Cloud-API-shaped service can't name
  its own side in the contact space, and only there absence remains) — and `name`, the
  service's display string (pushname), never a registry lookup of ours. Identity
  resolution (which grant binds a sender) is the classifier's business, not the
  envelope's.
- Principal↔own-agent conversations are **canonicalized across channels** via the alias
  bindings: one `local` conversation per principal (the mind), kept in sync with every
  bound surface by the mirror — copy in, CC out ("self-talk is special", below). Original
  wire in `extra.via`.
- **The log is the frontier (delivery identity is connector-internal).** Above the log an
  agent knows only *conversations and messages* — it addresses a conversation, never a
  token, a bot, or a transport. Below it, the connection owns credentials and delivery
  policy: *which* identity posts a given message (a bot token, the principal's user token)
  is the dispatcher's internal choice, invisible to the harness — the agent doesn't even
  know whether a "bot" exists on that service. Corollaries: onboarding/promotion of a
  connection inside a workspace is a *human* act (the admin shares a link), never a
  connector-orchestrated campaign; and anything the connector must tell the harness (a
  completed OAuth grant, a delivery failure) crosses the frontier the only legal way — as
  an **event published to the log**.

### Principal-DM bindings per platform

**Mind flows are user-scoped**: only a conversation whose counterpart can be NOBODY but
the principal binds as a mind surface — in practice, self-talk on an OWNED connection.
A shared/org account never hosts a mind, however well the sender classifies: other
humans stand behind a shared account (the secretary running the org WhatsApp would see
the mind's traffic, and could write into it as a third participant). Their DMs with the
org are world conversations the agent serves, not surfaces of its steering channel.

```
slack:  self-DM (agent posts via the principal's xoxp — true alter-ego in notes-to-self)
wa:     self-chat ("Message Yourself") on the principal's own paired number (whatsmeow)
teams:  later — the 1:1 bot chat is user-scoped but not self-talk: needs a binding door
email:  not a mind surface
cli/ui: native local conversations
        → all alias to the canonical local principal-DM (the agent's own DM)
```
- **The canonical principal-DM IS the mind session** (2026-08-04): `mind:<agent>` — the
  main session, the one with tools, where the agent is steered/controlled. The principal
  talks straight into it (the REPL does; platform DMs alias onto it at ingest via the rule
  below). There is no separate `home` conversation: `home = mind:<agent>`, and every other
  conversation is a peer conversation reached via connectors.
- **Self-talk is special, even across connections.** An envelope identified as the
  principal — a conversation whose counterpart IS the agent's principal (the WA self-chat,
  the Slack self-DM, the REPL) — maps **to and from the mind**, by COPY, never rewrite
  (an event with the right envelope must exist in the log for a dispatcher to carry it,
  and the wire original stays honest where it landed). The **mirror**
  (`connect/mirror.ts`, broker-side, one per org) holds both legs:
  - **fan-in**: an inbound on an alias conversation copies into `mind:<agent>` — the agent
    wakes on it exactly as on a REPL line (provenance in `extra.via`: origin event id +
    wire coordinates); in the agent's context every surface is the same **plain**
    user/assistant chat (§5 home mode — one voice, one thread, whatever surface the
    principal picked up).
  - **fan-out**: every mind event the REPL would show CCs to every alias binding except
    the origin surface (read off `extra.via`): the agent's voice as `[agent] …` (a
    self-conversation renders both speakers as the principal — the tag is the surface's
    only input/output distinction; the log needs none, authorship is the bit), the
    principal's own words as `[you via <surface>] …` (input replayed as output — fan-out
    over fan-in's own copy is what cross-syncs surfaces), tool calls as redacted
    one-liners under a tag of their own (`[agent tool] bash(git status)`). A CC is an ordinary
    outbound event on its service — the dispatchers post it, the platform echo merges into it (§4 echo-dedup).
    Fan-in guards that echo twice, because in an alias conversation an unmerged one reads
    as the principal speaking and cross-broadcasts to the other surfaces, which echo in
    turn: it settles briefly and re-reads, so an early echo the backfill absorbs copies
    nothing (the 小-window, one layer up); and since an inbound always carries the
    platform's id, a CC of the same words still holding NONE is that post returning
    unrecognized — the mirror stamps it, absorbing the echo the way the dispatcher would
    have, when a claim never lands (a crash between post and backfill, an API that
    returned no id).
  The alias conversation itself is **invisible to its own agent** (policy, §6): the
  copies are its face in the window — nothing to hide from the world render, and `send`
  can't reach it. **No backfill**: the mirror tails live — a surface connected
  mid-conversation starts mid-stream; only the REPL reads the log, so only the REPL has
  history. Per-service identification of the self-conversation (`aliases()`): **derived
  where platform structure gives it away, recorded where the id is opaque** — WA, the
  self-chat is addressed by the connection's own number, so an owned connection IS the
  binding, nothing stored; Slack, the self-DM channel is resolved once at
  connect (`conversations.open` on the granting user's own id) and recorded as
  `extra.self_conversation` on the **grant row**,
  beside the ownership edge that already names the principal — the same "who a wire
  address IS" semantics as the sender check; local, native.
  The agent must never treat its own principal as a peer/customer.
- **`send` exteriorizes the mind.** The one door from the mind to the world: `send`
  targets peer conversations only — the principal is never a send target, on any surface,
  because every principal-identified surface IS the mind and the voice reaches it by
  mirroring, not dispatch-by-address.

### Credentials per service

| | read as principal | speak as principal | plumbing |
|---|---|---|---|
| Slack | `xoxp` per agent | `xoxp` per agent | `xoxb` + `xapp`, one per org |
| Teams v0 | bot scope only | bot identity + agent signature | one bot registration |
| Teams later | Graph delegated per principal | Graph delegated per principal | same bot |
| WhatsApp | org number webhook | org number (agent = account owner) | Cloud API creds |

- Slack has no all-seeing token: **the dollhouse is the union of per-principal `xoxp`
  views** (one app, N OAuth grants) — the alter-ego permission model as infrastructure:
  an agent sees exactly what its principal sees.
- Org container holds one plumbing credential per service + one identity credential per
  agent; where identity creds don't exist yet (Teams v0), agents degrade to signed-bot mode.
- **WhatsApp pairing (whatsmeow, unofficial) — the connect walk-through** (2026-08-04):
  linking needs the companion device in hand — scan a QR, or type a pairing code into the
  phone. *Local*: the dev pairs (device in hand, or relaying for the principal) and
  declares the connection the org's or owned (`mu connect whatsapp [--agent <name>]`); the
  session keys land in the vault (`whatsapp × <number> × owner` — the blob's `session`
  field). *Docker*: credentials ride the DATA VOLUME, never the image (layers leak,
  registries cache); further pairing happens remotely through the agent itself — no
  dedicated UI: the pairing CODE is 8 chars of text and flows through the mind
  conversation; a QR renders in-terminal over SSH. Prefer the code flow remotely.

### The credential model (owner × consumer)

Credentials factor along two orthogonal axes, not one list:

- **Owner / scope** — **org · principal · agent** (whose credential it is / who grants it).
- **Consumer** — **connection · tool** (a channel's ingest/dispatch vs an exec-plane call).

The 3×2 grid, each cell real and distinct:

| | connection | tool |
|---|---|---|
| **org** | org's Slack app / GitHub App install — shared ingress for all agents | company-wide API key (shared search, Jira, a pooled LLM key) |
| **principal** | principal's own channel identity — agent acts **as** them (OAuth) | principal's OAuth to a SaaS used on their behalf (Drive, GitHub-as-user, calendar) |
| **agent** | agent's own bot identity, distinct from any human | agent's own service creds (its DB, its keys) |

- **Identity vs capability.** Principal creds are mostly *identity* (act **as** — attributable,
  hence OAuth: delegated, scoped, revocable, consented). Org/agent creds are mostly
  *capability* (access **to** — attribution matters less). The cut tells you which cells need
  real delegation machinery.
- **Two broker tables: `connections` and `credentials`** (decided 2026-08-04; the
  resource shape settled 2026-08-14). A *connection* is a GRANT the org vouches for:
  `(service, address, agent_id?, credential_key?, extra?)`. **Ownership is the privacy
  switch**: `agent_id` present ⇒ the owner's private account view; absent AND
  org-credentialed (`credential_key` — a bot, an org session) ⇒ the org's shared inbox,
  because that account itself reads as the org; absent WITHOUT a credential ⇒ a
  registration STUB — the gate's admission for a workspace whose only tokens are
  personal, visibility by membership alone (the acl table refines sharedness later;
  until then the row is the config). `credential_key` points at the grant's secret in the vault; `extra` holds
  what the connect flow discovers about the account (the Slack self-DM channel). Two
  teeth make the row load-bearing: **registration gates the log** — publish refuses any
  non-`local` event whose connection has no live row (an unknown account leaks to no
  one, and its events don't even land) — and **deletion is soft** (`deleted_at`),
  closing the GATE only: a cut grant stops ingesting, but identity and visibility over
  the history it already ingested persist — a revocation never empties a running
  session's window. A re-grant upsert REVIVES it, ownership intact. Conversations anchor to a connection
  (`envelope.connection_address`). A *membership* row (open-bsp's
  `conversations_agents`, address-keyed) enrolls an agent in one conversation — the
  Slack-shaped grain, and the local team-chat substrate. A membership is a LIFETIME:
  a live row grants the conversation whole; a channel leave stamps `deleted_at`, and
  the stamped row keeps granting events up to the stamp — the agent keeps what it has
  seen, never the conversation's future (reads and writes alike). A rejoin revives:
  the conversation whole again, Slack's own join-shows-history rule.
  **Slack: a workspace runs in ONE mode, and every row is a grant.** Operating
  assumption (2026-08-15): bot installed ⇒ no personal user grants; personal grants ⇒
  no bot. ORG mode: the bot's own row `<team>:<bot user>` (ownerless +
  `credential_key: slack:<team>:org` ⇒ the shared inbox, §6) anchors every delivery —
  `is_bot` in `authorizations` names it per event, no bot-location tracking. PERSONAL
  mode: deliveries anchor the bare `<team>` row — a registration STUB (gate admission,
  membership-only), because a delivery is authorized for MANY human grants and no
  single user address can be an event's connection; visibility rides the memberships
  the deliveries themselves enroll (and each connect flow enrolls its principal in the
  grant-note conversation, so the note reaches them). Human grant rows
  (`<team>:<user>`, owned) are the identity/credential map: a sender classifies by
  point lookup of ITS grant row (→ registry name), and credentials hang off grants
  (`credential_key`: `slack:<team>:<owner>` / `slack:<team>:org` by the connector's
  own convention — dispatch resolves author's grant → team bot → env from exactly the
  envelope's anchor + author). The assumption is about reality, NOT enforced in
  code: ingest derives the anchor per delivery either way, so a workspace that breaks
  the assumption still maps gracefully (bot-witnessed → the bot's row, personal-only →
  the stub) — and the ingredient survives verbatim in `extra.slack.authorizations`.
  *Credentials* is **the vault**: a key:value store in log.db (one substrate; its OWN
  accessor, so a policy-scoped log never carries credential capability into the agent
  plane) — `(key, value, agent_id?, extra)`, `value` the service-shaped secret blob
  (`{token, app_token}`, `{client_id, client_secret}`, `{api_key}`); it serves
  connections AND tools (a tool config's `credential_key` points into the same vault).
  `put` MERGES `value`/`extra` fields: each door writes the field it holds and never
  clobbers a sibling's. Broker-side by construction: on Postgres, RLS deny-all (the
  agent's substrate tool IS SQL-with-RLS, so co-residence is safe); on SQLite the agent
  has **no SQL client at all** — it reaches the store only through xi's tools, and in
  Docker the files are broker-owned.
  Connecting is **interactive, dev-shaped** — `gh login` / `claude login` is the pattern
  devs expect (Claude-Code MCP logins likewise): a `mu connect <service>` flow writes the
  connection row + vault rows; the same flow is later steerable through the agent (§8
  conversational setup), since the REPL into the mind is already the operator console.
  **The paste door (landed 2026-08-12, `connect/slack_connect.ts`)**: the dashboard's
  "Install to Workspace" button IS an OAuth flow with Slack hosting the redirect, so a
  dev self-serves tokens with zero public surface — the CLI prints the manifest prefill
  link (app creation and app-level tokens have no public API; the link is the automation
  ceiling), the dev pastes the token, and `auth.test` resolves the workspace (a token
  string never identifies one) before the SAME map writes as the hosted door — bound to
  the real registry name. Two doors, one map: paste = local/dev tier, hosted oauth = org
  tier (a shared link, N principals) — mirroring ingest's socket-vs-HTTP split. Facts
  that shaped it: one app × workspace = ONE bot (reinstall rotates the token, never a
  second bot; more bots ⇒ more apps — per-agent apps named after the agent), multiple
  apps coexist under ONE anchor row (per-bot identity lives in the vault, and the
  membership mirror scopes each bot's visibility with no flags); sockets are per-app
  (xapp is app-scoped, N apps = N carriers into the same handler; the same message
  arriving on two sockets merges by `external_id` — the merge key is TEAM-scoped while
  each copy anchors and enrolls its OWN leg first; which leg the merged row keeps, and
  cross-leg visibility of that one row, is the per-surface-delivery-rows open, PROJECT
  6). Each leg is asked for separately (a bot is a deliberate act, not a
  default), and a leg is only readable once **granted** — a carrier token reads nothing.
  (Slack's own install quirks live in PROJECT 5.5, not here.)
  **The grant WRITES the map** (landed 2026-08-06): both doors write the granted LEG —
  an owned connection row plus its one credential (paste: the dev's `<team>:<user>`;
  oauth: the bot anchor when the install grants it, and each consenting principal's own
  leg) — setup is what populates the map, and `deno task status` prints it (vault keys
  and blob field names only, secrets never print). **Use the platform's own types** (the open-bsp lesson: hand-rolled
  API shapes encode assumptions the API never promised — adopting official types surfaced
  real bugs there): oauth types against `@slack/web-api`'s `OauthV2AccessResponse`;
  ingest reads the `@slack/types` `SlackEvent` union and dispatch parses
  `ChatPostMessageResponse` (only the Events API *wrapper* stays hand-rolled — Slack
  ships no type for it; it's Bolt's, not the platform package's).
- **The wire fills the map (landed 2026-08-12 — the Slack messaging half).** Ingest is
  the classifier §3 promised *and* the membership mirror: `channel_type` stamps
  `conversation.kind` (im/mpim → direct); the wire id stays honest in `sender.address`
  and `sender.name` carries nothing of ours (Slack's events send no display name —
  identity resolution is the classifier's, not the envelope's); `member_joined_channel`/
  `member_left_channel` move membership rows when the mover is the leg's own user — a
  leave stamps the membership's `deleted_at` (the lifetime ends; seen history stays
  visible, §6) — and every delivery on an owned leg passively
  enrolls it (the delivery itself proves the leg's user sees the conversation), so
  ordinary traffic converges the map. Dispatch's
  token resolver is per-author now: the author's principal xoxp when the vault holds
  one (the alter-ego leg), else the org bot — unchanged frontier: the agent never
  knows which. (Implementation status of the mind-alias: PROJECT item 6.)
- **"Lends" ≠ copies the token.** The principal grants a **scoped, revocable OAuth
  credential** held by the **broker** (the §8 credential table on DB, a sidecar on files);
  the agent gets a **capability, not the raw secret** — it never enters the exec context.
  OAuth is exactly "delegate access without the password, with scopes + revocation."
- **Cardinality sets the authority ceiling.** 1 principal → can act **as** them (the duality).
  **0 principals** (autonomous/service agent) → bounded to org+self creds, **cannot act as
  anyone** — a hard blast-radius limit. n principals (rare) → forces **per-principal
  isolation** (no shared context holding all tokens; select per action; no cross-principal use).
- **Existence ≠ selection — a resolver.** When an action needs a credential, a **policy**
  picks which identity applies, keyed by (action/resource, available scopes, desired
  attribution). The design work is the resolver, not the store.
- **The two consumers sit on opposite sides of the security boundary.** **Connection** creds
  are consumed by the connection *process* — broker-side by construction, the agent never
  touches them (safe by default). **Tool** creds are consumed *inside the agent's turn* — the
  execution context, where a generic `bash` sees everything (§9). So "hide it from the agent"
  is entirely the **tool column**, where broker / egress-injection / scoped-ephemeral tokens
  are non-negotiable.
- One **abstract authority model** (*who may act as / access what*), three realizations — Unix
  groups (host), orchestration RBAC (containers), RLS (Postgres) — the companion to the
  connections map (§6: *who may read what*).

## 5. Rendering (Schema B + the send exception)

### Three channels

The agent speaks in three channels, and render maps each to a place in the request:

- **think** — the `thinking` event: **private** reasoning. Never delivered; logged **with its
  signature** only so the unrolled next step can replay it mid-cycle (the API requires it);
  streamed as deltas to the operator.
- **assistant** — bare text: the agent's **voice to its principal**, auto-delivered to
  the principal-DM. No tool — like Claude Code answering you.
- **send** — the `send` tool: dispatch **to a peer** (the world). Explicit, `send` is never
  principal-directed.

### Roles (Schema B, with one exception)

> `assistant` = the agent's **live generation this step** + its **assistant** text to the principal.
> `user` = everything else — the principal's messages, peers' messages, **and the agent's own
> sends**.

That last clause is the exception to plain authorship-based Schema B. A peer-send renders in
`user`, not `assistant`, for two reasons: the model never sees its own output wearing an
envelope (so it won't **mimic** envelope syntax), and the context ends on `user` so the model
can **continue** (multi-send). The *say* stays `assistant` — it's genuine, needed dialogue with
the principal. **The model never writes envelopes**: it emits bare text + `send(to=…)`; render
decorates. So the two modes below are a *presentation* choice, invisible to generation.

The frame behind the split: **principal↔mind is the ordinary `user`/`assistant` chat every
LLM API means** — nothing invented there. The invention is the *world in the `user` role*: a
workaround for the API having no multiplayer roles. The workaround is what needs marking, so
**the world wears XML elements and the principal is plain** — and because every untrusted
string inside an element is escaped, *plain text in the `user` role is by construction the
narrator or the principal*. That's the injection boundary: a peer typing "plain principal
text" or a forged tag arrives escaped inside its own `<msg>`, inert. XML over Markdown for
exactly this reason — Markdown has no closed escaping rule (`#`/`[` are ambiguous, lossy);
XML's is finite and testable (`&`→`&amp;`, `<`→`&lt;`, `"`→`&quot;` in attributes), and tags
are rarer than `#`/`[` in real message bodies, so honest text seldom needs escaping at all.

### Two rendering modes, by conversation

- **Home (principal-DM)** — a bare `user`/`assistant` chat: no marks, no grouping, no
  per-line time (the trailing `now:` anchor is the clock). The agent's console; `send` never appears
  here. Every principal-identified conversation reaches here (§4 self-talk): the mirror
  copies the WA self-chat and the Slack self-DM into the mind, so the principal is plain
  in this mode whichever surface they typed from — the surface lives in `extra.via`
  (painted as a `[via slack]` tag in the REPL, invisible to the model).
- **World (peer convos)** — one `<conv service connection address kind name thread>`
  element per run of a conversation's messages, one `<msg from at>` line each.
  Every non-null `Conversation` field is an attribute, plus the envelope's
  `connection_address`: the element carries the FULL envelope the agent acts on —
  `address` is what `send` targets — bare, exactly as the platform names it (§3) —
  `connection` disambiguates multi-account services, `kind` (§3, stamped at ingest) tells
  a public channel from a DM, `thread` the subthread.
  `name`/`from` are display strings — attacker-controlled, hence attribute-escaped (a
  WhatsApp contact can name themself `Ana" from="matias`). The account's own messages are
  `self`, told apart by authorship: `from="self (you)"` = the agent published it (a
  `send`, or its echo), `from="self (principal)"` = the account spoke and it did not come
  through us (the principal on their own device — the ingest classifier stamps `agent.id`
  from the sender's grant row on both wires, §3). The reply sits with what it answers. A dead delivery carries
  `status="failed"`; wire mentions ride a `mentions=` attribute. **Two elements, the
  deviation marked** (§3): `<msg>` carries text — `action="edit"` renders the new
  content, `action="delete"` the removed content; `<react>` carries the glyph —
  `action="remove"` = un-react. Bare defaults: create and add wear no attribute.
  **References**: every `<msg>` wears an `id`, and a line that answers, reacts to, edits or
  deletes another points at it with `re` — one handle, read and write, since `send` takes
  the same string back (§9). It is derived from the event id, so it names the same message
  in every render; `re="?"` says the referent is outside this window, and only then does a
  delete spell out what it removed. A `<react>` spends no id: nothing can point at one.
  Stamps format
  through the org's timezone (org config; stored ts is UTC, §3). Clustering: inbound runs
  are ts-sorted, then partitioned per conversation in first-arrival order —
  cross-conversation interleaving is arrival noise, not meaning; within a conversation,
  event time stands.
- **Open — XML for the principal too, when "multiplayer" arrives.** Plain-principal works
  because the mind has ONE untagged voice. Multiple principals talking to one mind (the
  real meaning of "multiplayer AI") breaks that: two plain voices are indistinguishable,
  so the principal grows a mark (`<principal name>` or similar) the moment there are two —
  and at that point the escaping invariant shifts from "plain text = narrator or
  principal" to "plain text = narrator". Not built: v0 is one principal per agent, and the
  N:M principals↔agents backlog item (§13) is where this lands.
- **Open — the address book (outgoing first contact).** Everything above serves incoming
  traffic and replies: the model learns addresses from `address=` attributes, and `search`
  recovers off-window ones. What no surface provides is an address the log has never
  seen — initiating (DM a colleague first, post to a channel the agent was never in) has
  no directory: connections/memberships are not rendered, no list tool exists, and the
  model cannot mint platform addresses. Outgoing matters as much as incoming; what the
  directory surface is — a rendered index, a tool over the map tables, a connector
  lookup — is the open.

### Trailing vs closed (no turns anywhere — derived, not tracked)

There are **no turns**: nu processes whatever is available and holds no turn state; every step
is a fresh `xi → nu → mu` over one flat log window. "Turn" survives only as an API formatting
constraint, and render derives it **from the window's shape**:

- **Event time wins for the world** — inbound messages render in **`ts`** order, not append
  order: `ts` is real-world event time, `id` is only where the store put it (§3), and a lagged
  webhook or a backfill appends 14:02 after 14:05. Then the run partitions per conversation
  (first-arrival order) so each room renders as one element. Scoped to contiguous runs of
  world-authored messages, so it never reorders the machine (tool cycles, thinking, the weld)
  and never rewrites history — a straggler arriving after the agent already answered stays
  put, because the answer breaks the run.
- **Boundary** — the last self-authored *home* message whose step (`payload.turn_id`, stamped
  by nu) emitted no `tool_use`: a closing assistant text. Everything before it is **closed**.
- **Trailing chain** (after the boundary) is **welded API-faithfully** — `thinking` (replayed
  verbatim, with signature) + text + `tool_use`/`tool_result` pairs (per-use `ref_id` linkage).
  A directed send dispatched by a welded `tool_use` is **skipped** (its content is in the block);
  once its group falls behind the boundary, the pair drops and the *message* renders — same
  event, two ages, zero bookkeeping.
- **Closed events collapse** — a `send` → its `from="self"` world line; tool pairs
  **dropped** uniformly (a failed tool renders as any failed tool — errored result while
  trailing, gone when closed); `thinking` **dropped**. The trace that *persists* is the
  message's own **delivery status**: a permanent dispatch failure (the platform refused, or
  the post threw — nothing retries) stamps `envelope.status = failed` via `setDelivery`,
  and the line renders `status="failed"` in both regions — the agent's only way to know a
  queued send never arrived. The log stays lossless for the rest (`search` re-fetches
  denied/errored exchanges).
- The log stays **lossless**; `search` re-fetches what render drops. Crashproof for free:
  recovery re-renders the same window and gets the same request.
- Three regions: **trailing** (faithful) · **recent** (collapsed) · **distant** (`summary`
  events + top-level `system`).
- **The boundary is also the cache breakpoint** — a closed event collapses once and then
  renders identically forever, and the boundary only moves forward, so everything up to it is
  a stable prefix (all volatility — `now`, ambient env, inlined media — sits after it by
  construction). Marking it makes the history a cache **read** (0.1× input) with only the
  turn's delta written. That is what makes the tool loop affordable: every tool round-trip
  re-sends this same prefix, seconds apart. A `<conv>` element never spans the boundary —
  trailing messages joining it would rewrite the prefix's last block. It caches for an
  **hour**: the window's floor is anchored (§2), so this prefix outlives the idle gaps
  between an agent's wakes, and it is the expensive block — a 2× write buys 0.1× reads
  across them. The within-turn breakpoint (the growing tool chain) keeps the default five
  minutes, which already outlives any chain.

### Media (the same collapse pattern, applied to bytes)

`FilePart.uri` is a real URI, and the SCHEME is the whole distinction: `file://` = local
bytes (the canonical form; bare paths tolerated on input), `http(s)://` = an external
link, passed through untouched — never downloaded nor uploaded broker-side (`size` is
unknowable there, hence nullable). Inbound uris are always local — ingest downloads
BROKER-side with the connection's credential into the conversation's media shelf
(`conversations/<safe(address)>/media/<content-hash>.<ext>`, §8 — content-named, so
re-downloads and the dispatch echo converge on one file; platform URL + token never
cross the frontier, §9). Outbound uris are local or public: `send` takes
`files: string[]` — paths statted broker-side, links kept as-is (no secret in a public
URL, the frontier rule is untouched).

A `FilePart` renders as a `<media kind name path/>` marker in EVERY region — the durable
handle (local: the plain path, re-viewable via `aread`/bash; external: the url). In the
TRAILING region only, inlineable files (images, PDFs) additionally render as REAL API
blocks after their element — local bytes as base64, external links as url-source blocks
(the API fetches those itself) — the model sees the picture while it's current, the
marker once it's history. Two caps keep the base64 sane: per-file (3MB raw) and a
per-request budget (12MB raw, NEWEST first; url blocks are budget-free) — a long session
full of images carries only its trailing burst as bytes, and each closing collapses them
back to markers (requests get LIGHTER after an answer, like tool pairs).

Dispatch is per-connector capability: Slack uploads local files via the `files.uploadV2`
flow with the text as the share comment, and external links join the text as lines
(Slack's own idiom — the client unfurls them); WhatsApp (future) passes links natively.

**Audio becomes text by PROCESSOR** (the Messages API has no audio input, and a voice
note's words belong in the log — durable, searchable, cheap). A processor is a broker-side
log listener like the mirror (`connect/transcribe.ts`, composed by main): connector-neutral
— by the time audio is an event, its origin doesn't matter — and its model is a SHELL
COMMAND from the org catalog (`processors.audio`: bytes on stdin → text on stdout), so the
implementation is swappable without touching the harness; the repo ships
`processors/qwen-asr/` (local Qwen3-ASR, CPU) as one. The transcript is an `action: "add"`
event — a `transcript` text part added to the audio message, `ref_external_id` pointing at
it — so the original row stays sealed, past WUMs stay invariant (§3), and the words render
as a later `<transcript re=…>` line whose wake IS the feature: the agent reads the note
when its words arrive (the instructions say to wait for them). Sender-less and agent-less
(the harness derived it — which is exactly what keeps it off dispatch's outbound predicate
and out of the mirror's absorb guard), `external_id = transcript:<audio external_id>` (the
upsert makes one audio message exactly one transcript), and a `<hash>.txt` sidecar beside
the media file caches the work — the same bytes forwarded again publish from the cache.
Serial, one note at a time: transcription is CPU-bound and a burst of forwarded notes is
exactly when N model trees must not race each other; concurrency becomes a `processors`
knob if a GPU box ever runs it.

Tool results carry attachments the same way (the model-initiated half of the loop —
Claude Code's Read pattern): `aread` on a bytes file (image/audio/video/PDF) prints a
`[media …]` line plus a `MEDIA_MARK` sentinel; bash peels the mark (the CWD_MARK
pattern) into an `ExecOutcome {output, files}`, xi stamps the paths onto the
tool_result event as FileParts — GENERIC in the log — and render (the Anthropic-shaped
transform) inlines them INSIDE the tool_result content as image/document blocks (the
API allows text · image · document · search_result blocks there), under the same
newest-first budget. So the harness shows what's current, and the model pulls anything
from history back by its marker path. Switching providers touches render, never the
events.

### Batch order (observed before optimized)

Within a batch, render keeps **chronological order** — no priority reordering. Steering
priority is won at *scheduling* (steering is never delayed, §2), not by rewriting the timeline.
*Noted for later:* models weight the **end** of context most, so if principal messages prove
to get lost in busy batches, the fix is ordering groups by class with the **home group last**
(nearest generation) — not first. Observe the model's behavior before reaching for this.

### The system prompt (cacheable prefix)

Built by render from `docs.list()` (§8): **instructions** = the bodies of `load:always` docs
(system → org → agent), inlined; **skill / memory index** = pointers (name + description) for
the rest, which the agent pulls via `aread` on demand; **cron / projections** = always-on.
Ordered most-stable → most-volatile, with a cache breakpoint at the end — the first of the
two the request carries; the second closes the collapsed history (above). An hour's TTL,
not the default five minutes: docs change when a human edits one, so an agent that wakes
every twenty minutes was paying to re-write this block on every wake.

### Inline system blocks (the narrator)

The system *block* (`MidConversationSystemBlockParam`) exists, but the API constrains it
**positionally: trailing block(s) of a turn only** (live-smoke finding, 2026-07-20) — a
prefix or interior `mid_conv_system` block is a 400. Its documented purpose is the pair we
want anyway: **cache** (it sits *after* the cached history, so volatile system-ish content
invalidates nothing) and **authority** (the non-spoofable operator channel — unlike
`<system-reminder>` text a peer could forge). So the narrator splits by position:

- **time** — every `<msg>` line carries its own absolute stamp (`at="12 Aug 9:50"`), so
  there are NO separator blocks: separators were cross-message state measured in render
  order (not a timeline after the per-conversation partition) and they broke `<conv>`
  clustering. One fact per line. **`[system] error:` markers** are plain text likewise:
  they precede what they mark, so they can't be (trailing-only) system blocks.
- **summaries** — `summary` events aging out distant messages; rendered as the window's
  LEADING plain-text block (the trailing-only rule bars a leading system block). See
  "Compaction" below.
- **`now:` anchor + ambient env + open state** — the trailing system block before the model
  answers. Carries `now: <ts>`, whatever is **still open** (`waiting on your principal — 2
  approvals:` and one line per ask, §9 — pending state, not history: the transcript already
  closed those calls, so the only honest place for them is the block that is rewritten every
  turn), plus **live environment lines** the exec plane composes (`cwd: …` ·
  `git: <branch> · N uncommitted` when the cwd is a repo · `background jobs (N): <cmd>
  (pid P, age)` each). Better than Claude Code's session-start env snapshot: we re-render
  every step, so it's *fresh*, not stale — and cache-free, since this block is already the
  only volatile one. Self-scoping: git appears only in a repo, jobs only when some run — so
  a conversational delegate sees a clean `cwd`+`now`, a coding/task agent sees the full set.
  The background-jobs line is also the agent's **handle** on what it left running: each job
  carries its **pid** (`kill <pid>` the leader, `kill -<pid>` the tree) — a kill handle the
  agent otherwise lacks, since every command runs in a fresh shell so bash job control
  (`jobs`/`fg`/`%1`) can't reach a job from a prior call. The `Job` keeps the *full* command
  (a UI/control-client shows it whole); the line clips it. This is the passive-visibility
  half; the active half — a job-exit **event** published into the log to *wake* the agent
  on completion (Claude Code's completion callback, done the mu way: the log is the
  continuation engine, so an exit event just pokes) — rides the §10 clock (pairs with the
  reaping registry, §9). **Deployment-specific** (the env note): composed by the
  exec plane, so on **Docker** it's the one persistent container env; on **Postgres+edge**
  there is no persistent bash env (functions are remote and ephemeral, possibly several),
  so the ambient lines are absent — `ports.ambient` is simply unset there.
- **Future (with compaction/memories):** split the docs cascade by volatility — stable
  identity/instructions stay in top-level `system` under the cache breakpoint; the
  volatile tail (memory index, mode flags) moves into the trailing system block, so a
  memory write never invalidates the system cache.

### Compaction (v0 — the checkpoint layer; from the pi / Agent-SDK study)

Two layers, one of which we already had: **pruning** is render's closed-region collapse
(tool pairs + thinking drop continuously — Claude Code's `clear_tool_uses` for free), so
compaction proper is only pi's **checkpoint layer**:

- **The `summary` event** = pi's `CompactionEntry` in log clothes: agent-authored,
  `payload.covers: [fromId, toId]`, appended like everything else. The log stays append-only;
  compaction is just another event.
- **Trigger — nu, and the checkpoint IS the turn.** nu is the layer that formats the
  window, so nu is the one that knows what the turn will weigh: when the **visible**
  (summary-applied) window exceeds `compactAt` (default 50K est. tokens, chars/4 over the
  RAW events — roughly 1.8x the prompt they render to, since the estimate counts ids,
  envelopes and the tool traffic the closed region drops; our checkpoint is non-destructive,
  the log keeps everything and `search` reads it back), the turn nu produces is not a think
  but **the checkpoint itself** — one bare model call (no tools) over the closed region,
  keeping the most recent `keepRecent` (~20K) uncovered. The summary commits as the batch
  (publishAndRelease), and **its own insert wakes the think it displaced** — the log as
  continuation engine, applied to maintenance. This keeps the invariant *one invocation =
  at most one model call* (edge wall-clocks), and it is why `summary` is the one
  self-authored non-message that passes `relevant` (§2). `decide` needs no compact arm:
  the displaced work is still owed, so the follow-up derivation says think all by itself —
  and a future user-*commanded* compact needs nothing either (nothing owed after it ⇒
  quiescence; a `meta` marker can distinguish the two if it ever matters). Measuring the
  VISIBLE window matters: the raw window stays heavy after a checkpoint (the read is
  windowLimit-capped), so a raw estimate would re-fire on the next invocation — a
  compact-forever livelock. Only CLOSED events are ever covered — the derived boundary
  gives us pi's never-cut-a-tool-result rule structurally.
- **The prompt is a DOC** — `system/instructions/compaction.md` (seeded, lazy): readable and
  editable like any instruction, never hidden in code (the embedded constant is only the
  fallback for unseeded stores). One unified instruction covers first-checkpoint and fold
  (it branches on `<previous-summary>` itself, so the code doesn't).
- **Prompt shape** = pi's structured checkpoint, adapted from task-scoped to conversational:
  ongoing threads · constraints & preferences · commitments · key facts & decisions ·
  critical context (exact names/ids/figures preserved). **Iterative merge**: a later
  compaction folds the previous summary in (`<previous-summary>` + new span → merged);
  `covers` chains from the previous summary's start, so survivors get re-covered (pi's
  rule).
- **Render**: drop everything with `id ≤ covers[1]` of the latest summary (superseded
  summaries fall in that range too); the summary body renders as the leading text block.
- **Later**: xi's window read starts at the latest summary instead of `windowLimit` (the
  cap becomes a fallback); the API's server-side compaction block (beta) could ride
  inside a summary event if we ever want it — noted, not planned.

### render is pure

`render({ events, docs, session, home, now }) → { system, messages }`. No I/O — nu resolves the
log window, docs, and tool set and feeds them. Output uses `@anthropic-ai/sdk` message /
content-block / system-block types, so it feeds `mu` untranslated.

## 6. Contexts

- **The conversation** = an envelope filter over the flat log (wire + internal events
  interleave; `visibility` keeps internals off the wire). `send` targets a conversation.
- **Logical views** = read-only queries over the log ("today's refund mentions"), pulled
  via `search`, permission-scoped (the cross-peer visibility surface).
- Slack: a channel renders threads as collapsed heads; a thread is its own conversation.
  (The agent wakes on everything it can read; no per-conversation wake-rule — §2.)

### `search` (the read half of `send`) — Slack-search semantics

`send` writes to `(service, connection, conversation)`; **`search` reads by the same
coordinates + text + time + sender** (Slack search: `in:`/`from:`/`before:` + FTS).
Returns **raw events, type-filtered** (messages; never tool/permission noise).

- **Push-default / pull-escape**: nu pushes the agent its recent window at buildContext;
  `search` is the escape hatch to reach beyond — older history, other *public*
  conversations, cross-conversation lookup.
- **Filters are exact, over addresses; a NAME is how you find one.** The model points with
  the handle it was shown, and what a render shows is a name — so `in`/`from` accept either
  and resolve a name against the names rows carry (`sender_name` / `conversation_name`,
  denormalized at ingest: a DM is named by its peer, a group by its subject). Results hand
  the `address` back, which is what `in` and `send(to:)` take. Ambiguity splits by
  direction, the same rule as `re`: a **read widens** across namesakes (two Anas cost a
  longer result), a **write refuses** (irreversible, so the model re-reads). A name nobody
  wears is an error, never an empty result — "I don't know who that is" and "they never
  said that" are different answers.
- **The connections map v0** (landed 2026-08-05): `policyFor(agent, map)` derives the
  §6 Policy from the two tables — THE three-branch predicate, one boolean for readable
  and writable alike:
  `member(service, connection, conversation, agent, ts)` (branch 3: Slack channel/DM ·
  local team chat · **the mind is a one-member conversation** — its privacy is plain
  membership, no special case; the registry seeds `(local, agent, mind:<name>, <name>)`;
  the event's `ts` rides in so a LEFT membership keeps granting what the agent has
  seen, §4)
  ∨ connection ownerless AND org-credentialed (branch 1: the org's — the bot/org
  account IS the shared inbox) ∨ `connection.agent_id → agent` (branch 2: owned ⇒
  private) — all under one guard: an agent's own **mind-alias conversation is invisible
  to it** (§4 self-talk: the mirror's copies are its face in the window; the same
  predicate on the write side is what keeps the principal out of `send`'s reach).
  **Ownership is the privacy switch**; an ownerless row WITHOUT an org
  credential is a registration stub — like no row at all (the local service),
  membership is the only door; a soft-deleted grant KEEPS its visibility (revocation
  closes the publish gate, never a session's window) — and the write side is harder
  still: publish REFUSES any non-local event whose connection isn't registered live
  (§4, the gate). The lookups **read
  through** prepared statements — live like the Postgres RLS join they emulate: a
  mid-run bind is visible on the next event, no reload, no restart. Applied to folder-declared agents;
  explicit `principals` (tests, task mode) stay allow-all unless they pass their own.
  **Local is a team chat**: a local conversation is visible iff you're a member; `send`
  to a peer agent's NAME canonicalizes to `dm:<sorted pair>` and enrolls both ends
  (the Slack membership mirror, landed 2026-08-12, fills the same rows from the wire —
  §4 "the wire fills the map").
- **Privacy = a property of the conversation**: `public` (org-readable) | `private`
  (participants + owning agent). Slack native (public channel / DM); WhatsApp by
  **connection ownership** (ownerless org inbox = public; personal book = private);
  **principal-DM always private**. `search` returns all `public` + `private` where the
  agent participates — enforced as an **RLS predicate**, the cross-peer visibility guard.
- Agent-role log RLS: **SELECT + INSERT, no UPDATE/DELETE** (readable & appendable, not
  editable; edits/status-backfills via elevated RPC).
- **The seam exists in code** (`policy.ts`): `scoped(log, {readable, writable})` — each
  boolean predicate applied where Postgres would (USING before LIMIT · WITH CHECK
  all-or-nothing · filtered delivery). Both default allow-all until the **connections map**
  defines how they're computed; main lifts them off the principal entry, so xi never sees
  policy — locally the scope is a wrapper, on Postgres a credential.
- Dedicated control tools reduce to **`send` + `search`**; everything else is substrate
  CRUD (docs, timers via SQL/RLS) or runtime-owned.

## 7. The unified session (v0 — subagents deferred)

- **One long-running session per agent** = the **principal-DM + all its peer
  conversations**, cross-labeled by envelope. This is cabra-bot, event-driven and
  multi-channel: *one coherent mind* with general workspace knowledge **and** in-context
  answers — a human-like alter-ego, which is *philosophically* the point (one mind per
  principal, not a fragmented tree).
- No tree, no spawn, no inter-session message-passing. The agent handles all its
  conversations in one context and replies via `send(→envelope)`.
- **Reactive + coalesced, no cursor.** The event log *is* the queue; every readable event
  pokes an xi invocation, coalescing (the turn lock + the closing message's self-poke) →
  one turn per burst. Responsive on arrival, batched when busy — better than cabra-bot's
  fixed 5-min poll.
- **No processing cursor** (we're push-based, not polling — cabra-bot needed
  `last_checked_ts` only to *fetch* from Slack). **Context = a bounded query**: the agent's
  relevant envelopes, from the last `summary` forward, up to a limit — the model responds
  to whatever's **unanswered** in that window (a peer message with no agent send after it).
  Scheduling state per agent is **the turn lock alone**; pending work, barriers, and gates
  are log queries. **Recovery re-derives** everything (the boot alarm + the steal-sweep);
  re-processing an ignored message is cheap/idempotent. `session_id ≈ agent id` in v0.
- **Internal events anchor to a per-agent `local` scratchpad** (the agent's "mind") —
  `thinking`/`tool_use`/`tool_result` have no single peer conversation when the agent
  reasons across many. The agent's assistant text anchors to the principal-DM; peer messages to
  their conversations; sends to their targets; render interleaves all into one chronological
  feed (home bare, world labeled — §5).
- **Agent memory dropped**: the long-running session **is** the memory. Only org memory
  (shared) and conversation working-state (optional projection) remain (§8).
- **Oversight & control are trivial** (one context; the principal reads and steers
  directly). Undirected `stop` cancels the agent's in-flight work. Coexistence = the model
  yields when it sees the principal reply; explicit per-conversation takeover is deferred (§10).
- **The limit + the deferral signal**: context capacity — one session holds all
  conversations, so it **dilutes at high volume**. Add subagents (the deferred tree) when
  compaction can't keep active conversations in useful detail. Until then, unified is
  simpler and truer to the concept.

### The principal's view is a projection (not the model's context)

The unified session is noisy *for the model* (all conversations cross-labeled), but what
the **principal reads** is a *separate projection*: the principal-DM — their messages + the
agent's reports — **not** the raw peer conversations (those go to the customers' channels).
So the principal's view can be made thinner independently of the model's context:

- **Thread the reports**: the agent posts updates in a **thread keyed by peer-conversation
  or task** (`envelope.conversation.thread`) → the principal's feed shows thread heads,
  detail on drill-in (same "collapsed heads" pattern as §5). Renders as native threads on
  **Slack** (DMs + channels) and **Teams channels**; degrades to a labeled flat line
  (`[re: customer X]`) on **Teams 1:1 chats** and **WhatsApp** (both flat). If an org wants
  threaded updates on Teams, bind the principal-DM to a **channel**, not a 1:1 bot chat.
- **A dedicated UI** (deferred, §10) is the rich view — a structured console (conversation
  list + status + drill-in) that displays *less*; Slack/Teams are the good-enough surfaces.
- **Curate**: the real volume lever is the agent reporting *selectively* (questions,
  exceptions, periodic digests), not every micro-update — the yield/reporting policy.

### Handoff (inter-agent, no primitive)

Handoff = a **speech act**: agent A `send`s agent B (in a shared real channel — visible to
the humans in situ — or a `local` workspace). B's ingest sees a coworker message → wakes B
(relational rule); A's ingest sees its own send → ignore. Consults, n-way, refusal, and
AI↔human symmetry come free. No handoff tool. **Ownership: none experimentally** — shared
conversations wake every bound agent; coordination from context; patch with an owner field
in conversation memory only if double-answers/dropped-threads show up.

### Deferred: the subagent tree (recorded for when volume demands it)

When one context can't hold an agent's conversations, split: a **main session**
(coordinator = principal-DM) + **subagents** (per-conversation focused sessions).
Message-passing, **not** fork (ephemeral) nor merge (histories combined):

- **Down**: delegation/brief/steer (`send` to a child; a *new* child = spawn). Schema B
  renders it `user` in the child (the task — and it *must* be `user`; the child's own
  outputs are `assistant`) and `assistant` in the main (visible to agent+principal).
- **Up**: results + questions (`send` back). The main is the **curated merge view** — the
  principal reads subagent activity *only* via the main session (agent→principal messages
  are invisible in the peer conversation), so the up-flow into the principal-DM is
  *required*, but it's **distilled** (results/questions), not raw histories. Few
  conversations → it feels like cabra-bot; many → summaries + drill-in (`search`).
- Steering/control: the principal steers *through* the main (their one interface); the
  main relays down; hard `stop` is undirected across in-flight subagents (per §2).
- Autoinvocation vs delegation = **await vs fire-and-forget** — same mechanism; the
  difference is whether the main's next step depends on the result.
- Global context reaches subagents via **shared memory + brief + `search`**, not the
  main's full history.

## 8. Memory & the docs cascade

Hierarchy (**agent memory dropped** — the session is the memory):

```
system        product base framing (world model, send, digest) + built-in skills/tools  [write: builtin]
org           instructions + memory + skills + tools   [shared across the org's agents]
agent         instructions (the persona) — NO memory store (the long-running session is it)
conversation  working state (optional projection for compaction)   [agent-written]
```

Cascade `system → org → agent → conversation`: concatenate in order, **more-specific wins
on conflict** (CLAUDE.md model). Same cascade builds instructions, tool set (tool-docs),
and memory. `system` scope is shipped via migration (RLS denies agent + org admin).
*(The subagent worker-overlay scope is deferred with the tree.)*

**One discovery rule, every scope** (2026-08-04): walk the scope directory recursively; a
file is a doc **iff it is `.md` and opens with YAML frontmatter** — *a doc declares
itself*. `kind` rides in the frontmatter (default `memory`); folder structure is pure
convention, plural by custom (`instructions/`, `skills/`, `memories/`, `tools/`), invisible
to the code. On the §9 layout the scope dirs are `system/` · `org/` · `agents/<name>/` ·
`conversations/<id>/` — so **the agent scope IS the agent's workspace**: a cloned repo's
READMEs have no frontmatter and stay files; the agent's frontmattered notes anywhere in its
home are its docs. A doc's `name` is its scope-relative path (`instructions/compaction`).

Registers (same substrate, different rules):

| | instructions | memory |
|---|---|---|
| mode | prescriptive (how to behave) | descriptive (what is known) |
| author | humans; agent may **propose** (ratification) | agent writes freely |
| volatility | stable, versioned | churns, tolerates decay |
| authority | binding | evidence; instructions override |

- **Load policy (v0): progressive disclosure** (the `MEMORY.md`/CLAUDE.md lazy-load model).
  nu pushes an **always-loaded index** — every doc's `name + description + scope` — plus the
  **bodies of `load:"always"` docs** (persona, core instructions). `load:"lazy"` docs appear
  as index pointers only; **mu pulls a body on demand via the substrate read** (`aread`/`sql`
  — "doc-read = the substrate read", §9). nu stays dumb (no relevance matching); mu decides
  what to pull. Keeps the prompt (and its cache prefix) lean as doc volume grows.
- Media lands NATIVE (§5): images/PDFs the model reads directly, everything else a
  marker + path. The PREPROCESSOR step (voice→transcription, image→described for
  non-vision paths) stays deferred to openbsp at the producer boundary. (Anthropic API:
  images + PDFs, not audio.)
- Eviction = an **un-anchored maintenance step** (cron sweep): merge/supersede, size
  budget per scope, every eviction logged with cause.

### The `docs` table

```ts
docs {
  scope:  "system" | "org" | "agent" | "conversation"        // (subagent worker-overlay deferred)
  kind:   "instruction" | "skill" | "memory" | "tool"        // tool = MCP config (nu-consumed)
  name, description, body
  load:   "always" | "lazy"
  write:  "builtin" | "human" | "ratified" | "agent"
  version, updated_at
}
```

- **No "memory subsystem"**: docs (all kinds) *and* cron are just rows/files managed via
  the generic substrate tool (SQL-client/RLS on DB, bash/Unix on files), bounded by the
  engine — full model in §9. Optional `docs.write`-style **RPC wrappers** are ergonomic
  sugar (literal params → no escaping bugs) and the home for atomic ops (send-executor,
  hard-stop, schedule_wake) — never the security boundary.

### Domain tools (MCP) & credentials

- **Setup is conversational**: the principal tells the agent "set up my calendar" → the
  agent runs an MCP-setup flow. The chat *is* the config UI (no dedicated UI).
- **`docs.kind: "tool"`** = an MCP registration (per-scope), loaded by nu into the tool
  registry — config, not rendered content.
- **Credentials in a table the agent cannot read** (RLS deny-all; its own accessor on
  SQLite). `docs.kind=tool` holds non-secret config + a `credential_key` into the vault
  (§4); nu/gateway resolves the token at call time
  (`SECURITY DEFINER`) and injects it. The agent sees the reference, never the secret
  (OneCLI/nanoclaw pattern).
- **OAuth callback endpoint**: agent sends the principal an auth link *in the chat* →
  browser consent → provider redirects to the harness callback → token written to
  `credentials` (agent-no-read), linked to the tool doc → agent notified. Teams-only UI is fine.

## 9. Deployment, storage, tools & security

- **Distribution (DX)**: target = **scaffold-the-surface, package-the-core** (shadcn C2):
  an init command copies what an org owns — `seed/docs/**` templates, config, `main.ts`
  wiring, Dockerfile — while the harness core stays a JSR dependency (the `store/`/exec
  ports are the package boundary). Surface files are exactly what updates never touch;
  core updates are a version bump. The init is npx-shaped (`deno run -A jsr:@mu/init .`;
  no folder → a short interview), additive and never-overwriting — re-run = update for
  added surface files. The template ships its own `AGENTS.md` so a coding agent (Claude
  Code, or mu itself) can run the customization interview — init stays dumb (copy +
  interpolate); the intelligence is a doc. The **front door is agent-first**: a repo-root
  `SKILL.md` at a stable URL ("read this and follow it") — the developer's own agent is
  the installer, wrapping the deterministic steps and carrying the interview; plainly
  readable (it is also the trust artifact), every step idempotent. `mu init` is the
  deterministic core the skill invokes once it exists. Near-term (v0.x, API churning): clone-the-repo, kept
  **template-ready** — seeds live as real files under `seed/docs/`, copied write-if-absent
  into `{dir}/docs` at boot (interpolating `{{DOCS_ROOT}}`/`{{AGENT_ID}}`), never
  overwriting edits. **Seed vs data is template vs LIVING state**: agents co-author
  `{dir}/docs` at runtime (memories, later skills), so it drifts by design — git sees
  `seed/` (the org definition, reproducible; private repo if sensitive), volumes hold
  `data/`. Per-file if-absent ⇒ additive seed evolution flows to deployments; *edits* to
  existing seeds reach live orgs only via an explicit migration action (future, ⟺ db
  migration — on Postgres seeding IS an INSERT-if-absent migration). The Docker image is the *deploy* artifact of whichever mode
  (`deno compile --include seed/docs`), not the dev artifact. **Isolation is per
  folder**: all state lives under the project dir (log, locks, docs, keys) — N inits =
  N unrelated orgs, co-runnable on one machine; never write global state. **Deno-less
  envs**: `deno compile` (cross-target) ships self-contained binaries — operator-mode
  without Deno; hacking wiring/core needs it. **Version clamping, one per layer**: git
  tag (clone/SKILL.md) · `jsr:@mu/core@x.y.z` + committed `deno.lock` (surface project)
  · `jsr:@mu/init@x.y.z` · binary release tag · Docker image tag.
- **Docker per org**: several processes in one container, coordinating through the shared
  log (`store/`). The **harness** process runs the agents (each a supervised async worker on
  an in-process scheduler, not process-per-conversation); **each channel connection is its
  own process** (Teams, Outlook mail, …) that publishes/subscribes to the same log. Config
  (env vars: Anthropic, Microsoft…) + bundled tools/binaries per org; filesystem substrate
  because it's a container. **Concurrency: one turn per session (the turn lease) — a MUST**, the invariant everything
  rests on (multiple sessions per agent are a likely future; each gets its own lease); agents/
  sessions run in parallel. A global provider-rate cap is a future happy problem (§10). Cross-process writes serialize on a
  file lock (flock); switching the whole substrate to Postgres is a config change.
- **The scheduler emulates edge**: the unit of execution is the stateless step; the
  scheduler is one invoker, the edge platform another. Same harness both places — only
  continuation-trigger and tool-transport drivers differ.
- **Tool planes**: control plane = **`send` + `search`** (the only dedicated control tools)
  + substrate CRUD (docs, timers via SQL/RLS) + MCP domain tools (tool-docs + injected
  credentials), over the storage port; execution plane = bash + agent binaries (+ browser,
  code) in the **sandbox** (subprocess in the org container; micro-VM/E2B/Fly later behind
  a SandboxProvider). Exec-plane security = OS (Unix perms + mounts + egress), not tool gating.
- **Background processes**: `bash` detaches (`cmd >/work/log 2>&1 &`) and samples
  (`tail`); the buffer is a file in the sandbox, **out of the log** (same principle as
  EventLog vs Stream — high-frequency output never enters the log). No dedicated tool.
  - **Lifetime is harness-bounded (containment, no registry).** A background job must
    outlive its *call* (that's the feature) but never the *harness* (the leak). Each bash
    command runs in its own **process group** (`setsid`); on timeout/abort the whole group
    is killed (a runaway foreground drags its children down, not just bash), and a group
    that still has members after the call (a `cmd &` job) is recorded and **reaped on
    shutdown** (`main.stop()` / task-mode exit). So no orphan survives the process that
    spawned it — the container-teardown guarantee, extended to the long-running org.
    Managed *visibility* has two halves. **Passive (shipped):** the ambient block lists each
    live job with a **pid kill-handle** + full command on the `Job` (§5) — enough to see and
    kill what's running. **Active (an idea, designed with clock/background, §10): a push
    notification on job death.** The exec plane can run a light **exit watcher** (~2s probe
    over the registry — push from the agent's perspective; a poll underneath, since a
    `cmd &` grandchild is not our child to await), complementary to the clock (which keeps
    TTL reaping / boot recovery). Timing would sort the agent-kill noise: a mid-turn death
    coalesces into that turn's closing think (reads as the obvious consequence of the kill);
    only a **lone** death spawns a fresh turn. **Open question, deliberately unresolved
    until the clock/background design pass:** what event TYPE carries the wake — an `alarm`
    today only *re-derives* what's owed (a lone alarm over a quiescent log is a no-op), so
    either the exit is published as information the owed-derivation counts, or alarms grow
    proper semantics; alarms are NOT messages, and the answer is part of the scheduler
    design, not this bullet. Exit *codes* are unknowable either way — the signal says
    "gone"; the agent `tail`s the job's log for the outcome.
    **The exit event generalizes to arbitrary conditions**: a watcher is just a background
    job whose death IS the signal — `(tail -f train.log | grep -qm1 DONE) &` or
    `(inotifywait -e close_write out/) &` exits when the condition fires → lone-death →
    exit event → poke, and the registry's command string tells the agent *which* watch
    fired. Condition-watching (Claude Code's Monitor tool) thus costs zero harness code —
    a **skill** teaches the incantations; latency is tick-bounded, which is the accepted
    v0.1 trade. (Claude Code's own model, for reference: completion pushes an injected
    notification; progress is never pushed — the model pulls the output file; mid-run
    conditions exist only via an explicitly armed, filtered watcher.)
    Kill-across-invocations / per-job output tools
    are a further v0.2 item only if long background work becomes common; the unix-native path
    (raw `&`/`tail`/`kill` + the ambient HUD) is the default. macOS lacks `setsid` → falls
    back to a bare spawn (isolation off, so no tracked job).
  - **Shutdown itself is bounded** — `main.stop()` awaits the in-flight turn's queue to
    settle before reaping, but that wait is capped (`stopTimeoutMs`, default 5s). Without
    the cap a turn wedged on a hung model connection (an API/network outage exactly at
    shutdown) blocks teardown *forever* — the reap and `log.close` never run, so the very
    safety net above is defeated. The orphaned turn is swallowed by the fan-out queue's
    catch (and in task mode killed outright by the process exit that follows). The deeper
    fix — threading an `AbortSignal` through `step`→transport so shutdown actively cancels
    the model call — is deferred; the cap is the correctness floor. (Surfaced by a
    Terminal-Bench run where a mid-outage trial wrote its trace but hung in `stop()`.)
  - **Shutdown-reap is containment, NOT leak prevention** — for an org agent running days/
    weeks, `main.stop()` ~never fires, so a *forgotten* job (or a loop spawning jobs) leaks
    within one lifetime. Three layers address the in-run leak: **(1) deploy floor** —
    container cgroup limits (`--pids-limit`, memory, CPU) so a runaway can't exhaust the
    host (Docker story, not harness code); **(2) harness hygiene on the clock (v0.1)** —
    the periodic alarm prunes dead groups and enforces a per-job **max-age TTL** (kill
    groups older than ~1h unless marked persistent; job-reaping is periodic maintenance
    under the lock, the alarm's exact shape); **(3) agent visibility (v0.2)** — surface the
    live-job set in the ambient block + a hygiene skill (only the agent knows if a job is
    still needed). For a *delegate* (conversational) agent bg jobs are rare/short — the
    heavy-background use is task mode, which the container reaps — so a generous TTL rarely
    bites a legit job. The registry already self-prunes dead groups so it stays bounded to
    live jobs even before the clock lands.
- **Control seam** (CLI, web console — clients that *drive* the harness): harness-as-server
  (OpenCode model), HTTP/WS + SSE, OpenAPI-defined. **Driver API** (the same for every
  control client): `submit(conversation, parts)` (write a principal `message` into the
  log) · `subscribe(filter)` → EventLog events (durable) + Stream (deltas/thinking/tool
  progress) · `approve(request_id, verdict)` · `stop`. A control client is a driver of this
  API; a channel adapter is the same driver bridging a platform (§4). *(The `local` CLI
  principal-DM is v0.0's only surface.)*
  - **Transport = RPC over a stream (pi reference).** RPC (*remote procedure call*) =
    invoke a procedure that runs in another process as if it were a local function; the
    transport (serialize args → send → run → return) is hidden. pi's **RPC mode** does the
    simplest possible version: **newline-delimited JSONL** over stdin/stdout — one JSON
    object per line, requests in, events out. Worth mirroring because it fits mu exactly:
    (a) **language/runtime independence** — a web console, a Python ops script, a mobile
    app drive the harness without importing our Deno/TS core, just speaking the protocol;
    (b) **process isolation** — client and harness are separate processes (our whole
    topology), so a client crash never touches the mind; (c) it's a **thin façade over the
    log** — `submit` = publish a `message`, `subscribe` = tail + Stream, so the RPC layer
    adds framing/typing, not new state; (d) **transport-transparent** — the same procedures
    ride stdin/stdout (local), a unix socket, or WS/HTTP (remote/edge), matching the
    container⟺edge goal. JSONL over a stream beats REST here (native bidirectional
    streaming for events) and beats library-embedding (no runtime coupling). The granular
    embed API (`ModelRuntime` / `SessionManager.inMemory()` / `createAgentSession`) is the
    in-process counterpart, worth revisiting when `@mu/core` splits out (C2).
  - **The typed verbs ARE the control-client's ingest.** A channel classifies raw text
    (is "stop" a command?); a control client emits already-classified events via UI (a
    Stop button → `control`, an Approve button → `permission_response`). Same job,
    button-press instead of NLP-guess — which is why the surface is verbs, not a text pipe.
  - **The RPC server is a log-driver like any other — so it need not live in `main`.** In
    the container `main` hosts it (a process is already running); detached, it's a
    standalone gateway (API survives a mind restart). **On Postgres + edge there is no
    `main.ts`**: `submit` = a row INSERT (serverless endpoint / PostgREST), `subscribe` =
    LISTEN/NOTIFY · Realtime — the "server" is the DB's realtime layer + a function, not a
    process we wrote. RPC decoupling is therefore **required** by the edge target, not
    optional: `main` is a container-only convenience that vanishes on edge, but the log and
    the four verbs survive, and the client code is byte-identical across both.
- **Channel seam**: producers/dispatchers publish/consume the EventLog (open-bsp model).
  MCP channels rejected for ingestion (wrong topology: harness-spawns-local-subprocess,
  can't publish to a log). Permission-relay UX worth copying from CC channels (request_id
  5 letters no 'l', first-answer-wins).

### Tools — `send` · `search` · one substrate primitive (`bash` / `sql`)

The exec/durable primitive is **one tool per substrate** — never a bag of capability-tools.
Capability lives in **helpers** the one tool invokes: **binaries** in the sandbox PATH
(filesystem) or **functions** in the database (db). This is the move openbsp *didn't* make on
its SQL side (5 tools: `executeSql`/`getDbSchema`/`sampleTableRows`/`selectAsCsv`/`bulkInsert`)
— we collapse it to `sql` + a helper library.

| tool | plane | signature → returns |
|---|---|---|
| `send` | control (dedicated, nu-mediated) | `send(to?, parts, re?, react?, action?)` → `{sent, event_id}`. `to` defaults to the triggering conversation. `re` is a rendered line's `id` (§5) — it quotes on the wire; `react` lands a glyph on it; `action` (`edit`/`delete`/`remove`) acts on the referent instead of adding to it, and the two mutating ones reach only the account's own messages. **The only dispatch path** — which is why every one of these is a send and not a tool of its own — and the only call the default rule table asks about (§3: policy is data; no tool is special). |
| `search` | control (dedicated) | `search({in?, from?, before?, after?, text?})` → events, RLS-scoped. Clean sugar over the control-plane log read (SELECT / ripgrep). |
| `bash` | exec + durable-on-files | `bash(cmd)` → `{stdout, stderr, exit}`. The **filesystem** substrate's one primitive; always present (scratch/task work). Capability via **binaries**: `aread` · `awrite` · `aedit` (Agent-SDK `Read`/`Write`/`Edit` semantics) + unix search/nav `grep` · `glob` · `ls`. |
| `sql` | durable-on-db | `sql(query)` → rows, RLS-scoped. The **database** substrate's one primitive; present only on the db backend (the sandbox can't touch the DB, §9 invariant). Capability via **functions** — the "DB OS": `db_schema` · `docs_write` · `docs_edit` · plus `grep`/`glob`/`ls` counterparts (FTS/`LIKE` · pattern-list · introspection). |

**A tool owns how it READS.** The same call is shown in four places — the approval card, the
anchor's pending list, the harness's report of a deferred outcome, the mirror's `[agent
tool]` line — so the rendering belongs to the tool, not to each consumer (`describeCall`,
optional `ExecTool.describe`). The default needs almost no overriding: a call with a single
string argument prints it bare (`bash(git status)`), everything else is `name(k: v, …)`. Two
verbosities, because the consumers differ: the LINE (bounded — a pending entry, a trace) and
the FULL form (the card: approving is judging exactly what will be said). `send` supplies its
own, and what it adds is the one thing no generic rule can know — a NAME where the wire has
an address: `send(to: Vivian, text: …)`, the address standing when nothing names it.

So the durable substrate is a config switch: **files (`bash` + binaries) ⟺ db (`sql` +
functions)**; `bash`-for-scratch rides along regardless. `aread`/`awrite`/`aedit` ≈
`SELECT`/`INSERT`/`UPDATE` ≈ the same read/write/edit triad, mediated by Unix perms (setuid)
or RLS (SECURITY DEFINER).

### The exec plane, concretely (v0.0 — from the pi / Agent-SDK study)

The `bash` tool and the binaries take their semantics from the two references — pi's
truncation discipline and edit engine, Claude Code's timeout and workspace discipline:

- **`bash(command, timeout?)`** — starts in the agent's **workspace** (`{dir}/workspace`),
  but **cwd persists between calls like a terminal** (a pwd sentinel appended to each
  command reports the shell's final dir + real exit code; env/venv state does NOT persist)
  — the tbench audit showed the model re-`cd`ing on nearly every call under the old
  fresh-cwd contract. PATH is prefixed with `{dir}/bin` (the binaries). stdout+stderr
  merged in arrival order. **Default timeout 120s** (a hung command otherwise holds the turn lock until
  the TTL steal); long work uses the background pattern (`cmd > log 2>&1 &` + `tail`).
  Non-zero exit ⇒ `is_error` result carrying the output + exit code — the agent's
  self-correction path, not a harness failure.
- **Truncation discipline** (pi's, wholesale): two independent limits, whichever hits
  first — **2000 lines / 50KB** — and never partial lines. These are *defaults, not
  caps*: the model may override per call (`bash(max_lines, max_bytes)`;
  `aread path [offset] [limit] [maxBytes]`) when it deliberately needs a wider or
  narrower window. `bash` truncates from the
  **tail** (errors live at the end); `aread` from the **head**. When bash truncates, the
  **full output is persisted** to `{workspace}/.out/<id>.log` and the footer says so —
  the model pages the rest with `aread`. Nothing is silently lost.
- **`aread path [offset] [limit]`** — head-truncate + continuation footer; 1-indexed;
  offset-beyond-EOF is an error. **No line-number prefixes** — `aedit` is text-anchored,
  not line-anchored (pi's pairing).
- **`awrite path`** — content on **stdin** (heredoc-friendly); creates parent dirs;
  overwrites.
- **`aedit path`** — a conflict-marker **multi-edit spec on stdin** (`<<<<<<<` old
  `=======` new `>>>>>>>` blocks — a format models already know). pi's engine: every
  block matched against the **original** file (not incrementally), must be unique and
  non-overlapping; **exact match first, then trailing-whitespace-insensitive fallback**;
  BOM and CRLF preserved.
- **Shared-workspace hardening** (an SMB mount as a workspace *folder* — workspace root stays
  local, external file domains mount as subtrees, each with its own credentials/mode; the
  mount table is the access policy — the INBOUND half of "the filesystem is the integration
  surface"; the outbound half, sharing the agent's home to the principal, is §9 remote
  steering): `aedit` holds an exclusive flock across its
  read-modify-write (cifs maps it to server byte-range locks → serializes against Office
  apps too; inode re-check after acquiring retries a rename-under-us), and both `aedit` and
  `awrite` commit via **temp + fsync + rename** — crash/disconnect-atomic, mode-preserving.
  Cross-turn concurrency needs no lock: the conflict-block match IS the optimistic guard (a
  colleague's change → no match → re-read).
- **No `agrep`/`aglob`/`als`** — pi itself shells out to ripgrep/fd; bespoke binaries
  only earn their existence where semantics differ from stock tools. The image ships
  `rg` + `fd`, and the bash tool description points at them.
- **`bash` is deliberately ungated** — no per-command permission or audit granularity.
  Gates are for outward effects (`send`, §9 gating); the workspace is the agent's own.
  (Both references promote file-ops to dedicated tools chiefly to gate/schedule them —
  a need we've explicitly declined for the exec plane.)
- Dev shims: `{dir}/bin` holds `aread`/`awrite`/`aedit` as `deno run` shims over one
  source; the Docker image compiles them (`deno compile`). The binaries' *contracts* are
  the spec the db substrate's helper functions mirror later (§9 symmetry).

**Not tools** — deliberately, per the substrate principle (a generic tool + a skill
beats a bespoke tool):
- **Scheduling** = write a timer row (control-plane SQL/RLS) or `at`/cron (files/OS); a
  firing peripheral runs it (§2 clock). No `schedule_*` tool — a **skill** teaches it.
- **Background processes** = `bash("cmd > /work/log 2>&1 &")` then `bash("tail /work/log")`.
  No `check_output`/`kill` tool — the agent owns its processes via bash + a **skill**.
- **docs / memory / cron reads/writes** = substrate CRUD via the one primitive: `bash`
  (`aread`/`awrite`/`aedit` on files) or `sql` (`docs_write`/`docs_edit` functions on db).
  render reads them the privileged way — the in-process `Docs` port, not the agent's tool.
- **reply / spawn / handoff / ask-principal** = `send` (+ routing). **soft-stop** = stop
  emitting + `bash` kill. **doc-read** = the substrate read.
- **MCP domain tools** (calendar, CRM…) = **dynamic per agent** (from tool-docs), credentials
  injected by nu (§8) — real tools, but wired at runtime, not part of the core surface.

So the core surface is **`send` · `search` · the substrate primitive (`bash` / `sql`)** +
dynamic MCP. Everything else is helpers (binaries/functions) + skill.

### Storage ports & backends (SQLite ⟺ Postgres — one SQL substrate, two coordinators)

The durable store is **SQL on both tiers**; only the coordinator differs. Locally the
**embedded SQLite engine** (`node:sqlite` — in the runtime, so it survives `deno compile`
with no external lib) provides it — WAL + `busy_timeout` serialize writers, dir-watch on WAL
commits is the change feed. On Postgres the **server** does — MVCC, LISTEN/NOTIFY·Realtime.
Because both are SQL, the local→edge jump is small. mu/nu/xi and run-to-quiescence are
identical; only the **ports** differ:

**The flattened `events` table** (open-bsp lineage — every queried scalar is a column):
`id` (uuidv7 pk — identity, internal-schema-only) · `external_id` (the platform id — the
upsert/merge key, mutable) · `type` · `service` · `connection_address` ·
`conversation_address`/`_name`/`_thread` · `session_id` (harness session) · `sender_address`/
`_name` · `agent_id` (null ⇒ the world wrote it; ≠ mine ⇒ a peer agent) · `timestamp` (event
time) · `created_at`/`updated_at` · `text` (derived from parts — the search column) ·
`parts` (the event body, JSON array; absent = a merge-only draft) · `payload` (what the
event MEANS: action · refs · turn keys, §3) · `extra` (the sidecar) · `status` (the
delivery-lifecycle JSON: `{state, delivered_at?, read_at?, deleted_at?}` — scalars in a DM,
per-participant maps in groups, json_patch-merged on update). Wire ids are `*_address` columns; `id` stays internal.

**The store owns `id`.** The column is `id uuid DEFAULT uuidv7()` on Postgres, and the SQLite
adapter is the *same DDL* (it binds a `uuidv7()` function, so the default is real there too).
Producers publish a **`Draft`** — an event without an id — and `publish` returns the stored
event with the id the store assigned; an explicit id is still accepted, as in any INSERT that
names the column. Three consequences: **(a)** every row's id is a UUIDv7 by construction, so
**append order = `ORDER BY id`** — that's the read order and the subscribe cursor, and no
`rowid` is needed (a SQLite-only crutch from when producers minted their own, possibly v4,
ids); **(b)** an upsert that MERGES returns the *surviving* row's id, so a dispatcher never
walks away holding an id that was never stored; **(c)** ids are minted while the write lock is
held, so mint order = commit order, except for two processes writing in the same millisecond,
where only the random tail separates them. That sub-ms inversion is accepted: it's below the
resolution of anything that reads the log, and **what the agent sees is ordered by `timestamp`
(real-world event time), not by `id`** — `id` orders *storage and delivery*, `ts` orders
*the world*.

| port | SQLite (embedded, single container) | Postgres (server, edge / multi-instance) |
|---|---|---|
| Log · publish | **UPSERT on `external_id`**, id from `DEFAULT (uuidv7())`, `RETURNING id`: new ⇒ INSERT (wakes) · known ⇒ MERGE `payload`/`status` via `json_patch` — no new row, no wake | `INSERT … ON CONFLICT DO UPDATE` + jsonb merge (the open-bsp before-update trigger) |
| Log · read | indexed `SELECT … WHERE`, `ORDER BY id` | `SELECT … WHERE` (RLS) |
| Log · growth | native indexes — no scan, no segment rotation | table partitioning |
| Log · subscribe (the trigger) | dir-watch (WAL commits) + poll backstop, cursored on `id` — seeded **synchronously at subscribe time**, so everything appended after `subscribe()` returns is delivered | LISTEN/NOTIFY · Realtime |
| retry / echo / edits (ONE mechanism) | the `external_id` upsert-merge above: a retried delivery, an edit, and our own dispatched artifact looping back all MERGE into the row | same, engine-native |
| delivery bookkeeping | `setDelivery(id, {external_id?, status})` — an UPDATE; backfills the echo key after dispatch; never wakes | same + `AFTER INSERT`-only trigger |
| privacy (`scoped(log, policy)`, §6) | the policy bakes into the port: reads filter BEFORE the window limit, writes are checked before landing (`WITH CHECK`), each agent's subscription delivers only its view | RLS (`USING`/`WITH CHECK`) + the agent's own credential — the wrapper vanishes |
| Stream | in-process EventEmitter → SSE | Supabase Realtime |
| the turn lease (§2) | a `locks` row **in the same DB** — `INSERT … ON CONFLICT DO NOTHING` to take, one atomic `UPDATE … WHERE born <= cutoff` to steal a dead holder's, `DELETE` to release | advisory lock, or the same row |
| timers / clock | `timers` table + in-mem wheel | pg_cron / pgmq |
| locks / atomicity | transactions (WAL + `busy_timeout`) | advisory locks · transactions |
| agents (`store/agents.ts`) | `agents` table in `log.db`, MIRRORED from the `agents/` folders at start (§9 framework way) | `agents` table (openbsp lineage) |
| blob | filesystem | object store |
| search | `LIKE` (v0) → FTS5 | FTS / pgvector |
| producers & dispatchers | separate processes, shared `log.db` | separate processes via DB |

- **JSONL was the bootstrap, now dropped.** A flat append-only file was the simplest thing to
  get the harness alive and readable — but once it needed indexed reads, an idempotency index,
  updatable delivery bookkeeping, and privacy-filter-at-source, it was hand-rolling (worse)
  versions of database features. SQLite *is* those, embedded, single-file (the DX is kept), and
  a small jump to Postgres. The lost "just `cat` it" was never real: the agent can't read the
  raw log anyway (it holds other principals' private events — `log.read` is the privacy
  chokepoint), and a multi-producer log is human-unreadable regardless of format. Readability is
  served by an **`export` tool** (pi-style, RLS-scoped), not by the on-disk format.
- **SQLite hardens "the sandbox never writes the durable store."** With JSONL the agent's `bash`
  could in principle `echo >> log.jsonl`; a binary SQLite db it has no tool for and no business
  touching — it reaches the log only through `send`/`search`. The exec plane's *workspace* stays
  filesystem+`bash` on both tiers (ephemeral scratch, §9); only the durable store is SQL.
  Scope precisely: the principle covers the **log and credentials** (broker plane). **Docs are
  the file plane** — agent-editable state, written with plain `bash`/`aedit` under unix
  permissions (below), no dedicated write tool and no port mediation.
- Producers and dispatchers are **separate processes sharing `log.db`**; concurrent publishes
  serialize on SQLite's WAL lock — no central writer, no funnel.
- **`store/agents.ts` (landed 2026-08-04):** the agent registry — each agent's identity,
  home, and declared settings/handles (`provider · model · effort · email · phone`,
  mirrored from `config.json` — the framework way below). Ingest/dispatch/main all read
  it; machine-discovered account bindings live on the connections map (§4), keyed to the
  same registry names. Named `agents` (not `principals`) deliberately — agent↔principal
  is N:M in the limit (an agent managed by many or any principals), so the *agent* is the
  entity. `MainConfig.principals` remains the in-code seam (tests, task mode); process
  bootstrap (data dir, API key) stays env — it exists before any substrate is open.
  **An agent IS its row** — identity + bindings; docs, workspace, memory may all be empty
  and the agent still fully exists (agents start blank). Everything else is a *projection*
  of the row onto the substrate: its log streams and turn lease; its policy (`readable`/
  `writable` from bindings + the connections map, §6); on Docker a **legit linux user**
  (the row is the passwd entry, `useradd -m` is provisioning — unix-safe names / a reserved
  uid range decided at provisioning, not in the registry); on Postgres a **DB role / JWT
  claims** (the row mints the credential). One derivation chain on every tier:
  registry row → policy → credential.
- **Tool-adapter principle**: a tool's *schema* is backend-agnostic; its *implementation* is
  a per-backend adapter behind a port (`system cron vs pg_cron` = one tool, two adapters).

### The edge tier: main dissolves into the database

On Supabase the change feed is neither `NOTIFY` (a hint capped at 8 KB, no replay) nor
Realtime (RLS + one `eq` filter — an org harness wants *everything*): it is an `AFTER INSERT`
trigger doing **`pg_net.http_post`** into an **edge function**. Which means **main stops
existing** — every piece of it is already something the database does better:

| main (container tier) | Postgres tier |
|---|---|
| `log.subscribe` + cursor + synchronous seed + poll | the trigger IS the delivery — no subscription state at all |
| the fan-out (`for each agent: invoke xi`) | the trigger's body, one `pg_net.http_post` per registered agent |
| the future class pre-filter | the trigger's `WHEN` clause (pure over the NEW row — that's the constraint it must keep) |
| `readable`/`writable` (`scoped`, §6) | RLS, engine-enforced (the trigger body re-uses the same predicate function for economy — shared predicate, two call sites) |
| in-flight set + `stop()` | the platform's invocation lifecycle; safety is the lock TTL + steal-sweep |
| the poll backstop | `pg_cron` — a periodic poke, which is also the liveness floor (§2) |

So the split is: **main's roles become SQL** (trigger + RPC functions, so a trigger and an
external caller poke the same way), and **xi/nu/mu + the connectors become functions** —
`(Request) => Response` with injected ports, which the connectors already are and which xi is
one adapter-swap away from (`log` → Postgres, `lock` → an advisory lock or `locks` row).

Two asymmetries to plan around, not paper over: **(1) no bash on an edge function**, so an
edge-deployed agent can run connectors, dispatch, a verdict and a think, but the exec plane
(§9's substrate primitive) needs the container — or a sandbox service, which is a different
tool with different failure modes, not a port. **(2) Wall-clock limits** can kill a think
mid-turn — which the design already survives, because verdict-once + log-as-continuation was
built for crash recovery: the stale lock is stolen, the steal sweeps, the model re-decides.

### Substrate symmetry & security model

```
filesystem : bash+binaries : Unix perms   ::   database : SQL-client + RPC funcs : RLS/grants
       (mutable substrate + generic execution tool + engine-enforced permissions)
```

- **Sandbox never writes the DB** (invariant): durable self-state (DB) is separated from
  ephemeral task capability (sandbox). Self-modification is a *deliberate, gated act*.
- **Two-plane power mirror**: ephemeral scratch = max power / min gate; durable self =
  bounded, gated.
- **Security is substrate-native, not tool-identity** (tool gating is theater when a
  generic tool exists — deny Write, the model does `echo >`). Two orthogonal axes:
  1. **Access control** — filesystem: container (blast radius) + Unix perms + mounts/egress;
     DB: SQL-client + RLS/grants (the engine bounds the SQL, whatever it writes). Full stack
     mirrors: RLS ≈ Unix perms · `EXECUTE` grants ≈ installed binaries · `SECURITY DEFINER`
     ≈ setuid.
  2. **Outward authorization** — `permission_request` → human, for semantic effects with no
     substrate analogue (send *this* email, issue *this* refund). Unforgeable because the
     sandbox has no route/creds outward — `send` is the sole door.

| axis | protects | enforcer |
|---|---|---|
| containment (isolation) | host/tenant from the agent's **execution** | container / sandboxed DB — free |
| access control (Unix / RLS) | *what the role may touch* statically | kernel / DB engine |
| outward authorization (`permission_request`) | the *world* from the agent's **decisions** | harness + human |

Isolation and authorization **don't substitute**: "secure environment → lighter perms" is
true for exec (kernel handles it), false for control (only harness/human authorizes a refund).

### The execution boundary (hiding from bash is impossible — move the secret instead)

- **Arbitrary code execution = full access to the execution context.** `bash` *is* arbitrary
  code execution, so anything the *process* can reach — env (`printenv`, `/proc/self/environ`),
  readable files (`.env`, `/run/secrets/*`), the cloud metadata endpoint, mounted tokens — the
  agent can read. In-context or prompt-level hiding ("don't read the token") is **theater**,
  not a control (the substrate-native rule above, sharpened).
- **You hide a secret by moving it to a boundary bash isn't inside**, never by obfuscation.
  Two ways: a **broker** (the credential lives in a separate process/table the agent can't
  reach; the agent gets a capability — §8 `SECURITY DEFINER` on DB, a sidecar on files), or
  **egress-injection** (a proxy adds the auth header on the way out; the sandbox never holds
  the secret).
- **The credential-delivery rungs** (weakest → strongest; decided 2026-08-03):
  1. *Same-uid env injection at spawn* — hygiene, not a boundary: same uid can read
     `/proc/<child>/environ`, ptrace, or just re-invoke the injector. What the injected token
     decays to (scope × TTL × attribution) is service-dependent: pass-through (Slack) <
     expiring OAuth access half (refresh stays broker-side) < minted derived token (GitHub
     App installation, STS). TTL protects replay-after-exfil only — a live compromise just
     re-requests.
  2. *`secure_call` + conduit uids* — a wrapper runs the **allowlisted binary** as a
     per-service **conduit user** (`mu-github`…) that alone can read the token: root
     supervisor spawns on request over a socket (`SO_PEERCRED` = kernel-attested caller,
     policy from the registry row), `clearEnv`, conduit-owned `HOME`; stdio fds inherit, so
     `secure_call -- gh pr list | jq` composes. A real kernel boundary — but exactly as
     strong as the binary's resistance to argument injection (env scrubbed, config
     conduit-side), and **git collapses it**: an agent-writable repo's `.git/config`
     (hooks, `core.fsmonitor`) executes as the conduit. The §4 consumer axis becomes a uid:
     org/principal tokens readable by conduit uids, never agent uids — the matrix as
     literal file ownership (same move as docs-scopes → groups).
  3. *Egress proxy with header injection (MITM CA)* — **the one rung, for everything,
     live** (`src/proxy/`, mandatory at start): user space is issued `HTTPS_PROXY` +
     `SSL_CERT_FILE` (the mu CA *replaces* the trust store — inside user space it is the
     only issuer, so TLS physically cannot bypass the proxy) + a `mu-grant-…` placeholder
     standing for the vault grant. The proxy terminates the tunnel with a per-host leaf
     (`ca.ts`), swaps the placeholder for a live token — refreshed broker-side against the
     vault, the refresh_token never leaving it (`grants.ts`) — re-originates over real
     TLS, and audits every request (method · host · path · status · agent, never the
     token). The sandbox never holds token material, binary-agnostic (git included), and
     the terminated plaintext is where the egress allowlist and auth policy attach — that
     seam exists, deliberately unused so far. Not the nicest (CA to manage, cert-pinning
     fights) but the most secure, with no per-service tiers and no interim mechanisms;
     rungs 1–2 above are recorded as the analysis of why they lost, not as options.
- **Smuggled credentials** (the proxy's complement): the proxy protects broker-held
  secrets from the sandbox, but cannot stop NEW secrets being born inside it — e.g. the
  agent social-engineers the principal into `gh auth login` (or a pasted token) so a real
  credential lands in agent env/context, bypassing the broker. Three controls, all at
  boundaries already owned:
  1. **Auth normalization at the proxy** — don't just inject: **strip/replace any
     sandbox-supplied `Authorization`** on allowed hosts. Outbound identity is whatever
     the broker says, period — a smuggled token is unusable for API calls, which also
     deletes the incentive to smuggle. Any non-broker auth header is anomalous by
     construction → alert.
  2. **Login flows live at the frontier, not in the sandbox** — grants enter the org only
     through the connection's OAuth door (§4: `/start` → callback → the vault; the grant
     crosses as a log event). Device-code/login endpoints (`github.com/login/*`) are
     simply not on the egress allowlist, so `gh auth login` cannot complete from inside.
  3. **Secret quarantine at ingest** — a principal who pastes a token into the DM would
     put it in the LOG (and thus in-context). Connections redact secret-shaped strings
     (`ghp_`, `xoxp-`, …) at ingest: the value goes to the vault, the event carries a
     reference. The trick becomes a donation — the credential ends up broker-held anyway.
  Residual, named honestly: payload-level exfiltration through *allowed* APIs (a gist, a
  Slack message containing stolen text) is a content problem the transport layer cannot
  close — that stays with gating consequential actions and treating channel input as
  injection (the trifecta bullet above).
- **The lethal trifecta.** A connector that ingests external content (any PR/issue/DM) into an
  agent with `bash` + credentials combines: access to secrets · attacker-controlled input · an
  exfil route. Treat all channel-sourced content as injection input. **Egress allowlist is the
  highest-leverage control** — reading a token is harmless if it can't be *sent* anywhere (lock
  egress to the APIs in use); then scope+TTL every in-context credential (ephemeral App
  tokens), broker the powerful ones out of context, and gate consequential actions.
- **Unix perms are per-UID, not per-process.** A child `bash` at the *same UID* as the harness
  has identical file access — `chmod 600 .env` stops *other users*, not *your own child* (which
  can also read the harness's `/proc/<pid>/environ`). Isolation needs a **different UID**: own
  secrets mode-600 by the harness UID, spawn bash under an agent UID, **and don't pass the
  secret in the child env** (env beats file perms) or leak an open fd (perms are checked at
  `open`, not `read`). `Deno.Command` exposes the primitives natively — **`uid`/`gid`** (privsep,
  needs `CAP_SETUID`), **`clearEnv`+`env`** (scrub/scope the child env) — so the cheap wins (drop
  privileges + scrub env) need no external wrapper.
- **Real users for agents.** user = **isolation** (the agent process's UID); group =
  **management ACL** (principals added to an agent's group may operate it; filesystem perms on
  the agent's data dir enforce it). Arbitrary numeric UIDs are legal (the kernel takes a number,
  no `/etc/passwd` needed) but break `HOME`-dependent tooling (`git`/`gh`/`npm` need a writable
  home) — so **pre-create the agent user with a home** in the image, or engineer for arbitrary
  UIDs (OpenShift-style: group-writable dirs, explicit `HOME`, `nss_wrapper`).
- **Deno's own sandbox is for the harness, not the agent.** Deno permissions
  (`--allow-*`/`--deny-*`) bound what *Deno code* touches and **stop at the subprocess
  boundary** — bash runs outside them. Use them to harden the **harness process** (mu runs `-A`
  today; `--allow-net=<apis> --deny-read=<secrets>` bounds a harness compromise) — orthogonal to
  sandboxing the agent, which is the container/UID/egress layer.

### Deployment tiers & DX (two knobs, graceful degradation)

Every deployment is a point in two orthogonal knobs — **sandbox provider** (isolation) × **store
backend** (data), the ports of this section — and the same `mu start` runs all of them; config
picks the knobs.

| tier | sandbox | store | root? | Docker? |
|---|---|---|---|---|
| **local dev** | in-process (as you) | files | no | no |
| self-hosted box | real-user privsep + groups | files/volume | once, at setup | no |
| container hosting (Fly/DO/Cloud Run) | container-per-agent (starts as non-root user) | volume or SQL | no (container is the boundary) | yes |
| Postgres + edge | edge isolate (no bash) | SQL | n/a | n/a |

- **Isolation is a tier, not a constant.** Local dev's threat model differs — **the developer is
  the trust boundary**, acting with creds they already hold, often with untrusted channels
  unwired — so Tier 0 is **in-process, bash as you, no `uid` switch, no root, no Docker**:
  `cd folder && mu init && mu start`. Privsep/root enter only where the threat model changes
  (multi-principal, untrusted channels, real creds), i.e. the host/container tiers where "root
  once at setup" is normal. Skipping privsep locally is a correct read, not a compromise.
- **Parity on demand, not in the inner loop.** The dev↔prod isolation gap (HOME/env-scrub/egress/
  uid don't manifest locally) is closed by opting in — `mu start --sandbox=container|user` — when
  validating, not on every run. Escape hatches for local privsep without host root: **rootless
  Podman / user namespaces**, or `setcap cap_setuid+ep` on the binary.
- **Deploy paths** all start from the `mu init` folder (a git repo): **git push → hosting GitHub
  app** (DO/Render/Fly builds the scaffolded Dockerfile) · **image → registry → wrangler/Fly/
  Cloud Run** (wrangler nudges toward the Tier-3 edge, where there's no bash — the tool model
  changes). `mu init` scaffolds; the knobs pick the tier; git-push or docker-push deploys.

### The two planes (broker · agent) and where things live

Every tier splits the same way: a **broker plane** (main + connections: log, locks,
registry, credentials, connection state) and an **agent plane** (per-agent body: workspace
+ its docs). Broker data follows the log's substrate *always*; **docs follow it only when
there is no shared filesystem** (the edge tier — editing a file there would mean mounting
into a sandbox; on files, docs stay files: `$EDITOR`-able, git-able).

| port | local (dev) | Docker (self-hosted/container) | Postgres + edge |
|---|---|---|---|
| log + lock | `log.db` (locks inside — one transaction, non-negotiable) | same file on a **broker-owned volume**; agents reach the log only through xi | `events` + `locks` tables, RLS, `publish_and_release` RPC |
| docs | files | files (ownership table below) | `docs` table (RLS `UPDATE` policy = the group, below) |
| exec | host fs, one user — insecure by design | container; **agent = linux user, workspace = its home**; main = root supervisor spawning bash as the agent's uid | none in v0 (send/search/docs), rented sandbox later |
| agents · connections · credentials | sqlite under the data root | sqlite on the broker volume, **never under `/home`** | tables; credentials RLS deny-all |

The Docker layout, concretely:

```
/var/lib/mu/                 root:root 0700 — BROKER plane
  log/log.db                 events · locks · usage · agents · connections · credentials
                             (the vault rides the same db behind its own accessor, §4)
  connections/<service>/     connection state: cursors, manifests (NON-secret)
  system/  org/              shared doc scopes (ownership below)
/home/<agent>/               agent:agent — AGENT plane, one per registry row
                             the workspace IS the docs source: frontmattered **/*.md (§8)
```

Local (dev, one user — same shape, no enforcement): `MU_DIR/{log/, credentials/, system/,
org/, agents/<name>/}` — `agents/<name>/` plays `/home/<agent>`. **Agents are created "the
framework way"**: a folder under `agents/` declares one (a blank folder is a blank agent);
at start main scans the folders and `syncAgents` MIRRORS the registry table to them
(upsert present, delete absent). Folders are the DX and the source of truth; the table is
their projection — it exists because policy derives from rows (RLS, §6). The REPL
principal is the **OS username**, trusted because localhost; when `agents/<username>/`
exists (auto-created on first run), principal name = agent name and **no identity map is
needed** — and when they share user/pass, user and agent are one (the vision line). Later:
N:M principals↔agents, and autonomous agents (no one holds the pass but the agent).
**The same framework way extends to settings — the catalog** (`src/config.ts`): every
harness knob, its default, one file exposing them all. `org/config.jsonc` carries three
sections, split by AUDIENCE — `organization` (org-wide facts, set there and nowhere else:
backlogHours), `agent` (every agent's defaults, the section an agent's own file
re-declares: model · effort · maxTokens · provider · timezone · locale · rules · the
attention knobs) and `system` (harness machinery: stopTimeoutMs · lockTtlMs ·
retryDelaysMs · compactAt · keepRecent · windowLimit · mirrorSettleMs · mirrorClaimMs ·
tickMs · settleMs) — while the VALUE still funnels to the deepest function that needs it
(main → xi → nu → mu; `timezone` reads as org identity but lands in nu's render).
`agents/<name>/config.jsonc` is sparse: an `agent` section carrying only the keys it
overrides, plus `identity` (`email`/`phone`, the handles a human knows the principal by);
at start the declaration MIRRORS into the registry's columns exactly as folders mirror
into `agents`. `rules` is the permission policy as data (§2): ordered rows
`{tool, action: allow|ask|deny, connection?, conversation?}` — first match decides, `*`
matches any tool, and the scope fields pin a rule to the org's three gating levels: a
conversation, a whole connection (the account/workspace — a WhatsApp number, a Slack
team), or global (no scope). xi resolves where a `send` lands before ruling, so "the
WhatsApp number asks, the Slack workspace flows, #general is blocked" is three rows, most
specific first. The config rows are the BASE half; the REMEMBERED half is the `rules`
table on the log (store/rules.ts), written by standing verdicts — the principal answers a
card `/{y,n} [conv|conn|all] [reason]`, and a scope word pins an allow/deny row to where
that call landed (upserted by scope: a later verdict replaces the action). The gate
compiles both, remembered first: the principal outranks the base, and among the
remembered the most specific wins. Same division of labor as the registry — humans write
config, verdicts write rows, the reader merges. Resolution, most specific wins: agent
file → MainConfig (the process: tests) → org file → the catalog's constants. The org file
always exposes the WHOLE catalog: absent, it is materialized from the constants; when the
catalog grows, the missing keys are appended (your values survive — the comments are the
catalog's); an unknown key or malformed value fails the boot loudly — a typo must not run
silently, and a silent fallback would run the org on settings the human believes
overridden. The functions are 100% parametrized — `start`/`xi`/`nu`/`mu` take values as
arguments and never read env; their argument defaults are the same exported constants
(ergonomics for direct callers: tests), so code and file cannot drift. Env is for secrets
(`ANTHROPIC_API_KEY`) and for pointing a standalone connector process at its org
(`MU_DIR`); session choices — which agent the REPL faces, which principal a connect door
binds — are CLI arguments, per-invocation by nature. The REPL's data root is a path
constant (`./data`): the org lives where you run mu.
Machine-discovered bindings (a Slack user id from `auth.test`, the self-DM channel) land
on the connections map directly — so the two tables are the merged QUERY surface (the
classifier's lookups, the RLS substrate) and no human ever edits them: humans write
config, connectors write discoveries, the tables mirror both.
**Remote steering = SSH + the REPL** (2026-08-04, pi.dev-shaped): the easiest door into a
deployed agent's mind is `ssh <box>` and launching the REPL — auth is the OS's (the
user/pass unification makes SSH credentials the identity map), no web UI to build, and
interactive flows (a WhatsApp pairing code, an OAuth link) run in the same conversation.
The move generalizes: any OS-authenticated door projects the same identity — SSH for the
session plane, SMB/SFTP for the file plane (mount your agent's home, edit docs in your own
editor; uid/gid enforcement rides along, the broker plane simply isn't shared). This is the
OUTBOUND half of "the filesystem is the integration surface" — the inbound half (external
SMB domains mounted INTO the workspace, mount table as policy, `aedit` cifs-hardened) is
already in the exec-plane section above. One unix
account = agent identity, policy substrate, login, steering credential, file-share
credential — no bespoke auth layer anywhere. (Samba detail: `smbpasswd` syncs its own hash
db against the unix account — provision it in the same `useradd` step, from the row.)

**The docs cascade maps to unix ownership — permissions ARE the write policy**, no
harness code and no dedicated doc tool:

| docs scope | owner:group · mode | effect |
|---|---|---|
| system | `root:root · 0755/0644` | read-only to agents; the operator edits |
| org | `root:mu-org · 2775/0664` (setgid) | **any agent edits with plain `aedit`/`bash`, as itself** |
| agent | `agent:agent`, in `$HOME` | its own memory |

Group membership (`mu-org`) is provisioned at `useradd` time *from the registry row* —
the same derivation that mints RLS grants on Postgres (group ⇔ role grant on the docs
table's `UPDATE` policy). Later scopes (a team dir) are just another group. Audit/review,
if ever wanted, is git on the docs tree — commits per uid, orthogonal, free.

**Credentials stay in ONE broker store** — the vault tables in log.db (§4), not
per-connection secret files: the matrix is cross-service (a principal token consumed by a
*tool* belongs to no connection's folder), rotation wants one chokepoint, and "no
agent-reachable path" is easiest to prove about one path. Connection folders hold
non-secret state only.
Least-privilege *between* connections (Slack must not read GitHub tokens) is real but
deferred hardening: per-connection unix users with split stores, or — on Postgres — RLS
per connection role. The connections map thus feeds **three surfaces of the same boolean**:
agents over events (§6), connections over credentials, and the docs write policy above.
- The **real-users+groups** model is the *host-tier realization* of the manage-relation; the same
  relation is orchestration RBAC in containers and RLS in Postgres (one model, three substrates —
  as with credentials and connections).

**Process supervision — only the container needs it.** An org runs several processes over the
shared log: `main` (the tail + fan-out) plus one **ingest process per enabled connection** (§7).
Who starts them is tier-dependent, and only one tier needs a supervisor:

- **Local dev — the user is the supervisor.** No launcher, nothing to build: the developer runs
  `deno task cli` (and `deno task ingest:github` in another terminal if testing a channel). Running
  the processes you want is the inner loop; a supervisor would be ceremony.
- **Container — `process-compose`.** A single Go binary (declarative YAML, dependency order, health
  checks, restarts) as the container CMD. The nice part: its `compose.yaml` **is** the "which
  connections are enabled" manifest we'd define anyway — supervisor config and enablement config are
  the *same file*, scaffolded by `mu init` from the connections you turned on. (s6-overlay / tini are
  the older container-init route; not needed.)
- **Cloud / edge — the platform.** One process per container (k8s pod / Fly Machines / Nomad), or
  edge functions the webhooks hit directly — the platform supervises; no in-container supervisor, no
  `mu`-authored launcher. (An earlier "built-in launcher" idea was dropped: it only duplicated what
  the user does locally and `process-compose` does in the container.)

## 10. Deferred / parked

**The subagent tree** (§7 — split when one context can't hold an agent's conversations:
main + subagents, message-passing down/up, curated merge into the principal-DM, Schema B
makes delegation a `user` message) · **agent-level memory** (add back only if the unified
session's history proves insufficient) · **park/hold as a first-class state** (takeover) ·
bindings & multi-service fan-out · **debounce** (write-time abort — important, not urgent)
· **global provider-rate cap** (be kind to the API when agents multiply — a happy future
problem; the per-session lease is the correctness invariant and already exists) ·
drafts/suggest mode · plan mode (approval gate +
read-only tool filter) · task_*/todos · queues & routing (call-center: Queue/Assignment/
Capacity; handlers ai|human unified) · **mention-only wake-rule** (cost optimization for
very busy channels — v0 wakes on everything) · departments (sub-orgs) · sandbox providers
(E2B/Fly/Firecracker) · Stagehand as browser tool · memory eviction sweeps · yield-policy
formalization (currently: silence = no send emitted) · timezones in digest · atomic RPC
functions (flock gives cross-process append atomicity on files; formalize transactional RPCs
on Postgres).

**Non-blocking permission requests.** A pending gate currently freezes the agent on ALL
fronts: while any use waits on the principal, `owed` yields nothing — so a gated
peer-related send stalls unrelated conversations too. The fix belongs with background
completion (below): let the gated use return *early* ("awaiting approval") so the chain
closes and the agent keeps working; the `permission_response` later arrives as the same
delayed, harness-delivered wake. Decide when background completion lands.

**Background completion & `escalation`.** A long-running tool (or a send that can't deliver
yet) returns *early* so the agent continues; the harness later writes a **system-authored
event** that wakes it with the outcome — the **same shape as `alarm`**: a delayed,
harness-delivered effect (scheduled by a `tool_use`, fired by the harness, so `system`-
authored → wakes under the relational rule). v0.2 reintroduces **`escalation`** (final,
actionable delivery failure) as one instance of this. v0 needs neither: `bash` backgrounding
covers long tools (detach + `tail`, §9), and `local` always delivers. Likely one event type
(`background`/`report`) with a kind, not a family — decide when the second instance lands.

## 11. Reference landscape (what we took from each)

- **Pi**: minimal loop, driver-API shape (prompt/steer/followUp/subscribe), 4-mode I/O.
  Barrier: sessions-as-files → mu drops storage. "mu: like pi but smaller."
- **OpenHands**: event-stream + append-only log + stateless agent + pub/sub + condensation-
  as-events + `cause`. Rejected the strict action/observation binary (open input vocabulary,
  small closed output vocabulary).
- **open-bsp-api**: parts/content model (A2A/MCP-derived), producers/dispatchers, agents
  table (ai|human), respond-tool pattern, abort-on-newer, media-preprocessor.
- **Claude Code**: hooks (PreToolUse = universal gate), skills' progressive disclosure,
  CLAUDE.md cascade + auto-memory, background-shell pattern, channels contract
  (capability flag + notification + reply tool + permission relay), system-reminders,
  compaction prompt, MidConversationSystemBlockParam, /recap vs /compact.
- **Claude Agent SDK**: canUseTool/hook callbacks, tool allowlists, in-process MCP.
- **Managed Agents**: brain/hands/session-log decoupling — the hosted twin of this
  architecture (wake + getEvents + events-in/out + tool_confirmation). Validation + possible
  backend, not foundation (Claude-only, server persistence).
- **nanoclaw**: container-per-session isolation, two-DB inbound/outbound, per-group config,
  approval gates, destination maps (send with `to`), OneCLI credential injection.
- **OpenClaw**: channel breadth, queue modes (steer/followup/collect ≈ xi + coalescing),
  per-channel-peer isolation.
- **OpenCode**: harness-as-server + OpenAPI + SSE; generate clients from spec.
- **Paper (arXiv 2604.14228)**: "minimal scaffolding, maximal operational harness"; no
  judge (environment ground truth); five-layer compaction; lazy CLAUDE.md; sidechain isolation.

## 12. Design log — key simplifications (all resolved)

- **No wake-rule** — wake on everything readable; the model decides relevance and stays
  quiet on noise (cabra-bot's scan model). §2/§5. *(Mention-only wake-rule = deferred cost
  optimization, §10.)*
- **No cursor** — push-based, so **context = a bounded query** from the last `summary`;
  recovery re-derives pending work from the log. §7.
- **Three channels** — think (`thinking`, private) · assistant (bare text → principal) ·
  send (tool → peer). `send` is never principal-directed. §2/§5.
- **Concurrency** — one turn per agent (the turn lock); agents parallel (global cap). §2/§9.
- **Tools** — core surface = **`send` · `search` · `bash`** + dynamic MCP; scheduling /
  background / docs-memory = substrate + skill, *not tools*. §9.
- **Internal-event anchoring** — per-agent `local` scratchpad. §7.
- **Shared inbox** — every agent reads; coexistence-yield self-coordinates. §4.

## 13. Future work (recorded, not v0)

- Harness quality measurement (SWE-bench/Terminal-Bench + private CX suite; tokens-per-task;
  resume-correctness; interventions-at-fixed-quality; **yield precision**; A/B vs Claude Code).
- Prompt-injection gating at ingest (sender allowlists, gate on sender not room, pairing).
- Coordination-failure metrics (double-send / dropped-thread as queryable log patterns).
- Hydrate/dehydrate for sandboxes (materialize scoped docs in; snapshot working dir out).
- MCP tool-permission facts (annotations = untrusted hints; enforcement host-side).
- Parked models (relevant with the tree / scale): agentverse entity model (endpoints/
  wirings; **relationship class** as permission input; `peer_id` identity unification);
  call-center dynamics (Queue/Assignment/Capacity; handling vs supervising capacity);
  yield-policy inputs (confidence/presence/latency/sensitivity; `suggest` = draft-for-one-tap);
  operator-console UX (two-pane chat + pinned context; Teach/Whisper/Why/Promote);
  cross-contact info-flow (scrubbed up-promotion, memory-laundering guard).
- Rejected & why (for future selves): **A2A** as gateway protocol (peer-protocol ceremony
  vs driver shape — open-bsp already ships A2A types); **MCP channels** for ingestion
  (local-subprocess topology, can't publish to a log).

## 14. Naming

- **mu** — the step (μ: smallest). **nu** — the turn. **xi** — the consumer, the log
  boundary (μ < ν < ξ: step ⊂ turn ⊂ consumer).
- **agent** = the AI (alter-ego) · **principal** = the human it belongs to · **peer** = the
  other party (external contact or another agent). **principal-DM** = the agent↔principal
  conversation.
- **EventLog** — durable plane. **Stream** — ephemeral plane.
- **小-window** — the dispatch-echo race window (小 = "small"; a fortunate glitch).
- **Schema B** — role = "did this session author it?" (self → assistant, else → user).
