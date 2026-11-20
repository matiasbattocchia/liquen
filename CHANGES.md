# Next batch: wakes, the looks a session is owed

Decided 17 to 19 Nov 2026, for Postgres: the database and short-lived functions, with no
process that must stay up. Any writer may insert into `events`, and it waits on nothing of
liquen's. What follows a write is TypeScript, the same on both engines: the database
stores rows and rings a bell. The twelve below are settled. What is still open closes the
file.

1. A `wakes` table holds every look a session is owed.
2. A look's life runs between `wakes` and `locks`.
3. `locks` keeps its contract, and gives a wake its status.
4. `events` is immutable, optimistically: a row's data is written once, and an update
   carries its status and metadata.
5. One drain routes each new event to `wakes` through the law and the class gate. Every
   consumer's queue is state on rows, and a bell carries nothing.
6. Every timer is one of three kinds: a look, a pass of the tick, or a watch on a live
   thing.
7. A session has one timer, its wake, and `decide` names the moment to ask again. No look
   comes by the minute.
8. Every model call is tried and metered one way, under one name.
9. On Postgres every table carries `organization_id`, and a store is opened on one org.
   On SQLite the file is the org.
10. A `looks` table keeps what each look cost in time and memory.
11. A look builds what it runs with, and an attached session holds its provider, model
    and effort.
12. DESIGN.md gains a glossary, and the batch takes its names from it: an invocation
    carries out one step, `think`, `act` or `ignore`, and the `looks` table is `metrics`.

## 1. The wakes table

A wake is one row per session. It says a look is owed, and not before its `due`. It
carries no payload, as a poke carries none.

- **Columns.** `session`, the key: the address the lease's name already holds
  (`turn-<address>`). `due`, the moment the look may run. `seq`, a count of how often the
  wake was armed.
- **What it holds.** The scheduling main keeps in memory: each agent's tail of the log,
  the debounce timer, the look owed after a held lease, and the look a hold defers.
- **What it leaves alone.** Who works a session stays in `locks`. What an attachment chose
  (model, effort, `cwd`) is no wake. Deltas and a turn's edges stay unstored.

## 2. A look's life

```
 frontend · open-bsp-api · connectors
              │ INSERT
              ▼
        ┌───────────┐
        │  events   │◀──────────────────────────────────────┐
        └───────────┘                                       │
              │ 1  the drain: the law, the class gate       │
              ▼    upsert, keep the earlier due             │
        ┌─────────────────────┐                             │
        │        wakes        │◀───────────────┐            │
        │ session · due · seq │                │            │
        └─────────────────────┘                │            │
              │ 2  due, no live lock:          │            │
              ▼    the drain offers it         │            │
        ┌─────────────────────┐                │            │
        │         xi          │                │            │
        │ main, or a function │                │            │
        └─────────────────────┘                │            │
              │ 3  take the lock               │            │
              ▼                                │            │
        ┌─────────────────────┐ 5  when deleted│            │
        │        locks        │────────────────┘            │
        │ name · born · seen  │    and a wake still stands  │
        └─────────────────────┘                             │
           │              │                                 │
          held          taken                               │
           │              │                                 │
           ▼              ▼                                 │
      exit, and        read seq and the window,             │
    the wake stays     decide, work                         │
                          │                                 │
                          ▼                                 │
          ┌─────────────────────────────────┐               │
          │ 4  one transaction              │               │
          │    insert the last events       ├───────────────┘
          │    delete the lock              │
          │    settle the wake if its seq   │
          │    is the one it read           │
          └─────────────────────────────────┘
```

1. **The drain arms the wake.** A pass takes the events not yet routed and applies the law
   and the class gate (`relevant`) to each (§5). For every session a row passes for, it
   upserts the wake: `seq` goes up, and the earlier `due` stays. A row from the world sets
   a mind's `due` one debounce away (`system.debounceMs`). The session's own row sets it
   to now.
