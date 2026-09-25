# EDGE-PLAN — paving main › xi › nu › mu for the edge tier

Companion to [DESIGN.md](DESIGN.md) §9 (*The edge tier: main dissolves into the database*).
Ten refactors that land in the local tier first and leave its behavior unchanged: each one
turns a filesystem- or memory-bound seam into a port whose local adapter is the code that
runs now. The edge host (the `pg_net` trigger, `pg_cron`, the doors over HTTP, the
debounce) is its own later build; this plan is what that build finds already in place.

The edge constraints the steps answer to: a wall clock per invocation (≈150s free / 400s
paid on Supabase), a hard CPU budget per request (≈2s, async I/O excluded), no
subprocesses, no durable filesystem, no memory shared between invocations.

Ordered by how much edge work each one retires. **1, 2 and 5 first**: they are where edge
code would otherwise leak into xi and render, and 2 and 5 pay off locally too.

## 1. Every store port is async

**Landed** (PROJECT.md, 2026-09-24). Every port method returns a `Promise`; the SQLite
adapter resolves what it has, and xi, main, the door, the connectors and the tests await.
`lock(name)` stays a plain constructor — its methods were already promises.

The audit found one interleaving that mattered: a wake that finds the turn lease held exits
on the word that the holder's end will poke, and an `ignore` verdict releases without
publishing, so a row landing between the holder's read and its release woke nothing until
the clock. main now owes such a session one trigger-less re-poke once its own in-flight
invocation settles (coalesced per session; a holder in another process is not waited on).
The edge host has the same debt: its trigger function, told "held", must re-enqueue the
session or let `pg_cron` be the backstop. Everything else that was two sync calls in a row
(enroll-then-scope in `runnerOf`, claim-then-publish in `fireDue`, gates-then-answer in xi)
reads correctly under a lease or an atomic statement already.

## 2. The read policy is SQL

**Landed** (PROJECT.md, 2026-09-24). `policyFor` and `historyFor` return a `Law` — the
visibility predicate as a SQL boolean over an event's columns, joined to `memberships`,
`connections` and the roster views (`speaks` · `principals` · `aliases`,
`src/store/roster.ts`), with named bindings. The store applies it in the read's WHERE
(the LIMIT is back in SQL), in the tail's scan and inside the writing transaction as
WITH CHECK; `admits(law, event)` asks it of one event. The Postgres adapter reuses the
expression as the role's `USING`/`WITH CHECK`, with three functions to define on its side
— `routed`, `same_handle`, `digits` — and the views as real views.

## 3. The lease carries the interrupt

