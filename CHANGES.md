# Next batch: wakes, the looks a session is owed

Decided 17 Nov 2026, for Postgres: the database and short-lived functions, with no process
that must stay up. Any writer may insert into `events`, and triggers make the row right.
The five below are settled. What is still open closes the file.

1. A `wakes` table holds every look a session is owed.
2. A look's life runs between `wakes` and `locks`.
3. `locks` keeps its contract, and gives a wake its status.
4. The trigger on `events` arms a wake through the law and the class gate.
5. On SQLite the adapter's publish arms the wake, and one drain serves every host that
   stays up.

## 1. The wakes table

A wake is one row per session. It says a look is owed, and not before its `due`. It
carries no payload, as a poke carries none.

- **Columns.** `session`, the key: the address the lease's name already holds
  (`turn-<address>`). `due`, the moment the look may run. `seq`, a count of how often the
  wake was armed.
- **What it holds.** The scheduling main keeps in memory: each agent's tail of the log,
  the debounce timer, and the look owed after a held lease.
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
          │    delete the wake if its seq   │
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
   wake's delete commit together. The wake goes only if its `seq` is the one read.
5. **A release offers what stands.** A trigger on the lock's delete sends a surviving wake
   through step 2 again. It offers, and writes nothing.

What follows:

- **A turn chains through the table.** Step 4's rows pass the same trigger and arm the
  wake under a new `seq`, so the delete misses and step 5 offers it.
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
- **Inserts only.** A merge into a known row is an update, and wakes nobody.
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
  with its in-flight map, and the raw-log router for named sessions.
- **What main keeps.** The drain, the ticker, the turns a stop waits out, the doors and
  the sandbox.

## Open

None of these is part of the batch until it is settled.

- **The minute's look.** Retiring it needs a look that defers to say when to ask again.
  `decide` answers only `ignore` today.
- **Other timers.** Whether the cache keeper, a job followed past its answer and a
  sign-in's poll are each a wake of their own kind.