2. **A due wake with no live lock is offered,** if its agent runs. On a host the drain
   runs xi itself. Where no host stays up it posts through `pg_net` to the function that
   runs xi, and waits on no turn.
3. **xi takes the lock.** Held, it exits and the wake stays. Taken, it reads the wake's
   `seq`, then the window, then decides and works.
4. **The end is one transaction.** The turn's last events, the lock's delete and the
   wake's settling commit together. The wake is settled only if its `seq` is the one read:
   deleted, or moved to the moment `decide` named (§7).
5. **A release rings the bell.** The lock's delete wakes the drain, and its pass offers a
   wake that still stands.

What follows:

- **A turn chains through the table.** Step 4's rows are routed as any insert is and arm
  the wake under a new `seq`, so the settling misses and step 5 offers it.
- **A lost post costs nothing.** `pg_net` tries once, the wake stands, and the next pass
  offers it again.
- **Two posts for one wake do no harm.** One xi takes the lock, and the other exits.
- **A crash needs no path of its own.** The wake was never deleted and the lock stops
  being renewed, so a later pass offers the wake and the next xi steals the lease. xi
  sweeps what the dead holder left, as after any steal.
- **A pass that dies loses nothing.** Its transaction rolls back, its rows stay unrouted,
  and the next pass takes them.

## 3. Locks

- **Two tables, one key.** A lock exists only while held: its insert takes the lease and
  its delete frees it (`store/lock.ts`). That contract stands.
- **A wake has no status column.** A live lock on its session is what "taken" means.
- **The cancel mark stays on the lock.** A `control` row marks a running turn and arms no
  wake, since it never starts one.

## 4. Events are written once

`events` is immutable, optimistically. A row's data is written once, at its insert. What
is written afterwards is about the event: its status, and its metadata.

- **The data.** `type`, `parts`, `text`, `payload`, `timestamp`, and the envelope: the
  service, the connection, the room, the sender, the agent and its session.
- **The metadata.** `status`, `extra`, `updated_at`, and `routed_at` (§5). A receipt, a
  withdrawal and a send's progress are updates to `status`. A connector's marks sit in
  `extra`, stamped on arrival.
- **A change to a message is a row of its own.** An edit and a revoke are inserted, with
  the original's id in `ref_external_id`, on every connector.
- **A late fact fills, once.** What the wire tells after the insert fills a field that
  was empty: a send's `external_id` and sender, a room's kind, the thread a sent mail
  opened. A filled field stays as it is.
- **A restated row lands as metadata.** An upsert on a known `external_id` merges `status`
  and `extra`, fills what is empty, and leaves the data as first written.
- **It is optimistic.** liquen's writers keep the rule in their own code, and the suite
  holds them to it: a row restated with other words reads back as first written, on both
  engines. A role that is not liquen's is held by its privileges on Postgres: it may
  insert, and update `status`, `extra` and `updated_at` alone.

What follows:

- **A row is news once.** Whether a row wakes a session is decided when it is routed,
  from data that will not change and marks stamped on arrival. An insert is asked, and an
  update is not.
- **An update is a bell.** It tells the consumers that read state to look again: a
  dispatcher its re-offer, the report pass a send that failed.

## 5. The drain, and the queues

What follows a write is one TypeScript module, the drain. It runs after the write,
wherever a process lives, and no writer waits on it. It keeps nothing between passes:
what it knows is in the tables.

- **A pass does three things.** It routes the events not yet routed, offers the wakes
  that are due with no live lock, and runs the tick's passes that are due (§6).
- **Its queue is state on `events`.** `routed_at` is null on a new row, and a partial
  index holds the rows where it is. A pass takes them oldest first, arms the wakes they
  earn and stamps them, in one transaction. The stamp is the drain's alone, and it leaves
  `updated_at` as it was, so no reader of a row's moves sees it.
- **One pass at a time.** A pass locks the rows it takes. A second drain waits, then
  finds them routed. So each row is routed once, and in order.
