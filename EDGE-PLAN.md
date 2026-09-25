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

main keeps a map of the running turns' `AbortController`s and fires one when a `control`
row lands in the session's room. An edge invocation has no process to hold that map.

`acquire()` hands back a lease with an `AbortSignal`, and the STORE fires it: the SQLite
adapter from its own subscription (as immediate as now), the Postgres adapter from the
heartbeat — a trigger on `control` rows marks `locks.cancel` on `turn-<session>`, and the
beat's `UPDATE … RETURNING cancel` reads it (latency ≤ `LOCK_TTL_MS / 3`). `XiPorts.interrupt`
and main's `turns` map retire; the lease already lives in the store, and now its
cancellation does too.

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

`loadMediaBlock` (`src/store/media.ts`) does `Deno.readFileSync`, and xi hands it to render
as a sync loader: filesystem I/O inside nu's pure layer, and a read that cannot await
Storage.

Render exports a pure `wantedMedia(window)` — the trailing-region uris it will inline. xi
fetches them through an async blob port (`get(uri) → bytes`) and passes nu a sync lookup
table. Render stays sync and becomes actually pure; the file adapter reads `file://`, an
edge adapter reads Storage under its own scheme — `FilePart.uri`'s scheme is already the
whole distinction (DESIGN §5, Media).

## 6. `FileScope` becomes a files port

`filePartOf` checks scope and stats paths on the broker's filesystem. An async
`files.resolve(ref) → FilePart` does the scope check, the stat and the mime, and both
`ExecOutcome.files` and `send({files})` go through it. A remote sandbox implements it by
moving the bytes from the sandbox into the blob store and returning the uri; the local
adapter is today's code.

## 7. One sandbox provider owns the exec plane

main wires `installProxy`, `writeTrustBundle`, `installExecGround` and the per-session
`shellOf` itself — all of them exec. One provider owns them:
`sandbox.forAgent(id).session(sid) → { exec, ambient, stand, reap, files }`, and main
holds only the provider. The edge tier either has none (`exec?` and `ambient?` are
already optional on `XiPorts`) or a remote one (E2B, Cloudflare Sandbox) that brings its
own egress proxy — the proxy exists for bash, so it travels with bash.

## 8. main's roles are functions

Extract, and have main call:

- `tick(store, now)` — `fireDue` · `lapseGates` · `sweep`
- `route(event) → [(agent, session)]` — `namedIn` and the membership it enrolls
- `portsFor(store, agentRow, session)` — the runner main builds per session

The edge tick function and the edge trigger function then call the same code main does:
one implementation per role, two hosts.

## 9. The agent row is enough to run xi

`syncAgents` stores the fully resolved settings on the row (`maxTokens`, `timezone`,
`gateHours`, tools, …), and main builds `AgentConfig` FROM the row — so a cold isolate
rebuilds an agent from the store alone ("an agent IS its row", DESIGN §9). `tune`
overrides stay in memory: they live as long as an attachment, and the edge tier's
attachments are the doors' redesign, not this step's.

## 10. The store suites run against an adapter factory

Parameterize `src/store/*.test.ts` over a factory that opens a store. The Postgres adapter
is done when it passes the same suite; its DDL is written with it, against these tests.