**Landed** (PROJECT.md, 2026-09-25). `TurnLock.signal()` is the running turn's interrupt,
fresh per acquire. The publish that lands a `control` row (any but the harness's own
`cancelled`) marks `locks.cancel` on `turn-<room>` inside its transaction; once it commits,
a holder in the same process is fired at once. A holder in another process is rung: the
locker, while it holds a lease, subscribes to the store's change stream for `control` rows
(`createLocker`'s `watch`; SQLite: the tail), and each ring has every holder read its mark.
The heartbeat reads it too (`UPDATE … RETURNING cancel`), so a missed ring costs a beat,
never the cancel. A stolen lease starts unmarked. `XiPorts.interrupt` and main's `turns`
map are gone. On Postgres the mark is the same column, set by a trigger on `control`
inserts, and `watch` is a Realtime subscription or `LISTEN/NOTIFY`.

The ways to reach a holder in another process, weighed:

- check the mark at step boundaries (before each model call, each tool run): cheap, but a
  long stream or tool still waits;
- a faster poll of the mark alone: one query per running turn per period;
- **a push that rings the holder to read its mark now** — the store's own change stream
  (SQLite: the tail's fs-watch; Postgres: Realtime or `LISTEN/NOTIFY`), the heartbeat
  left as the guaranteed fallback. Chosen: the mark stays the one truth, the push only
  makes it read sooner;
- a dispatcher holding every invocation's request and aborting it: instant, but a master
  process that must stay up;
- conversation-affine execution (one actor per room, Durable-Objects style): the cancel is
  always in-process; no Supabase equivalent.

## 4. Docs are addressed by a handle

On the edge tier docs are the `docs` table (DESIGN §8), written through substrate CRUD
under RLS — the query tool is that tier's editor. Locally they are files, written with
bash; the query tool arrives with the edge adapter, as that tier's tool.

The port gets there in two moves:

- `DocEntry.header` carries an opaque `handle`, and render prints it (`ref`,
  `src/render.ts`). The file adapter's handle is the home-relative path it prints now, so
  the prompt is byte-identical.
- The entry takes the table's columns — `scope · kind · name · description · body · load ·
  write · version` — in place of free-form `frontmatter`. The file adapter is then a
  projection of the table.

## 5. Render gets its bytes from xi

**Landed** (PROJECT.md, 2026-09-24). `wantedMedia(window, session)` (`src/render.ts`) is
the pure request budget: the trailing-region uris a render inlines, newest first. xi asks
the media port (`XiPorts.media`, a `MediaLoader`: `uri → Promise<MediaBlock | null>`) for
each and hands render a `ReadonlyMap` — render reads no file and awaits nothing. The file
adapter is `loadMediaBlock`, async, memoized once per process in main; an edge adapter
answers the same question from Storage under its own uri scheme.

## 6. `FileScope` becomes a files port

**Landed** (PROJECT.md, 2026-09-25). `Files` (`src/store/media.ts`) is the port:
`resolve(ref) → Promise<FilePart>` does the scope check, the stat and the mime, and both
`ExecOutcome.files` and `send({files})` go through it. `localFiles(scope)` is the local
adapter, and the sandbox session carries the port (`SandboxSession.files`) beside its
`home`, since what an agent may attach is the ground it stands on. A remote sandbox
implements it by moving the bytes from the sandbox into the blob store and returning the
uri.

## 7. One sandbox provider owns the exec plane

**Landed** (PROJECT.md, 2026-09-25). `Sandbox` (`src/sandbox.ts`) is the exec plane's
provider: `sandbox.forAgent(id).session(sid)` is a session's `exec · ambient · stand ·
reap · files`, and `close` reaps every shell and stops the proxy. `openLocalSandbox(dir,
{agents, locale, bashTimeoutMs})` is the local provider — the egress proxy and its trust
bundle, one ground per agent, one shell per session — and main holds only the provider.
The edge tier either has none (`exec?`, `ambient?` and `files?` are optional on
`XiPorts`) or a remote one (E2B, Cloudflare Sandbox) that brings its own egress proxy —
the proxy exists for bash, so it travels with bash.

## 8. main's roles are functions

**Landed** (PROJECT.md, 2026-09-25). `tick(log, settings, now)` (`src/tick.ts`) is one
beat of the clock — `fireDue` · `lapseGates` · `sweep`, each pass its own, a failure
named in the beat while the next still runs — answering with the counts;
`route(event)` (`src/route.ts`) is the named sessions an event's address wakes, pure over
the envelope, and `enroll` beside it is what a session named for the first time owes the
store. main calls both where it did the work inline; the edge tick function and the edge
trigger function call the same code: one implementation per role, two hosts.

The runner is one builder, `runnerFor(host, agentRow, sessionId, seams)`
(`src/runner.ts`), serving the mind and every named session over the store, the row and
a `Host` — the ports a host wires once: the policy, the history law, the stock transport
per agent, the sandbox (absent on the edge tier: the session then has no exec plane),
the address book, the media loader and the two fan-outs. `configOf(row, sessionId)` is
the row as the config a session runs with. main's own part is the `Host` it builds.

## 9. The agent row is enough to run xi

**Landed** (PROJECT.md, 2026-09-25). The row carries `settings` (`AgentSettings`,
`src/store/agents.ts`): everything the catalog's funnel decided past the identity columns
— `maxTokens`, `tools`, `rules`, `since`, the attention knobs, `gateHours`, the
compaction thresholds — nulls kept as the values they are. The roster compiles into rows,
`syncAgents` mirrors them, and main builds every `AgentConfig` by reading the table back
(`configOf`), explicit principals included: a test's agent takes the same round trip, so
a field the row cannot carry fails a test. Off the row by nature: `home` (this data
root's folder for the agent), and a test's compiled `gate` and `retryDelaysMs` (functions
and pace, passed in code). `tune` overrides stay in memory: they live as long as an
attachment, and the edge tier's attachments are the doors' redesign.

## 10. The store suites run against an adapter factory

Parameterize `src/store/*.test.ts` over a factory that opens a store. The Postgres adapter
is done when it passes the same suite; its DDL is written with it, against these tests.