- **Routing is the law and the class gate.** For each row the drain asks which sessions
  may see it (`policyFor`), and whether it can mean work for them (`relevant`). `wakes` is
  xi's queue, filled with what passed both, so no session looks at a row to learn it was
  not for it.
- **Who is asked.** The mind of every agent whose row says it runs, under the law. A named
  session by its room: the members a local address spells, or the memberships of a group.
  A paused agent's wake is armed and waits: the first pass after the agent runs again
  offers it, with all the news that came while it was paused.
- **The class gate comes before the wake.** A wake carries no payload, so xi has no row to
  refuse at its door, and a wake armed for nothing would cost a lease and a window read.
  `relevant` passes:
  - a `message`, unless it is silenced or holds only `room` parts;
  - a `tool_use` or a `tool_result`, when it is the session's own and no script made it;
  - a `permission_response`, an `alarm` and a `summary`;
  - an `error` in the session's own room, when it says the request was too long or that a
    checkpoint's try failed.
- **The debounce.** The drain reads `system.debounceMs` from the org's `config`. It delays
  a mind's wake for a row that is not the session's own. A named session's wake is due at
  once.
- **One language.** The law and the gate are TypeScript on both engines, and the suite
  runs their cases once.

Every consumer reads a queue held as state on rows:

| Consumer | Its queue |
|---|---|
| The drain | Events with no `routed_at` |
| xi | Wakes that are due, with no live lock |
| A dispatcher | Its service's rows in state `queued` |
| The tick | Rows whose time has come: reminders, asks, retries, reports |

- **A bell carries nothing.** It says a queue may have changed, and the consumer reads
  its queue. A lost bell costs time, never a row.

  | Bell | Who hears it | Where |
  |---|---|---|
  | The store's watch | A host on the file | SQLite |
  | `NOTIFY` | A host connected to the database | Postgres |
  | Realtime | A connector hosted elsewhere, a frontend | Supabase |
  | `pg_net` | Nobody: it starts the drain's function | Supabase, with no host |
  | `pg_cron` | Nobody: it rings each minute | Supabase: a lost bell, a `due` that came |

- **What rings.** An insert into `events`, a move of a row's `status`, and a lock's
  delete. On Postgres a statement-level trigger rings, with no condition and no row.
- **A claim is one statement.** A consumer takes a row by changing its state under a
  condition, so two of a kind never take the same one. A dispatcher claims a `queued` row
  by stamping `posting_at` so, in the store.
- **The mirror and the reports ride the drain.** The mirror copies from the rows a pass
  routes. The send reports run when a status moves, and each minute (§6).
- **Where the drain runs.** In main, on SQLite and on a Postgres host: a bell wakes it,
  and it sleeps until the next `due` otherwise. As a function where no host stays up,
  started by `pg_net` and by `pg_cron`.
- **What the database holds.** Rows, the bell's triggers, and the privileges of a role
  that is not liquen's.
- **Every start reads the org.** A look, a pass and a delivery read the org from the
  store as they start, and hold it until they end. The store's `config_version` and its
  triggers go. main brings an agent's door and sandbox in line when a command pokes its
  socket.
- **Steps 3 and 4 are the store's.** Reading `seq` and acknowledging with the release are
  the same statements on every engine.
- **The suite states it once.** Its cases run over a substrate, on both engines: an
  insert arms the wakes the law and the gate admit, and two drains route a row once.
- **What main lets go.** Its subscription per agent, the debounce timers, the owed set
  with its in-flight map, the raw-log router for named sessions, the subscriptions of the
  mirror and the reports, the minute's poke of every agent, the cache's keeper, and the
  runners it keeps per session (§11).
- **What main keeps.** The drain and its ticker, the turns a stop waits out, the doors and
  the sandbox.

## 6. Timers

Every timer is one of three kinds. A new one is placed by asking the three in this order.

