# Next batch: wakes, the looks a session is owed

Decided 17 Nov 2026, for Postgres: the database and short-lived functions, with no process
that must stay up. Any writer may insert into `events`, and triggers make the row right.
The seven below are settled. What is still open closes the file.

1. A `wakes` table holds every look a session is owed.
2. A look's life runs between `wakes` and `locks`.
3. `locks` keeps its contract, and gives a wake its status.
4. The trigger on `events` arms a wake through the law and the class gate.
5. On SQLite the adapter's publish arms the wake, and one drain serves every host that
   stays up.
6. Every timer is one of three kinds: a look, a pass of the tick, or a watch on a live
   thing.
7. A session has one timer, its wake, and `decide` names the moment to ask again. No look
   comes by the minute.

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
              │ 1  trigger: the law, the class gate         │
              ▼    upsert, keep the earlier due             │
        ┌─────────────────────┐                             │
        │        wakes        │◀───────────────┐            │
        │ session · due · seq │                │            │
        └─────────────────────┘                │            │
              │ 2  due, no live lock:          │            │
              ▼    trigger now, pg_cron later  │            │
        ┌─────────────────────┐                │            │
        │  pg_net → function  │                │            │
        │         xi          │                │            │
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

1. **An insert arms the wake.** The trigger on `events` applies the law and the class gate
   (`relevant`), then upserts the session's wake: `seq` goes up, and the earlier `due`
   stays. A row from the world sets a mind's `due` one debounce away
   (`system.debounceMs`). The session's own row sets it to now.
2. **A due wake with no live lock is offered.** A trigger on `wakes` posts through `pg_net`
   to the function that runs xi, and `pg_cron` offers the wakes that come due later.
3. **The function takes the lock.** Held, it exits and the wake stays. Taken, it reads the
   wake's `seq`, then the window, then decides and works.
4. **The end is one transaction.** The turn's last events, the lock's delete and the
   wake's settling commit together. The wake is settled only if its `seq` is the one read:
   deleted, or moved to the moment `decide` named (§7).
5. **A release offers what stands.** A trigger on the lock's delete sends a surviving wake
   through step 2 again. It offers, and writes nothing.

What follows:

- **A turn chains through the table.** Step 4's rows pass the same trigger and arm the
  wake under a new `seq`, so the settling misses and step 5 offers it.
- **A lost post costs nothing.** `pg_net` tries once, the wake stands, and `pg_cron`
  offers it again.
- **Two posts for one wake do no harm.** One function takes the lock, and the other exits.
- **A crash needs no path of its own.** The wake was never deleted and the lock stops
  being renewed, so `pg_cron` offers the wake and the next function steals the lease. xi
  sweeps what the dead holder left, as after any steal.

## 3. Locks

- **Two tables, one key.** A lock exists only while held: its insert takes the lease and
  its delete frees it (`store/lock.ts`). That contract stands.
- **A wake has no status column.** A live lock on its session is what "taken" means.
- **The cancel mark stays on the lock.** A `control` row marks a running turn and arms no
  wake, since it never starts one.

## 4. The trigger on events

The trigger answers two questions for each row: which sessions may see it, and whether it
can mean work for them.

- **The law has one source.** The schema builds a SQL function from the text `policyFor`
  gives the reads, as it builds `object_readable`. The trigger calls it, and a row-level
  policy may call it too.
- **Who is asked.** The mind of every agent whose row says it runs, under the law. A named
  session by its room: the members a local address spells, or the memberships of a group.
  A paused agent gets no wake.
- **The class gate lives in the trigger.** A wake carries no payload, so xi has no row to
  refuse at its door, and a wake armed for nothing would cost a lease and a window read.
  The gate is `relevant` in SQL:
  - a `message` passes unless it is silenced or holds only `room` parts;
  - a `tool_use` or a `tool_result` passes when it is the session's own and no script
    made it;
  - a `permission_response`, an `alarm` and a `summary` pass;
  - an `error` passes in the session's own room, when it says the request was too long or
    that a checkpoint's try failed;
  - any other row is dropped.