1. **A look.** A session's own act, read from its window, that the clock alone can make
   due. The session's wake keeps the time. The holds, the debounce and the cache's keeper
   are looks (§7).
2. **A pass of the tick.** A row says when something is due, or the store needs a sweep.
   The tick keeps the time: once a minute per org, each pass at its own pace. The drain
   runs it, on main's ticker or on `pg_cron`'s ring. Its passes:
   - reminders, lapsed asks, send retries and send reports;
   - sign-in tickets past their deadline;
   - pages past their days;
   - objects no event references.

   A bell may bring a pass early. The send reports run when a row's `status` moves, and
   the minute stays the guarantee.
3. **A watch on a live thing.** A process, a socket or a lease is alive now, and the
   process that owns it keeps the time: a job's probe, the lease's heartbeat, a
   connector's reconnect, a sign-in flow polling its provider.

A pass and a watch write rows, and their rows are routed as any insert is.

## 7. The clock's looks

`decide` reads three things: the window, the config and the clock. Two of them arm a
wake.

- **The window.** The drain arms the wake for a new event (§5).
- **The clock.** `decide` names the moment to ask again.
- **The config.** A look reads it as it starts. A change to the config or to the law
  reaches a session at its next look, whatever arms it.

Two rules keep the clock's part whole:

- **Whatever a session does by the clock is a verdict of `decide`.** A session has one
  timer, its wake, and the wake only ever asks `decide` again.
- **`decide` reads the clock through one door.** The door remembers each moment it was
  asked about, and the earliest one still ahead is the moment to ask again. A rule that
  reads the clock names its end by reading it.

What the door is asked about:

- a note waiting for its words: `PROCESSOR_TIMEOUT_MS` after the note;
- a room someone is writing in: when the stamp goes stale, or when the oldest news held
  there has waited `TYPING_HOLD_MS`;
- the night: when `sleepHours` ends on the agent's clock;
- the digest: `digestMinutes` after the agent last looked;
- the cache's hour: `WARM_MS` after the newer of the session's last anchor and its last
  `keepalive` row.

What follows:

- **`warm` is a verdict.** With nothing else owed and the cache's hour near its end, xi
  renders the window up to where its last step began and sends it with `max_tokens: 0`.
  The request places no anchor of its own, so its bytes are the ones that step's think
  sent: it reads what the think wrote, and closes as the think did. Only a mind is kept
  warm, on a provider whose cache a read renews.
- **The hour starts at the anchor.** nu stamps a step's anchor when its request is made,
  and places one whenever the minute moved. So the newest anchor is under a minute older
  than the newest think's send, and the ping comes that much early. A compaction with no
  think since leaves no anchor past its summary, and nothing to keep.
- **The suite holds the bytes.** A case renders a ping and finds the request its step
  sent. What the provider read shows in the `keepalive` row of a live org.
- **A ping writes a `keepalive` row.** It sits in the mind's room and says what the ping
  read, or the error that ended it. xi sets it aside from the window as it does a
  decision, so no rule, render or tool meets one, and it arms no wake. The log holds the
  run, so a restart keeps it.
- **A run ends when there is nothing to keep.** Each ping that read the cache names the
  next, `WARM_MS` on. The run goes on through the night, and stops `warmHours` past the
  start of the session's last model call, after a ping that failed, and after a ping that
  read nothing. The next turn starts a new one.
- **The end settles the wake.** xi asks `decide` about the window it leaves, after an
  `ignore` and after work alike. Something still owed keeps the wake, due now: the
  checkpoint an over-budget window needs after a turn's own error is one. A moment named
  moves the wake there. With neither, the wake is deleted.
- **An early look is free.** It answers `ignore` and settles the wake again. So the door
  may name a moment too soon, and never one too late.
- **The look's clock.** xi decides with the later of its own clock and the wake's `due`.
  A function whose clock runs behind the database's still finds the moment come.
- **The judge rides that look.** News a hold kept back is judged in the look that comes
  when the hold ends, and a green thinks at once.