- **Two languages, one answer.** The suite runs its cases through `relevant` and through
  the SQL, as it does for `fold` and `docs_edit`. The pattern for a request too long is
  built from `TOO_LONG` (`compact.ts`).
- **An insert is asked, and an update that turns a row.** A merge into a known row is an
  update. It is asked only when the row passes the gate and did not before, as a line in a
  muted room does once it is restated with a mention of the account. Any other merge wakes
  nobody.
- **The debounce.** The trigger reads `system.debounceMs` from the `config` table. It
  delays a mind's wake for a row that is not the session's own. A named session's wake is
  due at once.

## 5. SQLite, and the drain

- **The contract is the port.** A publish arms the wake of every session the law admits
  and the gate passes. Postgres keeps it with the trigger. SQLite keeps it in the
  adapter's publish, inside the writing transaction: the law's text in the arming query,
  and `relevant` called as it is. SQLite gets no trigger.
- **The suite states it once.** The case runs over a substrate, on both engines.
- **The drain is one module.** It takes the wakes that are due and have no live lock, and
  runs xi for each. A commit wakes it (SQLite's watch, Postgres's `NOTIFY`), and it sleeps
  until the next `due` otherwise. main runs it on SQLite, and so does a Postgres host
  with no `pg_net`. It stands where steps 2 and 5 of a look's life have a trigger.
- **Steps 3 and 4 are the store's.** Reading `seq` and acknowledging with the release are
  the same statements on every engine.
- **What main lets go.** Its subscription per agent, the debounce timers, the owed set
  with its in-flight map, the raw-log router for named sessions, the minute's poke of
  every agent, and the cache's keeper.
- **What main keeps.** The drain, the ticker for the clock's passes, the turns a stop
  waits out, the doors and the sandbox.

## 6. Timers

Every timer is one of three kinds. A new one is placed by asking the three in this order.

1. **A look.** A session's own act, read from its window, that the clock alone can make
   due. The session's wake keeps the time. The holds, the debounce and the cache's keeper
   are looks (§7).
2. **A pass of the tick.** A row says when something is due, or the store needs a sweep.
   The tick keeps the time: once a minute per org, each pass at its own pace, by main's
   ticker or by `pg_cron` where no host stays up. Its passes:
   - reminders, lapsed asks, send retries and send reports;
   - sign-in tickets past their deadline;
   - pages past their days;
   - objects no event references.
3. **A watch on a live thing.** A process, a socket or a lease is alive now, and the
   process that owns it keeps the time: a job's probe, the lease's heartbeat, a
   connector's reconnect, a sign-in flow polling its provider.

A pass and a watch write rows, and their rows arm wakes as any insert does.

## 7. The clock's looks

`decide` reads three things: the window, the config and the clock. A wake has a source
for each.

- **The window.** The trigger on `events` arms the wake (§4).
- **The config and the law.** A membership's insert arms that member's session. A write
  to `agents`, `connections` or `config` arms the mind of every running agent, and an
  agent that starts to run gets its first look so.
- **The clock.** `decide` names the moment to ask again.

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
- the cache's hour: `WARM_MS` after the session's last call.

What follows:

- **`warm` is a verdict.** With nothing else owed and the cache's hour near its end, xi
  renders the window and sends it with `max_tokens: 0`. The request places no anchor, so
  every byte it sends is the log's, and the next turn reads it back. `WARM_PINGS` bounds
  the run between two turns.
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

## Open

None of these is part of the batch until it is settled.

- **The keeper's render.** Whether a window rendered again reads the cache the session's
  last call wrote. `render.ts` says the request only ever grows, and no test holds a
  second render to a live cache.
- **The keeper's count.** `WARM_PINGS` needs the session's calls since its last turn. A
  `usage` row names the agent and the turn, and no session.