- **A stamp taken off.** A typing stamp removed ends its hold early. The look still comes
  when the stamp would have gone stale.
- **The suite holds the two together.** A case steps `decide` through time across each
  rule that reads the clock: the verdict turns no sooner than the moment it named.

## 8. Model calls

A model call is tried and metered one way, whatever it is for. `mu` shapes the request,
nu's ladder tries it, and the meter counts it under its kind.

| Model call | Verdict | Meter kind | Row |
|---|---|---|---|
| A think | `think` | `think` | `thinking`, `message`, `tool_use` |
| A compaction | `compact` | `compact` | `summary` |
| The judge | none, it runs before `decide` | `decide` | `decision` |
| The keeper's ping | `warm` | `warm` | `keepalive` |

- **The names follow the table.** A meter kind is a verb, the verdict's own where there is
  one: `checkpoint` becomes `compact`, `decision` becomes `decide`, and `keepalive`
  becomes `warm`. The `light` row becomes a `decision` row.
- **nu hands the model call out.** The judge and the ping take the one nu gives its
  compaction (`StepCall`), so each is tried as a think is: the client's fast retries, then
  `RETRY_DELAYS_MS`.
- **`mu` learns one thing.** A model call may ask for its answer in a schema. Thinking
  stays adaptive on every call, and the judge states only its `decision.effort`.
- **What each keeps.** The judge keeps its slice, its instruction and the shape of its
  answer. The ping keeps `max_tokens: 0`.
- **The judge names its provider.** `decision.provider` joins `decision.model` and
  `decision.effort`, which are checked against it. Unset, the judge rides the agent's
  provider. Its model call takes its own transport (§11).

## 9. Orgs

On Postgres one schema holds every org, and a column tells them apart. The schema is the
service's: liquen's stands beside open-bsp-api's.

- **The column.** Every table carries `organization_id`, `wakes` and `looks` among them.
  Every key and unique index that names a thing inside an org leads with it, as
  `connections (organization_id, service, address)` does.
- **`organizations` is liquen's own table.** One row per org: its `id` and its `name`.
- **A store is opened on one org.** The Postgres adapter binds its handle to the org, as
  it binds it to the schema. xi, nu and the connectors see one org's rows.
- **SQLite has no column.** The file is the org.
- **A pass stays inside its org.** The drain finds the orgs with unrouted events or due
  wakes, and opens a store on each. A row arms wakes only for its org's sessions, under
  that org's law and `config`, and a post to xi names the org with the session.
- **`pg_cron` is one job.** It rings the drain each minute, and the drain runs each org's
  passes.
- **The suite holds two orgs apart.** A Postgres case writes to two orgs in one schema.
  Neither reads the other's rows, and neither's insert arms the other's wake.

## 10. The looks table

A look is what a host bills: one invocation, its time and its memory. `looks` keeps a row
for each, an `ignore` too.

- **Columns.** `created_at`, `agent_id`, `session`, `turn_id`, `verdict`, `wall_ms`,
  `model_ms`, `cpu_ms`, `memory_bytes`, `events`, `request_bytes`.
- **What each number is.**
  - `wall_ms`: from the lease taken to the look's end.
  - `model_ms`: the wait on the provider, the judge's calls with the step's.
  - `cpu_ms`: the look's synchronous work, timed where it runs: reading the window,
    render, the request serialized and the answer parsed.
  - `memory_bytes`: the process's resident memory as the look ends.
  - `events` and `request_bytes`: the window's rows, and the bytes of the request sent.
- **It is telemetry, as `usage` is.** A table beside the log, so its rows arm no wake. It
  commits with the look's end (§2, step 4), and `turn_id` joins it to the calls `usage`
  holds.
- **A tool's time stays on its result.** An exec tool's run keeps its wall time in
  `extra.exec`.

## 11. The runner, and the tune

A look builds what it runs with, and keeps nothing for the next.

- **xi builds its own runner.** A look reads the org and the agent's row, makes the
  session's config, and builds its ports from the host. main hands it one thing more, the
  session's tune. A function hands it none.
- **A transport is asked for by provider.** The host hands every provider's transport
  through one function. xi binds its agent to it, for the agent's key and its meter, and
  resolves two: the session's, and the judge's. nu, the judge and the ping each receive a
  transport, and see no provider.
- **main keeps no runners.** Its maps of minds and of named sessions go, and `retune` with
  them: a change to a row is read by the next look.
- **The tune is the triple.** Provider, model and effort, taken when a session is first
  attached: the values the attach names, and the row's for the rest. The door checks it
  then, and refuses an attach whose provider cannot run the model at that effort. A look
  runs on the tune whole, so a write to `config` leaves an attached session's triple as
  it was.
- **The rest follows the org.** Tools, rules, `sleepHours` and the window's budget are
  read at each look, attached or not. So is the judge: its provider, model and effort are
  the org's, and a tune leaves them alone.
- **One tune per session.** main holds it beside the session's attachments. A later
  attach that names no values joins it. One that names other values is refused, with an
  error that says what the session holds.
- **The last hang-up ends it.** With no attachment left, the tune goes, and the next look
  runs on the row.

## 12. Names

DESIGN.md gains a glossary, grown from its §14: one entry for each term, under the name
the code already uses. This batch, and every doc after it, takes its names from the
glossary, so a thing that has a name is never given another.

- **An invocation is one run of xi.** The ReAct loop is unrolled across invocations: each
  reads the window, and `decide` picks the step it carries out.
- **A step is a verdict carried out.** `think`, `act`, or `ignore`, which stops the loop.
  An act is a step as a think is: it answers the tool calls the last think made.
- **An auxiliary step is outside the loop.** `compact`, `warm` and `unload` are verdicts
  the ReAct loop does not take. Each runs on the same invocation path as a step: the turn
  lease, the window read, and the end's one transaction.
- **A model call is one request to a provider,** whatever it is for: a think's, a
  compaction's, the judge's, the cache keepalive's. A tool call is the model's request to
  run a tool. Once a paragraph has named one of them, it may say call.
- **A turn is the loop.** It runs from the news that opens it to the `ignore` that stops
  it, one step to an invocation, chained through `wakes` (§2).
- **"Look" is no term.** Where this file says a look, the glossary's word is invocation.
- **The lease answers in the code's words.** `acquire` returns `acquired`, `stolen` or
  `held` (`store/lock.ts`). Where §2 says taken, it means acquired or stolen.
- **The session lease guards a step.** One invocation holds it for the one step it carries
  out, and between steps the row is gone, so it is named for the session it serializes:
  its key is the session's address alone, with no `turn-` before it. `locks` holds no
  other kind of row.
- **A step's rows carry a `step_id`.** `turn_id` groups one step's emissions, so it takes
  the step's name, and turn keeps its one meaning: the loop. `readTurns` and the turn line
  read the loop, and keep theirs.
- **The side table is `metrics`.** §10's table keeps what each invocation cost, and its
  name says it is telemetry, not a part of the loop.
- **A term is a compound noun.** A paragraph names a thing whole the first time it says
  it: the cache keeper, the cache keepalive, the turn lease, the send report. Once it has,
  the short form follows. CLAUDE.md states the rule.

## Open

None of these is part of the batch until it is settled.

- **How the store's role is held to its org.** A policy on every table could refuse what a
  missed predicate lets through, by reading a setting of the connection. Whether a pooler
  in transaction mode keeps that setting is unverified.
- **An org's users.** Which rows say that a signed-in user may reach an org through the
  Data API, and whether what they read of `events` passes the law.
- **The riders that keep state or take time.** The transcriber runs a command for each
  note, and presence remembers who asked for a stretch. Whether each is a step of a pass,
  or a consumer with a queue of its own.
